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
 *   - QR token → HttpOnly session cookie auth (see the Auth section below)
 *   - QR code generation for easy mobile access
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import QRCode from "qrcode";
import type { RemoteInstanceInfo } from "../shared/remote-protocol";
import type { RemoteNetInterface } from "../shared/types";
import { PATHS } from "./electrobun-platform";
import { createLogger } from "./logger";
import { initSecret, createQrToken, createSessionToken, exchangeQrForSession, getSessionTokenTtl, refreshSession, verifySessionToken, IOS_SESSION_TOKEN_TTL_S, SESSION_TOKEN_TTL_S, type SessionClient } from "./jwt";
import { getTunnelUrl, getTunnelState, tunnelManager } from "./cloudflare-tunnel";
import { startRemoteDiscoveryAdvertisement, type RemoteDiscoveryAdvertisement } from "./remote-discovery";
import { getRemoteInstanceInfo } from "./remote-instance";
import { loadSettingsSync } from "./settings";
import { getCurrentUiTheme } from "./theme-state";
import { prioritizeInterfaces } from "./network-interfaces";

const log = createLogger("remote-access");

// ── Auth ────────────────────────────────────────────────────────────
//
// The session credential is an HttpOnly cookie (decision 133, supersedes 086):
// POST /auth/exchange trades a one-time QR token (or the dev static code) for a
// Set-Cookie; every gated surface — the RPC and PTY WebSocket upgrades,
// /auth/refresh, /health — authenticates by that cookie. The token never
// appears in URLs, so it stops leaking into proxy/tunnel logs, and HttpOnly
// keeps it unreadable to injected script. SameSite=Strict is safe because
// static assets are served unauthenticated (the HTML shell needs no cookie;
// every JS-initiated same-origin fetch/WS upgrade carries it). No Secure flag:
// LAN mode is plain http — same threat model as the URL-is-the-password QR.

export const SESSION_COOKIE_NAME = "dev3_session";

/** Parse a Cookie request header into a name → value record. */
export function parseCookies(header: string | null): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		const name = part.slice(0, eq).trim();
		if (!name) continue;
		out[name] = part.slice(eq + 1).trim();
	}
	return out;
}

/** Build the Set-Cookie value carrying a fresh rolling session token. */
export function buildSessionCookie(token: string, maxAge: number = SESSION_TOKEN_TTL_S): string {
	return `${SESSION_COOKIE_NAME}=${token}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict`;
}

/** Build the Set-Cookie value that deletes the session cookie. */
export function buildClearSessionCookie(): string {
	return `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`;
}

/**
 * Same-origin check for WebSocket upgrades (cross-site WebSocket hijacking)
 * and state-changing auth POSTs (CSRF). Browsers always attach an Origin
 * header to both; a missing Origin means a non-browser client (curl, tests) —
 * allowed, since cookie theft via a hostile page requires a browser, and a
 * non-browser attacker gains nothing over calling the API directly.
 */
