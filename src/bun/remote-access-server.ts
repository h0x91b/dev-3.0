/**
 * Remote Access Server.
 *
 * A single HTTP + WebSocket server on 0.0.0.0:random that serves the full UI
 * to any browser on the local network. Replaces the previous browser-rpc-server.
 *
 * Features:
 *   - Static file serving (built Vite assets from dist/)
 *   - RPC WebSocket at /rpc (same JSON wire protocol as Electrobun IPC)
 *   - PTY WebSocket proxy at /pty?session=xxx
 *   - Passkey authentication → httpOnly cookie
 *   - QR code generation for easy mobile access
 */

import { existsSync, statSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import QRCode from "qrcode";
import { PATHS } from "electrobun/bun";
import { createLogger } from "./logger";

const log = createLogger("remote-access");

// ── Auth ────────────────────────────────────────────────────────────

const PASSKEY = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
const COOKIE_NAME = "dev3_access";
const COOKIE_MAX_AGE = 86400; // 24 hours

function isAuthenticated(req: Request): boolean {
	const cookies = req.headers.get("cookie") || "";
	if (cookies.includes(`${COOKIE_NAME}=${PASSKEY}`)) return true;

	// Also check query param for initial auth
	const url = new URL(req.url);
	return url.searchParams.get("key") === PASSKEY;
}

function authCookieHeader(): string {
	return `${COOKIE_NAME}=${PASSKEY}; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}; Path=/`;
}

// ── Static file serving ─────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
	".ico": "image/x-icon",
	".map": "application/json",
};

function getStaticRoot(): string {
	// Production: Electrobun bundles assets into PATHS.VIEWS_FOLDER/mainview/
	const prodRoot = resolve(PATHS.VIEWS_FOLDER, "mainview");
	if (existsSync(join(prodRoot, "index.html"))) return prodRoot;

	// Dev: Vite builds to dist/ in the project root
	const devRoot = resolve(import.meta.dir, "..", "..", "dist");
	if (existsSync(join(devRoot, "index.html"))) return devRoot;

	log.warn("No static assets found", { prodRoot, devRoot });
	return devRoot; // return anyway, will 404
}

const staticRoot = getStaticRoot();
log.info("Static root for remote access", { staticRoot });

async function serveStatic(pathname: string): Promise<Response | null> {
	// Sanitize path traversal
	const safePath = pathname.replace(/\.\./g, "").replace(/\/\//g, "/");
	let filePath = join(staticRoot, safePath === "/" ? "index.html" : safePath);

	// If path doesn't exist, try as directory with index.html
	if (!existsSync(filePath)) {
		const withIndex = join(filePath, "index.html");
		if (existsSync(withIndex)) filePath = withIndex;
		else return null;
	}

	// If it's a directory, serve index.html
	try {
		if (statSync(filePath).isDirectory()) {
			filePath = join(filePath, "index.html");
			if (!existsSync(filePath)) return null;
		}
	} catch {
		return null;
	}

	const ext = extname(filePath).toLowerCase();
	const contentType = MIME_TYPES[ext] || "application/octet-stream";
	const file = Bun.file(filePath);

	return new Response(file, {
		headers: {
			"Content-Type": contentType,
			"Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
		},
	});
}

// ── PTY proxy ───────────────────────────────────────────────────────

let ptyPortGetter: (() => number) | null = null;

/**
 * Proxy a WebSocket connection to the internal PTY server.
 * Browser connects to us at /pty?session=xxx, we forward to localhost:ptyPort.
 */
function proxyToPty(clientWs: any, sessionId: string): void {
	const ptyPort = ptyPortGetter?.() ?? 0;
	if (!ptyPort) {
		clientWs.close(4002, "PTY server not available");
		return;
	}

	const targetUrl = `ws://localhost:${ptyPort}?session=${sessionId}`;
	const upstream = new WebSocket(targetUrl);

	upstream.addEventListener("open", () => {
		log.info("PTY proxy upstream connected", { session: sessionId.slice(0, 8) });
	});

	upstream.addEventListener("message", (event) => {
		try {
			if (typeof event.data === "string") {
				clientWs.sendText(event.data);
			} else {
				clientWs.send(event.data);
			}
		} catch {
			// Client disconnected
		}
	});

	upstream.addEventListener("close", () => {
		try { clientWs.close(); } catch { /* already closed */ }
	});

	upstream.addEventListener("error", () => {
		try { clientWs.close(4003, "PTY upstream error"); } catch { /* ignore */ }
	});

	// Store upstream ref on the client WS for bidirectional forwarding
	(clientWs as any)._ptyUpstream = upstream;
}

// ── RPC ─────────────────────────────────────────────────────────────

type RpcRequestHandler = (method: string, params: any) => Promise<any>;

const rpcClients = new Set<any>();
let requestHandler: RpcRequestHandler | null = null;

async function handleRpcMessage(ws: any, raw: string | ArrayBuffer): Promise<void> {
	const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as unknown as ArrayBuffer);
	const packet = JSON.parse(text);

	if (packet.type === "request") {
		if (!requestHandler) {
			ws.send(JSON.stringify({ type: "response", id: packet.id, success: false, error: "RPC handler not ready" }));
			return;
		}
		try {
			const result = await requestHandler(packet.method, packet.params);
			ws.send(JSON.stringify({ type: "response", id: packet.id, success: true, payload: result }));
		} catch (err) {
			ws.send(JSON.stringify({
				type: "response", id: packet.id, success: false,
				error: err instanceof Error ? err.message : String(err),
			}));
		}
	}
}

