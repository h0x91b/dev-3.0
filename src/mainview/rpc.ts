import { Electroview } from "electrobun/view";
import type { AppRPCSchema } from "../shared/types";
import { adjustZoom, applyZoom, ZOOM_STEP, DEFAULT_ZOOM } from "./zoom";

// Push message handlers — shared between Electrobun and browser transports
const pushMessageHandlers: Record<string, (payload: any) => void> = {
	taskUpdated: (payload) => window.dispatchEvent(new CustomEvent("rpc:taskUpdated", { detail: payload })),
	projectUpdated: (payload) => window.dispatchEvent(new CustomEvent("rpc:projectUpdated", { detail: payload })),
	ptyDied: (payload) => window.dispatchEvent(new CustomEvent("rpc:ptyDied", { detail: payload })),
	projectPtyDied: (payload) => window.dispatchEvent(new CustomEvent("rpc:projectPtyDied", { detail: payload })),
	terminalBell: (payload) => window.dispatchEvent(new CustomEvent("rpc:terminalBell", { detail: payload })),
	gitOpCompleted: (payload) => window.dispatchEvent(new CustomEvent("rpc:gitOpCompleted", { detail: payload })),
	branchMerged: (payload) => window.dispatchEvent(new CustomEvent("rpc:branchMerged", { detail: payload })),
	updateAvailable: (payload) => window.dispatchEvent(new CustomEvent("rpc:updateAvailable", { detail: payload })),
	portsUpdated: (payload) => window.dispatchEvent(new CustomEvent("rpc:portsUpdated", { detail: payload })),
	resourceUsageUpdated: (payload) => window.dispatchEvent(new CustomEvent("rpc:resourceUsageUpdated", { detail: payload })),
	updateDownloadProgress: (payload) => window.dispatchEvent(new CustomEvent("rpc:updateDownloadProgress", { detail: payload })),
	navigateToSettings: () => window.dispatchEvent(new CustomEvent("rpc:navigateToSettings")),
	navigateToGaugeDemo: () => window.dispatchEvent(new CustomEvent("rpc:navigateToGaugeDemo")),
	navigateToViewportLab: () => window.dispatchEvent(new CustomEvent("rpc:navigateToViewportLab")),
	terminalSoftReset: () => window.dispatchEvent(new CustomEvent("rpc:terminalSoftReset")),
	terminalHardReset: () => window.dispatchEvent(new CustomEvent("rpc:terminalHardReset")),
	zoomIn: () => adjustZoom(ZOOM_STEP),
	zoomOut: () => adjustZoom(-ZOOM_STEP),
	zoomReset: () => applyZoom(DEFAULT_ZOOM),
	showRemoteAccessQR: (payload) => window.dispatchEvent(new CustomEvent("rpc:showRemoteAccessQR", { detail: payload })),
	qrTokenConsumed: () => window.dispatchEvent(new CustomEvent("rpc:qrTokenConsumed")),
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
	return { ...rawApi, request: enrichRequest(rawApi.request as any) } as any;
}

