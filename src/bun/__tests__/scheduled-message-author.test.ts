import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pane-input", () => ({ pinTaskPane: vi.fn() }));
vi.mock("../port-scanner", () => ({ collectProcessInfo: vi.fn() }));
vi.mock("../spawn", () => ({ spawn: vi.fn() }));
vi.mock("../native-task-panes", () => ({ nativeTaskPanesState: vi.fn() }));
vi.mock("../tmux", () => ({
	DEFAULT_TMUX_SOCKET: "dev3",
	PANE_ID_PID_FORMAT: { formatString: "#{pane_id}\t#{pane_pid}" },
	taskSessionName: (id: string) => `dev3-${id}`,
	tmux: { listPanes: vi.fn() },
}));

import { pinTaskPane } from "../pane-input";
import { collectProcessInfo } from "../port-scanner";
import { spawn } from "../spawn";
import { nativeTaskPanesState } from "../native-task-panes";
import { tmux } from "../tmux";
import { captureScheduledMessageAuthor, liveAgentPaneIds, resolveScheduledMessageAuthorPane, taskMainAgentLiveness } from "../scheduled-message-author";
import type { PaneSessionEntry, Task } from "../../shared/types";

/** A synthetic machine: processes plus the tmux panes (root pid each) on one server generation. */
type Proc = { pid: number; ppid: number; args: string; start?: string };
let procs: Proc[];
let panes: Record<string, number>;
let serverToken: string;

/**
 * Two agents in one task (A in %1, B in %2), an AI Review agent in %3 that is not
 * in `sessionState`, and %4, a plain shell split a human types in. Each agent pane
 * is `launch script → agent → tool shell → dev3`, exactly as a live pane looks.
 */
function machine(): void {
	serverToken = "gen-1";
	panes = { "%1": 100, "%2": 200, "%3": 300, "%4": 400 };
	procs = [
		{ pid: 100, ppid: 50, args: "/opt/homebrew/bin/zsh /tmp/dev3-task-cmd.sh" },
		{ pid: 101, ppid: 100, args: "/Users/me/.local/bin/claude --session-id conv-a" },
		{ pid: 102, ppid: 101, args: "/bin/zsh -c dev3 message --in 30m" },
		{ pid: 103, ppid: 102, args: "/Users/me/.dev3.0/bin/dev3 message --in 30m" },
		{ pid: 200, ppid: 50, args: "/opt/homebrew/bin/zsh /tmp/dev3-task-cmd.sh" },
		{ pid: 201, ppid: 200, args: "/Users/me/.local/bin/claude --session-id conv-b" },
		{ pid: 202, ppid: 201, args: "/bin/zsh -c dev3 message" },
		{ pid: 203, ppid: 202, args: "/Users/me/.dev3.0/bin/dev3 message" },
		{ pid: 300, ppid: 50, args: "bash /tmp/dev3-task-col-agent.sh" },
		{ pid: 301, ppid: 300, args: "node /usr/local/bin/codex" },
		{ pid: 302, ppid: 301, args: "bash -lc dev3 message" },
		{ pid: 303, ppid: 302, args: "/Users/me/.dev3.0/bin/dev3 message" },
		{ pid: 400, ppid: 50, args: "-zsh" },
		{ pid: 403, ppid: 400, args: "/Users/me/.dev3.0/bin/dev3 message" },
		{ pid: 410, ppid: 400, args: "bash" },
		{ pid: 411, ppid: 410, args: "/Users/me/.dev3.0/bin/dev3 message" },
		{ pid: 420, ppid: 400, args: "node /usr/local/bin/some-wrapper" },
		{ pid: 421, ppid: 420, args: "/Users/me/.dev3.0/bin/dev3 message" },
	];
}

/** The agent in `pane` exits; the launch script `exec`s a shell into the SAME root pid. */
function agentExits(rootPid: number): void {
	const agent = procs.find((p) => p.ppid === rootPid)!;
	const doomed = new Set([agent.pid]);
	for (const p of procs) if (doomed.has(p.ppid)) doomed.add(p.pid);
	procs = procs.filter((p) => !doomed.has(p.pid));
	procs.find((p) => p.pid === rootPid)!.args = "-zsh";
}

