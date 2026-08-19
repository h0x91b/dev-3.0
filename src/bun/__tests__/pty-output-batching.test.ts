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
import {
	PTY_BACKPRESSURE_HIGH_WATER_BYTES,
	PTY_BACKPRESSURE_LOW_WATER_BYTES,
	PTY_BATCH_INTERVAL_MAX_MS,
} from "../pty-backpressure";
import { encodeAckSequence, PTY_DROP_HIGH_WATER_BYTES } from "../../shared/pty-flow-control";
import { tmux, taskSessionName } from "../tmux";

// The PTY server's WebSocket handlers are part of the unit under test; intercept
// the config `Bun.serve` is handed at module load.
interface WsHandlers {
	open(ws: unknown): void;
	close(ws: unknown): void;
	message(ws: unknown, message: string): void;
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
const { createSession, destroySession, hasSession, registerBackpressureProbe } = pty;

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
/** The PTY the last spawned shell writes to — what a keystroke would reach. */
let shellTerminal: { write: ReturnType<typeof vi.fn> };
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
		shellTerminal = { close: vi.fn(), resize: vi.fn(), write: vi.fn() } as never;
		return {
			pid: 100,
			terminal: shellTerminal,
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

	it("holds the message rate to two frames per window under a continuous stream", () => {
		const client = startSession("task-batch-rate-1");

		// 4 ms between chunks for a second: unbatched that is 250 frames.
		for (let ms = 0; ms < 1000; ms += 4) {
			emit("o");
			vi.advanceTimersByTime(4);
		}
		vi.advanceTimersByTime(BATCH_MS);

		expect(client.sent.join("")).toBe("o".repeat(250));
		// TWO per window, not one: the leading edge opens each window with a small
		// frame and the timer closes it with the coalesced rest. That is the price
		// of never delaying a lone echo, and it is still an order of magnitude
		// below the raw chunk rate an agent produces.
		const windows = 1000 / BATCH_MS;
		expect(client.sent.length).toBeLessThanOrEqual(2 * windows + 2);
		expect(client.sent.length).toBeGreaterThan(windows);
	});

	it("loses no bytes and keeps their order across many windows", () => {
		const client = startSession("task-batch-order-1");

		for (let i = 0; i < 50; i++) {
			emit(`chunk${i}|`);
			vi.advanceTimersByTime(5);
		}
		vi.advanceTimersByTime(PTY_BATCH_INTERVAL_MAX_MS);

		const expected = Array.from({ length: 50 }, (_, i) => `chunk${i}|`).join("");
		expect(client.sent.join("")).toBe(expected);
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

	it("returns to the normal cadence once the socket drains", () => {
		const client = startSession("task-bp-drain-1");
		client.buffered = PTY_BACKPRESSURE_LOW_WATER_BYTES;

		emit("slow");
		expect(client.sent).toEqual([]);
		vi.advanceTimersByTime(PTY_BATCH_INTERVAL_MAX_MS);
		expect(client.sent).toEqual(["slow"]);

		client.buffered = 0;
		emit("fast");
		expect(client.sent).toEqual(["slow", "fast"]);
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

		// Saturated again mid-stream.
		client.buffered = PTY_BACKPRESSURE_HIGH_WATER_BYTES;
		emit("after|");
		expect(client.sent).toEqual(["before|", "during|"]);
		vi.advanceTimersByTime(PTY_BATCH_INTERVAL_MAX_MS);

		expect(client.sent.join("")).toBe("before|during|after|");
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

/**
 * Viewer flow control — the honest half of the fix for seq 1575's slow motion.
 *
 * Backpressure above can only widen the window; it never drops, so a viewer
 * slower than the shell falls further behind forever and replays history as a
 * video. These tests pin the escape: past the high-water mark output is thrown
 * away, and tmux is asked to repaint once the viewer is back.
 */
describe("viewer flow control", () => {
	/** Fill 128 KB per chunk — four of them cross the 512 KB high-water mark. */
	const CHUNK = "z".repeat(128 * 1024);

	/** Tell the server this client has consumed `total` bytes on its socket. */
	function ack(client: FakeClient, total: number): void {
		wsHandlers.message(client, encodeAckSequence(total));
	}

	/** Everything the client was actually handed, in bytes. */
	function received(client: FakeClient): number {
		return client.sent.reduce((sum, frame) => sum + frame.length, 0);
	}

	let listClients: ReturnType<typeof vi.spyOn>;
	let refreshClient: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		listClients = vi.spyOn(tmux, "listClients").mockResolvedValue([{ name: "/dev/ttys009" }] as never);
		refreshClient = vi.spyOn(tmux, "refreshClient").mockResolvedValue(undefined as never);
	});

	afterEach(() => {
		listClients.mockRestore();
		refreshClient.mockRestore();
	});

	it("never drops for a viewer that does not report progress at all", () => {
		const client = startSession("task-fc-silent");

		// An older renderer, or any plain WebSocket client: it opts out by saying
		// nothing, and must keep the old never-drop behaviour rather than starve.
		for (let i = 0; i < 20; i++) {
			emit(CHUNK);
			vi.advanceTimersByTime(BATCH_MS);
		}

		expect(received(client)).toBe(20 * CHUNK.length);
	});

	it("never drops for a viewer that keeps up", () => {
		const client = startSession("task-fc-fast");
		ack(client, 0);

		for (let i = 0; i < 20; i++) {
			emit(CHUNK);
			vi.advanceTimersByTime(BATCH_MS);
			ack(client, received(client));
		}

		expect(received(client)).toBe(20 * CHUNK.length);
	});

	it("stops sending to a viewer that stopped consuming", () => {
		const client = startSession("task-fc-stalled");
		ack(client, 0);

		for (let i = 0; i < 20; i++) {
			emit(CHUNK);
			vi.advanceTimersByTime(BATCH_MS);
		}

		// It never acked again, so it is held just past the high-water mark and the
		// rest is discarded instead of queued into a slow-motion replay.
		expect(received(client)).toBeLessThan(PTY_DROP_HIGH_WATER_BYTES + CHUNK.length);
		expect(received(client)).toBeGreaterThan(0);
	});

	it("repaints from tmux once the viewer catches up, and resumes sending", async () => {
		const client = startSession("task-fc-recover");
		ack(client, 0);

		for (let i = 0; i < 20; i++) {
			emit(CHUNK);
			vi.advanceTimersByTime(BATCH_MS);
		}
		const droppedFrom = received(client);
		expect(refreshClient).not.toHaveBeenCalled();

		// Caught up: the discarded bytes left the screen wrong, so tmux — which
		// still holds the real screen — is asked to redraw it.
		ack(client, droppedFrom);
		await vi.advanceTimersByTimeAsync(0);

		// THIS session's clients, not every client on the shared tmux socket:
		// refreshing the wrong one repaints somebody else's task.
		expect(listClients).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ target: taskSessionName("task-fc-recover") }),
		);
		expect(refreshClient).toHaveBeenCalledWith("/dev/ttys009", expect.objectContaining({ bestEffort: true }));

		// And the stream is live again, not stuck in the dropping state.
		emit("after|");
		expect(client.sent[client.sent.length - 1]).toBe("after|");
	});

	it("does not repaint when nothing was ever dropped", async () => {
		const client = startSession("task-fc-nodrop");
		ack(client, 0);

		emit("small");
		ack(client, received(client));
		await vi.advanceTimersByTimeAsync(0);

		expect(refreshClient).not.toHaveBeenCalled();
	});

	it("keeps an ack out of the shell — it is protocol, not keystrokes", () => {
		const client = startSession("task-fc-not-typed");

		wsHandlers.message(client, encodeAckSequence(4096));

		expect(shellTerminal.write).not.toHaveBeenCalled();
	});

	it("survives an ack that claims more than was ever sent", () => {
		const client = startSession("task-fc-overack");
		ack(client, Number.MAX_SAFE_INTEGER);

		// A backlog computed from that ack would be hugely negative; clamping keeps
		// the viewer at zero outstanding and the stream flowing.
		emit("still flowing");
		expect(client.sent[client.sent.length - 1]).toBe("still flowing");
	});

	it("frees the stream when the viewer that was holding it back disconnects", () => {
		const slow = startSession("task-fc-two-viewers");
		const fast = new FakeClient("task-fc-two-viewers");
		wsHandlers.open(fast);
		ack(slow, 0);
		ack(fast, 0);

		for (let i = 0; i < 20; i++) {
			emit(CHUNK);
			vi.advanceTimersByTime(BATCH_MS);
			ack(fast, received(fast));
		}
		// One broadcast, so the slowest viewer decided for both.
		const stalled = received(fast);

		wsHandlers.close(slow);
		emit("free now");

		expect(received(fast)).toBeGreaterThan(stalled);
		expect(fast.sent[fast.sent.length - 1]).toBe("free now");
	});
});
