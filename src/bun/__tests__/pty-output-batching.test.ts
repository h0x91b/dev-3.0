/**
 * PTY output batching: leading-edge flush and broadcast backpressure (seq 1470).
 *
 * Both live behind FEATURE_FLAGS.remoteTerminalLatency, so every behaviour is
 * asserted on BOTH branches — a flagged change covered on one branch is untested.
 * The tests drive the server's real WebSocket handlers with a fake client, the
 * same channel remote mode proxies to a browser.
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
import { FEATURE_FLAGS } from "../../shared/feature-flags";
import { setFeatureFlags, _resetFeatureFlagsForTests } from "../feature-flags";
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
const { createSession, destroySession, hasSession, registerBackpressureProbe } = pty;

const FLAG = FEATURE_FLAGS.remoteTerminalLatency;
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
	_resetFeatureFlagsForTests();
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
	_resetFeatureFlagsForTests();
});

describe("leading-edge flush", () => {
	it("makes an isolated keystroke echo wait the full window when the flag is off", () => {
		setFeatureFlags({ [FLAG]: false });
		const client = startSession("task-batch-off-1");

		emit("x");
		expect(client.sent).toEqual([]);

		vi.advanceTimersByTime(BATCH_MS);
		expect(client.sent).toEqual(["x"]);
	});

	it("sends an isolated keystroke echo with no delay when the flag is on", () => {
		setFeatureFlags({ [FLAG]: true });
		const client = startSession("task-batch-on-1");

		emit("x");
		expect(client.sent).toEqual(["x"]);

		// Nothing left over: the window closes without a second, empty frame.
		vi.advanceTimersByTime(BATCH_MS * 4);
		expect(client.sent).toEqual(["x"]);
	});

	it("still coalesces a burst into one frame per window on both branches", () => {
		for (const enabled of [false, true]) {
			_resetFeatureFlagsForTests();
			setFeatureFlags({ [FLAG]: enabled });
			const client = startSession(`task-batch-burst-${enabled}`);

			emit("a");
			emit("b");
			emit("c");
			vi.advanceTimersByTime(BATCH_MS);

			// Leading edge sends "a" alone, then "bc"; trailing edge sends "abc".
			expect(client.sent.join("")).toBe("abc");
			expect(client.sent.length).toBeLessThanOrEqual(2);
		}
	});

	it("loses no bytes and keeps their order across many windows", () => {
		setFeatureFlags({ [FLAG]: true });
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
	it("keeps blasting into a saturated socket when the flag is off", () => {
		setFeatureFlags({ [FLAG]: false });
		const client = startSession("task-bp-off-1");
		client.buffered = PTY_BACKPRESSURE_HIGH_WATER_BYTES;

		emit("first");
		vi.advanceTimersByTime(BATCH_MS);
		expect(client.sent).toEqual(["first"]);
	});

	it("widens the window instead of sending into a saturated socket", () => {
		setFeatureFlags({ [FLAG]: true });
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
		setFeatureFlags({ [FLAG]: true });
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
		setFeatureFlags({ [FLAG]: true });
		const client = startSession("task-bp-probe-2");
		registerBackpressureProbe("task-bp-probe-2", () => { throw new Error("socket closed"); });

		expect(() => emit("still fine")).not.toThrow();
		expect(client.sent).toEqual(["still fine"]);
	});

	it("returns to the normal cadence once the socket drains", () => {
		setFeatureFlags({ [FLAG]: true });
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

describe("mid-session flag flip", () => {
	it("switches cadence on a live session without losing or reordering output", () => {
		setFeatureFlags({ [FLAG]: false });
		const client = startSession("task-flip-1");

		emit("before|");
		expect(client.sent).toEqual([]);
		vi.advanceTimersByTime(BATCH_MS);
		expect(client.sent).toEqual(["before|"]);

		// Flip on mid-stream: the next chunk takes the fast path.
		setFeatureFlags({ [FLAG]: true });
		emit("during|");
		expect(client.sent).toEqual(["before|", "during|"]);

		// Flip back off: the next chunk waits out the window again.
		setFeatureFlags({ [FLAG]: false });
		emit("after|");
		expect(client.sent).toEqual(["before|", "during|"]);
		vi.advanceTimersByTime(BATCH_MS);

		expect(client.sent.join("")).toBe("before|during|after|");
	});

	it("flushes data already pending when the flag flips", () => {
		setFeatureFlags({ [FLAG]: false });
		const client = startSession("task-flip-2");

		emit("queued|");
		setFeatureFlags({ [FLAG]: true });
		// The open window still owns the pending bytes; the flip does not strand them.
		emit("next|");
		vi.advanceTimersByTime(BATCH_MS);

		expect(client.sent.join("")).toBe("queued|next|");
	});
});