function sig(pid: number): string {
	const p = procs.find((x) => x.pid === pid);
	return p ? `${pid}@${(p.start ?? "Mon Oct  5 09:00:00 2026").replace(/\s+/g, " ")}` : "";
}

function pane(paneId: string | null, sessionId: string | null): PaneSessionEntry {
	return { paneId, agentCmd: "claude", sessionId, agentId: "claude", configId: null };
}

function task(panesList: PaneSessionEntry[] = [pane("%1", "conv-a"), pane("%2", "conv-b")], extra: Partial<Task> = {}): Task {
	return { id: "task-1", projectId: "p", seq: 7, status: "in-progress", sessionState: { panes: panesList }, ...extra } as unknown as Task;
}

beforeEach(() => {
	vi.clearAllMocks();
	machine();
	vi.mocked(pinTaskPane).mockImplementation(async (t, paneId) =>
		panes[paneId]
			? { ok: true, incarnation: { backend: "tmux", taskId: t.id, paneId, sessionName: "s", serverToken } }
			: { ok: false, reason: "pane-absent", detail: "gone" });
	vi.mocked(tmux.listPanes).mockImplementation(async () =>
		Object.entries(panes).map(([paneId, panePid]) => ({ paneId, panePid })) as never);
	vi.mocked(collectProcessInfo).mockImplementation(async () => {
		const tree = new Map<number, number[]>();
		const cmdlines = new Map<number, string>();
		for (const p of procs) {
			tree.set(p.ppid, [...(tree.get(p.ppid) ?? []), p.pid]);
			cmdlines.set(p.pid, p.args);
		}
		return { tree, cmdlines, resources: new Map() };
	});
	// `ps -p PID -o lstart=` as the real binary answers it: the start time, or exit 1.
	vi.mocked(spawn).mockImplementation(((cmd: string[]) => {
		const start = sig(Number(cmd[2])).split("@")[1] ?? "";
		return { stdout: new Response(start ? `${start}\n` : "").body, exited: Promise.resolve(start ? 0 : 1) };
	}) as never);
	vi.mocked(nativeTaskPanesState).mockResolvedValue(null);
});

describe("captureScheduledMessageAuthor — who may own a self-reminder", () => {
	it("records agent A's process, not the pane alone", async () => {
		expect(await captureScheduledMessageAuthor(task(), "%1", 103)).toEqual({
			paneId: "%1", sessionId: "conv-a", paneToken: "gen-1", agentProcess: sig(101),
		});
	});

	it("records agent B separately, in its own pane", async () => {
		expect(await captureScheduledMessageAuthor(task(), "%2", 203)).toMatchObject({ paneId: "%2", agentProcess: sig(201) });
	});

	it("captures an AI Review agent that sessionState never registered", async () => {
		expect(await captureScheduledMessageAuthor(task(), "%3", 303)).toEqual({
			paneId: "%3", sessionId: null, paneToken: "gen-1", agentProcess: sig(301),
		});
	});

	it("captures nothing for a human in a shell split — plain, in a subshell, or via a wrapper", async () => {
		expect(await captureScheduledMessageAuthor(task(), "%4", 403)).toBeNull();
		expect(await captureScheduledMessageAuthor(task(), "%4", 411)).toBeNull();
		expect(await captureScheduledMessageAuthor(task(), "%4", 421)).toBeNull();
	});

	it("captures nothing when the CLI claims a pane it does not run in", async () => {
		expect(await captureScheduledMessageAuthor(task(), "%2", 103)).toBeNull();
	});

	it("captures nothing without a pane, a pid, or a live pane", async () => {
		expect(await captureScheduledMessageAuthor(task(), null, 103)).toBeNull();
		expect(await captureScheduledMessageAuthor(task(), "%1", null)).toBeNull();
		delete panes["%1"];
		expect(await captureScheduledMessageAuthor(task(), "%1", 103)).toBeNull();
	});

	it("captures a native extra agent pane by its shell pid and registry session", async () => {
		vi.mocked(nativeTaskPanesState).mockResolvedValue({
			taskId: "task-1", layout: "", activePaneId: "pane-1",
			panes: [
				{ paneId: "pane-1", sessionId: "native-s1", hostPid: 90, shellPid: 100, cols: 80, rows: 24, alive: true },
				{ paneId: "pane-2", sessionId: "native-s2", hostPid: 91, shellPid: 200, cols: 80, rows: 24, alive: true },
			],
		});
		const native = task([], { terminalBackend: "native" } as Partial<Task>);
		expect(await captureScheduledMessageAuthor(native, "pane-2", 203)).toEqual({
			paneId: "pane-2", sessionId: null, paneToken: "native-s2", agentProcess: sig(201),
		});
		expect(pinTaskPane).not.toHaveBeenCalled();
	});
});

