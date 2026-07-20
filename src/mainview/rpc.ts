import { Electroview } from "electrobun/view";
import type { AppRPCSchema } from "../shared/types";
import { adjustZoom, applyZoom, ZOOM_STEP, DEFAULT_ZOOM } from "./zoom";
import { createWatchdogState, decidePingOutcome, shouldAllowReload } from "./rpc-watchdog";
import { recordDiagnostic, RPC_STATUS_EVENT, type RpcConnectionState } from "./diagnostics";
import { createRemoteSession, type RemoteSessionState, type SocketLike } from "./remote-session";

// ── Transport connection state ──────────────────────────────────────
// Surfaced to the bootstrap screen so a stuck "Loading…" can tell the user
// WHERE it is stuck (connecting / authenticating / reconnecting) instead of
// spinning silently. Desktop (Electrobun) uses a local socket, so it seeds as
// "connected"; the browser remote transport drives the real transitions.
let rpcConnectionState: RpcConnectionState = "connected";
// Set by whichever transport initializes — lets `reconnectRpc()` do a soft
// recovery (re-open socket) before the user has to hard-reload the page.
let reconnectImpl: (() => void) | null = null;

function setRpcState(state: RpcConnectionState): void {
	rpcConnectionState = state;
	try {
		window.dispatchEvent(new CustomEvent(RPC_STATUS_EVENT, { detail: { state } }));
	} catch {
		/* no window (tests) — the getter still returns the value */
	}
}

/** Current RPC/WebSocket connection state (see {@link RpcConnectionState}). */
export function getRpcConnectionState(): RpcConnectionState {
	return rpcConnectionState;
}

/**
 * Soft-recover the transport: re-open the socket without a full page reload
 * (browser) or re-init the Electrobun bridge. Falls back to `location.reload()`
 * if no transport reconnect is wired. Used by the bootstrap "Retry" button.
 */
export function reconnectRpc(): void {
	if (reconnectImpl) {
		try {
			reconnectImpl();
			return;
		} catch (err) {
			console.error("[rpc] reconnect failed, falling back to reload", err);
		}
	}
	try {
		window.location.reload();
	} catch {
		/* no window (tests) */
	}
}

