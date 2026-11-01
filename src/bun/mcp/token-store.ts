/**
 * MCP tokens, as sha256 hashes, in `~/.config/dev3/mcp.json` — outside `~/.dev3.0`, which task
 * sandboxes can write. Only the CLI writes it. See decisions/2026/11/01/mcp-http-listener-for-external-senders.md.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { bytesToBase64Url } from "../../shared/base64url";
import { resolveDev3Home } from "../../shared/dev3-home";
import { resolveUserHome } from "../../shared/user-home";
import { atomicWriteFile } from "../atomic-write";
import { withFileLock } from "../file-lock";

export const MCP_TOKEN_PREFIX = "dev3mcp_";
export const MCP_CONFIG_VERSION = 1;
export const MCP_DEFAULT_PORT = 7391;
export const MCP_DEFAULT_EXPIRY_DAYS = 90;

export const MCP_SCOPES = ["read", "stats", "send", "write", "start", "content"] as const;
export type McpScope = typeof MCP_SCOPES[number];

export interface McpTokenRecord {
	/** First 8 hex chars of the token's sha256 — the only name lists, errors and logs use. */
	id: string;
	sha256: string;
	sender: string;
	scopes: McpScope[];
	/** Project ids, or ["*"] for every project. Never empty. */
	projects: string[];
	/** Let launches and resumes this token asks for auto-approve on the user's configured delay. */
	autoApprove: boolean;
	label: string | null;
	createdAt: string;
	expiresAt: string | null;
	revokedAt: string | null;
}

export interface McpConfig {
	v: typeof MCP_CONFIG_VERSION;
	enabled: boolean;
	listen: { port: number };
	tokens: McpTokenRecord[];
}

export function emptyMcpConfig(): McpConfig {
	return { v: MCP_CONFIG_VERSION, enabled: false, listen: { port: MCP_DEFAULT_PORT }, tokens: [] };
}

export function mcpConfigPath(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") {
		const appData = env.APPDATA?.trim() || `${resolveUserHome(env)}/AppData/Roaming`;
		return `${appData.replaceAll("\\", "/")}/dev3/mcp.json`;
	}
	const xdg = env.XDG_CONFIG_HOME?.trim();
	return `${xdg || `${resolveUserHome(env)}/.config`}/dev3/mcp.json`;
}

function realOrResolved(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		const parent = dirname(path);
		return parent === path ? resolve(path) : resolve(realOrResolved(parent), relative(parent, path));
	}
}

/**
 * Why this store path must not be used, or null when it is safe. A store inside the
 * dev3 data root (an `XDG_CONFIG_HOME` pointed there, a symlink) would be writable
 * by the very sandbox it exists to keep out, so the listener refuses it.
 */
export function mcpConfigPathProblem(path: string, env: Record<string, string | undefined> = process.env): string | null {
	const store = realOrResolved(path);
	const dataRoot = realOrResolved(resolveDev3Home(env));
	const rel = relative(dataRoot, store);
	if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
		return `the MCP token store ${path} is inside the dev3 data root ${dataRoot}, which task sandboxes can write; set XDG_CONFIG_HOME elsewhere`;
	}
	return null;
}

export function hashMcpToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export function generateMcpToken(): { token: string; id: string; sha256: string } {
	const token = `${MCP_TOKEN_PREFIX}${bytesToBase64Url(randomBytes(32))}`;
	const sha256 = hashMcpToken(token);
	return { token, id: sha256.slice(0, 8), sha256 };
}

function isScope(value: unknown): value is McpScope {
	return typeof value === "string" && (MCP_SCOPES as readonly string[]).includes(value);
}

function parseToken(raw: unknown): McpTokenRecord | null {
	if (!raw || typeof raw !== "object") return null;
	const t = raw as Record<string, unknown>;
	if (typeof t.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(t.sha256)) return null;
	if (typeof t.sender !== "string" || !t.sender) return null;
	if (!Array.isArray(t.scopes) || !t.scopes.every(isScope)) return null;
	if (!Array.isArray(t.projects) || t.projects.length === 0 || !t.projects.every((p) => typeof p === "string" && p)) return null;
	const iso = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);
	return {
		id: t.sha256.slice(0, 8),
		sha256: t.sha256,
		sender: t.sender,
		scopes: [...new Set(t.scopes)] as McpScope[],
		projects: t.projects as string[],
		autoApprove: t.autoApprove === true,
		label: typeof t.label === "string" && t.label ? t.label : null,
		createdAt: iso(t.createdAt) ?? new Date(0).toISOString(),
		// A malformed expiry fails closed: the token is treated as already expired.
		expiresAt: t.expiresAt === null ? null : iso(t.expiresAt) ?? new Date(0).toISOString(),
		revokedAt: t.revokedAt == null ? null : iso(t.revokedAt) ?? new Date(0).toISOString(),
	};
}

