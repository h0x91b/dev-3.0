/**
 * Unit tests for the remote session / reconnect state machine.
 *
 * The headline regression: a dead session token (e.g. desktop app restarted)
 * used to spin the reconnect loop forever — the browser WebSocket API hides
 * the HTTP 401 of a failed upgrade (close code 1006 either way), so the old
 * transport could not tell "network down" from "session dead". The machine
 * now probes POST /auth/refresh on every socket close: an auth rejection
 * terminates the loop (scan-QR screen); a network failure keeps the
 * exponential backoff going.
 */
import { describe, it, expect, vi } from "vitest";
import { createRemoteSession, type SocketLike, type RemoteSessionState } from "../remote-session";

// ── Test doubles ─────────────────────────────────────────────────────

class FakeSocket implements SocketLike {
	readyState = 0;
	sent: string[] = [];
	private listeners: Record<string, ((ev: any) => void)[]> = {};

	addEventListener(type: string, cb: (ev: any) => void): void {
		(this.listeners[type] ??= []).push(cb);
	}
	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.emit("close", { code: 1000, reason: "local close" });
	}
	emit(type: string, ev: Record<string, unknown> = {}): void {
		for (const cb of this.listeners[type] ?? []) cb(ev);
	}
	open(): void {
		this.readyState = 1;
		this.emit("open", {});
	}
}

function createFakeTimers() {
	let now = 0;
	let nextId = 1;
	const timers = new Map<number, { at: number; cb: () => void }>();
	const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
	return {
		setTimeoutFn: ((cb: () => void, ms: number) => {
			const id = nextId++;
			timers.set(id, { at: now + ms, cb });
			return id;
		}) as unknown as typeof setTimeout,
		clearTimeoutFn: ((id: unknown) => {
			timers.delete(id as number);
		}) as unknown as typeof clearTimeout,
		/** Advance fake time, firing due timers in order and letting promises settle. */
		async advance(ms: number): Promise<void> {
			const target = now + ms;
			for (;;) {
				const due = [...timers.entries()]
					.filter(([, t]) => t.at <= target)
					.sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				now = due[1].at;
				timers.delete(due[0]);
				due[1].cb();
				await flush();
			}
			now = target;
			await flush();
		},
		flush,
		pendingCount: () => timers.size,
	};
}

type FetchOutcome = { ok: boolean; status: number } | "network-error";

function createHarness(opts: {
	qrToken?: string | null;
	authMode?: "cookie" | "none";
	exchange?: FetchOutcome;
	refresh?: FetchOutcome | FetchOutcome[];
} = {}) {
	const timers = createFakeTimers();
	const sockets: FakeSocket[] = [];
	const states: RemoteSessionState[] = [];
	const fetchCalls: { url: string; at: number }[] = [];
	const onExpired = vi.fn();
	const onSocketOpen = vi.fn();
	const onSocketClosed = vi.fn();

	const refreshOutcomes = Array.isArray(opts.refresh) ? [...opts.refresh] : null;

	async function fetchFn(url: string): Promise<{ ok: boolean; status: number }> {
		fetchCalls.push({ url, at: Date.now() });
		let outcome: FetchOutcome | undefined;
		if (url.includes("exchange")) {
			outcome = opts.exchange ?? { ok: true, status: 200 };
		} else {
			outcome = refreshOutcomes ? (refreshOutcomes.length > 1 ? refreshOutcomes.shift() : refreshOutcomes[0]) : (opts.refresh as FetchOutcome | undefined) ?? { ok: true, status: 200 };
		}
		if (outcome === "network-error") throw new TypeError("Failed to fetch");
		return outcome!;
	}

	const session = createRemoteSession({
		qrToken: opts.qrToken ?? null,
		authMode: opts.authMode ?? "cookie",
		fetchFn,
		createSocket: () => {
			const s = new FakeSocket();
			sockets.push(s);
			return s;
		},
		setTimeoutFn: timers.setTimeoutFn,
		clearTimeoutFn: timers.clearTimeoutFn,
		callbacks: {
			onStateChange: (s) => states.push(s),
			onExpired,
			onSocketOpen,
			onSocketClosed,
		},
	});

	return { session, timers, sockets, states, fetchCalls, onExpired, onSocketOpen, onSocketClosed };
}

const refreshCalls = (h: ReturnType<typeof createHarness>) => h.fetchCalls.filter((c) => c.url.includes("refresh"));
const exchangeCalls = (h: ReturnType<typeof createHarness>) => h.fetchCalls.filter((c) => c.url.includes("exchange"));