// Push message handlers — shared between Electrobun and browser transports
const pushMessageHandlers: Record<string, (payload: any) => void> = {
	taskUpdated: (payload) => window.dispatchEvent(new CustomEvent("rpc:taskUpdated", { detail: payload })),
	projectUpdated: (payload) => window.dispatchEvent(new CustomEvent("rpc:projectUpdated", { detail: payload })),
	taskSound: (payload) => window.dispatchEvent(new CustomEvent("rpc:taskSound", { detail: payload })),
	ptyDied: (payload) => window.dispatchEvent(new CustomEvent("rpc:ptyDied", { detail: payload })),
	projectPtyDied: (payload) => window.dispatchEvent(new CustomEvent("rpc:projectPtyDied", { detail: payload })),
	terminalBell: (payload) => window.dispatchEvent(new CustomEvent("rpc:terminalBell", { detail: payload })),
	gitOpCompleted: (payload) => window.dispatchEvent(new CustomEvent("rpc:gitOpCompleted", { detail: payload })),
	branchMerged: (payload) => window.dispatchEvent(new CustomEvent("rpc:branchMerged", { detail: payload })),
	mergePromptResolved: (payload) => window.dispatchEvent(new CustomEvent("rpc:mergePromptResolved", { detail: payload })),
	agentCompletionRequested: (payload) => window.dispatchEvent(new CustomEvent("rpc:agentCompletionRequested", { detail: payload })),
	updateAvailable: (payload) => window.dispatchEvent(new CustomEvent("rpc:updateAvailable", { detail: payload })),
	portsUpdated: (payload) => window.dispatchEvent(new CustomEvent("rpc:portsUpdated", { detail: payload })),
	exposedPortsChanged: (payload) => window.dispatchEvent(new CustomEvent("rpc:exposedPortsChanged", { detail: payload })),
	resourceUsageUpdated: (payload) => window.dispatchEvent(new CustomEvent("rpc:resourceUsageUpdated", { detail: payload })),
	agentRateLimitsUpdated: (payload) => window.dispatchEvent(new CustomEvent("rpc:agentRateLimitsUpdated", { detail: payload })),
	updateDownloadProgress: (payload) => window.dispatchEvent(new CustomEvent("rpc:updateDownloadProgress", { detail: payload })),
	cloneProgress: (payload) => window.dispatchEvent(new CustomEvent("rpc:cloneProgress", { detail: payload })),
	columnAgentFailed: (payload) => window.dispatchEvent(new CustomEvent("rpc:columnAgentFailed", { detail: payload })),
	taskPreparationFailed: (payload) => window.dispatchEvent(new CustomEvent("rpc:taskPreparationFailed", { detail: payload })),
	globalSettingsUpdated: (payload) => window.dispatchEvent(new CustomEvent("rpc:globalSettingsUpdated", { detail: payload })),
	openTaskFromNotification: (payload) => window.dispatchEvent(new CustomEvent("rpc:openTaskFromNotification", { detail: payload })),
	cliToast: (payload) => window.dispatchEvent(new CustomEvent("rpc:cliToast", { detail: payload })),
	cliAttention: (payload) => window.dispatchEvent(new CustomEvent("rpc:cliAttention", { detail: payload })),
	cliShowImage: (payload) => window.dispatchEvent(new CustomEvent("rpc:cliShowImage", { detail: payload })),
	cliShowArtifact: (payload) => window.dispatchEvent(new CustomEvent("rpc:cliShowArtifact", { detail: payload })),
	webNotification: (payload) => window.dispatchEvent(new CustomEvent("rpc:webNotification", { detail: payload })),
	taskPrStatus: (payload) => window.dispatchEvent(new CustomEvent("rpc:taskPrStatus", { detail: payload })),
	automationsUpdated: (payload) => window.dispatchEvent(new CustomEvent("rpc:automationsUpdated", { detail: payload })),
	automationRunsMissed: (payload) => window.dispatchEvent(new CustomEvent("rpc:automationRunsMissed", { detail: payload })),
	openCreateTaskModal: () => window.dispatchEvent(new CustomEvent("rpc:openCreateTaskModal")),
	navigateToSettings: () => window.dispatchEvent(new CustomEvent("rpc:navigateToSettings")),
	navigateToGaugeDemo: () => window.dispatchEvent(new CustomEvent("rpc:navigateToGaugeDemo")),
	navigateToViewportLab: () => window.dispatchEvent(new CustomEvent("rpc:navigateToViewportLab")),
	terminalSoftReset: () => window.dispatchEvent(new CustomEvent("rpc:terminalSoftReset")),
	terminalHardReset: () => window.dispatchEvent(new CustomEvent("rpc:terminalHardReset")),
	zoomIn: () => adjustZoom(ZOOM_STEP),
	zoomOut: () => adjustZoom(-ZOOM_STEP),
	zoomReset: () => applyZoom(DEFAULT_ZOOM),
	osc52Clipboard: (payload) => window.dispatchEvent(new CustomEvent("rpc:osc52Clipboard", { detail: payload })),
	showRemoteAccessQR: (payload) => window.dispatchEvent(new CustomEvent("rpc:showRemoteAccessQR", { detail: payload })),
	qrTokenConsumed: () => window.dispatchEvent(new CustomEvent("rpc:qrTokenConsumed")),
	menuAction: (payload) => window.dispatchEvent(new CustomEvent("rpc:menuAction", { detail: payload })),
	showQuitDialog: () => window.dispatchEvent(new CustomEvent("rpc:showQuitDialog")),
	showAbout: (payload) => window.dispatchEvent(new CustomEvent("rpc:showAbout", { detail: payload })),
	updateCheckOutcome: (payload) => window.dispatchEvent(new CustomEvent("rpc:updateCheckOutcome", { detail: payload })),
};

/**
 * Detect if we're running inside Electrobun (WKWebView) or a regular browser.
 * Electrobun injects __electrobunWebviewId on the window object.
 */
export const isElectrobun = typeof (window as any).__electrobunWebviewId !== "undefined";


