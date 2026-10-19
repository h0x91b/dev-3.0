/**
 * Shared tmux PTY sizing across several viewers (h0x91b/dev-3.0#2000).
 *
 * Drives the server's real WebSocket handlers with fake viewers. The PTY follows
 * the viewer used LAST — never the smallest one — so a forgotten narrow tab on
 * another device can no longer clamp the terminal for everyone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		accessSync: vi.fn(),
		existsSync: vi.fn(() => true),
		writeFileSync: vi.fn(),
		mkdirSync: vi.fn(),
		lstatSync: vi.fn(() => { throw new Error("ENOENT"); }),
		statSync: vi.fn(() => ({ isFile: () => true })),
		readlinkSync: vi.fn(() => { throw new Error("EINVAL"); }),
		realpathSync: vi.fn((p: string) => p),
		unlinkSync: vi.fn(),
		symlinkSync: vi.fn(),
	};
});

vi.mock("../spawn", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

import { spawn, spawnSync } from "../spawn";
import {
	encodeResizeSequence,
	encodeViewerSignal,
	isSizingNotice,
	parseSizingNotice,
	type SizingNotice,
} from "../../shared/resize-protocol";

interface WsHandlers {
	open(ws: unknown): void;
	message(ws: unknown, message: string): void;
	close(ws: unknown): void;
}
let wsHandlers: WsHandlers;
const bun = globalThis as unknown as { Bun: { serve: (config: unknown) => unknown } };
const stubServe = bun.Bun.serve;
bun.Bun.serve = (config: unknown) => {
	const websocket = (config as { websocket?: WsHandlers }).websocket;
	if (websocket) wsHandlers = websocket;
	return stubServe(config);
};

const { createSession, destroySession, hasSession } = await import("../pty-server");

class FakeViewer {
	readonly sent: string[] = [];
	readonly data: { url: URL };

	constructor(sessionId: string) {
		this.data = { url: new URL(`http://localhost/?session=${sessionId}`) };
	}

	sendText(text: string): void {
		this.sent.push(text);
	}

	getBufferedAmount(): number {
		return 0;
	}

	/** The last sizing notice the server sent this viewer. */
	lastNotice(): SizingNotice | null {
		const notices = this.sent.filter(isSizingNotice);
		return notices.length ? parseSizingNotice(notices[notices.length - 1]) : null;
	}
}

const mockSpawn = vi.mocked(spawn);
const mockSpawnSync = vi.mocked(spawnSync);
let terminal: { resize: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
const activeSessions: string[] = [];

function startSession(taskId: string): void {
	activeSessions.push(taskId);
	createSession(taskId, "proj-1", "/tmp/cwd", "bash", {});
}

function connect(taskId: string, cols: number, rows: number): FakeViewer {
	const viewer = new FakeViewer(taskId);
	wsHandlers.open(viewer);
	wsHandlers.message(viewer, encodeResizeSequence(cols, rows));
	// Let a first-paint jiggle finish so its deferred resize cannot land later.
	vi.advanceTimersByTime(50);
	return viewer;
}

/** The size the PTY was last resized to, ignoring the one-row repaint jiggle. */
function ptySize(): { cols: number; rows: number } | null {
	vi.advanceTimersByTime(50);
	const calls = terminal.resize.mock.calls;
	const last = calls[calls.length - 1];
	return last ? { cols: last[0], rows: last[1] } : null;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	mockSpawnSync.mockReturnValue({ exitCode: 0, stdout: new Uint8Array(0) } as never);
	// Only the attach spawn owns a PTY; deferred tmux config calls must not replace it.
	mockSpawn.mockImplementation(((_cmd: unknown, opts: { terminal?: unknown }) => {
		const term = { close: vi.fn(), resize: vi.fn(), write: vi.fn() };
		if (opts?.terminal) terminal = term;
		return { pid: 100, terminal: term, kill: vi.fn(), exited: new Promise(() => {}) };
	}) as never);
});

afterEach(() => {
	for (const id of activeSessions) {
		if (hasSession(id)) destroySession(id);
	}
	activeSessions.length = 0;
	vi.useRealTimers();
});

