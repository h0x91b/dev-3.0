import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../shared/types";

const H = vi.hoisted(() => ({
	stored: new Map<string, Record<string, unknown>>(),
	push: vi.fn(),
}));

vi.mock("../data", () => ({
	loadProjects: vi.fn(async () => [{ id: "p1", name: "P", path: "/x/repo" }]),
	loadVirtualProjects: vi.fn(async () => []),
	loadTasks: vi.fn(async () => [...H.stored.values()]),
	// Runs the mutator against the stored row, like the real read-modify-write under the lock.
	updateTaskWith: vi.fn(async (_project: unknown, id: string, mutator: (t: unknown) => { updates: Record<string, unknown> }) => {
		const current = H.stored.get(id)!;
		const { updates } = mutator(current);
		const next = { ...current, ...updates };
		H.stored.set(id, next);
		return { task: next, result: null };
	}),
}));
vi.mock("../scheduled-message-author", () => ({
	taskMainAgentLiveness: vi.fn(async () => "exited"),
	processTable: vi.fn(async () => ({ parentOf: new Map(), childrenOf: new Map(), cmdlines: new Map() })),
}));
vi.mock("../rpc-handlers", () => ({ getPushMessage: vi.fn(() => H.push) }));
vi.mock("../logger", () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import * as data from "../data";
import { processTable, taskMainAgentLiveness } from "../scheduled-message-author";
import { agentExitDecision, applyDecision, isAgentExitCandidate, startAgentExitProbe, stopAgentExitProbe } from "../agent-exit-probe";

const project = { id: "p1", name: "P", path: "/x/repo" } as never;
const FLAG = "2026-11-13T10:00:00.000Z";

function task(over: Partial<Task> = {}): Task {
	return {
		id: "t1",
		seq: 1,
		title: "T",
		status: "in-progress",
		worktreePath: "/wt/t1",
		sessionState: { panes: [{ paneId: "%1", agentCmd: "claude" }] },
		...over,
	} as unknown as Task;
}

beforeEach(() => {
	H.stored.clear();
	H.push.mockClear();
	vi.mocked(data.updateTaskWith).mockClear();
	vi.mocked(processTable).mockClear();
	vi.mocked(taskMainAgentLiveness).mockReset();
});
afterEach(() => stopAgentExitProbe());

describe("agentExitDecision", () => {
	it("marks a candidate whose agent exited", () => {
		expect(agentExitDecision(task(), "exited")).toBe("mark");
	});

	it("keeps an existing mark while the agent stays exited", () => {
		expect(agentExitDecision(task({ agentExitedAt: FLAG }), "exited")).toBe("keep");
	});

	it("clears the mark once the agent runs again", () => {
		expect(agentExitDecision(task({ agentExitedAt: FLAG }), "alive")).toBe("clear");
	});

	it("leaves a running task unmarked", () => {
		expect(agentExitDecision(task(), "alive")).toBe("keep");
	});

	it("never changes anything on unknown", () => {
		expect(agentExitDecision(task(), "unknown")).toBe("keep");
		expect(agentExitDecision(task({ agentExitedAt: FLAG }), "unknown")).toBe("keep");
	});

	it.each([
		["hibernated", { hibernated: true }],
		["no longer active", { status: "completed" as const }],
		["runtime idle", { runtimeState: { runtime: "idle", updatedAt: 1 } }],
		["draft", { draft: true }],
		["preparing", { preparing: true }],
		["shutting down", { shuttingDown: true }],
		["no worktree", { worktreePath: null }],
		["no saved panes", { sessionState: { panes: [] } }],
	] as Array<[string, Partial<Task>]>)("clears a stale mark on a non-candidate (%s), even on an exited verdict", (_name, over) => {
		const t = task({ agentExitedAt: FLAG, ...over });
		expect(isAgentExitCandidate(t)).toBe(false);
		expect(agentExitDecision(t, "exited")).toBe("clear");
		expect(agentExitDecision(t, null)).toBe("clear");
	});

	it("does nothing for a non-candidate without a mark", () => {
		expect(agentExitDecision(task({ hibernated: true }), null)).toBe("keep");
	});
});

describe("applyDecision", () => {
	it("writes the mark and pushes the update", async () => {
		H.stored.set("t1", task() as never);
		await applyDecision(project, task(), "exited");
		expect(H.stored.get("t1")?.agentExitedAt).toEqual(expect.any(String));
		expect(H.push).toHaveBeenCalledWith("taskUpdated", expect.objectContaining({ projectId: "p1" }));
	});

	it("removes the mark when the agent is alive again", async () => {
		H.stored.set("t1", task({ agentExitedAt: FLAG }) as never);
		await applyDecision(project, task({ agentExitedAt: FLAG }), "alive");
		expect(H.stored.get("t1")?.agentExitedAt).toBeUndefined();
		expect(H.push).toHaveBeenCalledTimes(1);
	});

	it("does not mark when the fresh row's main pane differs from the probed one", async () => {
		// A restart gave the task a new tmux pane id after the probe read the old one.
		H.stored.set("t1", task({ sessionState: { panes: [{ paneId: "%9", agentCmd: "claude" }] } as never }) as never);
		await applyDecision(project, task(), "exited");
		expect(H.stored.get("t1")?.agentExitedAt).toBeUndefined();
		expect(H.push).not.toHaveBeenCalled();
	});

	it("clears without comparing panes", async () => {
		const fresh = task({ agentExitedAt: FLAG, sessionState: { panes: [{ paneId: "%9", agentCmd: "claude" }] } as never });
		H.stored.set("t1", fresh as never);
		await applyDecision(project, task({ agentExitedAt: FLAG }), "alive");
		expect(H.stored.get("t1")?.agentExitedAt).toBeUndefined();
	});

	it("writes and pushes nothing when the fresh task needs no change", async () => {
		// The stale copy said "mark"; the fresh row was hibernated meanwhile.
		H.stored.set("t1", task({ hibernated: true }) as never);
		await applyDecision(project, task(), "exited");
		expect(H.stored.get("t1")?.agentExitedAt).toBeUndefined();
		expect(H.push).not.toHaveBeenCalled();
	});
});

describe("probe tick", () => {
	it.skipIf(process.platform === "win32")("never asks for liveness of a non-candidate", async () => {
		H.stored.set("t1", task({ id: "t1", hibernated: true }) as never);
		H.stored.set("t2", task({ id: "t2", status: "completed" }) as never);
		H.stored.set("t3", task({ id: "t3", runtimeState: { runtime: "idle", updatedAt: 1 } as never }) as never);
		H.stored.set("t4", task({ id: "t4", sessionState: { panes: [] } as never }) as never);
		startAgentExitProbe();
		await vi.waitFor(() => expect(data.loadTasks).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 20));
		expect(taskMainAgentLiveness).not.toHaveBeenCalled();
		expect(processTable).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform === "win32")("builds one process table for the pass and marks only exited tasks", async () => {
		H.stored.set("t1", task({ id: "t1" }) as never);
		H.stored.set("t2", task({ id: "t2" }) as never);
		H.stored.set("t3", task({ id: "t3" }) as never);
		vi.mocked(taskMainAgentLiveness).mockImplementation(async (t) => (t.id === "t1" ? "exited" : t.id === "t2" ? "alive" : "unknown"));
		startAgentExitProbe();
		await vi.waitFor(() => expect(H.stored.get("t1")?.agentExitedAt).toBeDefined());
		await vi.waitFor(() => expect(taskMainAgentLiveness).toHaveBeenCalledTimes(3));
		expect(processTable).toHaveBeenCalledTimes(1);
		const shared = await vi.mocked(processTable).mock.results[0].value;
		for (const call of vi.mocked(taskMainAgentLiveness).mock.calls) expect(call[1]).toBe(shared);
		expect(H.stored.get("t2")?.agentExitedAt).toBeUndefined();
		expect(H.stored.get("t3")?.agentExitedAt).toBeUndefined();
		expect(data.updateTaskWith).toHaveBeenCalledTimes(1);
	});
});
