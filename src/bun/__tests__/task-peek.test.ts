/**
 * Peek parity suite (seq 1410).
 *
 * ONE set of expectations, executed twice: once with a fake tmux client, once
 * with a fake native pane/parser layer. Both fakes describe the SAME terminal
 * reality, so any coordinator-visible difference between backends fails here —
 * except `granularity`, the one declared asymmetry (tmux has no per-pane
 * activity variable).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "../../shared/types";
import { createSplitTree, type SplitTree } from "../../shared/split-tree";

const mocks = vi.hoisted(() => ({
	taskTerminalBackendIdentity: vi.fn(),
	// tmux
	hasSession: vi.fn(),
	listPanes: vi.fn(),
	capturePane: vi.fn(),
	// Write-shaped operations, present ONLY so the parity suite can prove a peek
	// never reaches them.
	selectPane: vi.fn(),
	sendKeys: vi.fn(),
	resizeWindow: vi.fn(),
	killPane: vi.fn(),
	focusView: vi.fn(),
	writePane: vi.fn(),
	splitView: vi.fn(),
	closeView: vi.fn(),
	getSessionSocket: vi.fn(() => "dev3-sock"),
	getSessionTmuxName: vi.fn(() => "dev3-aaaaaaaa"),
	// native runtime (below the pane layer)
	readPaneSet: vi.fn(),
	captureView: vi.fn(),
	attachView: vi.fn(),
	readRecord: vi.fn(),
	stopSession: vi.fn(),
	nativeBackend: {} as Record<string, unknown>,
}));

vi.mock("../tmux", () => ({
	PEEK_PANE_FORMAT: { formatString: "fake" },
	CAPTURE_SCROLLBACK_START_LINE: -3000,
	tmux: {
		hasSession: mocks.hasSession,
		listPanes: mocks.listPanes,
		capturePane: mocks.capturePane,
		selectPane: mocks.selectPane,
		sendKeys: mocks.sendKeys,
		resizeWindow: mocks.resizeWindow,
		killPane: mocks.killPane,
	},
}));

// The fake native backend, shaped like the real one's used surface.
Object.assign(mocks.nativeBackend, {
	readPaneSet: mocks.readPaneSet,
	captureView: mocks.captureView,
	attachView: mocks.attachView,
	focusView: mocks.focusView,
	writePane: mocks.writePane,
	splitView: mocks.splitView,
	closeView: mocks.closeView,
});

vi.mock("../pty-server", () => ({
	getSessionSocket: mocks.getSessionSocket,
	getSessionTmuxName: mocks.getSessionTmuxName,
}));

// The native runtime is faked BELOW `native-task-panes`, so the real pane layer
// runs: its ownership sweep shaping, labelling, parser-state read and the
// attach/capture/detach discipline are all under test.
vi.mock("../task-terminal-backend", () => ({
	taskTerminalBackendIdentity: mocks.taskTerminalBackendIdentity,
	nativeTaskTerminalBackend: () => mocks.nativeBackend,
	nativeTaskSessionId: (taskId: string) => `dev3-task-${taskId}`,
	isCapturedPane: (capture: { availability: string }) => capture.availability === "captured",
}));

vi.mock("../native-terminal-registry/record", () => ({
	readRecord: mocks.readRecord,
}));

vi.mock("../native-terminal-registry/registry", () => ({
	stop: mocks.stopSession,
}));

import { _resetBackendForTests } from "../native-task-panes";
import { taskPeek } from "../task-peek";
import { PEEK_MAX_LINES } from "../../shared/task-peek";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TASK_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const ACTIVITY_ISO = "2026-08-04T10:00:00.000Z";
const ACTIVITY_EPOCH = Math.floor(Date.parse(ACTIVITY_ISO) / 1000);

function task(extra: Partial<Task> = {}): Task {
	return {
		id: TASK_ID,
		seq: 42,
		title: "Fix auth race",
		status: "in-progress",
		...extra,
	} as Task;
}

/** The terminal reality both fakes describe: two panes, first focused. */
interface PaneFixture {
	paneId: string;
	label: string;
	alive: boolean;
	focused: boolean;
	text: string;
	/** null = the backend cannot say when this pane last produced output. */
	lastOutput: string | null;
	/** tmux pane title; an unset title equals the hostname, which is not a label. */
	title?: string;
}

const TWO_PANES: PaneFixture[] = [
	{ paneId: "P1", label: "claude", alive: true, focused: true, text: "line-1\nline-2\nline-3", lastOutput: ACTIVITY_ISO },
	{ paneId: "P2", label: "bun", alive: true, focused: false, text: "tests ok", lastOutput: ACTIVITY_ISO },
];

