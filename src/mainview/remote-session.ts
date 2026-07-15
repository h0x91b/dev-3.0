/**
 * Remote session / reconnect state machine (decision 132).
 *
 * Owns everything the browser transport needs to decide: the QR-token →
 * session-cookie exchange, the silent cookie revival on boot, the rolling
 * refresh while the tab is open, and — critically — the reconnect loop.
 *
 * The browser WebSocket API hides the HTTP status of a failed upgrade (close
 * code 1006 whether the server is down or the session is dead), so on every
 * socket close the machine probes POST /auth/refresh: an auth rejection
 * (401/403) terminates the loop and surfaces `onExpired` (the scan-QR
 * screen); a network failure keeps the exponential backoff going (2s
 * doubling, 15s cap). The session credential itself is an HttpOnly cookie —
 * this module never sees it; the injected `fetchFn` must send requests with
 * same-origin credentials.
 *
 * Pure logic with injected fetch, WebSocket factory, and timers so the whole
 * machine is unit-testable without a browser; `rpc.ts` is the thin wiring.
 */

export type RemoteSessionState =
	| "idle"
	| "authenticating"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "expired";

/** The subset of the WebSocket surface the machine touches. */
export interface SocketLike {
	readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: string, cb: (ev: any) => void): void;
}

export interface FetchResponseLike {
	ok: boolean;
	status: number;
}

export interface RemoteSessionCallbacks {
	onStateChange?: (state: RemoteSessionState) => void;
	/** A socket finished its handshake — flush queued requests into it. */
	onSocketOpen?: (socket: SocketLike) => void;
	onMessage?: (data: unknown) => void;
	/** The active socket dropped — reject in-flight requests. */
	onSocketClosed?: (info: { code: number; reason: string; hadConnected: boolean }) => void;
	/** The session is dead for good — show the scan-QR screen. */
	onExpired?: (detail: Record<string, unknown>) => void;
	onError?: (detail: string) => void;
}

export interface RemoteSessionOptions {
	/** One-time QR token from the page URL, if any. */
	qrToken?: string | null;
	/** "cookie" = real remote server; "none" = Vite dev (no auth endpoints). */
	authMode: "cookie" | "none";
	fetchFn: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<FetchResponseLike>;
	createSocket: () => SocketLike;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
	/** Rolling-refresh cadence; default 15 minutes. */
	refreshIntervalMs?: number;
	backoffInitialMs?: number;
	backoffMaxMs?: number;
	callbacks?: RemoteSessionCallbacks;
}

export interface RemoteSession {
	start(): void;
	/** Force-replace a possibly-dead socket now (resume from background, Retry button). */
	kick(): void;
	getState(): RemoteSessionState;
	getSocket(): SocketLike | null;
	destroy(): void;
}

type ProbeOutcome = "ok" | "unauthorized" | "network";

