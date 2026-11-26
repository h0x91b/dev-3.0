/**
 * PTY output batching: leading-edge flush and broadcast backpressure (seq 1470,
 * unconditional since seq 1575 — the flag that gated them is gone).
 *
 * The tests drive the server's real WebSocket handlers with a fake client, the
 * same channel remote mode proxies to a browser. The behaviour that matters:
 * a lone echo is never held back, a burst still costs at most one extra frame,
 * a saturated socket is throttled instead of blasted, and nothing is ever lost
 * or reordered on any of those paths.
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
import { throughputSnapshot } from "../pty-throughput";
import { ptyOutputRecorder } from "../freeze-diagnostics/pty-output";
import {
	PTY_BACKPRESSURE_HIGH_WATER_BYTES,
	PTY_BACKPRESSURE_LOW_WATER_BYTES,
	PTY_BATCH_INTERVAL_MAX_MS,
} from "../pty-backpressure";

// The PTY server's WebSocket handlers are part of the unit under test; intercept
// the config `Bun.serve` is handed at module load.
interface WsHandlers {
	open(ws: unknown): void;
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

const pty = await import("../pty-server");
const { createSession, destroySession, hasSession, registerBackpressureProbe, shouldDeferLeadingEdgeFlush } = pty;

const BATCH_MS = 16;

/** A viewer of the session: every frame the server pushed it, in order. */
class FakeClient {
	readonly sent: string[] = [];
	readonly data: { url: URL };
	/** What this socket claims it still owes the far end. */
	buffered = 0;

	constructor(sessionId: string) {
		this.data = { url: new URL(`http://localhost/?session=${sessionId}`) };
	}

	sendText(text: string): void {
		this.sent.push(text);
	}

	getBufferedAmount(): number {
		return this.buffered;
	}
}

const mockSpawn = vi.mocked(spawn);
const mockSpawnSync = vi.mocked(spawnSync);

let emit: (data: string) => void;
const activeSessions: string[] = [];

/** A tmux-backed session with one attached viewer, ready to receive output. */
function startSession(taskId: string): FakeClient {
	activeSessions.push(taskId);
	createSession(taskId, "proj-1", "/tmp/cwd", "bash", {});
	const client = new FakeClient(taskId);
	wsHandlers.open(client);
	return client;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	mockSpawnSync.mockReturnValue({ exitCode: 0, stdout: new Uint8Array(0) } as never);
	mockSpawn.mockImplementation(((_cmd: unknown, opts: { terminal?: { data?: unknown } }) => {
		const onData = opts?.terminal?.data as ((t: unknown, d: string) => void) | undefined;
		if (onData) emit = (data: string) => onData(null, data);
		return {
			pid: 100,
			terminal: { close: vi.fn(), resize: vi.fn(), write: vi.fn() },
			kill: vi.fn(),
			exited: new Promise(() => {}),
		};
	}) as never);
});

afterEach(() => {
	for (const id of activeSessions) {
		if (hasSession(id)) destroySession(id);
	}
	activeSessions.length = 0;
	vi.useRealTimers();
});

describe("leading-edge flush", () => {
	it("sends an isolated keystroke echo with no delay at all", () => {
		const client = startSession("task-batch-on-1");

		emit("x");
		expect(client.sent).toEqual(["x"]);

		// Nothing left over: the window closes without a second, empty frame.
		vi.advanceTimersByTime(BATCH_MS * 4);
		expect(client.sent).toEqual(["x"]);
	});

	it("still coalesces a burst into at most two frames per window", () => {
		const client = startSession("task-batch-burst-1");

		emit("a");
		emit("b");
		emit("c");
		vi.advanceTimersByTime(BATCH_MS);

		// The leading edge sends "a" alone, the window's trailing flush sends "bc".
		expect(client.sent.join("")).toBe("abc");
		expect(client.sent.length).toBeLessThanOrEqual(2);
	});

	it("holds the message rate to two frames per window under a continuous stream, losing and reordering nothing", () => {
		const client = startSession("task-batch-rate-1");

		// 4 ms between chunks for a second: unbatched that is 250 frames.
		let expected = "";
		for (let ms = 0; ms < 1000; ms += 4) {
			emit(`${ms}|`);
			expected += `${ms}|`;
			vi.advanceTimersByTime(4);
		}
		vi.advanceTimersByTime(PTY_BATCH_INTERVAL_MAX_MS);

		expect(client.sent.join("")).toBe(expected);
		// TWO per window, not one: the leading edge opens each window with a small
		// frame and the timer closes it with the coalesced rest. That is the price
		// of never delaying a lone echo, and it is still an order of magnitude
		// below the raw chunk rate an agent produces.
		const windows = 1000 / BATCH_MS;
		expect(client.sent.length).toBeLessThanOrEqual(2 * windows + 2);
		expect(client.sent.length).toBeGreaterThan(windows);
	});
});