// ── The headline bug: dead session must terminate the reconnect loop ─

describe("reconnect loop termination on dead session", () => {
	it("socket close + refresh 401 → expired, no further reconnect attempts", async () => {
		const h = createHarness({ qrToken: "qr", exchange: { ok: true, status: 200 }, refresh: { ok: false, status: 401 } });
		h.session.start();
		await h.timers.flush();
		expect(h.sockets).toHaveLength(1);
		h.sockets[0].open();

		// The desktop app restarts: socket dies, and the session token no
		// longer verifies (secret rotated / expired).
		h.sockets[0].emit("close", { code: 1006, reason: "" });
		await h.timers.flush();

		expect(h.session.getState()).toBe("expired");
		expect(h.onExpired).toHaveBeenCalledOnce();

		// The old transport looped forever here. Advance far past any backoff:
		// no new sockets, no more probes.
		const probesSoFar = refreshCalls(h).length;
		await h.timers.advance(10 * 60 * 1000);
		expect(h.sockets).toHaveLength(1);
		expect(refreshCalls(h).length).toBe(probesSoFar);
	});

	it("socket close + refresh network error → keeps retrying with backoff", async () => {
		const h = createHarness({ qrToken: "qr", refresh: "network-error" });
		h.session.start();
		await h.timers.flush();
		h.sockets[0].open();
		h.sockets[0].emit("close", { code: 1006, reason: "" });
		await h.timers.flush();

		expect(h.session.getState()).toBe("reconnecting");
		expect(h.onExpired).not.toHaveBeenCalled();

		// Backoff fires → a fresh socket attempt.
		await h.timers.advance(2_000);
		expect(h.sockets).toHaveLength(2);
	});
});

// ── Boot flows ───────────────────────────────────────────────────────

describe("boot with a QR token", () => {
	it("exchange ok → connects and reaches connected on socket open", async () => {
		const h = createHarness({ qrToken: "qr" });
		h.session.start();
		await h.timers.flush();
		expect(exchangeCalls(h)).toHaveLength(1);
		expect(h.sockets).toHaveLength(1);
		h.sockets[0].open();
		expect(h.session.getState()).toBe("connected");
		expect(h.onSocketOpen).toHaveBeenCalledWith(h.sockets[0]);
	});

	it("consumed QR + valid cookie → silent re-entry via refresh probe (reopen from history)", async () => {
		const h = createHarness({
			qrToken: "stale-qr",
			exchange: { ok: false, status: 401 },
			refresh: { ok: true, status: 200 },
		});
		h.session.start();
		await h.timers.flush();
		// Exchange failed, but the cookie probe succeeded — no expired screen.
		expect(h.onExpired).not.toHaveBeenCalled();
		expect(h.sockets).toHaveLength(1);
		h.sockets[0].open();
		expect(h.session.getState()).toBe("connected");
	});

	it("consumed QR + no valid cookie → expired (scan a fresh QR)", async () => {
		const h = createHarness({
			qrToken: "stale-qr",
			exchange: { ok: false, status: 401 },
			refresh: { ok: false, status: 401 },
		});
		h.session.start();
		await h.timers.flush();
		expect(h.session.getState()).toBe("expired");
		expect(h.onExpired).toHaveBeenCalledOnce();
		expect(h.sockets).toHaveLength(0);
	});
});

describe("boot without a QR token", () => {
	it("valid cookie → silent reconnect", async () => {
		const h = createHarness({ refresh: { ok: true, status: 200 } });
		h.session.start();
		await h.timers.flush();
		expect(h.sockets).toHaveLength(1);
	});

	it("no session → expired immediately, never an eternal spinner", async () => {
		const h = createHarness({ refresh: { ok: false, status: 401 } });
		h.session.start();
		await h.timers.flush();
		expect(h.session.getState()).toBe("expired");
		expect(h.sockets).toHaveLength(0);
	});

	it("network down → retries the probe with exponential backoff (2s doubling, 15s cap)", async () => {
		const h = createHarness({ refresh: "network-error" });
		h.session.start();
		await h.timers.flush();
		expect(refreshCalls(h)).toHaveLength(1);

		await h.timers.advance(2_000);
		expect(refreshCalls(h)).toHaveLength(2);
		await h.timers.advance(4_000);
		expect(refreshCalls(h)).toHaveLength(3);
		await h.timers.advance(8_000);
		expect(refreshCalls(h)).toHaveLength(4);
		// Capped at 15s from here on.
		await h.timers.advance(15_000);
		expect(refreshCalls(h)).toHaveLength(5);
		await h.timers.advance(15_000);
		expect(refreshCalls(h)).toHaveLength(6);
		expect(h.onExpired).not.toHaveBeenCalled();
	});

	it("network down then server back with valid cookie → connects", async () => {
		const h = createHarness({ refresh: ["network-error", { ok: true, status: 200 }] });
		h.session.start();
		await h.timers.flush();
		expect(h.sockets).toHaveLength(0);
		await h.timers.advance(2_000);
		expect(h.sockets).toHaveLength(1);
	});
});

