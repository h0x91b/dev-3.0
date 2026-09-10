/**
 * Provenance on a message log row: it is stamped by the caller, it survives a
 * delay, and it is ABSENT everywhere the caller could not prove a human acted.
 *
 * The absence cases carry the weight. A null sender is worn by four different
 * things — an artifact form submit, a dev3 hand-off, a `dev3 message` run
 * outside a worktree, and the user — so a reader that treats "no sender" as
 * "the user" mislabels three of them. These cases fail the moment someone
 * re-derives origin from the row's shape instead of reading what was stamped.
 *
 * Same redirected-disk harness as `agent-message-log-callsite.test.ts`: the row
 * is read back off a real file, never asserted against the writer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

const home = vi.hoisted(() => require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/dev3-msglog-origin-`) as string);
vi.mock("../paths", () => ({ DEV3_HOME: home, OPS_DIR: `${home}/ops`, SANDBOX_DIR: `${home}/sandbox` }));
vi.mock("../git", () => ({
	projectSlug: (p: string) => p.replace(/^\//, "").replaceAll("/", "-"),
	taskDir: (_p: unknown, t: { id: string }) => `${home}/worktrees/proj/${t.id.slice(0, 8)}`,
}));
vi.mock("../data", () => ({
	loadProjects: vi.fn(async () => []),
	loadVirtualProjects: vi.fn(async () => []),
	loadTasks: vi.fn(async () => []),
	getProject: vi.fn(async () => project),
	getTask: vi.fn(),
	updateTaskWith: vi.fn(async (_p: unknown, _id: unknown, mutator: (t: unknown) => { updates: Partial<Task> }) => {
		const { updates } = mutator(makeTask());
		return { task: { ...makeTask(), ...updates }, result: undefined };
	}),
}));
vi.mock("../agent-prompt", () => ({
	sendPromptToAgentPane: vi.fn(async () => true),
	sendPromptToPane: vi.fn(async () => true),
	holdMessageForAgentPane: vi.fn(async () => ({ status: "held" })),
	holdMessageForPane: vi.fn(async () => ({ status: "held" })),
}));
vi.mock("../agent-prompt-native", () => ({
	sendPromptToNativeAgentPane: vi.fn(async () => true),
	sendPromptToNativePane: vi.fn(async () => true),
}));
vi.mock("../pty-server", () => ({ DEFAULT_TMUX_SOCKET: "dev3" }));
vi.mock("../rpc-handlers", () => ({
	getPushMessage: vi.fn(() => vi.fn()),
	pushCliToast: vi.fn(),
	pushCliAttention: vi.fn(),
	pushAgentMessage: vi.fn(),
}));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import type { Project, ScheduledMessage, Task } from "../../shared/types";
import { isUserOrigin } from "../../shared/agent-message-log";
import { messageLogDir, readAgentMessageLog, resetAgentMessageLogPruneState } from "../agent-message-log";
import { fireScheduledMessage, scheduleMessage, sendMessageImmediately } from "../scheduled-message-scheduler";

const project = { id: "proj-1", name: "Proj", path: "/Users/x/repo" } as unknown as Project;

function makeTask(overrides: Record<string, unknown> = {}): Task {
	return {
		id: "task-12345678",
		projectId: "proj-1",
		seq: 1650,
		title: "Worker",
		status: "in-progress",
		scheduledMessages: [],
		sessionState: { panes: [{ paneId: "%1", agentCmd: "claude", sessionId: null, agentId: null, configId: null }] },
		...overrides,
	} as unknown as Task;
}

/** A peer agent's `dev3 message` — the traffic that already had a sender. */
const source = { taskId: "coordinator-task", seq: 1141, title: "Coordinator", projectId: "proj-1" };

beforeEach(() => {
	resetAgentMessageLogPruneState();
	rmSync(messageLogDir(project), { recursive: true, force: true });
});