describe("liveAgentPaneIds — which panes really run an agent", () => {
	const nativePanes = (...rows: Array<[string, number, boolean]>) =>
		vi.mocked(nativeTaskPanesState).mockResolvedValue({
			taskId: "task-1", layout: "", activePaneId: "pane-1",
			panes: rows.map(([paneId, shellPid, alive]) => ({ paneId, sessionId: `s-${paneId}`, hostPid: 90, shellPid, cols: 80, rows: 24, alive })),
		});
	const native = (extra: Partial<Task> = {}) => task([pane("pane-1", null)], { terminalBackend: "native", ...extra } as Partial<Task>);

	it("tmux: counts recorded panes that exist and run an agent, not a stale record nor a shell split", async () => {
		expect(await liveAgentPaneIds(task([pane("%1", "conv-a"), pane("%dead", "conv-x")]))).toEqual(["%1"]);
	});

	it("tmux: a stale record beside a live shell split means no agent pane at all", async () => {
		expect(await liveAgentPaneIds(task([pane("%dead", "conv-x")]))).toEqual([]);
	});

	it("tmux: an agent that exited into a shell no longer counts", async () => {
		agentExits(100);
		expect(await liveAgentPaneIds(task([pane("%1", "conv-a")]))).toEqual([]);
	});

	it("tmux: a shell running a foreground program is not an agent, alone or beside one", async () => {
		procs.push({ pid: 600, ppid: 50, args: "-zsh" }, { pid: 601, ppid: 600, args: "tail -f /tmp/dev-server.log" });
		panes["%6"] = 600;

		expect(await liveAgentPaneIds(task([pane("%6", null)]))).toEqual([]);
		expect(await liveAgentPaneIds(task([pane("%1", "conv-a"), pane("%6", null)]))).toEqual(["%1"]);
	});

	it("native: a split's own shell (`$SHELL`, no argv) running a program is not an agent beside a real one", async () => {
		procs.push({ pid: 600, ppid: 50, args: "/bin/zsh" }, { pid: 601, ppid: 600, args: "bun test" });
		nativePanes(["pane-1", 100, true], ["pane-2", 600, true]);
		expect(await liveAgentPaneIds(native())).toEqual(["pane-1"]);
	});

	it("tmux: both recorded agents count", async () => {
		expect(await liveAgentPaneIds(task())).toEqual(["%1", "%2"]);
	});

	it("tmux: a recorded entry with no pane id yet makes the answer unknown", async () => {
		expect(await liveAgentPaneIds(task([pane(null, null)]))).toBeNull();
	});

	it("native: counts extra agent panes that sessionState never recorded", async () => {
		nativePanes(["pane-1", 100, true], ["pane-2", 200, true]);
		expect(await liveAgentPaneIds(native())).toEqual(["pane-1", "pane-2"]);
	});

	it("native: a lone agent pane need not be called pane-1, and a shell split is not an agent", async () => {
		procs.push({ pid: 500, ppid: 50, args: "-zsh" }); // an idle shell split
		nativePanes(["pane-1", 500, true], ["pane-3", 200, true]);
		expect(await liveAgentPaneIds(native())).toEqual(["pane-3"]);
	});

	it("native: a dead pane is skipped", async () => {
		nativePanes(["pane-1", 100, false], ["pane-2", 200, true]);
		expect(await liveAgentPaneIds(native())).toEqual(["pane-2"]);
	});

	it("is unknown when the process table cannot be read", async () => {
		vi.mocked(collectProcessInfo).mockResolvedValue({ tree: new Map(), cmdlines: new Map(), resources: new Map() });
		expect(await liveAgentPaneIds(task())).toBeNull();
	});

	describe("on Windows, which has no process table", () => {
		const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		beforeEach(() => Object.defineProperty(process, "platform", { value: "win32", configurable: true }));
		afterEach(() => { if (realPlatform) Object.defineProperty(process, "platform", realPlatform); });

		it("a lone coordinator pane is the agent", async () => {
			nativePanes(["pane-1", 100, true]);
			expect(await liveAgentPaneIds(native())).toEqual(["pane-1"]);
		});

		it("anything more is unknown rather than guessed", async () => {
			nativePanes(["pane-1", 100, true], ["pane-2", 200, true]);
			expect(await liveAgentPaneIds(native())).toBeNull();
		});
	});
});

