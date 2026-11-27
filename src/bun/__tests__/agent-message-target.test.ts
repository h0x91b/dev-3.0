import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent-prompt-native", () => ({ NATIVE_AGENT_PANE_ID: "pane-1" }));
vi.mock("../native-task-panes", () => ({ nativeTaskPanesState: vi.fn() }));
vi.mock("../native-agent-attribution", () => ({ listNativeTaskAgents: vi.fn() }));
vi.mock("../scheduled-message-author", () => ({
	liveAgentPaneIds: vi.fn(),
	readPaneAgentIdentity: vi.fn(),
	resolveScheduledMessageAuthorPane: vi.fn(),
}));
vi.mock("../task-aux-panes", () => ({ findAuxPanes: vi.fn() }));
vi.mock("../task-terminal-backend", () => ({
	taskTerminalBackendIdentity: (task: { terminalBackend?: string }) => (task.terminalBackend === "native" ? "native" : "tmux"),
}));
vi.mock("../tmux", () => ({
	DEFAULT_TMUX_SOCKET: "dev3",
	PANE_ID_FORMAT: { sentinel: "pane-id-format" },
	taskSessionName: (id: string) => `dev3-${id}`,
	tmux: { listPanes: vi.fn(), activePaneId: vi.fn(), showOption: vi.fn() },
}));

import { listNativeTaskAgents } from "../native-agent-attribution";
import { nativeTaskPanesState } from "../native-task-panes";
import { liveAgentPaneIds, readPaneAgentIdentity, resolveScheduledMessageAuthorPane } from "../scheduled-message-author";
import { findAuxPanes } from "../task-aux-panes";
import { tmux } from "../tmux";
import {
	addressedAgentRefusal,
	agentPaneRoles,
	isSoleMainAgent,
	mainAgentPaneId,
	resolveMainAgentTarget,
	withAgentPanes,
} from "../agent-message-target";
import { decodeAgentHandle } from "../../shared/agent-handle";
import type { PaneRunListing, PaneRunPaneLine } from "../../shared/pane-runs";
import type { PaneSessionEntry, ScheduledMessageAuthor, Task } from "../../shared/types";

function entry(paneId: string | null): PaneSessionEntry {
	return { paneId, agentCmd: "claude", sessionId: null, agentId: null, configId: null };
}

/** Main agent in %1, a `+ Agent` extra in %2, the AI Review agent in %3, a shell split in %4. */
function task(panes: PaneSessionEntry[] | null = [entry("%1"), entry("%2")], extra: Partial<Task> = {}): Task {
	return { id: "task-1234abcd", projectId: "p", ...(panes ? { sessionState: { panes } } : {}), ...extra } as unknown as Task;
}

function author(paneId: string, pid = 101): ScheduledMessageAuthor {
	return { paneId, sessionId: null, paneToken: "gen-1", agentProcess: `${pid}@Mon Oct 26 09:00:00 2026` };
}

let live: string[];

beforeEach(() => {
	vi.clearAllMocks();
	live = ["%1", "%2", "%3", "%4"];
	vi.mocked(tmux.listPanes).mockImplementation(async () => live.map((paneId) => ({ paneId })) as never);
	vi.mocked(findAuxPanes).mockImplementation(async () => (live.includes("%3") ? [{ backend: "tmux", paneId: "%3" }] : []) as never);
	vi.mocked(readPaneAgentIdentity).mockImplementation(async (_t, paneId) => ({ ok: true, author: author(paneId) }));
	vi.mocked(nativeTaskPanesState).mockResolvedValue(null);
	vi.mocked(listNativeTaskAgents).mockResolvedValue([]);
});