describe("a send the caller proved was the user's", () => {
	it("records the origin, the recipient and the time together", async () => {
		const before = Date.now();
		await sendMessageImmediately(makeTask(), "look at the failing shard", null, null, { origin: "user" });

		const { rows } = readAgentMessageLog(project);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			origin: "user",
			// No agent wrote it, and that stays true — origin does not invent a sender.
			fromTaskId: null,
			fromSeq: null,
			toTaskId: "task-12345678",
			toSeq: 1650,
			toProjectId: "proj-1",
			kind: "immediate",
			body: "look at the failing shard",
		});
		const at = Date.parse(rows[0]!.at);
		expect(at).toBeGreaterThanOrEqual(before);
		expect(at).toBeLessThanOrEqual(Date.now());
	});

	it("carries the origin across the delay of a Send later", async () => {
		// Queued now, fired later: nothing at fire time could tell who wrote it, so
		// the queue record is the only thing that can carry the answer.
		const queued = await scheduleMessage(project, makeTask(), {
			text: "start the rebase when CI is green",
			at: new Date(Date.now() + 60_000).toISOString(),
			origin: "user",
		});
		const stored = (queued.scheduledMessages ?? [])[0]! as ScheduledMessage;
		expect(stored.origin).toBe("user");

		const fired = { ...stored, at: new Date(Date.now() - 1_000).toISOString() };
		await fireScheduledMessage(project, makeTask({ scheduledMessages: [fired] }), fired, { late: true });

		const { rows } = readAgentMessageLog(project);
		expect(rows[0]).toMatchObject({ origin: "user", kind: "scheduled", scheduledFor: fired.at });
	});

	it("writes exactly one row per submission", async () => {
		await sendMessageImmediately(makeTask(), "one click", null, null, { origin: "user" });
		const { rows } = readAgentMessageLog(project);
		expect(rows.filter((row) => isUserOrigin(row))).toHaveLength(1);
	});
});

describe("a send nobody could attribute to the user", () => {
	it("leaves a peer agent's message unmarked", async () => {
		await sendMessageImmediately(makeTask(), "shard 3 is green", null, source);
		const { rows } = readAgentMessageLog(project);
		expect(rows[0]?.origin).toBeUndefined();
		expect(isUserOrigin(rows[0]!)).toBe(false);
	});

	it("leaves a sender-less send unmarked rather than guessing", async () => {
		// This is the artifact form submit, the dev3 hand-off and a `dev3 message`
		// run outside a worktree — all of them reach this exact call shape.
		await sendMessageImmediately(makeTask(), "rebase finished", null, null);
		const { rows } = readAgentMessageLog(project);
		expect(rows[0]).toMatchObject({ fromTaskId: null, fromSeq: null });
		expect(rows[0]?.origin).toBeUndefined();
		expect(isUserOrigin(rows[0]!)).toBe(false);
	});

	it("leaves an unmarked queued fire unmarked after the delay too", async () => {
		const at = new Date(Date.now() - 1_000).toISOString();
		const message = { id: "m-1", text: "wake up", at, target: { kind: "agent" as const }, source };
		await fireScheduledMessage(project, makeTask({ scheduledMessages: [message] }), message, { late: true });
		const { rows } = readAgentMessageLog(project);
		expect(rows[0]?.origin).toBeUndefined();
	});

	it("keeps the origin off an attempt that landed nowhere, without losing the verdict", async () => {
		// A drop is still recorded, and a dropped user message is still the user's:
		// origin describes who wrote it, never whether it arrived.
		const message = { id: "m-2", text: "too late", at: new Date().toISOString(), target: { kind: "agent" as const }, origin: "user" as const };
		await fireScheduledMessage(project, makeTask({ status: "completed" }), message, { late: false });
		const { rows } = readAgentMessageLog(project);
		expect(rows[0]).toMatchObject({ origin: "user", status: "not-delivered" });
	});
});