type Backend = "tmux" | "native";

/** Minimal SplitTree for N panes, shaped as the native pane layer expects. */
function nativeLayout(panes: PaneFixture[]): SplitTree {
	let tree = createSplitTree();
	const root = panes.length === 1
		? { type: "pane" as const, id: panes[0].paneId }
		: {
			type: "split" as const,
			id: "split-1",
			orientation: "horizontal" as const,
			ratio: 0.5,
			first: { type: "pane" as const, id: panes[0].paneId },
			second: { type: "pane" as const, id: panes[1].paneId },
		};
	return {
		...tree,
		root,
		activePaneId: panes.find((p) => p.focused)?.paneId ?? panes[0].paneId,
		nextPaneOrdinal: panes.length + 1,
		nextSplitOrdinal: 2,
	};
}

/** Point the mocks at a pane fixture list for the given backend. */
function arrange(backend: Backend, panes: PaneFixture[], opts: { session?: boolean } = {}): void {
	const sessionPresent = opts.session ?? true;
	mocks.taskTerminalBackendIdentity.mockReturnValue(backend);

	if (backend === "tmux") {
		mocks.hasSession.mockResolvedValue(sessionPresent);
		mocks.listPanes.mockResolvedValue(
			panes.map((p) => ({
				paneId: p.paneId,
				active: p.focused,
				dead: !p.alive,
				windowActivity: p.lastOutput === null ? 0 : ACTIVITY_EPOCH,
				command: p.label,
				hostShort: "hostname",
				title: p.title ?? "hostname",
			})),
		);
		mocks.capturePane.mockImplementation(async ({ target }: { target: string }) =>
			panes.find((p) => p.paneId === target)?.text ?? "",
		);
		return;
	}

	mocks.readPaneSet.mockResolvedValue(
		sessionPresent && panes.length > 0
			? {
				panes: panes.map((p) => ({
					paneId: p.paneId,
					sessionId: `sess-${p.paneId}`,
					hostPid: 1,
					shellPid: 2,
					cols: 80,
					rows: 24,
					state: p.alive ? "alive" : "dead",
				})),
				layout: nativeLayout(panes),
			}
			: null,
	);
	// The pane layer reads each pane's launch command from its session record.
	mocks.readRecord.mockImplementation((sessionId: string) => {
		const pane = panes.find((p) => `sess-${p.paneId}` === sessionId);
		return pane ? { shell: { command: [`/usr/bin/${pane.label}`] } } : null;
	});
	mocks.captureView.mockImplementation(async (_id: string, paneId: string) => {
		const pane = panes.find((p) => p.paneId === paneId);
		if (!pane) return { availability: "view-absent", reason: `no pane ${paneId}`, liveness: "unknown" };
		return {
			availability: "captured",
			liveness: pane.alive ? "live" : "dead",
			sourceUpdatedAt: pane.lastOutput === null
				? { known: false, reason: "no producer heartbeat" }
				: { known: true, value: pane.lastOutput },
			content: { viewport: pane.text.split("\n"), history: [], lineModel: "physical-rows" },
		};
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	_resetBackendForTests();
	mocks.getSessionSocket.mockReturnValue("dev3-sock");
	mocks.getSessionTmuxName.mockReturnValue("dev3-aaaaaaaa");
});

// ── The parity suite ─────────────────────────────────────────────────────────

describe.each<Backend>(["tmux", "native"])("dev3 peek on %s", (backend) => {
	const expectedGranularity = backend === "tmux" ? "window" : "pane";

	it("summarizes every pane and tails the focused one", async () => {
		arrange(backend, TWO_PANES);

		const snap = await taskPeek({ task: task() });

		expect(snap.backend).toBe(backend);
		expect(snap.seq).toBe(42);
		expect(snap.title).toBe("Fix auth race");
		expect(snap.status).toBe("in-progress");
		expect(snap.sessionPresent).toBe(true);
		expect(snap.unavailable).toBeNull();
		// Both backends answer with the same fields; only the freshness of a pane
		// nobody captured differs, and tmux gets it from its window clock.
		const unreadPaneTime = backend === "tmux" ? ACTIVITY_ISO : null;
		expect(snap.panes).toEqual([
			{ index: 1, paneId: "P1", label: "claude", alive: true, focused: true, lastOutputAt: ACTIVITY_ISO, lastOutputAgeMs: expect.any(Number), granularity: expectedGranularity },
			{ index: 2, paneId: "P2", label: "bun", alive: true, focused: false, lastOutputAt: unreadPaneTime, lastOutputAgeMs: unreadPaneTime === null ? null : expect.any(Number), granularity: expectedGranularity },
		]);
		expect(snap.tail).toEqual({ paneIndex: 1, paneId: "P1", lines: 3, text: "line-1\nline-2\nline-3" });
		expect(Date.parse(snap.observedAt)).not.toBeNaN();
	});

	it("reports the captured pane's output age against the observation time", async () => {
		arrange(backend, TWO_PANES);

		const snap = await taskPeek({ task: task() });

		const expected = Date.parse(snap.observedAt) - Date.parse(ACTIVITY_ISO);
		expect(snap.panes[0].lastOutputAt).toBe(ACTIVITY_ISO);
		expect(snap.panes[0].lastOutputAgeMs).toBe(expected);
	});

	it("leaves the age null when the time itself is unknown", async () => {
		arrange(backend, [{ ...TWO_PANES[0], lastOutput: null }]);

		const snap = await taskPeek({ task: task() });

		expect(snap.panes[0].lastOutputAt).toBeNull();
		expect(snap.panes[0].lastOutputAgeMs).toBeNull();
	});

	it("selects a pane by its 1-based index", async () => {
		arrange(backend, TWO_PANES);

		const snap = await taskPeek({ task: task(), pane: "2" });

		expect(snap.tail).toEqual({ paneIndex: 2, paneId: "P2", lines: 1, text: "tests ok" });
	});

	it("selects a pane by its raw backend pane id", async () => {
		arrange(backend, TWO_PANES);

		const snap = await taskPeek({ task: task(), pane: "P2" });

		expect(snap.tail?.paneId).toBe("P2");
	});

	it("says which pane was missing instead of silently returning no tail", async () => {
		arrange(backend, TWO_PANES);

		const snap = await taskPeek({ task: task(), pane: "9" });

		expect(snap.sessionPresent).toBe(true);
		expect(snap.panes).toHaveLength(2);
		expect(snap.tail).toBeNull();
		expect(snap.unavailable).toEqual({ kind: "pane-not-found", detail: expect.stringContaining("9") });
	});

	it("honors a line budget and clamps it to the cap", async () => {
		const long = { ...TWO_PANES[0], text: Array.from({ length: 50 }, (_, i) => `l${i + 1}`).join("\n") };
		arrange(backend, [long]);

		const limited = await taskPeek({ task: task(), lines: 5 });
		expect(limited.tail?.lines).toBe(5);
		expect(limited.tail?.text).toBe("l46\nl47\nl48\nl49\nl50");

		const clamped = await taskPeek({ task: task(), lines: PEEK_MAX_LINES + 500 });
		expect(clamped.tail?.lines).toBe(50);
	});

	it("strips terminal escape sequences from the tail", async () => {
		const noisy = { ...TWO_PANES[0], text: "\u001b[31mred\u001b[0m\n\u001b]0;title\u0007plain" };
		arrange(backend, [noisy]);

		const snap = await taskPeek({ task: task() });

		expect(snap.tail?.text).toBe("red\nplain");
	});

	it("says freshness is unknown rather than guessing a time", async () => {
		arrange(backend, [{ ...TWO_PANES[0], lastOutput: null }]);

		const snap = await taskPeek({ task: task() });

		expect(snap.panes[0].lastOutputAt).toBeNull();
		expect(snap.panes[0].granularity).toBe(expectedGranularity);
	});

	it("reports a dead pane as dead", async () => {
		arrange(backend, [{ ...TWO_PANES[0], alive: false }]);

		const snap = await taskPeek({ task: task() });

		expect(snap.panes[0].alive).toBe(false);
	});

	it.each([
		["a draft", { draft: true }, "draft"],
		["a hibernated task", { hibernated: true }, "hibernated"],
		["an idle task", {}, "not running"],
	])("succeeds with an explicit reason for %s with no session", async (_name, extra, reason) => {
		arrange(backend, [], { session: false });

		const snap = await taskPeek({ task: task(extra as Partial<Task>) });

		expect(snap.sessionPresent).toBe(false);
		expect(snap.unavailable?.kind).toBe("no-session");
		expect(snap.unavailable?.detail).toContain(reason);
		expect(snap.panes).toEqual([]);
		expect(snap.tail).toBeNull();
	});

	it("reports a failed read as OUR failure, never as a quiet task", async () => {
		arrange(backend, TWO_PANES);
		if (backend === "tmux") mocks.listPanes.mockRejectedValue(new Error("tmux exploded"));
		else mocks.readPaneSet.mockRejectedValue(new Error("registry exploded"));

		const snap = await taskPeek({ task: task() });

		expect(snap.backend).toBe(backend);
		expect(snap.unavailable?.kind).toBe("read-failed");
		expect(snap.unavailable?.detail).toContain("exploded");
	});

	it("never writes, focuses, or resizes anything", async () => {
		arrange(backend, TWO_PANES);

		await taskPeek({ task: task(), pane: "2" });

		for (const name of ["selectPane", "sendKeys", "resizeWindow", "killPane", "focusView", "writePane", "splitView", "closeView", "attachView"] as const) {
			expect(mocks[name], name).not.toHaveBeenCalled();
		}
	});
});

// ── Backend-specific labelling ───────────────────────────────────────────────

describe("pane labels", () => {
	it("prefers the tmux pane title over the foreground command", async () => {
		// Agents set their pane title to what they are currently doing, while
		// pane_current_command only ever names the wrapper shell.
		arrange("tmux", [{ ...TWO_PANES[0], label: "zsh", title: "Thinking about auth" }]);

		const snap = await taskPeek({ task: task() });

		expect(snap.panes[0].label).toBe("Thinking about auth");
	});

	it("ignores an unset tmux title, which tmux reports as the hostname", async () => {
		arrange("tmux", [{ ...TWO_PANES[0], label: "bun", title: "hostname" }]);

		const snap = await taskPeek({ task: task() });

		expect(snap.panes[0].label).toBe("bun");
	});

	it("labels a native pane by its launch executable", async () => {
		arrange("native", [{ ...TWO_PANES[0], label: "claude" }]);

		const snap = await taskPeek({ task: task() });

		expect(snap.panes[0].label).toBe("claude");
	});
});

// ── Native-specific read discipline ──────────────────────────────────────────

describe("native read discipline", () => {
	it("observes without ever opening a write channel to the pane", async () => {
		arrange("native", TWO_PANES);

		await taskPeek({ task: task() });

		expect(mocks.captureView).toHaveBeenCalledTimes(1);
		expect(mocks.attachView).not.toHaveBeenCalled();
	});

	it("asks for exactly the requested history depth", async () => {
		arrange("native", TWO_PANES);

		await taskPeek({ task: task(), lines: 40 });

		expect(mocks.captureView).toHaveBeenCalledWith(expect.any(String), "P1", { historyLines: 40 });
	});

	it("reports a capture the backend cannot produce as OUR failure, with its reason", async () => {
		// Production answer today: the host publishes no capture artifact
		// (decision 202), which must never read as a quiet worker.
		arrange("native", TWO_PANES);
		mocks.captureView.mockResolvedValue({
			availability: "not-enabled",
			reason: "the host records no capture artifact",
			liveness: "live",
		});

		const snap = await taskPeek({ task: task() });

		expect(snap.sessionPresent).toBe(true);
		expect(snap.panes).toHaveLength(2);
		expect(snap.tail).toBeNull();
		expect(snap.unavailable).toEqual({
			kind: "read-failed",
			detail: "not-enabled: the host records no capture artifact",
		});
	});

	it("maps a pane the backend says is absent onto pane-not-found", async () => {
		arrange("native", TWO_PANES);
		mocks.captureView.mockResolvedValue({
			availability: "view-absent",
			reason: "the session has no pane P1",
			liveness: "unknown",
		});

		const snap = await taskPeek({ task: task() });

		expect(snap.unavailable?.kind).toBe("pane-not-found");
	});

	it("keeps a dead pane's final screen and marks it dead", async () => {
		arrange("native", [{ ...TWO_PANES[0], alive: true }]);
		mocks.captureView.mockResolvedValue({
			availability: "captured",
			liveness: "dead",
			sourceUpdatedAt: { known: true, value: ACTIVITY_ISO },
			content: { viewport: ["last words"], history: [], lineModel: "physical-rows" },
		});

		const snap = await taskPeek({ task: task() });

		expect(snap.panes[0].alive).toBe(false);
		expect(snap.tail?.text).toBe("last words");
	});

	it("puts history before the viewport so the tail reads in produced order", async () => {
		arrange("native", TWO_PANES);
		mocks.captureView.mockResolvedValue({
			availability: "captured",
			liveness: "live",
			sourceUpdatedAt: { known: true, value: ACTIVITY_ISO },
			content: { viewport: ["newer"], history: ["older"], lineModel: "physical-rows" },
		});

		const snap = await taskPeek({ task: task() });

		expect(snap.tail?.text).toBe("older\nnewer");
	});
});