// ── Reconnect backoff ────────────────────────────────────────────────

describe("reconnect backoff", () => {
	it("doubles the delay on repeated failures and resets after a successful open", async () => {
		const h = createHarness({ qrToken: "qr", refresh: { ok: true, status: 200 } });
		h.session.start();
		await h.timers.flush();
		h.sockets[0].open();

		// First drop → probe ok → reconnect after ~2s.
		h.sockets[0].emit("close", { code: 1006, reason: "" });
		await h.timers.flush();
		await h.timers.advance(2_000);
		expect(h.sockets).toHaveLength(2);

		// Second drop without an open in between → 4s.
		h.sockets[1].emit("close", { code: 1006, reason: "" });
		await h.timers.flush();
		await h.timers.advance(2_000);
		expect(h.sockets).toHaveLength(2); // not yet
		await h.timers.advance(2_000);
		expect(h.sockets).toHaveLength(3);

		// Successful open resets the backoff to 2s.
		h.sockets[2].open();
		h.sockets[2].emit("close", { code: 1006, reason: "" });
		await h.timers.flush();
		await h.timers.advance(2_000);
		expect(h.sockets).toHaveLength(4);
	});
});

// ── Rolling refresh ──────────────────────────────────────────────────

describe("periodic session refresh", () => {
	it("probes /auth/refresh on the refresh interval while connected", async () => {
		const h = createHarness({ qrToken: "qr", refresh: { ok: true, status: 200 } });
		h.session.start();
		await h.timers.flush();
		h.sockets[0].open();
		const before = refreshCalls(h).length;
		await h.timers.advance(15 * 60 * 1000);
		expect(refreshCalls(h).length).toBe(before + 1);
		await h.timers.advance(15 * 60 * 1000);
		expect(refreshCalls(h).length).toBe(before + 2);
	});

	it("a 401 on periodic refresh expires the session and closes the socket", async () => {
		const h = createHarness({ qrToken: "qr", refresh: { ok: false, status: 401 } });
		h.session.start();
		await h.timers.flush();
		h.sockets[0].open();
		await h.timers.advance(15 * 60 * 1000);
		expect(h.session.getState()).toBe("expired");
		expect(h.sockets[0].readyState).toBe(3);
	});
});

// ── Vite dev mode (no auth endpoints) ────────────────────────────────

describe("authMode 'none' (Vite dev)", () => {
	it("connects without any fetch calls and reconnects on close", async () => {
		const h = createHarness({ authMode: "none" });
		h.session.start();
		await h.timers.flush();
		expect(h.fetchCalls).toHaveLength(0);
		expect(h.sockets).toHaveLength(1);
		h.sockets[0].open();
		h.sockets[0].emit("close", { code: 1006, reason: "" });
		await h.timers.advance(2_000);
		expect(h.sockets).toHaveLength(2);
		expect(h.fetchCalls).toHaveLength(0);
	});
});

// ── kick() (resume / Retry button) ───────────────────────────────────

describe("kick", () => {
	it("replaces a possibly-dead socket with a fresh one immediately", async () => {
		const h = createHarness({ qrToken: "qr" });
		h.session.start();
		await h.timers.flush();
		h.sockets[0].open();

		h.session.kick();
		await h.timers.flush();
		expect(h.sockets[0].readyState).toBe(3); // old one closed
		expect(h.sockets).toHaveLength(2);
		expect(h.onExpired).not.toHaveBeenCalled();
	});

	it("is a no-op once expired", async () => {
		const h = createHarness({ refresh: { ok: false, status: 401 } });
		h.session.start();
		await h.timers.flush();
		expect(h.session.getState()).toBe("expired");
		h.session.kick();
		await h.timers.flush();
		expect(h.sockets).toHaveLength(0);
	});
});
