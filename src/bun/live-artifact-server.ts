import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import type { Project, Task } from "../shared/types";
import { LIVE_CLIENT_GESTURE_MS, LIVE_CLIENT_TIMEOUT_MS, liveArtifactClientScript } from "../shared/live-artifact-client";
import type { LiveChange } from "../shared/live-artifact";
import { DEV3_HOME } from "./paths";
import { projectSlug } from "./git";
import { liveStoreDir, onLivePageChange, onLiveStoreChange, readLiveState } from "./live-artifact-store";
import { LiveOpError, runLiveOp, type LiveAgentSender } from "./live-artifact-ops";
import { createLogger } from "./logger";

/**
 * The loopback web server that shows a task's Live Artifact in a real browser tab.
 *
 * - Bound to 127.0.0.1 only. Never a fixed port: prod, staging and dev builds run
 *   side by side, so it binds the port this install used last time (stable
 *   bookmarks) and falls back to any free one when another process holds it.
 * - Each task is reached through an unguessable token path, `/<token>/`; the
 *   `Host` header must name this server (DNS-rebinding guard) and writes must be
 *   `application/json` from this origin (cross-site forms cannot send that).
 * See `decisions/2026/10/21/live-artifact-per-task.md`.
 */

const log = createLogger("live-artifact-server");

const TOKEN_RE = /^[A-Za-z0-9_-]{24}$/;
const SSE_PING_MS = 25_000;
const MIME: Record<string, string> = {
	css: "text/css; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	svg: "image/svg+xml",
	mp4: "video/mp4",
	webm: "video/webm",
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	wav: "audio/wav",
	ogg: "audio/ogg",
};

export interface LiveServerDeps {
	port: () => number;
	/** The task behind a token, re-read on every request so status and page are current. */
	resolveToken: (token: string) => Promise<{ project: Project; task: Task } | null>;
	sendToAgent: LiveAgentSender;
}

function text(status: number, body: string): Response {
	return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function injectClient(html: string, token: string, pageRev: number): string {
	const script = liveArtifactClientScript({
		transport: "http",
		base: `/${token}/`,
		pageRev,
		gestureMs: LIVE_CLIENT_GESTURE_MS,
		timeoutMs: LIVE_CLIENT_TIMEOUT_MS,
	});
	if (/<head(?:\s|>)/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${script}`);
	return `${script}${html}`;
}

function eventStream(project: Project, task: Task): Response {
	const encoder = new TextEncoder();
	let cleanup = () => {};
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (event: string, data: unknown) => {
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					cleanup();
				}
			};
			const stopChanges = onLiveStoreChange((event: { taskId: string; changes: LiveChange[] }) => {
				if (event.taskId === task.id) send("change", { changes: event.changes });
			});
			const stopPages = onLivePageChange((event) => {
				if (event.taskId === task.id) send("page", { pageRev: event.pageRev });
			});
			const ping = setInterval(() => {
				try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { cleanup(); }
			}, SSE_PING_MS);
			cleanup = () => { stopChanges(); stopPages(); clearInterval(ping); };
			// A tab that missed a publish while disconnected learns it here and reloads.
			send("page", { pageRev: task.liveArtifact?.pageRev ?? 0 });
			send("snapshot", await readLiveState(project.path, task.id));
		},
		cancel() { cleanup(); },
	});
	return new Response(stream, {
		headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" },
	});
}

/** The whole HTTP surface, as a plain fetch handler so it is testable without Bun. */
export function createLiveFetch(deps: LiveServerDeps): (request: Request) => Promise<Response> {
	return async (request) => {
		const port = deps.port();
		const host = request.headers.get("host") ?? "";
		if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return text(421, "Unknown host");
		const url = new URL(request.url);
		// Every tab asks for this on its own; answering 404 puts a console error on each live page.
		if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
		const [, token = "", ...rest] = url.pathname.split("/");
		if (!TOKEN_RE.test(token)) return text(404, "Not found");
		const found = await deps.resolveToken(token);
		if (!found) return text(404, "This live page no longer exists.");
		const { project, task } = found;
		const live = task.liveArtifact;
		const path = rest.join("/");

		if (rest.length === 0) return new Response(null, { status: 308, headers: { location: `/${token}/` } });

		if (path === "api/stream" && request.method === "GET") return eventStream(project, task);

		if (path.startsWith("api/")) {
			if (request.method !== "POST") return json(405, { error: "POST only", reason: "invalid" });
			if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) return json(415, { error: "JSON only", reason: "invalid" });
			const origin = request.headers.get("origin");
			if (origin && origin !== `http://${host}`) return json(403, { error: "Cross-origin write refused", reason: "invalid" });
			let args: Record<string, unknown>;
			try {
				args = (await request.json()) as Record<string, unknown>;
			} catch {
				return json(400, { error: "Body is not JSON", reason: "invalid" });
			}
			try {
				return json(200, { result: await runLiveOp(project, task, path.slice("api/".length), args ?? {}, deps.sendToAgent) });
			} catch (error) {
				const failure = error instanceof LiveOpError ? error : new LiveOpError(String(error), "failed");
				const status = failure.reason === "conflict" ? 409 : failure.reason === "read-only" ? 423 : failure.reason === "invalid" ? 400 : 500;
				return json(status, { error: failure.message, reason: failure.reason });
			}
		}

		if (request.method !== "GET") return text(405, "GET only");
		if (!live) return text(404, "This task has no live page yet.");

		if (path === "") {
			const html = readFileSync(live.page.storedPath, "utf8");
			return new Response(injectClient(html, token, live.pageRev), {
				headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
			});
		}

		// Only files the page was published with; the stored record is the allowlist.
		const name = decodeURIComponent(path);
		const asset = live.page.assets.find((candidate) => candidate.name === name);
		if (!asset) return text(404, "Not found");
		const ext = extname(asset.name).slice(1).toLowerCase();
		return new Response(readFileSync(asset.storedPath), {
			headers: { "content-type": MIME[ext] ?? asset.mime ?? "application/octet-stream", "cache-control": "no-store" },
		});
	};
}

