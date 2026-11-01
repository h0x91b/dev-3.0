/**
 * `dev3 mcp`: stateless MCP (JSON responses only) on its own 127.0.0.1 listener, for
 * agents outside dev3. See decisions/2026/11/01/mcp-http-listener-for-external-senders.md.
 */

import type { CliRequest, CliResponse } from "../../shared/types";
import { CLI_EXIT_CODE_COMMAND_FAILED, CLI_EXIT_CODE_INTERNAL_ERROR } from "../../shared/cli-exit-codes";
import { createLogger } from "../logger";
import type { McpRequestOrigin } from "../cli-socket/shared";
import { requireExternalSender } from "../external-senders";
import { authAttemptRetryAfterS, recordAuthFailure } from "../remote-auth-rate-limit";
import { McpConfigCache, type McpTokenRecord } from "./token-store";
import {
	MCP_LIMITS,
	MCP_PROTOCOL_VERSION,
	MCP_SERVER_INFO,
	MCP_TOOLS,
	findTool,
	runTool,
	toolAllowed,
	type ToolDef,
	type ToolOutcome,
} from "./tools";

const log = createLogger("mcp");

export type HandleAppRequest = (req: CliRequest, signal?: AbortSignal, mcp?: McpRequestOrigin) => Promise<CliResponse>;

export interface McpCallRecord {
	at: string;
	tokenId: string;
	sender: string;
	peer: string;
	tool: string;
	task?: string;
	project?: string;
	exitCode: number;
	errorCode?: string;
	ms: number;
}

const RECENT_CALLS = 20;
const MINUTE_MS = 60_000;

/** In-memory, per-instance counters. A valid token is never throttled on auth, only on volume. */
class Limits {
	inFlight = 0;
	private perToken = new Map<string, { active: number; parked: number; calls: number[]; mutating: number[] }>();

	private entry(tokenId: string) {
		let e = this.perToken.get(tokenId);
		if (!e) {
			e = { active: 0, parked: 0, calls: [], mutating: [] };
			this.perToken.set(tokenId, e);
		}
		return e;
	}

	/** Null when the call may run (and is now counted), else the seconds to wait. */
	admit(tokenId: string, tool: ToolDef, now: number): number | null {
		const e = this.entry(tokenId);
		const cutoff = now - MINUTE_MS;
		e.calls = e.calls.filter((t) => t > cutoff);
		e.mutating = e.mutating.filter((t) => t > cutoff);
		if (this.inFlight >= MCP_LIMITS.globalInFlight) return 1;
		if (tool.parked ? e.parked >= MCP_LIMITS.perTokenParked : e.active >= MCP_LIMITS.perTokenInFlight) return 1;
		if (e.calls.length >= MCP_LIMITS.callsPerMinute) return Math.max(1, Math.ceil((e.calls[0] + MINUTE_MS - now) / 1000));
		if (tool.mutating && e.mutating.length >= MCP_LIMITS.mutatingCallsPerMinute) {
			return Math.max(1, Math.ceil((e.mutating[0] + MINUTE_MS - now) / 1000));
		}
		e.calls.push(now);
		if (tool.mutating) e.mutating.push(now);
		if (tool.parked) e.parked++;
		else e.active++;
		this.inFlight++;
		return null;
	}

	release(tokenId: string, tool: ToolDef): void {
		const e = this.entry(tokenId);
		if (tool.parked) e.parked--;
		else e.active--;
		this.inFlight--;
	}
}

interface JsonRpcMessage {
	jsonrpc?: unknown;
	id?: unknown;
	method?: unknown;
	params?: unknown;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function rpcError(id: unknown, code: number, message: string, status = 200): Response {
	return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);
}