describe("resolveScheduledMessageAuthorPane — where the reminder may land", () => {
	const authorOf = async (paneId: string, cli: number, t = task()) => (await captureScheduledMessageAuthor(t, paneId, cli))!;

	it("goes back to agent A whichever agent is focused", async () => {
		const a = await authorOf("%1", 103);
		expect(await resolveScheduledMessageAuthorPane(task(), a)).toEqual({ ok: true, paneId: "%1" });
	});

	it("goes back to the AI Review agent while it runs", async () => {
		const reviewer = await authorOf("%3", 303);
		expect(await resolveScheduledMessageAuthorPane(task(), reviewer)).toEqual({ ok: true, paneId: "%3" });
	});

	it("refuses when agent A exited and its pane is now a shell — even though sessionState still lists it", async () => {
		const a = await authorOf("%1", 103);
		agentExits(100);
		const res = await resolveScheduledMessageAuthorPane(task(), a);
		expect(res).toMatchObject({ ok: false, detail: expect.stringContaining("no longer running") });
	});

	it("refuses when agent A exited and the user now runs a program in the leftover shell", async () => {
		const a = await authorOf("%1", 103);
		agentExits(100);
		procs.push({ pid: 150, ppid: 100, args: "vim notes.md" });
		expect((await resolveScheduledMessageAuthorPane(task(), a)).ok).toBe(false);
	});

	it("refuses when the AI Review agent exited", async () => {
		const reviewer = await authorOf("%3", 303);
		agentExits(300);
		expect((await resolveScheduledMessageAuthorPane(task(), reviewer)).ok).toBe(false);
	});

	it("refuses a recycled pid: same number, different start time", async () => {
		const a = await authorOf("%1", 103);
		procs.find((p) => p.pid === 101)!.start = "Tue Oct  6 11:00:00 2026";
		expect((await resolveScheduledMessageAuthorPane(task(), a)).ok).toBe(false);
	});

	it("follows A's conversation when it was resumed into a new pane after a tmux restart", async () => {
		const a = await authorOf("%1", 103);
		machine();
		serverToken = "gen-2";
		panes = { "%7": 700, "%8": 800 };
		procs = [
			{ pid: 700, ppid: 50, args: "zsh /tmp/cmd.sh" },
			{ pid: 701, ppid: 700, args: "claude --resume conv-a" },
			{ pid: 800, ppid: 50, args: "zsh /tmp/cmd.sh" },
			{ pid: 801, ppid: 800, args: "claude --resume conv-b" },
		];
		const resumed = task([pane("%8", "conv-b"), pane("%7", "conv-a")]);
		expect(await resolveScheduledMessageAuthorPane(resumed, a)).toEqual({ ok: true, paneId: "%7" });
	});

	it("refuses a resumed pane whose agent has since exited too", async () => {
		const a = await authorOf("%1", 103);
		serverToken = "gen-2";
		panes = { "%7": 700 };
		procs = [{ pid: 700, ppid: 50, args: "-zsh" }];
		expect((await resolveScheduledMessageAuthorPane(task([pane("%7", "conv-a")]), a)).ok).toBe(false);
	});

	it("refuses the reviewer after a restart: it has no conversation id to follow", async () => {
		const reviewer = await authorOf("%3", 303);
		serverToken = "gen-2";
		procs = procs.filter((p) => p.pid < 300 || p.pid >= 400);
		procs.push({ pid: 301, ppid: 300, args: "node /usr/local/bin/codex", start: "Tue Oct  6 11:00:00 2026" });
		expect((await resolveScheduledMessageAuthorPane(task(), reviewer)).ok).toBe(false);
	});

	it("refuses rather than guess when two panes claim the conversation", async () => {
		const a = await authorOf("%1", 103);
		agentExits(100);
		const res = await resolveScheduledMessageAuthorPane(task([pane("%1", "conv-a"), pane("%2", "conv-a")]), a);
		expect(res).toMatchObject({ ok: false, detail: expect.stringContaining("several panes") });
	});

	it("goes back to a native extra agent while it runs, and refuses once its pane was recreated", async () => {
		const state = (shellPid: number, sessionId: string) => ({
			taskId: "task-1", layout: "", activePaneId: "pane-1",
			panes: [{ paneId: "pane-2", sessionId, hostPid: 91, shellPid, cols: 80, rows: 24, alive: true }],
		});
		vi.mocked(nativeTaskPanesState).mockResolvedValue(state(200, "native-s2"));
		const native = task([], { terminalBackend: "native" } as Partial<Task>);
		const b = await authorOf("pane-2", 203, native);
		expect(await resolveScheduledMessageAuthorPane(native, b)).toEqual({ ok: true, paneId: "pane-2" });
		agentExits(200);
		expect((await resolveScheduledMessageAuthorPane(native, b)).ok).toBe(false);
	});
});