// ---- tokens -----------------------------------------------------------------

const tokenIndex = new Map<string, { projectId: string; taskId: string }>();

function tokenFile(project: Project, taskId: string): string {
	return `${liveStoreDir(project.path, taskId)}/token`;
}

/** The task's browser token, minted once and kept beside its store so URLs survive restarts. */
export function liveTokenFor(project: Project, taskId: string): string {
	const file = tokenFile(project, taskId);
	let token = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
	if (!TOKEN_RE.test(token)) {
		token = randomBytes(18).toString("base64url");
		mkdirSync(liveStoreDir(project.path, taskId), { recursive: true });
		writeFileSync(file, token, { mode: 0o600 });
	}
	tokenIndex.set(token, { projectId: project.id, taskId });
	return token;
}

/** After a restart the in-memory index is empty: find the token on disk once. */
export function findTokenOnDisk(token: string, projects: Project[]): { projectId: string; taskId: string } | null {
	const cached = tokenIndex.get(token);
	if (cached) return cached;
	for (const project of projects) {
		const root = `${DEV3_HOME}/worktrees/${projectSlug(project.path)}/live-artifacts`;
		if (!existsSync(root)) continue;
		for (const taskId of readdirSync(root)) {
			const file = `${root}/${taskId}/token`;
			if (existsSync(file) && readFileSync(file, "utf8").trim() === token) {
				const entry = { projectId: project.id, taskId };
				tokenIndex.set(token, entry);
				return entry;
			}
		}
	}
	return null;
}

// ---- lifecycle --------------------------------------------------------------

function portMemoryFile(): string {
	// One record per installed app binary, so two builds never fight over one port.
	const install = createHash("sha256").update(process.execPath).digest("hex").slice(0, 12);
	return `${DEV3_HOME}/live-server/${install}.json`;
}

function rememberedPort(): number {
	try {
		const port = Number(JSON.parse(readFileSync(portMemoryFile(), "utf8")).port);
		return Number.isInteger(port) && port > 1024 && port < 65536 ? port : 0;
	} catch {
		return 0;
	}
}

let running: { port: number; stop: () => void } | null = null;

/** Start the server on first use and return its port. */
export function ensureLiveServer(deps: Omit<LiveServerDeps, "port">): number {
	if (running) return running.port;
	const fetch = createLiveFetch({ ...deps, port: () => running?.port ?? 0 });
	const listen = (port: number) => Bun.serve({ hostname: "127.0.0.1", port, fetch, idleTimeout: 0 });
	const preferred = rememberedPort();
	let server: ReturnType<typeof listen>;
	try {
		server = listen(preferred);
	} catch (error) {
		if (!preferred) throw error;
		log.warn("Remembered live server port is taken, using a free one", { port: preferred });
		server = listen(0);
	}
	const port = server.port ?? 0;
	running = { port, stop: () => server.stop(true) };
	try {
		mkdirSync(`${DEV3_HOME}/live-server`, { recursive: true });
		writeFileSync(portMemoryFile(), JSON.stringify({ port }));
	} catch (error) {
		log.warn("Could not remember the live server port", { error: String(error) });
	}
	log.info("Live artifact server listening", { port });
	return port;
}

export function stopLiveServer(): void {
	running?.stop();
	running = null;
}