// Add .browser-mode class to <html> when running outside Electrobun.
// Scopes mobile-friendly CSS rules (e.g. font-size: 16px on inputs) to browser only.
if (!isElectrobun) {
	document.documentElement.classList.add("browser-mode");
}

// --- RPC API type (matches what components expect) ---
type BunRequests = AppRPCSchema["bun"]["requests"];
type RequestProxy = {
	[K in keyof BunRequests]: (
		...args: BunRequests[K]["params"] extends void ? [] : [params: BunRequests[K]["params"]]
	) => Promise<BunRequests[K]["response"]>;
};

interface ApiShape {
	request: RequestProxy;
}

const RPC_TIMEOUT_MS = 120_000;

// Wrap api.request to enrich timeout errors with the method name.
// Electrobun rejects with a generic "RPC request timed out." — no indication
// of which method failed.  This proxy catches that and re-throws with context
// so the unhandled-rejection tracker (analytics.ts) and console show something
// actionable like: 'RPC "getBranchStatus" timed out (120 000 ms)'.
function enrichRequest(rawRequest: RequestProxy): RequestProxy {
	return new Proxy(rawRequest, {
		get(target: RequestProxy, prop: string | symbol, receiver: unknown) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				const promise = (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
				return promise.catch((err: unknown) => {
					const msg = err instanceof Error ? err.message : String(err);
					if (/timed?\s*out/i.test(msg)) {
						throw new Error(`RPC "${String(prop)}" timed out (${RPC_TIMEOUT_MS} ms)`);
					}
					throw err;
				});
			};
		},
	});
}

// ── Electrobun transport ────────────────────────────────────────────
// Only executed inside WKWebView where electrobun/view is the real module.
// In browser mode, the import resolves to a stub (via Vite alias) but this
// function is never called.
// Liveness-probe timing for the bridge watchdog. The ping races a short timeout
// (independent of RPC_TIMEOUT_MS) so a jammed socket is detected in seconds, not
// the 2-minute request timeout.
const PING_TIMEOUT_MS = 4_000;
const PING_INTERVAL_MS = 30_000;
const RELOAD_MIN_GAP_MS = 30_000;

// Guard against reload loops: if a previous watchdog reload happened very
// recently (same browser session), skip another one and let socket re-init try.
// The gap decision lives in shouldAllowReload (unit-tested); this only handles
// the sessionStorage I/O.
function allowWatchdogReload(now: number): boolean {
	try {
		const KEY = "dev3-rpc-watchdog-last-reload";
		const last = Number(sessionStorage.getItem(KEY) || NaN);
		if (!shouldAllowReload(now, last, RELOAD_MIN_GAP_MS)) return false;
		sessionStorage.setItem(KEY, String(now));
		return true;
	} catch {
		return true;
	}
}

// Watchdog for the desktop transport: the Electrobun localhost socket has no
// reconnect, so after sleep it can die with every request hanging forever. We
// ping on a timer and on wake/focus; on confirmed failure we re-open the socket,
// and as a last resort reload the webview (bun stays alive, so this recovers the
// bridge without a force-quit).
function startBridgeWatchdog(electroview: Electroview<any>, rawRequest: RequestProxy): void {
	const state = createWatchdogState();
	let inFlight = false;

	async function pingOnce(): Promise<boolean> {
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				(rawRequest as any).ping(),
				new Promise((_, reject) => {
					timeoutId = setTimeout(() => reject(new Error("ping timeout")), PING_TIMEOUT_MS);
				}),
			]);
			return true;
		} catch {
			return false;
		} finally {
			// Clear the race timer regardless of which leg won, so a successful
			// ping doesn't leave a dangling timeout every interval.
			if (timeoutId) clearTimeout(timeoutId);
		}
	}

	async function check(): Promise<void> {
		if (inFlight) return;
		// Only probe while the window is visible — no point pinging (or recovering)
		// a backgrounded app, and it avoids racing the OS as it suspends/resumes.
		if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
		inFlight = true;
		try {
			const ok = await pingOnce();
			const action = decidePingOutcome(state, ok, Date.now());
			if (action === "reinit") {
				console.warn("[rpc-watchdog] bridge unresponsive — re-opening Electrobun socket");
				try {
					// Close the stale socket first — initSocketToBun() opens a fresh
					// WebSocket and reassigns bunSocket without closing the old one,
					// which would leak a socket on every re-init.
					electroview.bunSocket?.close();
					electroview.initSocketToBun();
				} catch (err) {
					console.error("[rpc-watchdog] socket re-init failed", err);
				}
			} else if (action === "reload") {
				console.warn("[rpc-watchdog] bridge still dead after re-init — reloading webview");
				recordDiagnostic({
					kind: "rpc",
					level: "error",
					message: "Bridge unresponsive — reloading the app",
					source: "rpc-watchdog",
				});
				if (allowWatchdogReload(Date.now())) window.location.reload();
			}
		} finally {
			inFlight = false;
		}
	}

	setInterval(() => void check(), PING_INTERVAL_MS);
	if (typeof document !== "undefined") {
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible") void check();
		});
	}
	window.addEventListener("focus", () => void check());
}