// ── Server ──────────────────────────────────────────────────────────

interface WsData {
	type: "rpc" | "pty";
	sessionId?: string;
}

let serverPort = 0;

interface StartOptions {
	rpcHandler: RpcRequestHandler;
	getPtyPort: () => number;
}

export function startRemoteAccessServer(options: StartOptions): void {
	requestHandler = options.rpcHandler;
	ptyPortGetter = options.getPtyPort;

	const server = Bun.serve<WsData>({
		hostname: "0.0.0.0",
		port: 0, // random
		fetch(req, server) {
			const url = new URL(req.url);

			// ── Auth gate ──
			// Allow passkey param on any request (sets cookie + redirects)
			if (url.searchParams.has("key")) {
				if (url.searchParams.get("key") === PASSKEY) {
					// Set cookie and redirect to clean URL (strip key param)
					url.searchParams.delete("key");
					return new Response(null, {
						status: 302,
						headers: {
							Location: url.pathname + url.search,
							"Set-Cookie": authCookieHeader(),
						},
					});
				}
				return new Response("Invalid passkey", { status: 403 });
			}

			if (!isAuthenticated(req)) {
				return new Response("Unauthorized — use the full URL with passkey", { status: 401 });
			}

			// ── WebSocket upgrades ──
			if (url.pathname === "/rpc") {
				if (server.upgrade(req, { data: { type: "rpc" } as WsData })) return;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			if (url.pathname === "/pty") {
				const sessionId = url.searchParams.get("session");
				if (!sessionId) return new Response("Missing session param", { status: 400 });
				if (server.upgrade(req, { data: { type: "pty", sessionId } as WsData })) return;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			// ── API endpoints ──
			if (url.pathname === "/health") {
				return Response.json({ ok: true, ptyPort: ptyPortGetter?.() ?? 0 });
			}

			// ── Static files ──
			return serveStatic(url.pathname).then(resp => {
				if (resp) return resp;
				// SPA fallback: serve index.html for non-file routes
				return serveStatic("/").then(r => r || new Response("Not Found", { status: 404 }));
			});
		},
		websocket: {
			open(ws) {
				const wsData = (ws as any).data as { type: string; sessionId?: string };
				if (wsData.type === "rpc") {
					rpcClients.add(ws);
					log.info("Remote RPC client connected", { total: rpcClients.size });
				} else if (wsData.type === "pty") {
					proxyToPty(ws, wsData.sessionId!);
				}
			},
			message(ws, raw) {
				const wsData = (ws as any).data as { type: string };
				if (wsData.type === "rpc") {
					handleRpcMessage(ws, raw as string).catch(err => {
						log.error("RPC message handler error", { error: String(err) });
					});
				} else if (wsData.type === "pty") {
					// Forward client input to PTY upstream
					const upstream = (ws as any)._ptyUpstream as WebSocket | undefined;
					if (upstream?.readyState === WebSocket.OPEN) {
						const data = typeof raw === "string" ? raw : new TextDecoder().decode(raw as unknown as ArrayBuffer);
						upstream.send(data);
					}
				}
			},
			close(ws) {
				const wsData = (ws as any).data as { type: string };
				if (wsData.type === "rpc") {
					rpcClients.delete(ws);
					log.info("Remote RPC client disconnected", { total: rpcClients.size });
				} else if (wsData.type === "pty") {
					const upstream = (ws as any)._ptyUpstream as WebSocket | undefined;
					if (upstream && upstream.readyState === WebSocket.OPEN) {
						upstream.close();
					}
				}
			},
		},
	});

	serverPort = server.port ?? 0;
	log.info(`Remote access server running on port ${serverPort}`);

	// Print access URL to console
	printAccessInfo();
}

/**
 * Push a message to all connected browser RPC clients.
 */
export function pushToBrowserClients(name: string, payload: any): void {
	if (rpcClients.size === 0) return;
	const packet = JSON.stringify({ type: "message", id: name, payload });
	for (const ws of rpcClients) {
		try {
			ws.send(packet);
		} catch { /* disconnected */ }
	}
}

// ── Access URL helpers ──────────────────────────────────────────────

function getLocalIp(): string {
	const interfaces = networkInterfaces();
	for (const name of Object.keys(interfaces)) {
		for (const iface of interfaces[name]!) {
			if (iface.family === "IPv4" && !iface.internal) {
				return iface.address;
			}
		}
	}
	return "localhost";
}

export function getAccessUrl(): string {
	const ip = getLocalIp();
	return `http://${ip}:${serverPort}/?key=${PASSKEY}`;
}

export function getServerPort(): number {
	return serverPort;
}

function printAccessInfo(): void {
	const url = getAccessUrl();
	const sep = "═".repeat(60);
	console.log("");
	console.log(`╔${sep}╗`);
	console.log(`║  🌐 Remote Access                                          ║`);
	console.log(`╠${sep}╣`);
	console.log(`║                                                            ║`);
	console.log(`║  ${url.padEnd(58)}║`);
	console.log(`║                                                            ║`);
	console.log(`╚${sep}╝`);
	console.log("");

	// Generate QR code in terminal
	QRCode.toString(url, { type: "terminal", small: true }, (err: Error | null | undefined, qr: string) => {
		if (!err && qr) {
			console.log(qr);
		}
	});
}

/**
 * Generate a QR code as a data URL (PNG) for display in the GUI.
 */
export async function generateQrDataUrl(): Promise<string> {
	const url = getAccessUrl();
	return QRCode.toDataURL(url, { width: 256, margin: 2 });
}