describe("broadcast backpressure", () => {
	it("widens the window instead of sending into a saturated socket", () => {
		const client = startSession("task-bp-on-1");
		client.buffered = PTY_BACKPRESSURE_HIGH_WATER_BYTES;

		emit("first");
		// No leading-edge send: the socket cannot absorb it.
		expect(client.sent).toEqual([]);
		vi.advanceTimersByTime(BATCH_MS);
		expect(client.sent).toEqual([]);

		emit("second");
		vi.advanceTimersByTime(PTY_BATCH_INTERVAL_MAX_MS);
		// Nothing dropped — the whole stream arrives, just later and coalesced.
		expect(client.sent.join("")).toBe("firstsecond");
	});

	it("reads pressure from a registered probe, not only from the local socket", () => {
		const client = startSession("task-bp-probe-1");
		// The loopback socket looks idle; the tunnel-facing one is saturated.
		client.buffered = 0;
		const off = registerBackpressureProbe("task-bp-probe-1", () => PTY_BACKPRESSURE_HIGH_WATER_BYTES);

		emit("under pressure");
		expect(client.sent).toEqual([]);
		vi.advanceTimersByTime(PTY_BATCH_INTERVAL_MAX_MS);
		expect(client.sent).toEqual(["under pressure"]);

		// Unregistered: the fast path is back.
		off();
		emit("clear");
		expect(client.sent).toEqual(["under pressure", "clear"]);
	});

	it("survives a probe that throws because its owner is gone", () => {
		const client = startSession("task-bp-probe-2");
		registerBackpressureProbe("task-bp-probe-2", () => { throw new Error("socket closed"); });

		expect(() => emit("still fine")).not.toThrow();
		expect(client.sent).toEqual(["still fine"]);
	});
});

describe("pressure changing mid-session", () => {
	it("switches cadence on a live session without losing or reordering output", () => {
		const client = startSession("task-flip-1");
		client.buffered = PTY_BACKPRESSURE_HIGH_WATER_BYTES;

		// Saturated: no leading edge, and the window is at its widest.
		emit("before|");
		expect(client.sent).toEqual([]);
		vi.advanceTimersByTime(PTY_BATCH_INTERVAL_MAX_MS);
		expect(client.sent).toEqual(["before|"]);

		// Drained: the next chunk takes the fast path again.
		client.buffered = 0;
		emit("during|");
		expect(client.sent).toEqual(["before|", "during|"]);

		// Pressured again mid-stream — the low-water mark already throttles.
		client.buffered = PTY_BACKPRESSURE_LOW_WATER_BYTES;
		emit("after|");
		expect(client.sent).toEqual(["before|", "during|"]);
		vi.advanceTimersByTime(PTY_BATCH_INTERVAL_MAX_MS);

		expect(client.sent.join("")).toBe("before|during|after|");
	});

	// The overlay's `q` row answers "is a backlog sitting in the server". Sampled
	// before the flush it froze at the last chunk's size, so a drained idle session
	// showed a permanent multi-KB queue in warn colour — measured live at 8.2 KB with
	// nothing flowing and the socket at zero.
	it("reports an empty queue once the bytes have been flushed", () => {
		startSession("task-queue-gauge-1");

		emit("some output|");
		vi.advanceTimersByTime(BATCH_MS);

		expect(throughputSnapshot()["task-queue-gauge-1"].queued).toBe(0);
	});

	it("reports the real backlog while the socket cannot take it", () => {
		const client = startSession("task-queue-gauge-2");
		client.buffered = PTY_BACKPRESSURE_HIGH_WATER_BYTES;

		emit("held|");
		emit("and more|");

		// Nothing left, so the gauge has to show it rather than a zero.
		const snap = throughputSnapshot()["task-queue-gauge-2"];
		expect(snap.queued).toBe("held|and more|".length);
		expect(snap.queuedPeak).toBe("held|and more|".length);
	});

	it("drops the session's throughput counters when the session is destroyed", () => {
		startSession("task-throughput-1");
		emit("output|");
		vi.advanceTimersByTime(BATCH_MS);
		expect(throughputSnapshot()).toHaveProperty("task-throughput-1");

		destroySession("task-throughput-1");

		// tmux is the DEFAULT backend, so a leak here is one entry per task ever
		// launched — and the overlay would keep listing sessions that are long gone.
		expect(throughputSnapshot()).not.toHaveProperty("task-throughput-1");
	});

	it("does not strand bytes already pending when the pressure lifts", () => {
		const client = startSession("task-flip-2");
		client.buffered = PTY_BACKPRESSURE_HIGH_WATER_BYTES;

		emit("queued|");
		client.buffered = 0;
		// The open window still owns the pending bytes; the change does not lose them.
		emit("next|");
		vi.advanceTimersByTime(PTY_BATCH_INTERVAL_MAX_MS);

		expect(client.sent.join("")).toBe("queued|next|");
	});
});