function initElectrobunApi(): ApiShape {
	const rpc = Electroview.defineRPC<AppRPCSchema>({
		maxRequestTime: RPC_TIMEOUT_MS,
		handlers: {
			requests: {},
			messages: pushMessageHandlers as any,
		},
	});

	const electroview = new Electroview({ rpc });
	const rawApi = electroview.rpc!;
	startBridgeWatchdog(electroview, rawApi.request as any);
	// Desktop socket is local — seed "connected" and wire a soft reconnect so the
	// bootstrap "Retry" re-opens the bridge without a full reload.
	setRpcState("connected");
	reconnectImpl = () => {
		try {
			electroview.bunSocket?.close();
		} catch {
			/* already closed */
		}
		electroview.initSocketToBun();
	};
	return { ...rawApi, request: enrichRequest(rawApi.request as any) } as any;
}

// ── Browser WebSocket transport ─────────────────────────────────────
// Used when running in Chrome/Safari (remote access server or Vite dev).
// Session auth rides an HttpOnly cookie set by POST /auth/exchange (decision
// 133): this code never sees the credential — it just sends same-origin
// requests. All session/reconnect DECISIONS live in the remote-session state
// machine (unit-tested); this function is the thin browser wiring around it.
function initBrowserApi(): ApiShape {
	const FALLBACK_RPC_PORT = (globalThis as any).__DEV3_BROWSER_RPC_PORT || 19191;
	const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const isViteDevServer = window.location.port === "5173";

	// Pre-cookie versions persisted the session token in localStorage — purge
	// the stale credential from upgraded devices.
	try { localStorage.removeItem("dev3-remote-session"); } catch { /* storage blocked */ }

	function dispatchAuthFailed(detail: Record<string, unknown>): void {
		setRpcState("auth-failed");
		recordDiagnostic({
			kind: "rpc",
			level: "error",
			message: "Remote authentication failed — scan a fresh QR code",
			detail: JSON.stringify(detail),
			source: "auth",
		});
		window.dispatchEvent(new CustomEvent("rpc:authFailed", { detail }));
	}

	// Extract QR token from URL and clean it from the address bar
	const urlParams = new URLSearchParams(window.location.search);
	const qrToken = urlParams.get("token") || "";
	console.log("[browser-rpc] init", { isViteDevServer, hasQrToken: !!qrToken, protocol: wsProtocol });
	if (qrToken) {
		window.history.replaceState({}, "", window.location.pathname);
	}

	function buildWsUrl(path: string, extraParams?: string): string {
		if (isViteDevServer) {
			return `ws://localhost:${FALLBACK_RPC_PORT}${path}`;
		}
		return `${wsProtocol}//${window.location.host}${path}${extraParams ? `?${extraParams}` : ""}`;
	}

	let activeSocket: SocketLike | null = null;
	let requestId = 0;
	let wasHidden = document.visibilityState === "hidden";
	const pending = new Map<number, {
		resolve: (v: any) => void;
		reject: (e: Error) => void;
		packet: string;
		sent: boolean;
	}>();

	function rejectSentRequests(error: Error) {
		for (const [id, entry] of pending.entries()) {
			if (!entry.sent) continue;
			pending.delete(id);
			entry.reject(error);
		}
	}

	function flushQueuedRequests(socket: SocketLike): void {
		for (const entry of pending.values()) {
			if (entry.sent) continue;
			socket.send(entry.packet);
			entry.sent = true;
		}
	}

	function handlePacket(data: unknown): void {
		try {
			const packet = JSON.parse(String(data));

			if (packet.type === "response") {
				const entry = pending.get(packet.id);
				if (entry) {
					pending.delete(packet.id);
					if (packet.success) {
						entry.resolve(packet.payload);
					} else {
						entry.reject(new Error(packet.error || "RPC error"));
					}
				}
			} else if (packet.type === "message") {
				const handler = pushMessageHandlers[packet.id];
				if (handler) handler(packet.payload);
			}
		} catch (err) {
			console.error("[browser-rpc] Parse error:", err);
		}
	}

	function mapSessionState(state: RemoteSessionState): RpcConnectionState {
		switch (state) {
			case "authenticating": return "authenticating";
			case "connected": return "connected";
			case "reconnecting": return "reconnecting";
			case "expired": return "auth-failed";
			default: return "connecting";
		}
	}

	const session = createRemoteSession({
		qrToken: qrToken || null,
		authMode: isViteDevServer ? "none" : "cookie",
		// The HttpOnly session cookie rides same-origin requests; be explicit so
		// a future fetch-default change can't silently drop auth.
		fetchFn: (url, init) => fetch(url, { ...init, credentials: "same-origin" }),
		createSocket: () => new WebSocket(buildWsUrl("/rpc")) as unknown as SocketLike,
		callbacks: {
			onStateChange: (state) => setRpcState(mapSessionState(state)),
			onSocketOpen: (socket) => {
				console.log("[browser-rpc] WS OPEN");
				activeSocket = socket;
				flushQueuedRequests(socket);
			},
			onMessage: handlePacket,
			onSocketClosed: ({ code, reason, hadConnected }) => {
				activeSocket = null;
				console.warn("[browser-rpc] WS CLOSED", { code, reason });
				rejectSentRequests(
					new Error(`RPC connection closed (code ${code}${reason ? `: ${reason}` : ""})`),
				);
				recordDiagnostic({
					kind: "rpc",
					level: hadConnected ? "warn" : "error",
					message: `Connection to the server dropped (code ${code})${reason ? `: ${reason}` : ""}`,
					source: "websocket",
				});
			},
			onExpired: (detail) => {
				activeSocket = null;
				console.warn("[browser-rpc] Session expired — scan a fresh QR", detail);
				dispatchAuthFailed(detail);
			},
			onError: (message) => {
				console.error("[browser-rpc] WS ERROR", message);
				recordDiagnostic({ kind: "rpc", level: "error", message, source: "websocket" });
			},
		},
	});

	// Soft reconnect for the bootstrap "Retry": replace the (possibly dead)
	// socket without a full page reload.
	reconnectImpl = () => {
		rejectSentRequests(new Error("RPC connection restarted"));
		session.kick();
	};

	function reconnectOnResume(event: Event): void {
		if (document.visibilityState === "hidden") {
			wasHidden = true;
			return;
		}
		const returnedFromBackground = wasHidden;
		wasHidden = false;
		// `pageshow` also fires once on a normal first load. Only its persisted
		// (bfcache restore) form is a resume signal; initial auth owns first connect.
		if (event.type === "pageshow" && !(event as PageTransitionEvent).persisted && !returnedFromBackground) return;
		if (session.getState() === "connected" && event.type === "visibilitychange" && !returnedFromBackground) return;
		// A CONNECTING socket created before mobile suspension can remain stuck
		// indefinitely, and an apparently OPEN socket may already be dead underneath.
		// Replace either one after a real background/pageshow/online transition.
		rejectSentRequests(new Error("RPC connection replaced after resume"));
		session.kick();
	}
	document.addEventListener("visibilitychange", reconnectOnResume);
	window.addEventListener("pageshow", reconnectOnResume);
	window.addEventListener("online", reconnectOnResume);

	session.start();

	function rpcRequest(method: string, params: any): Promise<any> {
		return new Promise((resolve, reject) => {
			const id = ++requestId;
			const timeout = setTimeout(() => {
				pending.delete(id);
				recordDiagnostic({
					kind: "rpc",
					level: "error",
					message: `Request "${method}" timed out (${Math.round(RPC_TIMEOUT_MS / 1000)}s) — the server may be unreachable`,
					source: "rpc",
				});
				reject(new Error(`RPC request "${method}" timed out`));
			}, RPC_TIMEOUT_MS);

			const packet = JSON.stringify({ type: "request", id, method, params });
			const entry = {
				resolve: (v: any) => { clearTimeout(timeout); resolve(v); },
				reject: (e: Error) => { clearTimeout(timeout); reject(e); },
				packet,
				sent: false,
			};
			pending.set(id, entry);

			if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
				activeSocket.send(packet);
				entry.sent = true;
			}
		});
	}

	// ── Browser-side overrides for native-only methods ──────────────
	const browserOverrides: Record<string, (params: any) => Promise<any>> = {
		async pasteClipboardImage(params: { projectId: string }): Promise<{ path: string } | null> {
			try {
				const items = await navigator.clipboard.read();
				for (const item of items) {
					const imageType = item.types.find(t => t.startsWith("image/"));
					if (imageType) {
						const blob = await item.getType(imageType);
						const buffer = await blob.arrayBuffer();
						const base64 = btoa(
							new Uint8Array(buffer).reduce((s, b) => s + String.fromCharCode(b), ""),
						);
						return rpcRequest("uploadFileBase64", {
							projectId: params.projectId,
							base64,
							mimeType: imageType,
						});
					}
				}
				return null;
			} catch (err) {
				console.warn("[browser-rpc] Clipboard read failed:", err);
				return null;
			}
		},

		// PTY WebSocket URLs carry no credential: the /pty upgrade authenticates
		// via the same HttpOnly session cookie as /rpc, which the browser
		// attaches to the same-origin upgrade request automatically.
		async getPtyUrl(params: { taskId: string; resume?: boolean }) {
			const result = await rpcRequest("getPtyUrl", params);
			// If the server signals a recoverable session, pass it through
			if (result && typeof result === "object" && "recoverable" in result) {
				return result;
			}
			// Otherwise build our own WS URL for the browser transport
			return { url: `${wsProtocol}//${window.location.host}/pty?session=${params.taskId}` };
		},

		async getProjectPtyUrl(params: { projectId: string }): Promise<string> {
			// Server-side: ensure the tmux session exists.
			// We discard the URL it returns (`ws://localhost:<ptyPort>`) because
			// `localhost` resolves on the laptop in browser mode, not on the
			// server. Build the proxied `/pty` URL relative to window.location.
			await rpcRequest("getProjectPtyUrl", params);
			return `${wsProtocol}//${window.location.host}/pty?session=project-${params.projectId}`;
		},

		async resumeTask(params: { taskId: string }): Promise<string> {
			await rpcRequest("resumeTask", params);
			return `${wsProtocol}//${window.location.host}/pty?session=${params.taskId}`;
		},

		async restartTask(params: { taskId: string }): Promise<string> {
			await rpcRequest("restartTask", params);
			return `${wsProtocol}//${window.location.host}/pty?session=${params.taskId}`;
		},

		async hideApp(): Promise<void> {
			// No-op in browser
		},

		async quitApp(): Promise<void> {
			// No-op in browser
		},

		async requestQuit(): Promise<void> {
			// No-op in browser — you don't quit the host app from a remote tab.
		},

		async consumePendingQuitDialog(): Promise<boolean> {
			// Never pending in browser — the reopen-to-confirm flow is desktop-only.
			return false;
		},

		async openNewWindow(): Promise<void> {
			// No-op in browser — native desktop windows don't exist in a remote tab.
		},
	};

	// Proxy: api.request.methodName(params) → override or rpcRequest
	const request = new Proxy({} as RequestProxy, {
		get(_target, prop: string) {
			if (browserOverrides[prop]) {
				return browserOverrides[prop];
			}
			return (params: any) => rpcRequest(prop, params);
		},
	});

	return { request };
}

// ── Export ───────────────────────────────────────────────────────────
export const api: ApiShape = isElectrobun ? initElectrobunApi() : initBrowserApi();