export function createRemoteSession(opts: RemoteSessionOptions): RemoteSession {
	const {
		qrToken = null,
		authMode,
		fetchFn,
		createSocket,
		setTimeoutFn = setTimeout,
		clearTimeoutFn = clearTimeout,
		refreshIntervalMs = 15 * 60 * 1000,
		backoffInitialMs = 2_000,
		backoffMaxMs = 15_000,
		callbacks = {},
	} = opts;

	let state: RemoteSessionState = "idle";
	let socket: SocketLike | null = null;
	let hasConnected = false;
	let attempts = 0;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	let started = false;
	let destroyed = false;
	let qrSpent = false;

	function setState(next: RemoteSessionState): void {
		if (state === next) return;
		state = next;
		callbacks.onStateChange?.(next);
	}

	// `state` is a captured `let` that async work mutates between awaits; a
	// function call is opaque to TS control-flow narrowing, so re-checks after
	// an await don't trip "no overlap" errors.
	function isDead(): boolean {
		return destroyed || state === "expired";
	}

	function cancelRetry(): void {
		if (retryTimer !== null) {
			clearTimeoutFn(retryTimer);
			retryTimer = null;
		}
	}

	function cancelRefresh(): void {
		if (refreshTimer !== null) {
			clearTimeoutFn(refreshTimer);
			refreshTimer = null;
		}
	}

	/** Next backoff delay: 2s doubling per consecutive failure, capped at 15s. */
	function nextBackoffDelay(): number {
		const delay = Math.min(backoffInitialMs * 2 ** attempts, backoffMaxMs);
		attempts += 1;
		return delay;
	}

	function scheduleRetry(fn: () => void): void {
		if (retryTimer !== null || destroyed) return;
		retryTimer = setTimeoutFn(() => {
			retryTimer = null;
			fn();
		}, nextBackoffDelay());
	}

	/**
	 * Probe the refresh endpoint. "unauthorized" is authoritative — the server
	 * examined the cookie and rejected it. Anything else that isn't a 2xx
	 * (network error, 5xx, proxy hiccup) is transient.
	 */
	async function probeRefresh(): Promise<ProbeOutcome> {
		try {
			const resp = await fetchFn("/auth/refresh", { method: "POST" });
			if (resp.ok) return "ok";
			if (resp.status === 401 || resp.status === 403) return "unauthorized";
			return "network";
		} catch {
			return "network";
		}
	}

	function expire(detail: Record<string, unknown>): void {
		if (isDead()) return;
		cancelRetry();
		cancelRefresh();
		const stale = socket;
		socket = null;
		if (stale) {
			try {
				stale.close();
			} catch {
				/* already closed */
			}
		}
		setState("expired");
		callbacks.onExpired?.(detail);
	}

	function startRefreshLoop(): void {
		if (authMode === "none" || refreshTimer !== null || destroyed) return;
		const tick = async () => {
			refreshTimer = null;
			if (isDead()) return;
			const outcome = await probeRefresh();
			if (isDead()) return;
			if (outcome === "unauthorized") {
				expire({ reason: "refresh-rejected" });
				return;
			}
			// ok → cookie rolled forward; network → try again next interval.
			refreshTimer = setTimeoutFn(() => void tick(), refreshIntervalMs);
		};
		refreshTimer = setTimeoutFn(() => void tick(), refreshIntervalMs);
	}

	function connect(): void {
		if (destroyed || state === "expired" || socket) return;
		setState(hasConnected ? "reconnecting" : "connecting");
		const s = createSocket();
		socket = s;

		s.addEventListener("open", () => {
			if (socket !== s || destroyed) return;
			hasConnected = true;
			attempts = 0;
			setState("connected");
			callbacks.onSocketOpen?.(s);
		});

		s.addEventListener("message", (ev) => {
			if (socket !== s) return;
			callbacks.onMessage?.(ev?.data);
		});

		s.addEventListener("close", (ev) => {
			if (socket !== s) return;
			socket = null;
			callbacks.onSocketClosed?.({
				code: (ev?.code as number) ?? 0,
				reason: (ev?.reason as string) ?? "",
				hadConnected: hasConnected,
			});
			if (isDead()) return;
			void handleClose();
		});

		s.addEventListener("error", () => {
			if (socket !== s) return;
			callbacks.onError?.("WebSocket connection error");
		});
	}

	async function handleClose(): Promise<void> {
		setState("reconnecting");
		if (authMode === "none") {
			scheduleRetry(connect);
			return;
		}
		const outcome = await probeRefresh();
		if (isDead()) return;
		if (outcome === "unauthorized") {
			expire({ reason: "session-rejected-after-close" });
			return;
		}
		scheduleRetry(connect);
	}

	async function bootAuth(): Promise<void> {
		setState("authenticating");
		if (qrToken && !qrSpent) {
			qrSpent = true;
			try {
				const resp = await fetchFn("/auth/exchange", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ token: qrToken }),
				});
				if (destroyed) return;
				if (resp.ok) {
					attempts = 0;
					startRefreshLoop();
					connect();
					return;
				}
				// Consumed/expired QR (typical when the URL is reopened from
				// browser history) — fall through to the cookie probe: a
				// still-valid session must re-enter silently.
			} catch {
				// Network error — fall through to the probe/backoff path.
			}
		}
		const outcome = await probeRefresh();
		if (isDead()) return;
		if (outcome === "ok") {
			attempts = 0;
			startRefreshLoop();
			connect();
			return;
		}
		if (outcome === "unauthorized") {
			expire({ reason: qrToken ? "exchange-and-refresh-rejected" : "no-session" });
			return;
		}
		// Network down — keep probing with backoff until the server answers.
		setState(hasConnected ? "reconnecting" : "connecting");
		scheduleRetry(() => void bootAuth());
	}

	return {
		start(): void {
			if (started || destroyed) return;
			started = true;
			if (authMode === "none") {
				connect();
				return;
			}
			void bootAuth();
		},

		kick(): void {
			if (destroyed || state === "expired" || !started) return;
			// A boot-time auth attempt is still in flight (or backoff-scheduled);
			// its own retry loop recovers — replacing sockets here would race it.
			if (state === "authenticating") return;
			cancelRetry();
			const stale = socket;
			socket = null;
			if (stale) {
				try {
					stale.close();
				} catch {
					/* already closed */
				}
			}
			connect();
		},

		getState(): RemoteSessionState {
			return state;
		},

		getSocket(): SocketLike | null {
			return socket;
		},

		destroy(): void {
			destroyed = true;
			cancelRetry();
			cancelRefresh();
			const stale = socket;
			socket = null;
			if (stale) {
				try {
					stale.close();
				} catch {
					/* already closed */
				}
			}
		},
	};
}