describe("resolveMainAgentTarget — where a task-addressed message goes", () => {
	it("is the task's own agent, bound to its process, whichever pane has focus", async () => {
		await expect(resolveMainAgentTarget(task())).resolves.toEqual({ ok: true, paneId: "%1", author: author("%1") });
		// Focus is never consulted: that is the behaviour #1809 removes for messages.
		expect(tmux.activePaneId).not.toHaveBeenCalled();
		expect(tmux.showOption).not.toHaveBeenCalled();
	});

	it("refuses when the main agent exited, naming who is still running instead of picking one", async () => {
		vi.mocked(readPaneAgentIdentity).mockResolvedValueOnce({ ok: false, reason: "no-agent", detail: "the agent in pane %1 has exited" });
		const target = await resolveMainAgentTarget(task());
		expect(target.ok).toBe(false);
		if (target.ok) return;
		expect(target.detail).toContain("the task's main agent has exited (the agent in pane %1 has exited); not sent to another agent.");
		expect(target.detail).toContain("pane %2 (agent), pane %3 (review)");
		expect(target.detail).not.toContain("%4");
		expect(target.detail).toContain("--agent <handle> from `dev3 pane list --task task-123`");
	});

	it("refuses when the main agent's pane is gone, even if it is the only extra left", async () => {
		live = ["%2"];
		const target = await resolveMainAgentTarget(task());
		expect(target).toMatchObject({ ok: false, detail: expect.stringContaining("the task's main agent (pane %1) is not running") });
		expect(readPaneAgentIdentity).not.toHaveBeenCalled();
	});

	it("still delivers to the main agent's pane, unbound, when its agent cannot be verified", async () => {
		vi.mocked(readPaneAgentIdentity).mockResolvedValueOnce({ ok: false, reason: "unknown", detail: "the process table could not be read" });
		await expect(resolveMainAgentTarget(task())).resolves.toEqual({ ok: true, paneId: "%1", author: null });
		vi.mocked(readPaneAgentIdentity).mockResolvedValueOnce({ ok: false, reason: "unsupported", detail: "windows" });
		await expect(resolveMainAgentTarget(task())).resolves.toEqual({ ok: true, paneId: "%1", author: null });
	});

	it("uses the oldest tmux pane without a registry, even after a swap reorders the list, and refuses with no live pane", async () => {
		live = ["%7", "%8"];
		await expect(resolveMainAgentTarget(task(null)), "legacy task").resolves.toMatchObject({ ok: true, paneId: "%7" });
		await expect(resolveMainAgentTarget(task([entry(null), entry("%8")])), "first entry without a pane id").resolves.toMatchObject({ ok: true, paneId: "%7" });

		// swap-pane turns `0 %7, 1 %8` into `0 %8, 1 %7`; pane ids stay, and %10 sorts after %9.
		live = ["%10", "%8", "%9"];
		expect(mainAgentPaneId(task(null), live)).toBe("%8");
		await expect(resolveMainAgentTarget(task(null)), "after a swap").resolves.toMatchObject({ ok: true, paneId: "%8" });

		live = [];
		await expect(resolveMainAgentTarget(task(null)), "no live pane").resolves.toMatchObject({ ok: false, detail: expect.stringContaining("is not running") });
	});

	it("is pane-1 on native, and refuses when that pane is not alive", async () => {
		vi.mocked(nativeTaskPanesState).mockResolvedValue({ panes: [{ paneId: "pane-1", alive: true }, { paneId: "pane-2", alive: true }] } as never);
		const native = task(null, { terminalBackend: "native" } as Partial<Task>);
		await expect(resolveMainAgentTarget(native)).resolves.toEqual({ ok: true, paneId: "pane-1", author: author("pane-1") });
		vi.mocked(nativeTaskPanesState).mockResolvedValue({ panes: [{ paneId: "pane-1", alive: false }, { paneId: "pane-2", alive: true }] } as never);
		await expect(resolveMainAgentTarget(native)).resolves.toMatchObject({ ok: false, detail: expect.stringContaining("pane pane-1") });
	});
});