export function checkOrigin(req: Request): boolean {
	const origin = req.headers.get("origin");
	if (!origin) return true;
	const host = req.headers.get("host");
	if (!host) return false;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

/** The native session class is accepted only from a non-browser request. */
export function getRequestedSessionClient(req: Request, marker: unknown): SessionClient | undefined {
	return marker === "ios" && !req.headers.has("origin") ? "ios" : undefined;
}

function extractSessionToken(req: Request): string | null {
	return parseCookies(req.headers.get("cookie"))[SESSION_COOKIE_NAME] ?? null;
}

async function isSessionAuthenticated(req: Request): Promise<boolean> {
	const token = extractSessionToken(req);
	if (!token) return false;
	return verifySessionToken(token);
}

interface AuthHandlerContext {
	clientIp?: string;
	ua?: string;
	onQrConsumed?: () => void;
}

/**
 * POST /auth/exchange — trade a one-time QR token (or the dev static code)
 * for a session cookie. Exported for handler-level tests.
 */
export async function handleAuthExchange(req: Request, ctx: AuthHandlerContext = {}): Promise<Response> {
	const { clientIp, ua } = ctx;
	if (!checkOrigin(req)) {
		log.warn("Auth exchange: origin mismatch", { ip: clientIp, ua, origin: req.headers.get("origin") });
		return new Response("Forbidden", { status: 403 });
	}
	try {
		const body = await req.json() as { token?: string; client?: unknown };
		if (!body.token) {
			log.warn("Auth exchange: missing token", { ip: clientIp, ua });
			return new Response("Missing token", { status: 400 });
		}
		const sessionClient = getRequestedSessionClient(req, body.client);
		const sessionTtl = sessionClient === "ios" ? IOS_SESSION_TOKEN_TTL_S : SESSION_TOKEN_TTL_S;
		// Static code path — fixed code, no replay protection, dev only.
		// When active, the JWT exchange path is disabled entirely: only
		// the static code is accepted so that a stale QR JWT cannot bypass it.
		const staticCode = getStaticCode();
		if (staticCode) {
			if (body.token !== staticCode) {
				log.warn("Auth exchange: invalid static code", { ip: clientIp, ua });
				return new Response("Invalid or expired token", { status: 401 });
			}
			const sessionToken = await createSessionToken(sessionClient);
			log.info("Auth exchange: static code accepted", { ip: clientIp, ua });
			ctx.onQrConsumed?.();
			return Response.json({ ok: true }, { headers: { "Set-Cookie": buildSessionCookie(sessionToken, sessionTtl) } });
		}
		const sessionToken = await exchangeQrForSession(body.token, sessionClient);
		if (!sessionToken) {
			// Do NOT clear an existing cookie here: a consumed QR token replayed
			// from browser history must not kill a still-valid session — the
			// client falls back to /auth/refresh with that cookie.
			log.warn("Auth exchange: invalid/expired QR token", { ip: clientIp, ua });
			return new Response("Invalid or expired token", { status: 401 });
		}
		log.info("Auth exchange: success", { ip: clientIp, ua });
		ctx.onQrConsumed?.();
		return Response.json({ ok: true }, { headers: { "Set-Cookie": buildSessionCookie(sessionToken, sessionTtl) } });
	} catch (err) {
		log.error("Auth exchange: error", { ip: clientIp, error: String(err) });
		return new Response("Bad request", { status: 400 });
	}
}

/**
 * POST /auth/refresh — roll the session cookie forward. Authenticates via the
 * cookie itself (no body). A 401 means the session is genuinely dead (expired,
 * tampered, or signed by a previous secret) — the client stops reconnecting
 * and shows the scan-QR screen. Exported for handler-level tests.
 */
export async function handleAuthRefresh(req: Request, ctx: AuthHandlerContext = {}): Promise<Response> {
	const { clientIp, ua } = ctx;
	if (!checkOrigin(req)) {
		log.warn("Auth refresh: origin mismatch", { ip: clientIp, ua, origin: req.headers.get("origin") });
		return new Response("Forbidden", { status: 403 });
	}
	const current = extractSessionToken(req);
	if (!current) {
		log.warn("Auth refresh: no session cookie", { ip: clientIp, ua });
		return new Response("Unauthorized", { status: 401 });
	}
	const newToken = await refreshSession(current);
	if (!newToken) {
		log.warn("Auth refresh: invalid/expired session cookie", { ip: clientIp, ua });
		return new Response("Invalid or expired session", {
			status: 401,
			headers: { "Set-Cookie": buildClearSessionCookie() },
		});
	}
	const sessionTtl = await getSessionTokenTtl(newToken);
	if (!sessionTtl) {
		return new Response("Invalid or expired session", {
			status: 401,
			headers: { "Set-Cookie": buildClearSessionCookie() },
		});
	}
	log.info("Auth refresh: success", { ip: clientIp });
	return Response.json({ ok: true }, { headers: { "Set-Cookie": buildSessionCookie(newToken, sessionTtl) } });
}

/** Unauthenticated metadata used to validate a discovered remote instance. */
export function handleInstanceRequest(info: RemoteInstanceInfo = getRemoteInstanceInfo()): Response {
	return Response.json(info, { headers: { "Cache-Control": "no-store" } });
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

/**
 * Exported for testing. `staticRootOverride` lets tests point at a temp dir
 * without going through the lazily-resolved bundle path.
 */
export async function serveStatic(pathname: string, staticRootOverride?: string): Promise<Response | null> {
	const staticRoot = staticRootOverride ?? getStaticRoot();
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

	// Materialize the file into memory instead of handing Bun.serve a raw
	// `Bun.file` blob. When the body is a Bun.file, Bun serves large files via
	// the zero-copy sendfile(2) fast-path — and on macOS that path drops the
	// HTTP response status line + headers when the socket is a real network
	// interface (LAN), so the client receives a header-less body and rejects it
	// with ERR_INVALID_HTTP_RESPONSE. Loopback (127.0.0.1 / localhost — the path
	// the Cloudflare tunnel origin uses) is unaffected, which is exactly why the
	// blank-page bug only reproduced over direct LAN access and vanished behind
	// Cloudflare. Reading the bytes up front bypasses sendfile entirely.
	// See decisions/113-remote-static-sendfile-lan-headerless.md. readFileSync
	// returns an in-memory Buffer — a body Bun.serve never routes through
	// sendfile, unlike a Bun.file blob backed by an fd.
	const body = readFileSync(filePath);
	return new Response(body, {
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

/** Bounds for client input received while the localhost PTY socket connects. */
export const PTY_PREOPEN_MAX_FRAMES = 64;
export const PTY_PREOPEN_MAX_BYTES = 256 * 1024;

const utf8Encoder = new TextEncoder();

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
	let downstreamCloseStarted = false;
	let acceptingInput = true;
	let pendingInput: string[] = [];
	let pendingInputBytes = 0;
	const clearPendingInput = (): void => {
		acceptingInput = false;
		pendingInput = [];
		pendingInputBytes = 0;
	};
	const closeDownstream = (code?: number, reason?: string): void => {
		if (downstreamCloseStarted) return;
		downstreamCloseStarted = true;
		clearPendingInput();
		try {
			if (code !== undefined) clientWs.close(code, reason ?? "");
			else clientWs.close();
		} catch { /* already closed */ }
	};
	const failProxy = (reason: string): void => {
		clearPendingInput();
		closeUpstreamSocket(upstream);
		closeDownstream(4003, reason);
	};
	const forwardInput = (data: string): void => {
		if (!acceptingInput) return;
		if (upstream.readyState === WebSocket.OPEN) {
			try {
				upstream.send(data);
			} catch {
				failProxy("PTY upstream error");
			}
			return;
		}
		if (upstream.readyState !== WebSocket.CONNECTING) return;

		const byteLength = utf8Encoder.encode(data).byteLength;
		if (
			pendingInput.length >= PTY_PREOPEN_MAX_FRAMES ||
			pendingInputBytes + byteLength > PTY_PREOPEN_MAX_BYTES
		) {
			failProxy("PTY input queue overflow");
			return;
		}
		pendingInput.push(data);
		pendingInputBytes += byteLength;
	};

	upstream.addEventListener("open", () => {
		log.info("PTY proxy upstream connected", { session: sessionId.slice(0, 8) });
		if (!acceptingInput) return;
		const queued = pendingInput;
		pendingInput = [];
		pendingInputBytes = 0;
		for (const data of queued) {
			try {
				upstream.send(data);
			} catch {
				failProxy("PTY upstream error");
				return;
			}
		}
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

	upstream.addEventListener("close", (event) => {
		if (event.code >= 4000 && event.code <= 4003) {
			closeDownstream(event.code, event.reason);
		} else {
			closeDownstream();
		}
	});

	upstream.addEventListener("error", () => {
		failProxy("PTY upstream error");
	});

	// Store proxy hooks on the client WS for bidirectional forwarding and cleanup.
	(clientWs as any)._ptyUpstream = upstream;
	(clientWs as any)._ptyForwardInput = forwardInput;
	(clientWs as any)._ptyCleanup = clearPendingInput;
}

/**
 * Open a WebSocket against the localhost dev server for a shared-tunnel
 * `/p/<subtoken>/<port>/<path>` upgrade, and wire bidirectional message
 * forwarding. Same shape as `proxyToPty` but targets an arbitrary dev port
 * rather than the PTY server. Used by Vite/Next HMR, live-reload, etc.
 */
function proxyToSharedUpstream(clientWs: any, upstreamUrl: string): void {
	const upstream = new WebSocket(upstreamUrl);

	upstream.addEventListener("open", () => {
		log.info("Shared proxy WS upstream connected", { url: upstreamUrl });
	});

	upstream.addEventListener("message", (event) => {
		try {
			if (typeof event.data === "string") {
				clientWs.sendText(event.data);
			} else {
				clientWs.send(event.data);
			}
		} catch {
			// Client disconnected — error will surface via close handler.
		}
	});

	upstream.addEventListener("close", () => {
		try { clientWs.close(); } catch { /* already closed */ }
	});

	upstream.addEventListener("error", () => {
		try { clientWs.close(4003, "Shared upstream error"); } catch { /* ignore */ }
	});

	(clientWs as any)._proxyUpstream = upstream;
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
	type: "rpc" | "pty" | "shared-proxy";
	sessionId?: string;
	/** For `shared-proxy`: the upstream `ws://localhost:<port>/<path>` URL to dial. */
	proxyUpstreamUrl?: string;
}

// ── Shared-tunnel reverse proxy helpers ───────────────────────────────

/**
 * Headers we must not forward end-to-end. RFC 9110 hop-by-hop list plus
 * `host` (we set our own) and `content-length` (Bun's fetch recomputes it
 * from the body). Leaving `connection: keep-alive` in place can wedge Bun's
 * client when the upstream sends `Connection: close`.
 */
const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailers",
	"transfer-encoding",
	"upgrade",
	"host",
	"content-length",
]);

function stripHopByHop(headers: Headers): Headers {
	const out = new Headers();
	for (const [k, v] of headers.entries()) {
		if (!HOP_BY_HOP_HEADERS.has(k.toLowerCase())) out.append(k, v);
	}
	return out;
}

/**
 * Close a proxied upstream socket when its browser-side client goes away.
 * Closing must also happen in CONNECTING — not just OPEN: a client that
 * disconnects mid-handshake would otherwise leak an upstream that goes on to
 * complete its connection and then lingers forever, holding a PTY session slot
 * (F5). `close()` is a no-op once CLOSING/CLOSED, so guard only against CLOSED.
 */
export function closeUpstreamSocket(
	upstream: { readyState: number; close: () => void } | undefined | null,
): void {
	if (upstream && upstream.readyState !== WebSocket.CLOSED) {
		upstream.close();
	}
}

/**
 * Parse `/p/<subtoken>/<port>/<rest...>`. `<rest>` may be empty; `<port>`
 * must be a positive integer in [1, 65535].
 */
export function parseSharedProxyPath(pathname: string): { subToken: string; port: number; rest: string } | null {
	// strip leading "/p/"
	const tail = pathname.slice(3);
	const firstSlash = tail.indexOf("/");
	if (firstSlash <= 0) return null;
	const subToken = tail.slice(0, firstSlash);
	const afterToken = tail.slice(firstSlash + 1);
	const secondSlash = afterToken.indexOf("/");
	const portStr = secondSlash === -1 ? afterToken : afterToken.slice(0, secondSlash);
	const rest = secondSlash === -1 ? "" : afterToken.slice(secondSlash + 1);
	const port = Number.parseInt(portStr, 10);
	if (!Number.isFinite(port) || port < 1 || port > 65535 || String(port) !== portStr) return null;
	if (!subToken) return null;
	return { subToken, port, rest };
}

async function proxyHttpToLocalhost(req: Request, port: number, rest: string, search: string): Promise<Response> {
	const upstreamUrl = `http://localhost:${port}/${rest}${search}`;
	try {
		const upstream = await fetch(upstreamUrl, {
			method: req.method,
			headers: stripHopByHop(req.headers),
			body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
			redirect: "manual",
		});
		// Stream response back. Strip hop-by-hop headers from the upstream's
		// response too — Bun would otherwise let `transfer-encoding: chunked`
		// through to a client that's already running over Cloudflare's HTTP/2.
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: stripHopByHop(upstream.headers),
		});
	} catch (err) {
		log.warn("Shared proxy: upstream fetch failed", { port, error: String(err) });
		return new Response(`Upstream localhost:${port} unreachable`, { status: 502 });
	}
}

let serverPort = 0;

interface RemoteServerHandle {
	port?: number;
	stop(closeActiveConnections?: boolean): void | Promise<void>;
}

let remoteServer: RemoteServerHandle | null = null;
let discoveryAdvertisement: RemoteDiscoveryAdvertisement | null = null;
let instanceInfo: RemoteInstanceInfo | null = null;

function stopDiscoveryAdvertisement(): void {
	if (!discoveryAdvertisement) return;
	discoveryAdvertisement.stop();
	discoveryAdvertisement = null;
}

function onProcessExit(): void {
	stopDiscoveryAdvertisement();
}

interface StartOptions {
	rpcHandler: RpcRequestHandler;
	getPtyPort: () => number;
	onQrTokenConsumed?: () => void;
}

let qrConsumedCallback: (() => void) | null = null;

/**
 * Resolve the listen port from DEV3_REMOTE_PORT env.
 *
 * Returns 0 (let Bun pick a random port) when unset, invalid, or explicitly "0".
 * The env is set by the CLI's `--port <n>` flag (Docker maps a stable host port
 * to a known container port) and by the dev script as `DEV3_REMOTE_PORT=${DEV3_PORT0:-0}`,
 * which pins the dev app to its task's pool-allocated port — see decision 093.
 *
 * "0" is the documented "pick a random port" sentinel: the dev script's `:-0`
 * fallback produces it whenever no pool port is allocated, so it is a normal,
 * expected value — return 0 silently, do NOT warn.
 *
 * Genuinely invalid values (non-numeric, negative, > 65535) fall back to 0 with
 * a warning rather than crashing: the banner still prints a usable URL.
 * Privileged ports (< 1024) are accepted — bind() will fail later and Bun
 * surfaces the EACCES cleanly, which is more informative than "refused at startup".
 */
export function resolveListenPort(): number {
	const raw = process.env.DEV3_REMOTE_PORT;
	if (!raw) return 0;
	const n = Number.parseInt(raw, 10);
	if (n === 0) return 0; // explicit random-port sentinel — not an error
	if (!Number.isFinite(n) || n < 1 || n > 65535) {
		log.warn("Invalid DEV3_REMOTE_PORT, falling back to random port", { raw });
		return 0;
	}
	return n;
}

export async function startRemoteAccessServer(options: StartOptions): Promise<void> {
	if (remoteServer) throw new Error("Remote access server is already running");
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
			if (url.pathname.startsWith("/auth") || url.pathname === "/instance" || url.pathname === "/rpc" || url.pathname === "/pty" || url.pathname === "/health") {
				log.info("Remote request", {
					method: req.method,
					path: url.pathname,
					ip: clientIp,
					ua,
					hasCookie: !!extractSessionToken(req),
				});
			}

			// ── Discovery metadata (no session required) ──
			if (url.pathname === "/instance") {
				if (req.method !== "GET") {
					return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
				}
				return handleInstanceRequest(instanceInfo ?? getRemoteInstanceInfo());
			}

			// ── Auth endpoints (no session required) ──
			if (url.pathname === "/auth/exchange" && req.method === "POST") {
				return handleAuthExchange(req, { clientIp, ua, onQrConsumed: qrConsumedCallback ?? undefined });
			}

			if (url.pathname === "/auth/refresh" && req.method === "POST") {
				return handleAuthRefresh(req, { clientIp, ua });
			}

			// ── WebSocket upgrades (session cookie required) ──
			if (url.pathname === "/rpc") {
				if (!checkOrigin(req)) {
					log.warn("RPC WS upgrade: origin mismatch", { ip: clientIp, ua, origin: req.headers.get("origin") });
					return new Response("Forbidden", { status: 403 });
				}
				const authed = await isSessionAuthenticated(req);
				if (!authed) {
					log.warn("RPC WS upgrade: unauthorized", { ip: clientIp, ua, hasCookie: !!extractSessionToken(req) });
					return new Response("Unauthorized", { status: 401 });
				}
				log.info("RPC WS upgrade: authorized", { ip: clientIp, ua });
				if (server.upgrade(req, { data: { type: "rpc" } as WsData })) return;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			if (url.pathname === "/pty") {
				if (!checkOrigin(req)) {
					log.warn("PTY WS upgrade: origin mismatch", { ip: clientIp, ua, origin: req.headers.get("origin") });
					return new Response("Forbidden", { status: 403 });
				}
				const authed = await isSessionAuthenticated(req);
				if (!authed) {
					log.warn("PTY WS upgrade: unauthorized", { ip: clientIp, ua, hasCookie: !!extractSessionToken(req) });
					return new Response("Unauthorized", { status: 401 });
				}
				const sessionId = url.searchParams.get("session");
				if (!sessionId) return new Response("Missing session param", { status: 400 });
				log.info("PTY WS upgrade: authorized", { ip: clientIp, session: sessionId.slice(0, 8) });
				if (server.upgrade(req, { data: { type: "pty", sessionId } as WsData })) return;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			// ── Shared-tunnel reverse proxy: /p/<subtoken>/<port>/<rest> ──
			//
			// A task's shared Cloudflare tunnel resolves a single public origin
			// (`https://random.trycloudflare.com`) and the user navigates to
			// `<origin>/p/<subtoken>/<port>/...`. We dispatch the request to
			// `http://localhost:<port>/...` on this machine. The subtoken is the
			// capability — a 24-byte random secret minted at tunnel-start and
			// carried in the URL itself (no JWT plumbing inside the dev server's
			// HTML/JS, no CORS, no cookies). This is the "URL is the password"
			// pattern used by Google Docs share links.
			if (url.pathname.startsWith("/p/")) {
				const parsed = parseSharedProxyPath(url.pathname);
				if (!parsed) return new Response("Bad shared-proxy path", { status: 400 });
				const tunnel = tunnelManager.list({ kind: "task-shared" }).find((t) => t.subToken === parsed.subToken);
				if (!tunnel) {
					log.warn("Shared proxy: unknown subtoken", { ip: clientIp });
					return new Response("Not Found", { status: 404 });
				}
				if (!tunnel.ports.includes(parsed.port)) {
					log.warn("Shared proxy: port not registered", { ip: clientIp, port: parsed.port, registered: tunnel.ports });
					return new Response("Port not registered for this tunnel", { status: 404 });
				}

				// WebSocket upgrade (HMR, live-reload, dev-server inspector).
				const isWsUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
				if (isWsUpgrade) {
					const upstreamUrl = `ws://localhost:${parsed.port}/${parsed.rest}${url.search}`;
					log.info("Shared proxy WS upgrade", { ip: clientIp, port: parsed.port });
					if (server.upgrade(req, { data: { type: "shared-proxy", proxyUpstreamUrl: upstreamUrl } as WsData })) return;
					return new Response("WebSocket upgrade failed", { status: 400 });
				}

				// Plain HTTP — proxy the request, stream the response back.
				return proxyHttpToLocalhost(req, parsed.port, parsed.rest, url.search);
			}

			// ── API endpoints (session cookie required) ──
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
				const wsData = (ws as any).data as { type: string; sessionId?: string; proxyUpstreamUrl?: string };
				if (wsData.type === "rpc") {
					rpcClients.add(ws);
					log.info("Remote RPC client connected", { total: rpcClients.size });
				} else if (wsData.type === "pty") {
					proxyToPty(ws, wsData.sessionId!);
				} else if (wsData.type === "shared-proxy") {
					proxyToSharedUpstream(ws, wsData.proxyUpstreamUrl!);
				}
			},
			message(ws, raw) {
				const wsData = (ws as any).data as { type: string };
				if (wsData.type === "rpc") {
					handleRpcMessage(ws, raw as string).catch(err => {
						log.error("RPC message handler error", { error: String(err) });
					});
				} else if (wsData.type === "pty") {
					// Input may arrive before the localhost upstream handshake completes.
					const data = typeof raw === "string" ? raw : new TextDecoder().decode(raw as unknown as ArrayBuffer);
					((ws as any)._ptyForwardInput as ((data: string) => void) | undefined)?.(data);
				} else if (wsData.type === "shared-proxy") {
					const upstream = (ws as any)._proxyUpstream as WebSocket | undefined;
					if (upstream?.readyState === WebSocket.OPEN) {
						upstream.send(raw as string | ArrayBuffer);
					}
				}
			},
			close(ws) {
				const wsData = (ws as any).data as { type: string };
				if (wsData.type === "rpc") {
					rpcClients.delete(ws);
					log.info("Remote RPC client disconnected", { total: rpcClients.size });
				} else if (wsData.type === "pty") {
					((ws as any)._ptyCleanup as (() => void) | undefined)?.();
					closeUpstreamSocket((ws as any)._ptyUpstream as WebSocket | undefined);
				} else if (wsData.type === "shared-proxy") {
					closeUpstreamSocket((ws as any)._proxyUpstream as WebSocket | undefined);
				}
			},
		},
	});

	remoteServer = server as unknown as RemoteServerHandle;
	serverPort = server.port ?? 0;
	instanceInfo = getRemoteInstanceInfo();
	log.info(`Remote access server running on port ${serverPort}`);
	discoveryAdvertisement = await startRemoteDiscoveryAdvertisement(instanceInfo, serverPort);
	process.once("exit", onProcessExit);

	// Print access URL to console
	printAccessInfo();
}