/** The body, or null once it passes `limit` bytes — counted while streaming, not trusted from a header. */
async function readCapped(req: Request, limit: number): Promise<string | null> {
	if (!req.body) return "";
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			void reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

export interface McpServerDeps {
	handle: HandleAppRequest;
	cache?: McpConfigCache;
	now?: () => number;
}

/**
 * The HTTP handler, separate from the socket so tests drive it with plain
 * `Request`s. `peer` is the socket address; behind `tailscale serve` or `ssh -L`
 * every caller is 127.0.0.1, which only ever shares the auth-FAILURE budget.
 */
export function createMcpHandler(deps: McpServerDeps) {
	const cache = deps.cache ?? new McpConfigCache();
	const now = deps.now ?? Date.now;
	const limits = new Limits();
	const recent: McpCallRecord[] = [];
	const seen = new Set<string>();
	const bodyReads = new Map<string, number>();
	let callSeq = 0;

	function audit(record: McpCallRecord): void {
		recent.push(record);
		if (recent.length > RECENT_CALLS) recent.shift();
		log.info("call", { ...record });
	}

	async function callTool(token: McpTokenRecord, senderLabel: string, peer: string, msg: JsonRpcMessage, signal: AbortSignal): Promise<Response> {
		const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
		const tool = typeof params.name === "string" ? findTool(params.name) : undefined;
		if (!tool) return rpcError(msg.id, -32602, `unknown method: ${String(params.name)}`);
		const args = (params.arguments ?? {}) as Record<string, unknown>;
		const started = now();
		let outcome: ToolOutcome;
		const wait = limits.admit(token.id, tool, started);
		if (wait !== null) {
			outcome = { exitCode: CLI_EXIT_CODE_COMMAND_FAILED, error: { code: "RATE_LIMITED", message: "Too many calls for this token; retry later.", retryAfterS: wait } };
		} else {
			try {
				outcome = await runTool(tool, args, {
					token,
					senderLabel,
					signal,
					call: (method, p) => deps.handle(
						{ id: `mcp-${++callSeq}`, method, params: p },
						tool.parked && !tool.mutating ? signal : undefined,
						{ tokenId: token.id, interactiveOnly: !token.autoApprove },
					),
				});
			} catch (err) {
				log.error("tool threw", { tool: tool.name, tokenId: token.id, error: String(err instanceof Error ? err.message : err) });
				outcome = { exitCode: CLI_EXIT_CODE_INTERNAL_ERROR, error: { code: "INTERNAL", message: "Internal error in the MCP layer." } };
			} finally {
				limits.release(token.id, tool);
			}
		}
		audit({
			at: new Date(started).toISOString(),
			tokenId: token.id,
			sender: token.sender,
			peer,
			tool: tool.name,
			...(typeof args.task === "string" ? { task: args.task.slice(0, 64) } : {}),
			...(typeof args.project === "string" ? { project: args.project.slice(0, 64) } : {}),
			exitCode: outcome.exitCode,
			...(outcome.error ? { errorCode: outcome.error.code } : {}),
			ms: now() - started,
		});
		const structured = { exitCode: outcome.exitCode, ...(outcome.json === undefined ? {} : { json: outcome.json }), ...(outcome.error ? { error: outcome.error } : {}) };
		return json({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				structuredContent: structured,
				content: [{ type: "text", text: JSON.stringify(structured) }],
				isError: !tool.successCodes.includes(outcome.exitCode),
			},
		});
	}

	async function fetch(req: Request, peer: string): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
		if (req.headers.has("origin")) return new Response("Forbidden: browser origins are refused", { status: 403 });
		if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });

		const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
		const token = match ? cache.lookup(match[1], now()) : null;
		const failureKey = `mcp:${peer}`;
		if (!token) {
			const retry = authAttemptRetryAfterS(failureKey, now());
			if (retry !== null) return new Response("Too many failed attempts", { status: 429, headers: { "retry-after": String(retry) } });
			recordAuthFailure(failureKey, now());
			log.warn("auth refused", { peer, reason: match ? "unknown, revoked or expired token" : "no bearer token" });
			return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
		}
		let senderLabel: string;
		try {
			senderLabel = requireExternalSender(token.sender).label;
		} catch {
			log.warn("auth refused", { peer, tokenId: token.id, reason: "sender no longer registered" });
			return new Response("Unauthorized: this token's sender is no longer registered", { status: 401 });
		}
		if (!seen.has(token.id)) {
			seen.add(token.id);
			log.info("token first use", { tokenId: token.id, sender: token.sender, peer });
		}

		const declared = Number(req.headers.get("content-length") ?? "0");
		if (declared > MCP_LIMITS.bodyBytes) return new Response("Payload too large", { status: 413 });
		// Slow uploads count too: a token gets as many body reads at once as calls in flight.
		const reading = bodyReads.get(token.id) ?? 0;
		if (reading >= MCP_LIMITS.perTokenInFlight) return new Response("Too many concurrent requests", { status: 429, headers: { "retry-after": "1" } });
		bodyReads.set(token.id, reading + 1);
		let text: string | null;
		try {
			text = await readCapped(req, MCP_LIMITS.bodyBytes);
		} finally {
			bodyReads.set(token.id, (bodyReads.get(token.id) ?? 1) - 1);
		}
		if (text === null) return new Response("Payload too large", { status: 413 });

		let msg: unknown;
		try {
			msg = JSON.parse(text);
		} catch {
			return rpcError(null, -32700, "Parse error", 400);
		}
		if (Array.isArray(msg)) return rpcError(null, -32600, "Batches are not supported", 400);
		const m = msg as JsonRpcMessage;
		if (!m || typeof m !== "object" || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
			return rpcError(m?.id, -32600, "Invalid request", 400);
		}
		// Notifications (initialized, cancelled, …) carry no id and get no answer.
		if (m.id === undefined) return new Response(null, { status: 202 });

		switch (m.method) {
			case "initialize":
				return json({
					jsonrpc: "2.0",
					id: m.id,
					result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO },
				});
			case "ping":
				return json({ jsonrpc: "2.0", id: m.id, result: {} });
			case "tools/list":
				return json({
					jsonrpc: "2.0",
					id: m.id,
					result: {
						tools: MCP_TOOLS.filter((t) => toolAllowed(t, token)).map((t) => ({
							name: t.name,
							description: t.description,
							inputSchema: t.inputSchema,
							_meta: { "dev3/scope": t.scope, "dev3/trustedFields": t.trustedFields },
						})),
					},
				});
			case "tools/call":
				return callTool(token, senderLabel, peer, m, req.signal);
			default:
				return rpcError(m.id, -32601, `Method not found: ${m.method}`);
		}
	}

	return { fetch, recentCalls: () => [...recent], cache };
}