describe("native extra agents (sidecar panes)", () => {
	const native = () => task(null, { terminalBackend: "native" } as Partial<Task>);
	const extra = { paneId: "pane-2", agentCmd: "claude", agentId: null, configId: null, shellPid: 2 };

	it("marks sidecar panes as agents and gives them an agent handle", async () => {
		vi.mocked(listNativeTaskAgents).mockResolvedValue([extra]);
		expect((await agentPaneRoles(native())).get("pane-2")).toBe("agent");
		const listing = { backend: "native", screenReadable: true, screenReadableDetail: "", selfPaneId: null, runs: [],
			panes: [{ paneId: "pane-2", index: 2, label: "", active: false, self: false, alive: true, runId: null }] } as PaneRunListing;
		const out = await withAgentPanes(native(), listing);
		expect(out.panes[0]).toMatchObject({ agentRole: "agent" });
		expect(decodeAgentHandle(out.panes[0]!.agentHandle!)).toEqual(author("pane-2"));
	});

	it("the refusal names the extra agent when the main agent is gone", async () => {
		vi.mocked(listNativeTaskAgents).mockResolvedValue([extra]);
		vi.mocked(nativeTaskPanesState).mockResolvedValue({ panes: [{ paneId: "pane-1", alive: false }, { paneId: "pane-2", alive: true }] } as never);
		await expect(resolveMainAgentTarget(native())).resolves.toMatchObject({
			ok: false,
			detail: expect.stringContaining("pane pane-2 (agent)"),
		});
	});
});

describe("agentPaneRoles", () => {
	it("labels the main agent, the extras and the unregistered AI Review agent, never relabelling a registered agent as reviewer", async () => {
		expect([...(await agentPaneRoles(task()))]).toEqual([["%1", "main"], ["%2", "agent"], ["%3", "review"]]);
		vi.mocked(findAuxPanes).mockResolvedValue([{ backend: "tmux", paneId: "%2" }] as never);
		expect((await agentPaneRoles(task())).get("%2")).toBe("agent");
	});
});

describe("agentPaneRoles — the main flag", () => {
	it("keeps main on the flagged entry once the main pane is gone, instead of promoting the entry now at index 0", async () => {
		const parkedMain = { ...entry(null), main: true, parked: true };
		await expect([...(await agentPaneRoles(task([{ ...entry("%2"), main: false }, parkedMain])))]).toEqual([["%2", "agent"], ["%3", "review"]]);
		const flagged = task([{ ...entry("%2"), main: false }, { ...entry("%1"), main: true }]);
		expect((await agentPaneRoles(flagged)).get("%1")).toBe("main");
		expect((await agentPaneRoles(flagged)).get("%2")).toBe("agent");
	});

	it("falls back to index 0 when no entry carries the flag", async () => {
		expect((await agentPaneRoles(task([entry("%1"), entry("%2")]))).get("%1")).toBe("main");
	});
});

describe("withAgentPanes — what `dev3 pane list` adds", () => {
	const line = (paneId: string, index: number, alive: boolean | null = null): PaneRunPaneLine =>
		({ paneId, index, label: "", active: false, self: false, alive, runId: null });
	const listing = (panes: PaneRunPaneLine[]): PaneRunListing =>
		({ backend: "tmux", screenReadable: true, screenReadableDetail: "", selfPaneId: null, panes, runs: [] });

	it("gives each live agent pane its role and a handle that decodes to that agent", async () => {
		const out = await withAgentPanes(task(), listing([line("%1", 1), line("%3", 3), line("%4", 4)]));
		expect(out.panes[0]).toMatchObject({ agentRole: "main" });
		expect(decodeAgentHandle(out.panes[0]!.agentHandle!)).toEqual(author("%1"));
		expect(out.panes[1]).toMatchObject({ agentRole: "review" });
		expect(decodeAgentHandle(out.panes[1]!.agentHandle!)).toEqual(author("%3"));
		expect(out.panes[2]).toEqual(line("%4", 4));
	});

	it("says why an agent pane has no handle, and asks nothing of a dead pane", async () => {
		vi.mocked(readPaneAgentIdentity).mockResolvedValueOnce({ ok: false, reason: "no-agent", detail: "the agent in pane %1 has exited" });
		const out = await withAgentPanes(task(), listing([line("%1", 1), line("%2", 2, false)]));
		expect(out.panes[0]).toMatchObject({ agentRole: "main", agentHandleUnavailable: "the agent in pane %1 has exited" });
		expect(out.panes[0]).not.toHaveProperty("agentHandle");
		expect(out.panes[1]).toEqual({ ...line("%2", 2, false), agentRole: "agent" });
		expect(readPaneAgentIdentity).toHaveBeenCalledTimes(1);
	});
});