describe("taskMainAgentLiveness — what the keep-alive watchdog may conclude", () => {
	it("sees the main agent running", async () => {
		expect(await taskMainAgentLiveness(task())).toBe("alive");
	});

	it("proves an exit once the launch script handed the pane to a bare shell", async () => {
		agentExits(100);
		expect(await taskMainAgentLiveness(task())).toBe("exited");
	});

	it("still proves the exit when the leftover shell runs a prompt helper", async () => {
		agentExits(100);
		procs.push({ pid: 150, ppid: 100, args: "/Users/me/.cache/gitstatus/gitstatusd-darwin-arm64 -G v1.5.4" });
		expect(await taskMainAgentLiveness(task())).toBe("exited");
	});

	it("is unknown, never exited, while a setup script runs ahead of the agent", async () => {
		procs = procs.filter((p) => p.ppid !== 100);
		procs.find((p) => p.pid === 100)!.args = "/opt/homebrew/bin/zsh /tmp/dev3-task-startup.sh";
		procs.push({ pid: 160, ppid: 100, args: "/opt/homebrew/bin/zsh /tmp/dev3-task-setup.sh" });
		expect(await taskMainAgentLiveness(task())).toBe("unknown");
	});

	it("is unknown when `ps` fails or times out (an empty table)", async () => {
		vi.mocked(collectProcessInfo).mockResolvedValue({ tree: new Map(), cmdlines: new Map(), resources: new Map() });
		expect(await taskMainAgentLiveness(task())).toBe("unknown");
	});

	it("is unknown when tmux cannot pin the pane or no pane id is stored", async () => {
		vi.mocked(pinTaskPane).mockResolvedValue({ ok: false, reason: "pane-absent", detail: "gone" } as never);
		expect(await taskMainAgentLiveness(task())).toBe("unknown");
		expect(await taskMainAgentLiveness(task([pane(null, "conv-a")]))).toBe("unknown");
	});

	it("is unknown on Windows, which has no `ps` to read the process table from", async () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			agentExits(100);
			expect(await taskMainAgentLiveness(task())).toBe("unknown");
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
	});
});