/** Stop the remote server and withdraw its DNS-SD advertisement. */
export function stopRemoteAccessServer(): void {
	process.removeListener("exit", onProcessExit);
	stopDiscoveryAdvertisement();
	if (remoteServer) {
		try {
			void remoteServer.stop(true);
		} catch (error) {
			log.debug("Remote access server stop failed", { error: String(error) });
		}
	}
	remoteServer = null;
	instanceInfo = null;
	serverPort = 0;
	requestHandler = null;
	ptyPortGetter = null;
	qrConsumedCallback = null;
	rpcClients.clear();
}

/**
 * Number of browser RPC clients currently connected over the remote-access
 * server. Used to keep the machine awake while someone is connected remotely.
 */
export function getConnectedClientCount(): number {
	return rpcClients.size;
}

/**
 * Whether the app is currently reachable / being used remotely: either the
 * Cloudflare tunnel is connected, or at least one browser client is attached.
 * While true, sleep prevention is forced on regardless of the user setting.
 */
export function isRemoteAccessActive(): boolean {
	return getTunnelState() === "connected" || rpcClients.size > 0;
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

/** Raw non-internal IPv4 interfaces, in OS enumeration order (unranked). */
function enumerateExternalIPv4(): RemoteNetInterface[] {
	const out: RemoteNetInterface[] = [];
	const interfaces = networkInterfaces();
	for (const name of Object.keys(interfaces)) {
		for (const iface of (interfaces[name] ?? [])) {
			if (iface.family === "IPv4" && !iface.internal) {
				out.push({ name, address: iface.address, internal: false });
			}
		}
	}
	return out;
}

function getLocalIp(): string {
	// Pick the most-reachable interface, not merely the first the OS reports —
	// VPN (utun*) and VM-bridge (bridge*) addresses commonly enumerate first but
	// are unreachable from a phone on the LAN. See ./network-interfaces.
	const ranked = prioritizeInterfaces(enumerateExternalIPv4());
	return ranked[0]?.address ?? "localhost";
}

/**
 * Every IPv4 the machine is reachable at, for the Remote Access modal's
 * interface picker: real LAN interfaces (en0…) first, VPN/bridge/link-local
 * deprioritized below them, then loopback `127.0.0.1` last (same-machine /
 * SSH-forward). The browser can't enumerate host interfaces, so this is
 * computed here and shipped to the renderer.
 */
export function getLocalInterfaces(): RemoteNetInterface[] {
	const out = enumerateExternalIPv4();
	// Always offer loopback — the SSH-forward path. Ranked last (internal).
	out.push({ name: "loopback", address: "127.0.0.1", internal: true });
	return prioritizeInterfaces(out);
}

/**
 * Resolve the host to embed in the access URL. A caller-supplied `host` is
 * honoured only if it is one of the addresses we actually expose (allow-list —
 * no arbitrary host injected into the URL); otherwise we fall back to the
 * auto-picked first non-internal IPv4. Tunnel mode ignores this entirely.
 */
export function resolveAccessHost(host?: string): string {
	if (host) {
		const allowed = new Set([...getLocalInterfaces().map((i) => i.address), "127.0.0.1", "localhost"]);
		if (allowed.has(host)) return host;
	}
	return getLocalIp();
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

export async function getAccessUrl(host?: string): Promise<string> {
	const token = getStaticCode() ?? await createQrToken();
	const tunnel = getTunnelUrl();
	if (tunnel) return `${tunnel}/?token=${token}`;
	const ip = resolveAccessHost(host);
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
export async function generateQrDataUrl(host?: string): Promise<string> {
	const url = await getAccessUrl(host);
	return QRCode.toDataURL(url, { width: 256, margin: 2 });
}