// ── Browser WebSocket transport ─────────────────────────────────────
// Used when running in Chrome/Safari (remote access server or Vite dev).
function initBrowserApi(): ApiShape {
	const FALLBACK_RPC_PORT = (globalThis as any).__DEV3_BROWSER_RPC_PORT || 19191;
	const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const isViteDevServer = window.location.port === "5173";

	// ── JWT session token (in-memory only) ──
	let sessionToken: string | null = null;
	let authReady: Promise<void>;

	// Extract QR token from URL and clean it from the address bar
	const urlParams = new URLSearchParams(window.location.search);
	const qrToken = urlParams.get("token") || "";
	console.log("[browser-rpc] init", { isViteDevServer, hasQrToken: !!qrToken, protocol: wsProtocol });
	if (qrToken) {
		window.history.replaceState({}, "", window.location.pathname);
	}

	// Exchange QR token for session token
	async function authenticate(): Promise<void> {
		if (isViteDevServer || !qrToken) {
			console.log("[browser-rpc] auth skip", { isViteDevServer, hasToken: !!qrToken });
			return;
		}
		console.log("[browser-rpc] Exchanging QR token...");
		try {
			const resp = await fetch("/auth/exchange", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token: qrToken }),
			});
			if (resp.ok) {
				const data = await resp.json();
				sessionToken = data.token;
				console.log("[browser-rpc] Auth OK, got session token");
			} else {
				console.error("[browser-rpc] Token exchange failed:", resp.status);
				window.dispatchEvent(new CustomEvent("rpc:authFailed", { detail: { status: resp.status } }));
			}
		} catch (err) {
			console.error("[browser-rpc] Token exchange error:", err);
			window.dispatchEvent(new CustomEvent("rpc:authFailed", { detail: { error: String(err) } }));
		}
	}

	// Refresh session token periodically (every 15 minutes)
	function startRefreshTimer(): void {
		setInterval(async () => {
			if (!sessionToken) return;
			try {
				const resp = await fetch("/auth/refresh", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ token: sessionToken }),
				});
				if (resp.ok) {
					const data = await resp.json();
					sessionToken = data.token;
					console.log("[browser-rpc] Session token refreshed");
				}
			} catch {
				// Will retry on next interval
			}
		}, 15 * 60 * 1000);
	}

	// Build authenticated WebSocket URL
	function buildWsUrl(path: string, extraParams?: string): string {
		if (isViteDevServer) {
			return `ws://localhost:${FALLBACK_RPC_PORT}${path}`;
		}
		const tokenParam = sessionToken ? `token=${sessionToken}` : "";
		const params = [tokenParam, extraParams].filter(Boolean).join("&");
		return `${wsProtocol}//${window.location.host}${path}${params ? `?${params}` : ""}`;
	}

	// Start auth, then connect
	authReady = authenticate().then(() => {
		if (!isViteDevServer) startRefreshTimer();
	});

	let ws: WebSocket | null = null;
	let requestId = 0;
	const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	// Promise that resolves when WS is open — reset on each connect
	let wsReady: Promise<void>;
	let wsReadyResolve: (() => void) | null = null;

	function resetWsReady() {
		wsReady = new Promise((resolve) => { wsReadyResolve = resolve; });
	}
	resetWsReady();

	function connect() {
		const wsUrl = buildWsUrl("/rpc");
		console.log("[browser-rpc] Connecting WS to", wsUrl.replace(/token=[^&]+/, "token=***"));
		resetWsReady();
		ws = new WebSocket(wsUrl);

		ws.addEventListener("open", () => {
			console.log("[browser-rpc] WS OPEN");
			wsReadyResolve?.();
		});

		ws.addEventListener("message", (event) => {
			try {
				const packet = JSON.parse(event.data);

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
		});

		ws.addEventListener("close", (event) => {
			console.warn("[browser-rpc] WS CLOSED", { code: event.code, reason: event.reason, hasToken: !!sessionToken });
			// Only reconnect if we have a valid session token (or are in Vite dev mode).
			// Without a token the server returns 401 and we'd loop forever.
			if (isViteDevServer || sessionToken) {
				setTimeout(connect, 2000);
			} else {
				console.warn("[browser-rpc] No session token — skipping reconnect");
			}
		});

		ws.addEventListener("error", (event) => {
			console.error("[browser-rpc] WS ERROR", event);
		});
	}

	// Gate WS connection behind auth
	authReady.then(connect);

	function rpcRequest(method: string, params: any): Promise<any> {
		return new Promise((resolve, reject) => {
			const id = ++requestId;
			const timeout = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`RPC request "${method}" timed out`));
			}, RPC_TIMEOUT_MS);

			pending.set(id, {
				resolve: (v) => { clearTimeout(timeout); resolve(v); },
				reject: (e) => { clearTimeout(timeout); reject(e); },
			});

			const packet = JSON.stringify({ type: "request", id, method, params });

			// Wait for WS to be open before sending (no polling)
			wsReady.then(() => {
				if (!pending.has(id)) return; // already timed out
				if (ws?.readyState === WebSocket.OPEN) {
					ws.send(packet);
				}
			});
		});
	}

	// ── Browser-side overrides for native-only methods ──────────────
	const browserOverrides: Record<string, (params: any) => Promise<any>> = {
		async pickFolder(): Promise<string | null> {
			const path = prompt("Enter folder path:");
			return path?.trim() || null;
		},

		async showConfirm(params: { title: string; message: string }): Promise<boolean> {
			return confirm(`${params.title}\n\n${params.message}`);
		},

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
						return rpcRequest("uploadImageBase64", {
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

		async getPtyUrl(params: { taskId: string; resume?: boolean }): Promise<string> {
			// Call the server to ensure PTY session is initialized (result unused — we build our own WS URL)
			await rpcRequest("getPtyUrl", params);
			const tokenParam = sessionToken ? `&token=${sessionToken}` : "";
			return `${wsProtocol}//${window.location.host}/pty?session=${params.taskId}${tokenParam}`;
		},

		async hideApp(): Promise<void> {
			// No-op in browser
		},

		async quitApp(): Promise<void> {
			// No-op in browser
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
