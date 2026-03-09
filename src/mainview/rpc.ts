import { Electroview } from "electrobun/view";
import type { AppRPCSchema } from "../shared/types";
import { adjustZoom, applyZoom, ZOOM_STEP, DEFAULT_ZOOM } from "./zoom";

// Push message handlers — shared between Electrobun and browser transports
const pushMessageHandlers: Record<string, (payload: any) => void> = {
	taskUpdated: (payload) => window.dispatchEvent(new CustomEvent("rpc:taskUpdated", { detail: payload })),
	projectUpdated: (payload) => window.dispatchEvent(new CustomEvent("rpc:projectUpdated", { detail: payload })),
	ptyDied: (payload) => window.dispatchEvent(new CustomEvent("rpc:ptyDied", { detail: payload })),
	terminalBell: (payload) => window.dispatchEvent(new CustomEvent("rpc:terminalBell", { detail: payload })),
	gitOpCompleted: (payload) => window.dispatchEvent(new CustomEvent("rpc:gitOpCompleted", { detail: payload })),
	branchMerged: (payload) => window.dispatchEvent(new CustomEvent("rpc:branchMerged", { detail: payload })),
	updateAvailable: (payload) => window.dispatchEvent(new CustomEvent("rpc:updateAvailable", { detail: payload })),
	portsUpdated: (payload) => window.dispatchEvent(new CustomEvent("rpc:portsUpdated", { detail: payload })),
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
};

/**
 * Detect if we're running inside Electrobun (WKWebView) or a regular browser.
 * Electrobun injects __electrobunWebviewId on the window object.
 */
const isElectrobun = typeof (window as any).__electrobunWebviewId !== "undefined";

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

// ── Electrobun transport ────────────────────────────────────────────
// Only executed inside WKWebView where electrobun/view is the real module.
// In browser mode, the import resolves to a stub (via Vite alias) but this
// function is never called.
function initElectrobunApi(): ApiShape {
	const rpc = Electroview.defineRPC<AppRPCSchema>({
		maxRequestTime: 120_000,
		handlers: {
			requests: {},
			messages: pushMessageHandlers as any,
		},
	});

	const electroview = new Electroview({ rpc });
	return electroview.rpc! as any;
}

// ── Browser WebSocket transport ─────────────────────────────────────
// Used when running in Chrome/Safari via Vite dev server.
function initBrowserApi(): ApiShape {
	const BROWSER_RPC_PORT = (globalThis as any).__DEV3_BROWSER_RPC_PORT || 19191;
	const wsUrl = `ws://localhost:${BROWSER_RPC_PORT}/rpc`;

	let ws: WebSocket | null = null;
	let requestId = 0;
	const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

	function connect() {
		ws = new WebSocket(wsUrl);

		ws.addEventListener("open", () => {
			console.log("[browser-rpc] Connected to", wsUrl);
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

		ws.addEventListener("close", () => {
			console.warn("[browser-rpc] Disconnected, reconnecting in 2s...");
			setTimeout(connect, 2000);
		});

		ws.addEventListener("error", () => {
			// close event will fire after this, triggering reconnect
		});
	}

	connect();

	function rpcRequest(method: string, params: any): Promise<any> {
		return new Promise((resolve, reject) => {
			const id = ++requestId;
			const timeout = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`RPC request "${method}" timed out`));
			}, 120_000);

			pending.set(id, {
				resolve: (v) => { clearTimeout(timeout); resolve(v); },
				reject: (e) => { clearTimeout(timeout); reject(e); },
			});

			const packet = JSON.stringify({ type: "request", id, method, params });

			if (ws?.readyState === WebSocket.OPEN) {
				ws.send(packet);
			} else {
				// Wait for connection, then send
				const waitForOpen = () => {
					if (ws?.readyState === WebSocket.OPEN) {
						ws.send(packet);
					} else {
						setTimeout(waitForOpen, 100);
					}
				};
				waitForOpen();
			}
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
						// Send to backend to save the file
						return rpcRequest("uploadImageBase64", {
							projectId: params.projectId,
							base64,
						});
					}
				}
				return null;
			} catch (err) {
				console.warn("[browser-rpc] Clipboard read failed:", err);
				return null;
			}
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