// ── lifecycle ───────────────────────────────────────────────────────────────

interface ListenerState {
	server: ReturnType<typeof Bun.serve> | null;
	port: number | null;
	bindError: string | null;
	handler: ReturnType<typeof createMcpHandler> | null;
	timer: ReturnType<typeof setInterval> | null;
}

const state: ListenerState = { server: null, port: null, bindError: null, handler: null, timer: null };

const SYNC_INTERVAL_MS = 2_000;

function stopServer(): void {
	if (!state.server) return;
	state.server.stop(true);
	log.info("MCP listener stopped", { port: state.port });
	state.server = null;
	state.port = null;
}

/** Bring the socket in line with the store: bound on its port while enabled, closed otherwise. */
export function syncMcpListener(): void {
	const handler = state.handler;
	if (!handler) return;
	const { config, error } = handler.cache.current();
	const wanted = config.enabled ? config.listen.port : null;
	if (wanted === state.port && (wanted === null || state.server)) return;
	stopServer();
	if (wanted === null) {
		state.port = null;
		state.bindError = null;
		return;
	}
	try {
		state.server = Bun.serve({
			hostname: "127.0.0.1",
			port: wanted,
			// A long-poll parks ~25 s; the default 10 s would cut it.
			idleTimeout: 45,
			fetch: (req, server) => handler.fetch(req, server.requestIP(req)?.address ?? "unknown"),
		});
		state.port = wanted;
		state.bindError = null;
		log.info("MCP listener started", { port: wanted, storeError: error });
	} catch (err) {
		const message = String(err instanceof Error ? err.message : err);
		// Retried on every sync (the port may free up); logged once per distinct failure.
		if (message !== state.bindError) log.error("MCP listener could not bind", { port: wanted, error: message });
		state.bindError = message;
		state.port = wanted;
	}
}

/**
 * Called from both entries (desktop and headless). A guest instance — an app
 * started from inside a task — never binds: the port belongs to the user's app.
 * The store is polled, so `dev3 mcp enable|disable|token …` take effect without
 * any socket method that a sandboxed task could call.
 */
export function startMcpListener(handle: HandleAppRequest): void {
	if (process.env.DEV3_TASK_ID) {
		log.info("MCP listener not started: this is a guest instance inside a task");
		return;
	}
	state.handler = createMcpHandler({ handle });
	syncMcpListener();
	// A 2 s stat poll of one small file: fs.watch is unreliable across platforms for atomic renames.
	state.timer = setInterval(syncMcpListener, SYNC_INTERVAL_MS);
	state.timer.unref?.();
}

export function stopMcpListener(): void {
	if (state.timer) clearInterval(state.timer);
	state.timer = null;
	stopServer();
	state.handler = null;
}

/** What `dev3 mcp status` shows. Never a hash, never a token. */
export function mcpListenerStatus() {
	const handler = state.handler;
	const read = handler?.cache.current();
	return {
		running: handler !== null,
		guest: Boolean(process.env.DEV3_TASK_ID),
		enabled: read?.config.enabled ?? false,
		listening: state.server !== null,
		port: state.port,
		bindError: state.bindError,
		storePath: handler?.cache.storePath ?? null,
		storeError: read?.error ?? null,
		recentCalls: handler?.recentCalls() ?? [],
	};
}
