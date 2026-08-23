/**
 * The log is only worth anything if a real send writes to it. These cases drive
 * the two public entry points — the immediate `dev3 message` send and a queued
 * "Send later" fire — and then read the file back off a real (redirected) disk.
 * Nothing here asserts against the writer directly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

const home = vi.hoisted(() => require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/dev3-msglog-cs-`) as string);
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
	updateTaskWith: vi.fn(async (_p: unknown, _id: unknown, mutator: (t: unknown) => unknown) => {
		await mutator(makeTask());
		return { task: makeTask(), result: undefined };
	}),
}));
vi.mock("../agent-prompt", () => ({
	sendPromptToAgentPane: vi.fn(async () => true),
	sendPromptToPane: vi.fn(async () => true),
	// A message is held, never typed on arrival — the two the message paths use.
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

import type { Project, Task } from "../../shared/types";
import { messageLogDir, readAgentMessageLog, resetAgentMessageLogPruneState } from "../agent-message-log";
import { fireScheduledMessage, sendMessageImmediately } from "../scheduled-message-scheduler";

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

const source = { taskId: "coordinator-task", seq: 1141, title: "Coordinator", projectId: "proj-1" };

beforeEach(() => {
	resetAgentMessageLogPruneState();
	rmSync(messageLogDir(project), { recursive: true, force: true });
});

describe("an immediate send", () => {
	it("writes one row naming both ends and the outcome", async () => {
		await sendMessageImmediately(makeTask(), "check CI and continue", null, source);

		const { rows } = readAgentMessageLog(project);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			fromTaskId: "coordinator-task",
			fromSeq: 1141,
			fromTitle: "Coordinator",
			toTaskId: "task-12345678",
			toSeq: 1650,
			toTitle: "Worker",
			toProjectId: "proj-1",
			kind: "immediate",
			// The body as the sender wrote it, not the pseudo-XML envelope it travels in.
			body: "check CI and continue",
			bodyKind: "text",
		});
		// A message is held on arrival, so that is the outcome the row records — the
		// log carries the real verdict, never the intent.
		expect(["delivered", "held", "unconfirmed"]).toContain(rows[0]?.status);
	});

	it("records a message with no agent sender as having none", async () => {
		await sendMessageImmediately(makeTask(), "rebase finished", null, null);
		const { rows } = readAgentMessageLog(project);
		expect(rows[0]).toMatchObject({ fromTaskId: null, fromSeq: null, toSeq: 1650 });
	});

	it("marks an oversized body as a pointer and keeps the file path", async () => {
		await sendMessageImmediately(makeTask(), "y".repeat(5_000), null, source);
		const { rows } = readAgentMessageLog(project);
		expect(rows[0]?.bodyKind).toBe("spill-pointer");
		expect(rows[0]?.spillPath).toContain("/messages/message-");
		// The row carries the pointer the pane got, not the 5 KB body.
		expect(rows[0]?.body).toContain("too large to type");
	});
});

describe("a queued fire", () => {
	it("writes a scheduled row carrying the time it was queued for", async () => {
		const at = new Date(Date.now() - 1000).toISOString();
		const message = { id: "msg-1", text: "wake up", at, target: { kind: "agent" as const }, source };
		await fireScheduledMessage(project, makeTask({ scheduledMessages: [message] }), message, { late: true });

		const { rows } = readAgentMessageLog(project);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: "scheduled", scheduledFor: at, body: "wake up", fromSeq: 1141 });
	});

	it("records an attempt that landed nowhere rather than staying silent", async () => {
		const message = { id: "msg-2", text: "too late", at: new Date().toISOString(), target: { kind: "agent" as const }, source };
		// A finished task has no live agent: nothing is delivered, and that is the
		// exact state a user reconstructing a silence needs to find in the log.
		await fireScheduledMessage(project, makeTask({ status: "completed" }), message, { late: false });

		const { rows } = readAgentMessageLog(project);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ status: "not-delivered", body: "too late", toSeq: 1650 });
	});
});
