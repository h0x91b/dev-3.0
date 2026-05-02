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
import { PATHS } from "./electrobun-platform";
import { createLogger } from "./logger";
import { initSecret, createQrToken, createSessionToken, exchangeQrForSession, refreshSession, verifySessionToken } from "./jwt";
import { getTunnelUrl } from "./cloudflare-tunnel";
import { loadSettingsSync } from "./settings";
import { getCurrentUiTheme } from "./theme-state";

const log = createLogger("remote-access");

// ── Auth ────────────────────────────────────────────────────────────

function extractToken(req: Request): string | null {
	const url = new URL(req.url);
	return url.searchParams.get("token") ?? null;
}

async function isSessionAuthenticated(req: Request): Promise<boolean> {
	const token = extractToken(req);
	if (!token) return false;
	return verifySessionToken(token);
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

// Lazily resolved + cached. We cannot resolve at module-eval time because in
// headless mode `PATHS.VIEWS_FOLDER` reads `process.env.DEV3_VIEWS_DIR`, which
// `headless-entry` only sets after this module has already been imported.
// Resolving on first request lets the env settle first; once we hit a real
// directory we cache it forever.
let cachedStaticRoot: string | null = null;

function resolveStaticRoot(): string {
	// Two valid layouts:
	//   Electrobun bundle:  PATHS.VIEWS_FOLDER/mainview/index.html
	//   Flat Vite output:   PATHS.VIEWS_FOLDER/index.html (e.g. headless dist/)
	// Plus a dev fallback resolved relative to this source file.
	const viewsFolder = PATHS.VIEWS_FOLDER || "";
	const candidates: string[] = [];
	if (viewsFolder) {
		candidates.push(resolve(viewsFolder, "mainview"));
		candidates.push(viewsFolder);
	}
	// Dev: bun run src/cli/main.ts remote → resolve from src/bun/ → repo's dist/
	candidates.push(resolve(import.meta.dir, "..", "..", "dist"));

	for (const candidate of candidates) {
		if (existsSync(join(candidate, "index.html"))) return candidate;
	}

	log.warn("No static assets found yet", { candidates });
	return candidates[candidates.length - 1]; // returned for the 404, not cached
}

function getStaticRoot(): string {
	if (cachedStaticRoot && existsSync(join(cachedStaticRoot, "index.html"))) {
		return cachedStaticRoot;
	}
	const root = resolveStaticRoot();
	if (existsSync(join(root, "index.html"))) {
		if (cachedStaticRoot !== root) {
			log.info("Static root for remote access", { staticRoot: root });
			cachedStaticRoot = root;
		}
	}
	return root;
}

/** Exported for testing. */
export async function serveStatic(pathname: string): Promise<Response | null> {
	const staticRoot = getStaticRoot();
	let filePath = resolve(staticRoot, "." + pathname);

	// Reject any path that escapes the static root (path traversal)
	if (!filePath.startsWith(staticRoot + "/") && filePath !== staticRoot) return null;

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

	// Re-check after directory resolution
	if (!filePath.startsWith(staticRoot + "/")) return null;

	const ext = extname(filePath).toLowerCase();
	const contentType = MIME_TYPES[ext] || "application/octet-stream";
	const file = Bun.file(filePath);

	if (contentType.startsWith("text/html")) {
		const html = await file.text();
		return new Response(injectInitialThemeBootstrap(html), {
			headers: {
				"Content-Type": contentType,
				"Cache-Control": "no-cache, no-store, must-revalidate",
			},
		});
	}

	return new Response(file, {
		headers: {
			"Content-Type": contentType,
			"Cache-Control": "no-cache, no-store, must-revalidate",
		},
	});
}

function getInitialThemeBootstrap(): { preference: "dark" | "light" | "system"; resolved: "dark" | "light" } {
	const settings = loadSettingsSync();
	const resolved = settings.resolvedTheme ?? getCurrentUiTheme();
	const preference = settings.theme ?? resolved;
	return { preference, resolved };
}

export function injectInitialThemeBootstrap(html: string): string {
	const { preference, resolved } = getInitialThemeBootstrap();
	const script =
		`<script>window.__DEV3_INITIAL_THEME__=${JSON.stringify(preference)};` +
		`window.__DEV3_INITIAL_RESOLVED_THEME__=${JSON.stringify(resolved)};</script>`;

	return html.includes("</head>")
		? html.replace("</head>", `${script}</head>`)
		: `${script}${html}`;
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
	onQrTokenConsumed?: () => void;
}

let qrConsumedCallback: (() => void) | null = null;

/**
 * Resolve the listen port from DEV3_REMOTE_PORT env.
 *
 * Returns 0 (let Bun pick a random port) when unset or invalid. The env is
 * set by the CLI's `--port <n>` flag and is what Docker containers use to
 * map a stable host port to a known container port — otherwise the caller
 * would have to scrape the rolling banner line to discover the port.
 *
 * Invalid values (non-numeric, out of range, < 1, > 65535) fall back to 0
 * rather than crashing: the banner will still print a usable URL. Privileged
 * ports (< 1024) are accepted — bind() will fail later and Bun surfaces the
 * EACCES cleanly, which is a more informative error than "refused at startup".
 */
export function resolveListenPort(): number {
	const raw = process.env.DEV3_REMOTE_PORT;
	if (!raw) return 0;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 1 || n > 65535) {
		log.warn("Invalid DEV3_REMOTE_PORT, falling back to random port", { raw });
		return 0;
	}
	return n;
}