describe("freeze capture recording", () => {
	afterEach(() => ptyOutputRecorder.setEnabled(false));

	it("keeps no terminal output while freeze capture is off", () => {
		startSession("task-freeze-off-1");
		emit("private output");
		vi.advanceTimersByTime(PTY_BATCH_INTERVAL_MAX_MS);
		expect(ptyOutputRecorder.snapshot()).toEqual([]);
	});

	it("records exactly the frames a viewer was sent, in order, and forgets the viewer on close", () => {
		ptyOutputRecorder.setEnabled(true);
		const client = startSession("task-freeze-rec-1");
		for (let i = 0; i < 20; i++) {
			emit(`chunk${i}|`);
			vi.advanceTimersByTime(5);
		}
		vi.advanceTimersByTime(PTY_BATCH_INTERVAL_MAX_MS);

		const [record] = ptyOutputRecorder.snapshot();
		expect(client.sent.length).toBeGreaterThan(1);
		expect(record!.chunks.map((chunk) => chunk.text)).toEqual(client.sent);
		expect(record!.sessionKey).toBe("task-freeze-rec-1");

		wsHandlers.close(client);
		expect(ptyOutputRecorder.snapshot()).toEqual([]);
	});
});

describe("TUI redraw coalescing (DEC 2026 & CSI erase)", () => {
	it("classifies unclosed DEC 2026 and CSI erase chunks for deferred leading-edge flush", () => {
		expect(shouldDeferLeadingEdgeFlush("x")).toBe(false);
		expect(shouldDeferLeadingEdgeFlush("\x1b[?2026hhello\x1b[?2026l")).toBe(false);
		expect(shouldDeferLeadingEdgeFlush("\x1b[?2026h\x1b[1A")).toBe(true);
		expect(shouldDeferLeadingEdgeFlush("\x1b[?2026h\x1b[?2026l\x1b[?2026hnext")).toBe(true);
		expect(shouldDeferLeadingEdgeFlush("\x1b[2K")).toBe(true);
		expect(shouldDeferLeadingEdgeFlush("\x1b[0J")).toBe(true);
	});

	it("coalesces a multi-chunk DEC 2026 redraw into a single WebSocket message", () => {
		const client = startSession("task-redraw-sync-1");

		emit("\x1b[?2026h\x1b[2K");
		// Held briefly instead of flushing the erased half immediately.
		expect(client.sent).toEqual([]);

		vi.advanceTimersByTime(1);
		emit("footer line\x1b[?2026l");
		expect(client.sent).toEqual([]);

		vi.advanceTimersByTime(3);
		expect(client.sent).toEqual(["\x1b[?2026h\x1b[2Kfooter line\x1b[?2026l"]);
	});

	it("coalesces a multi-chunk CSI erase + repaint without mode 2026 into one message", () => {
		const client = startSession("task-redraw-erase-1");

		emit("\x1b[2K\x1b[1A\x1b[2K");
		expect(client.sent).toEqual([]);

		vi.advanceTimersByTime(2);
		emit("new footer");
		vi.advanceTimersByTime(3);

		expect(client.sent).toEqual(["\x1b[2K\x1b[1A\x1b[2Knew footer"]);
	});

	it("caps redraw debouncing at PTY_BATCH_INTERVAL_MS so continuous output never starves", () => {
		const client = startSession("task-redraw-cap-1");

		emit("\x1b[2Kchunk0");
		for (let i = 1; i <= 10; i++) {
			vi.advanceTimersByTime(2);
			emit(`|chunk${i}`);
		}
		// 20 ms elapsed (> 16 ms cap) — must have flushed at least once already.
		expect(client.sent.length).toBeGreaterThanOrEqual(1);

		vi.advanceTimersByTime(BATCH_MS);
		const joined = client.sent.join("");
		expect(joined).toContain("\x1b[2Kchunk0");
		expect(joined).toContain("|chunk10");
	});
});