describe("shared tmux PTY sizing", () => {
	it("follows the viewer that was used last, not the smallest", () => {
		startSession("task-size-last-active");
		const desk = connect("task-size-last-active", 200, 50);
		const phone = connect("task-size-last-active", 22, 40);

		wsHandlers.message(desk, encodeViewerSignal("active"));
		expect(ptySize()).toEqual({ cols: 200, rows: 50 });

		wsHandlers.message(phone, encodeViewerSignal("active"));
		expect(ptySize()).toEqual({ cols: 22, rows: 40 });

		wsHandlers.message(desk, encodeViewerSignal("active"));
		expect(ptySize()).toEqual({ cols: 200, rows: 50 });
	});

	it("does not let a viewer take over merely by connecting or resizing", () => {
		startSession("task-size-no-flip");
		const desk = connect("task-size-no-flip", 200, 50);
		wsHandlers.message(desk, encodeViewerSignal("active"));

		const tab = connect("task-size-no-flip", 80, 24);
		wsHandlers.message(tab, encodeResizeSequence(90, 30));
		expect(ptySize()).toEqual({ cols: 200, rows: 50 });
		expect(tab.lastNotice()).toEqual({ cols: 200, rows: 50, sizing: false });
		expect(desk.lastNotice()).toEqual({ cols: 200, rows: 50, sizing: true });
	});

	it("drops a hidden viewer out of sizing and lets it back in when used", () => {
		startSession("task-size-hidden");
		const desk = connect("task-size-hidden", 200, 50);
		const phone = connect("task-size-hidden", 22, 40);
		wsHandlers.message(desk, encodeViewerSignal("active"));
		wsHandlers.message(phone, encodeViewerSignal("active"));
		expect(ptySize()).toEqual({ cols: 22, rows: 40 });

		wsHandlers.message(phone, encodeViewerSignal("hidden"));
		expect(ptySize()).toEqual({ cols: 200, rows: 50 });
		expect(phone.lastNotice()).toEqual({ cols: 200, rows: 50, sizing: false });

		wsHandlers.message(phone, encodeViewerSignal("active"));
		expect(ptySize()).toEqual({ cols: 22, rows: 40 });
	});

	it("falls back to the next most recently active viewer when the sizer disconnects", () => {
		startSession("task-size-disconnect");
		const a = connect("task-size-disconnect", 120, 40);
		const b = connect("task-size-disconnect", 100, 30);
		const c = connect("task-size-disconnect", 60, 20);
		wsHandlers.message(a, encodeViewerSignal("active"));
		wsHandlers.message(b, encodeViewerSignal("active"));
		wsHandlers.message(c, encodeViewerSignal("active"));

		wsHandlers.close(c);
		expect(ptySize()).toEqual({ cols: 100, rows: 30 });
		expect(b.lastNotice()).toEqual({ cols: 100, rows: 30, sizing: true });
		expect(a.lastNotice()).toEqual({ cols: 100, rows: 30, sizing: false });
	});

	it("tracks a follower's own viewport so taking over applies it at once", () => {
		startSession("task-size-follower-resize");
		const desk = connect("task-size-follower-resize", 200, 50);
		const tab = connect("task-size-follower-resize", 80, 24);
		wsHandlers.message(desk, encodeViewerSignal("active"));

		wsHandlers.message(tab, encodeResizeSequence(150, 45));
		expect(ptySize()).toEqual({ cols: 200, rows: 50 });

		wsHandlers.message(tab, encodeViewerSignal("active"));
		expect(ptySize()).toEqual({ cols: 150, rows: 45 });
	});

	it("never writes a viewer signal into the shell", () => {
		startSession("task-size-no-leak");
		const viewer = connect("task-size-no-leak", 100, 30);
		wsHandlers.message(viewer, encodeViewerSignal("active"));
		wsHandlers.message(viewer, encodeViewerSignal("hidden"));
		wsHandlers.message(viewer, "\x1b]dev3viewer;bogus\x07");
		expect(terminal.write).not.toHaveBeenCalled();
	});

	it("sends each viewer a notice only when its own state changes", () => {
		startSession("task-size-dedupe");
		const desk = connect("task-size-dedupe", 200, 50);
		wsHandlers.message(desk, encodeViewerSignal("active"));
		wsHandlers.message(desk, encodeViewerSignal("active"));
		wsHandlers.message(desk, encodeViewerSignal("active"));
		expect(desk.sent.filter(isSizingNotice)).toEqual(["\x1b]dev3sizing;200;50;1\x07"]);
	});

	it("does not jiggle everyone's screen for a repeated identical report or a confirming signal", () => {
		startSession("task-size-no-jiggle");
		const desk = connect("task-size-no-jiggle", 200, 50);
		wsHandlers.message(desk, encodeViewerSignal("active"));
		vi.advanceTimersByTime(50);
		terminal.resize.mockClear();

		wsHandlers.message(desk, encodeResizeSequence(200, 50));
		wsHandlers.message(desk, encodeViewerSignal("active"));
		vi.advanceTimersByTime(50);
		expect(terminal.resize).not.toHaveBeenCalled();
	});

	// Found in browser QA: the follower's own report jiggled the PTY, and the
	// jiggle's 16ms restore then undid the new sizer's real resize.
	it("never lets a repaint jiggle undo a real resize that lands inside it", () => {
		startSession("task-size-jiggle-race");
		const desk = connect("task-size-jiggle-race", 167, 45);
		wsHandlers.message(desk, encodeViewerSignal("active"));
		vi.advanceTimersByTime(50);

		const late = new FakeViewer("task-size-jiggle-race");
		wsHandlers.open(late);
		wsHandlers.message(late, encodeResizeSequence(80, 24));
		wsHandlers.message(desk, encodeResizeSequence(167, 46));

		expect(ptySize()).toEqual({ cols: 167, rows: 46 });
	});

	it("does not repaint everyone when a follower re-reports its own viewport", () => {
		startSession("task-size-follower-quiet");
		const desk = connect("task-size-follower-quiet", 167, 45);
		const phone = connect("task-size-follower-quiet", 78, 64);
		wsHandlers.message(desk, encodeViewerSignal("active"));
		vi.advanceTimersByTime(50);
		terminal.resize.mockClear();

		wsHandlers.message(phone, encodeResizeSequence(78, 62));
		vi.advanceTimersByTime(50);
		expect(terminal.resize).not.toHaveBeenCalled();
	});
});
