import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Task } from "../../shared/types";

const fixtures = vi.hoisted(() => ({ task: {} as Task }));
vi.mock("../cli-socket/task-resolution", () => ({
	resolveTaskFromParams: async () => ({ project: { id: "project" }, task: fixtures.task }),
}));
vi.mock("../rpc-handlers", () => ({
	moveTask: vi.fn(async (params) => {
		if (fixtures.task.status === params.ifStatus) fixtures.task = { ...fixtures.task, status: params.newStatus };
		return fixtures.task;
	}),
}));
vi.mock("../cli-socket/pane-sessions", () => ({ capturePaneSession: vi.fn(async () => {}) }));
vi.mock("../agent-terminal-prompt-log", () => ({ recordTerminalPromptSubmission: vi.fn(() => "suppressed") }));

import { agentHandlers } from "../cli-socket/agent-commands";
import { claudeSessionWatches } from "../claude-session-watch";
import { moveTask } from "../rpc-handlers";
import { recordTerminalPromptSubmission } from "../agent-terminal-prompt-log";

let directory: string;
let params: Record<string, unknown>;
let timestamp: number;
function state(status: string, extra = {}) {
	writeFileSync(join(directory, `${process.pid}.json`), JSON.stringify({
		pid: process.pid, startedAt: 1, sessionId: "session", cwd: directory,
		kind: "interactive", entrypoint: "cli", status, statusUpdatedAt: ++timestamp, ...extra,
	}));
}
async function prompt() { await agentHandlers["task.promptSubmitted"]!(params); }
async function idle() { state("idle"); await claudeSessionWatches.check("task", "%1"); }

beforeEach(() => {
	vi.clearAllMocks();
	directory = mkdtempSync(join(tmpdir(), "claude-interruption-"));
	timestamp = 10;
	fixtures.task = {
		id: "task", projectId: "project", status: "in-progress", worktreePath: directory,
		sessionState: { panes: [{ paneId: "%1", sessionId: "session", agentCmd: "claude", agentId: null, configId: null }] },
	} as Task;
	params = { taskId: "task", projectId: "project", harness: "claude", paneId: "%1", sessionId: "session", prompt: "fixture", sessionStateDirectory: directory };
	state("busy");
});
afterEach(() => { claudeSessionWatches.close(); rmSync(directory, { recursive: true, force: true }); });

describe("Claude interruption lifecycle", () => {
	it("leaves working after Escape without a Stop hook, and handles the next prompt", async () => {
		await prompt();
		await idle();
		expect(fixtures.task.status).toBe("user-questions");
		state("busy");
		await prompt();
		expect(fixtures.task.status).toBe("in-progress");
		await idle();
		expect(fixtures.task.status).toBe("user-questions");
		expect(moveTask).toHaveBeenCalledTimes(3);
	});

	it.each(["review-by-ai", "review-by-user"] as const)("preserves normal Stop's %s lane", async status => {
		await prompt();
		await agentHandlers["task.claudeTurnEnded"]!(params);
		fixtures.task.status = status;
		await idle();
		expect(fixtures.task.status).toBe(status);
		expect(moveTask).not.toHaveBeenCalled();
	});

	it("does not reclassify approval waits or a pending cancellation", async () => {
		await prompt();
		await claudeSessionWatches.check("task", "%1");
		expect(fixtures.task.status).toBe("in-progress");
		fixtures.task.status = "user-questions";
		await idle();
		expect(moveTask).not.toHaveBeenCalled();
	});

	it("observes agent-to-agent prompts without treating submission as interruption", async () => {
		params.prompt = "<dev3-ai-message>Fixture agent input</dev3-ai-message>";
		await prompt();
		expect(moveTask).not.toHaveBeenCalled();
		await agentHandlers["task.claudeTurnEnded"]!(params);
		await idle();
		expect(moveTask).not.toHaveBeenCalled();
	});

	it("does not park a task with another unobserved agent", async () => {
		fixtures.task.sessionState!.panes.push({ paneId: "native-pane-2", sessionId: "peer", agentCmd: "codex", agentId: null, configId: null });
		await prompt();
		await idle();
		expect(fixtures.task.status).toBe("in-progress");
	});

	it("accepts a native pane identity without tmux-specific parsing", async () => {
		params.paneId = "pane-1";
		fixtures.task.sessionState!.panes[0]!.paneId = "pane-1";
		await prompt();
		state("idle");
		await claudeSessionWatches.check("task", "pane-1");
		expect(fixtures.task.status).toBe("user-questions");
	});

	it("rejects an idle callback queued just before another prompt", async () => {
		await prompt();
		state("idle");
		const oldIdle = claudeSessionWatches.check("task", "%1");
		state("busy");
		await Promise.all([oldIdle, prompt()]);
		expect(fixtures.task.status).toBe("in-progress");
		expect(moveTask).not.toHaveBeenCalled();
	});

	it("starts working even if traffic recording fails", async () => {
		fixtures.task.status = "user-questions";
		vi.mocked(recordTerminalPromptSubmission).mockImplementationOnce(() => { throw new Error("fixture log failure"); });
		await expect(prompt()).rejects.toThrow("fixture log failure");
		expect(fixtures.task.status).toBe("in-progress");
	});
});