describe("addressedAgentRefusal — asked again at release", () => {
	it("is null while that agent is still in the pane, and refuses once it is gone or moved", async () => {
		vi.mocked(resolveScheduledMessageAuthorPane).mockResolvedValueOnce({ ok: true, paneId: "%3" });
		await expect(addressedAgentRefusal(task(), author("%3"), "%3"), "still there").resolves.toBeNull();
		vi.mocked(resolveScheduledMessageAuthorPane).mockResolvedValueOnce({ ok: false, detail: "the addressed agent (pane %3) is no longer running" });
		await expect(addressedAgentRefusal(task(), author("%3"), "%3"), "gone").resolves.toBe("the addressed agent (pane %3) is no longer running");
		vi.mocked(resolveScheduledMessageAuthorPane).mockResolvedValueOnce({ ok: true, paneId: "%9" });
		await expect(addressedAgentRefusal(task(), author("%3"), "%3"), "moved").resolves.toContain("moved to pane %9");
	});
});

describe("isSoleMainAgent — may a reply to this agent drop --agent?", () => {
	beforeEach(() => {
		live = ["%1", "%4"];
		vi.mocked(liveAgentPaneIds).mockResolvedValue(["%1"]);
		vi.mocked(resolveScheduledMessageAuthorPane).mockResolvedValue({ ok: true, paneId: "%1" });
	});

	it("yes for the main agent alone, a shell split beside it not counting", async () => {
		await expect(isSoleMainAgent(task([entry("%1")]), author("%1"))).resolves.toBe(true);
	});

	it("no while another agent runs, or for a lone extra or reviewer (a task-addressed reply would reach the main agent)", async () => {
		vi.mocked(liveAgentPaneIds).mockResolvedValue(["%1", "%2"]);
		await expect(isSoleMainAgent(task(), author("%1")), "extra agent beside").resolves.toBe(false);
		vi.mocked(liveAgentPaneIds).mockResolvedValue(["%1"]);
		live = ["%1", "%3"];
		await expect(isSoleMainAgent(task([entry("%1")]), author("%1")), "reviewer beside").resolves.toBe(false);

		vi.mocked(liveAgentPaneIds).mockResolvedValue(["%2"]);
		vi.mocked(resolveScheduledMessageAuthorPane).mockResolvedValue({ ok: true, paneId: "%2" });
		await expect(isSoleMainAgent(task(), author("%2")), "lone extra").resolves.toBe(false);
		vi.mocked(liveAgentPaneIds).mockResolvedValue([]);
		await expect(isSoleMainAgent(task([entry("%1")]), author("%3")), "lone reviewer").resolves.toBe(false);
	});

	it("no when the main pane now runs another agent, or the agents cannot be counted", async () => {
		vi.mocked(resolveScheduledMessageAuthorPane).mockResolvedValueOnce({ ok: false, detail: "gone" });
		await expect(isSoleMainAgent(task([entry("%1")]), author("%1")), "another agent").resolves.toBe(false);
		vi.mocked(liveAgentPaneIds).mockResolvedValueOnce(null);
		await expect(isSoleMainAgent(task([entry("%1")]), author("%1")), "uncountable").resolves.toBe(false);
		vi.mocked(findAuxPanes).mockRejectedValue(new Error("tmux down"));
		await expect(isSoleMainAgent(task([entry("%1")]), author("%1")), "tmux down").resolves.toBe(false);
	});

	it("on native: yes for pane-1 alone, no beside a second agent pane", async () => {
		const native = task(null, { terminalBackend: "native" } as Partial<Task>);
		vi.mocked(liveAgentPaneIds).mockResolvedValue(["pane-1"]);
		vi.mocked(resolveScheduledMessageAuthorPane).mockResolvedValue({ ok: true, paneId: "pane-1" });
		await expect(isSoleMainAgent(native, author("pane-1"))).resolves.toBe(true);
		vi.mocked(liveAgentPaneIds).mockResolvedValue(["pane-1", "pane-2"]);
		await expect(isSoleMainAgent(native, author("pane-1"))).resolves.toBe(false);
	});
});
