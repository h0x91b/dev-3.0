import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../shared/types";
import { mainAgentNeverStarted } from "../../shared/agent-launch-failure";

vi.mock("../data", () => ({ updateTaskWith: vi.fn() }));

import * as data from "../data";
import { tmux } from "../tmux";
import { noteAgentLaunched, resetAgentSessionRecordsForTests } from "../agent-session-receipts";
import { recordLaunchFailure, trimLaunchFailureOutput } from "../agent-launch-failure";

const failure = { exitCode: 2, at: "t", output: null, neverStarted: true, sessionId: "dead-1" };
const withPane = (sessionId: string | null, launchFailure: Task["launchFailure"] = failure) =>
	({ launchFailure, sessionState: { panes: [{ agentCmd: "claude", sessionId, agentId: null, configId: null }] } }) as unknown as Task;

describe("the never-started rule", () => {
	it("holds when the main pane still points at the failed launch, or has no conversation id", () => {
		expect(mainAgentNeverStarted(withPane("dead-1")), "failed launch").toBe(true);
		expect(mainAgentNeverStarted(withPane(null))).toBe(true);
		expect(mainAgentNeverStarted({ launchFailure: failure } as Task)).toBe(true);
	});

	it("does not hold once the main pane carries another conversation, for a crash of a started agent, or without a failure", () => {
		expect(mainAgentNeverStarted(withPane("later-session")), "another conversation").toBe(false);
		expect(mainAgentNeverStarted(withPane("dead-1", { ...failure, neverStarted: false }))).toBe(false);
		expect(mainAgentNeverStarted({ ...withPane("dead-1"), launchFailure: undefined })).toBe(false);
	});
});

describe("the captured output", () => {
	it("drops the run script's own Starting line and keeps the last 40 lines; null when only the banner was printed", () => {
		expect(trimLaunchFailureOutput("Starting: claude\n\n"), "banner only").toBeNull();
		const raw = ["Starting: claude --very-long-command", ...Array.from({ length: 50 }, (_, i) => `line ${i}`), "", ""].join("\n");
		const lines = trimLaunchFailureOutput(raw)?.split("\n");
		expect(lines).toHaveLength(40);
		expect(lines?.[0]).toBe("line 10");
		expect(lines?.[lines.length - 1]).toBe("line 49");
	});


	it("is captured with wrapped lines joined", async () => {
		const capture = vi.spyOn(tmux, "capturePane").mockResolvedValue("");
		noteAgentLaunched("task", "dead-1", { startReceipts: true });
		vi.mocked(data.updateTaskWith).mockResolvedValue({ task: {} as Task, result: false } as never);
		await recordLaunchFailure({ id: "p" } as Project, { id: "task" } as Task, { exitCode: 1, sessionId: "dead-1", neverStarted: true }, vi.fn());
		expect(capture).toHaveBeenCalledWith(expect.objectContaining({ joinWrapped: true }));
	});
});

describe("a failure report that outlived its launch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetAgentSessionRecordsForTests();
		vi.spyOn(tmux, "capturePane").mockResolvedValue("boom");
		vi.mocked(data.updateTaskWith).mockImplementation((async (_p: unknown, _id: string, mutator: (t: Task) => { updates: Partial<Task>; result: boolean }) => {
			const { updates, result } = mutator({ id: "task" } as Task);
			return { task: { id: "task", ...updates }, result };
		}) as never);
	});

	const record = (push: (payload: unknown) => void) =>
		recordLaunchFailure({ id: "p" } as Project, { id: "task" } as Task, { exitCode: 1, sessionId: "old-launch", neverStarted: true }, push);
	const written = () => (vi.mocked(data.updateTaskWith).mock.results[0]?.value as Promise<{ task: Task }>)?.then((r) => r.task.launchFailure);

	it("is written while its launch is the task's latest", async () => {
		noteAgentLaunched("task", "old-launch", { startReceipts: true });
		const push = vi.fn();
		await record(push);
		expect(await written()).toMatchObject({ output: "boom", sessionId: "old-launch" });
		expect(push).toHaveBeenCalledTimes(1);
	});

	it("is not written once a newer launch started during the capture", async () => {
		noteAgentLaunched("task", "old-launch", { startReceipts: true });
		vi.spyOn(tmux, "capturePane").mockImplementation(async () => {
			noteAgentLaunched("task", "new-launch", { startReceipts: true });
			return "boom";
		});
		const push = vi.fn();
		await record(push);
		expect(await written()).toBeUndefined();
		expect(push).not.toHaveBeenCalled();
	});
});
