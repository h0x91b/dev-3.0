/**
 * The two handlers that are allowed to claim a message was the user's.
 *
 * Provenance is only as honest as its call sites: the field means nothing if the
 * one handler that serves a click forgets to stamp it, or if a handler that
 * cannot prove anything stamps it anyway. So these cases drive the real handlers
 * and read the argument the scheduler was actually called with.
 *
 * The scheduler itself is mocked here on purpose — the disk-level behaviour is
 * covered in `agent-message-origin.test.ts`, and what is at stake here is only
 * what each handler asks for.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../scheduled-message-scheduler", () => ({
	sendMessageImmediately: vi.fn(async () => ({ status: "delivered", spilledPath: null })),
	scheduleMessage: vi.fn(async () => task),
	cancelScheduledMessage: vi.fn(),
	sendScheduledMessageNow: vi.fn(),
}));
vi.mock("../data", () => ({
	getProject: vi.fn(async () => project),
	getTask: vi.fn(async () => task),
	loadProjects: vi.fn(async () => [project]),
	loadVirtualProjects: vi.fn(async () => []),
	loadTasks: vi.fn(async () => [task]),
}));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../github", () => ({}));
// git-operations reaches Electrobun through the terminal and lifecycle layers,
// neither of which this file exercises. Stubbed at the widest points rather than
// leaf by leaf, so the mock wall does not have to track their internals.
vi.mock("../tmux", () => ({ DEFAULT_TMUX_SOCKET: "dev3", tmux: {} }));
vi.mock("../task-aux-panes", () => ({ auxPaneAlive: vi.fn(), auxPaneTitle: vi.fn(), openAuxPane: vi.fn() }));
vi.mock("../lifecycle/service", () => ({ lifecycleActorRuntime: {} }));
vi.mock("../agent-prompt-delivery", () => ({ deliverAgentPrompt: vi.fn() }));
// The handler barrel's shared module pulls in Electrobun, which cannot start a
// socket server in a test process — stubbed down to the one thing they use.
vi.mock("../rpc-handlers/shared", () => ({
	log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { Project, Task } from "../../shared/types";
import { prCommentsHandlers } from "../rpc-handlers/pr-comments";
import { artifactMessageHandlers } from "../rpc-handlers/artifact-messages";
import { gitOperationHandlers } from "../rpc-handlers/git-operations";
import { scheduleMessage, sendMessageImmediately } from "../scheduled-message-scheduler";

const project = { id: "proj-1", name: "Proj", path: "/Users/x/repo" } as unknown as Project;
const task = { id: "task-1", projectId: "proj-1", seq: 7, title: "Worker", status: "in-progress" } as unknown as Task;

beforeEach(() => {
	vi.mocked(sendMessageImmediately).mockClear();
});

describe("the Send to agent button", () => {
	it("claims the user as the origin", async () => {
		await prCommentsHandlers.sendAgentMessageNow({ taskId: "task-1", projectId: "proj-1", text: "fix this thread" });

		const [, , , source, opts] = vi.mocked(sendMessageImmediately).mock.calls[0]!;
		expect(opts).toMatchObject({ origin: "user" });
		// The user is not an agent: the row must still have no sender task.
		expect(source).toBeNull();
	});
});

describe("the Send later modal", () => {
	it("claims the user at queue time, not at fire time", async () => {
		await gitOperationHandlers.scheduleMessage({
			taskId: "task-1",
			projectId: "proj-1",
			at: new Date(Date.now() + 60_000).toISOString(),
			text: "rebase in an hour",
			target: { kind: "agent" },
		});

		const [, , input] = vi.mocked(scheduleMessage).mock.calls[0]!;
		expect(input).toMatchObject({ origin: "user" });
	});
});

describe("a form inside a published artifact", () => {
	it("claims nothing, because the submitter may be anyone the link reached", async () => {
		await artifactMessageHandlers.sendArtifactMessageToAgent({
			taskId: "task-1",
			text: "looks wrong on page 2",
			artifactTitle: "Shard report",
			version: 2,
			versionCount: 3,
		});

		const [, , , , opts] = vi.mocked(sendMessageImmediately).mock.calls[0]!;
		expect(opts?.origin).toBeUndefined();
	});
});