export async function startRemoteAccessServer(options: StartOptions): Promise<void> {
	await initSecret();
	requestHandler = options.rpcHandler;
	ptyPortGetter = options.getPtyPort;
	qrConsumedCallback = options.onQrTokenConsumed ?? null;

	const requestedPort = resolveListenPort();
	const server = Bun.serve<WsData>({
		hostname: "0.0.0.0",
		port: requestedPort, // 0 = random, otherwise pinned via DEV3_REMOTE_PORT
		async fetch(req, server) {
			const url = new URL(req.url);
			const ua = req.headers.get("user-agent")?.slice(0, 80) ?? "unknown";
			const clientIp = req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "direct";

			// Log all non-static requests
			if (url.pathname.startsWith("/auth") || url.pathname === "/rpc" || url.pathname === "/pty" || url.pathname === "/health") {
				log.info("Remote request", {
					method: req.method,
					path: url.pathname,
					ip: clientIp,
					ua,
					hasToken: !!url.searchParams.get("token"),
				});
			}

			// ── Auth endpoints (no session required) ──
			if (url.pathname === "/auth/exchange" && req.method === "POST") {
				try {
					const body = await req.json() as { token?: string };
					if (!body.token) {
						log.warn("Auth exchange: missing token", { ip: clientIp, ua });
						return new Response("Missing token", { status: 400 });
					}
					// Static code path — fixed code, no replay protection, dev only.
					// When active, the JWT exchange path is disabled entirely: only
					// the static code is accepted so that a stale QR JWT cannot bypass it.
					const staticCode = getStaticCode();
					if (staticCode) {
						if (body.token !== staticCode) {
							log.warn("Auth exchange: invalid static code", { ip: clientIp, ua });
							return new Response("Invalid or expired token", { status: 401 });
						}
						const sessionToken = await createSessionToken();
						log.info("Auth exchange: static code accepted", { ip: clientIp, ua });
						qrConsumedCallback?.();
						return Response.json({ token: sessionToken });
					}
					const sessionToken = await exchangeQrForSession(body.token);
					if (!sessionToken) {
						log.warn("Auth exchange: invalid/expired QR token", { ip: clientIp, ua });
						return new Response("Invalid or expired token", { status: 401 });
					}
					log.info("Auth exchange: success", { ip: clientIp, ua });
					qrConsumedCallback?.();
					return Response.json({ token: sessionToken });
				} catch (err) {
					log.error("Auth exchange: error", { ip: clientIp, error: String(err) });
					return new Response("Bad request", { status: 400 });
				}
			}

			if (url.pathname === "/auth/refresh" && req.method === "POST") {
				try {
					const body = await req.json() as { token?: string };
					if (!body.token) return new Response("Missing token", { status: 400 });
					const newToken = await refreshSession(body.token);
					if (!newToken) {
						log.warn("Auth refresh: invalid/expired session", { ip: clientIp });
						return new Response("Invalid or expired token", { status: 401 });
					}
					log.info("Auth refresh: success", { ip: clientIp });
					return Response.json({ token: newToken });
				} catch {
					return new Response("Bad request", { status: 400 });
				}
			}

			// ── WebSocket upgrades (session token required) ──
			if (url.pathname === "/rpc") {
				const authed = await isSessionAuthenticated(req);
				if (!authed) {
					log.warn("RPC WS upgrade: unauthorized", { ip: clientIp, ua, hasToken: !!extractToken(req) });
					return new Response("Unauthorized", { status: 401 });
				}
				log.info("RPC WS upgrade: authorized", { ip: clientIp, ua });
				if (server.upgrade(req, { data: { type: "rpc" } as WsData })) return;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			if (url.pathname === "/pty") {
				const authed = await isSessionAuthenticated(req);
				if (!authed) {
					log.warn("PTY WS upgrade: unauthorized", { ip: clientIp, ua });
					return new Response("Unauthorized", { status: 401 });
				}
				const sessionId = url.searchParams.get("session");
				if (!sessionId) return new Response("Missing session param", { status: 400 });
				log.info("PTY WS upgrade: authorized", { ip: clientIp, session: sessionId.slice(0, 8) });
				if (server.upgrade(req, { data: { type: "pty", sessionId } as WsData })) return;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			// ── API endpoints (session token required) ──
			if (url.pathname === "/health") {
				if (!(await isSessionAuthenticated(req))) return new Response("Unauthorized", { status: 401 });
				return Response.json({ ok: true, ptyPort: ptyPortGetter?.() ?? 0 });
			}

			// ── Static files (no auth — UI code is not sensitive) ──
			const resp = await serveStatic(url.pathname);
			if (resp) return resp;
			return (await serveStatic("/")) || new Response("Not Found", { status: 404 });
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
		for (const iface of (interfaces[name] ?? [])) {
			if (iface.family === "IPv4" && !iface.internal) {
				return iface.address;
			}
		}
	}
	return "localhost";
}

/**
 * True when `dev3 remote --static-code=<value>` is in effect. In that mode the
 * URL token is the fixed user-supplied code (not a rolling JWT), the auth
 * exchange accepts it as a magic word, and the QR auto-refresher is skipped.
 * Intended for local dev only — there is no replay protection.
 */
export function getStaticCode(): string | null {
	return process.env.DEV3_REMOTE_STATIC_CODE || null;
}

export async function getAccessUrl(): Promise<string> {
	const token = getStaticCode() ?? await createQrToken();
	const tunnel = getTunnelUrl();
	if (tunnel) return `${tunnel}/?token=${token}`;
	const ip = getLocalIp();
	return `http://${ip}:${serverPort}/?token=${token}`;
}

export function getBaseUrl(): string {
	const ip = getLocalIp();
	return `http://${ip}:${serverPort}/`;
}

export function getServerPort(): number {
	return serverPort;
}

function printAccessInfo(): void {
	const url = getBaseUrl();
	const sep = "═".repeat(60);
	console.log("");
	console.log(`╔${sep}╗`);
	console.log(`║  🌐 Remote Access                                          ║`);
	console.log(`╠${sep}╣`);
	console.log(`║                                                            ║`);
	console.log(`║  ${url.padEnd(58)}║`);
	console.log(`║  Use the QR code feature for authenticated access.${" ".repeat(7)}║`);
	console.log(`║                                                            ║`);
	console.log(`╚${sep}╝`);
	console.log("");
}

/**
 * Generate a QR code as a data URL (PNG) for display in the GUI.
 */
export async function generateQrDataUrl(): Promise<string> {
	const url = await getAccessUrl();
	return QRCode.toDataURL(url, { width: 256, margin: 2 });
}