export type McpConfigRead =
	| { ok: true; config: McpConfig; missing: boolean }
	| { ok: false; error: string };

/** Parse the store. A missing file is an empty, disabled config; anything unreadable is an error. */
export function parseMcpConfig(text: string | null): McpConfigRead {
	if (text === null) return { ok: true, config: emptyMcpConfig(), missing: true };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return { ok: false, error: `not valid JSON (${String(err)})` };
	}
	const c = raw as Record<string, unknown> | null;
	if (!c || typeof c !== "object") return { ok: false, error: "not a JSON object" };
	if (c.v !== MCP_CONFIG_VERSION) return { ok: false, error: `unsupported version ${String(c.v)} (this dev3 reads v${MCP_CONFIG_VERSION})` };
	const port = (c.listen as { port?: unknown } | undefined)?.port;
	if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
		return { ok: false, error: `listen.port must be 1..65535` };
	}
	const tokens: McpTokenRecord[] = [];
	for (const entry of Array.isArray(c.tokens) ? c.tokens : []) {
		const token = parseToken(entry);
		if (!token) return { ok: false, error: "a token entry is malformed" };
		tokens.push(token);
	}
	return {
		ok: true,
		missing: false,
		config: { v: MCP_CONFIG_VERSION, enabled: c.enabled === true, listen: { port: (port as number | undefined) ?? MCP_DEFAULT_PORT }, tokens },
	};
}

export function readMcpConfig(path: string = mcpConfigPath()): McpConfigRead {
	let text: string | null;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") text = null;
		else return { ok: false, error: String(err) };
	}
	return parseMcpConfig(text);
}

/** CLI only: locked read-modify-write of the store, written 0600 in a 0700 directory. */
export async function updateMcpConfig<T>(mutate: (config: McpConfig) => T, path: string = mcpConfigPath()): Promise<T> {
	const problem = mcpConfigPathProblem(path);
	if (problem) throw new Error(problem);
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {
		// Windows: modes are a no-op; the profile ACL applies.
	}
	return withFileLock(path, async () => {
		const read = readMcpConfig(path);
		if (!read.ok) throw new Error(`Refusing to rewrite ${path}: ${read.error}. Fix or remove the file first.`);
		const result = mutate(read.config);
		await atomicWriteFile(path, `${JSON.stringify(read.config, null, 2)}\n`, { mode: 0o600 });
		return result;
	});
}

export function tokenIsLive(token: McpTokenRecord, now = Date.now()): boolean {
	if (token.revokedAt !== null) return false;
	return token.expiresAt === null || Date.parse(token.expiresAt) > now;
}

/**
 * The app's view of the store, re-read only when the file changes (inode plus
 * nanosecond mtime and size, the same signal `data.ts` caches on). An unreadable
 * file fails CLOSED: no token is accepted until it parses again, while the last
 * good port is kept so the listener does not flap.
 */
export class McpConfigCache {
	private stamp: string | null = null;
	private config: McpConfig = emptyMcpConfig();
	private error: string | null = null;

	constructor(private readonly path: string = mcpConfigPath()) {}

	get storePath(): string {
		return this.path;
	}

	current(): { config: McpConfig; error: string | null } {
		let stamp: string;
		try {
			const st = statSync(this.path, { bigint: true });
			stamp = `${st.ino}:${st.mtimeNs}:${st.size}`;
		} catch {
			stamp = "missing";
		}
		if (stamp !== this.stamp) {
			this.stamp = stamp;
			const problem = mcpConfigPathProblem(this.path);
			const read: McpConfigRead = problem ? { ok: false, error: problem } : readMcpConfig(this.path);
			if (read.ok) {
				this.config = read.config;
				this.error = null;
			} else {
				this.config = { ...this.config, tokens: [] };
				this.error = read.error;
				// Retry next time: a read can fail for reasons the file's stamp never shows (EMFILE, EIO).
				this.stamp = null;
			}
		}
		return { config: this.config, error: this.error };
	}

	/** The live token this bearer value names, or null. */
	lookup(bearer: string, now = Date.now()): McpTokenRecord | null {
		if (!bearer.startsWith(MCP_TOKEN_PREFIX)) return null;
		const sha256 = hashMcpToken(bearer);
		const token = this.current().config.tokens.find((t) => t.sha256 === sha256);
		return token && tokenIsLive(token, now) ? token : null;
	}
}
