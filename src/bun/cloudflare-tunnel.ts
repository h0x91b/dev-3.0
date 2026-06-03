import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "./spawn";
import { createLogger } from "./logger";

const log = createLogger("cf-tunnel");

export type TunnelState = "idle" | "starting" | "connected" | "failed";
export type TunnelKind = "main" | "task-port" | "task-shared";

/**
 * One running cloudflared process + the metadata we need to address it.
 *
 *  - `id` is a stable key used in the manager map:
 *      • `"main"` for the headless web-UI tunnel (single instance per process)
 *      • `"task:<taskId>:port:<n>"` for a per-port quick tunnel
 *      • `"task:<taskId>:shared"` for the shared multi-port tunnel
 *  - `targetPort` is the localhost port that cloudflared is pointed at. For
 *    `task-shared`, that's the headless server's own port (the proxy lives
 *    inside it and dispatches `/p/<port>/*` to the registered `ports`).
 *  - `ports` is meaningful only for `task-shared`: the set of localhost ports
 *    accessible through this tunnel's `/p/<port>/*` proxy.
 *  - `subToken` is an HMAC-grade random secret minted per shared tunnel; it
 *    gates WebSocket upgrades on `/p/*` because browsers can't send Authorization
 *    headers on WS handshakes — we embed this in the URL instead. Unused (but
 *    harmless) on `main` and `task-port` entries.
 */
export interface TunnelEntry {
	id: string;
	kind: TunnelKind;
	targetPort: number;
	ports: number[];
	taskId?: string;
	state: TunnelState;
	url: string | null;
	process: ReturnType<typeof spawn> | null;
	startedAt: number;
	subToken: string;
}

export interface StartTunnelOptions {
	id: string;
	kind: TunnelKind;
	targetPort: number;
	ports?: number[];
	taskId?: string;
}

const MAIN_ID = "main";
const URL_WAIT_TIMEOUT_MS = 30_000;

const tunnels = new Map<string, TunnelEntry>();

export function isCloudflaredAvailable(): boolean {
	const result = spawnSync(["which", "cloudflared"]);
	return result.exitCode === 0;
}

/**
 * Parse a Cloudflare Tunnel URL from a line of cloudflared stderr output.
 * cloudflared prints lines like:
 *   INF |  https://something-random.trycloudflare.com
 *   or: ... https://something.trycloudflare.com ...
 * Returns the full URL or null.
 */
export function parseTunnelUrl(line: string): string | null {
	const match = line.match(/https:\/\/[a-zA-Z0-9_-]+\.trycloudflare\.com/);
	return match ? match[0] : null;
}

async function waitForUrl(stderr: ReadableStream, timeoutMs: number): Promise<string | null> {
	const reader = stderr.getReader();
	const decoder = new TextDecoder();
	const deadline = Date.now() + timeoutMs;
	let buffer = "";

	try {
		while (Date.now() < deadline) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;

			const result = await Promise.race([
				reader.read(),
				new Promise<{ done: true; value: undefined }>((resolve) =>
					setTimeout(() => resolve({ done: true, value: undefined }), remaining),
				),
			]);

			if (result.done) break;

			buffer += decoder.decode(result.value, { stream: true });

			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const url = parseTunnelUrl(line);
				if (url) {
					reader.releaseLock();
					return url;
				}
			}
		}

		if (buffer) {
			const url = parseTunnelUrl(buffer);
			if (url) return url;
		}
	} finally {
		try { reader.releaseLock(); } catch { /* already released */ }
	}

	return null;
}

interface TunnelFilter {
	kind?: TunnelKind;
	taskId?: string;
}

function matchesFilter(entry: TunnelEntry, filter?: TunnelFilter): boolean {
	if (!filter) return true;
	if (filter.kind !== undefined && entry.kind !== filter.kind) return false;
	if (filter.taskId !== undefined && entry.taskId !== filter.taskId) return false;
	return true;
}

async function startEntry(opts: StartTunnelOptions): Promise<TunnelEntry> {
	const existing = tunnels.get(opts.id);
	if (existing && (existing.state === "starting" || existing.state === "connected")) {
		log.warn("Tunnel already active", { id: opts.id, state: existing.state });
		return existing;
	}

	const entry: TunnelEntry = {
		id: opts.id,
		kind: opts.kind,
		targetPort: opts.targetPort,
		ports: opts.ports ?? [],
		taskId: opts.taskId,
		state: "starting",
		url: null,
		process: null,
		startedAt: Date.now(),
		subToken: randomBytes(24).toString("base64url"),
	};
	tunnels.set(opts.id, entry);

	try {
		const proc = spawn(
			["cloudflared", "tunnel", "--url", `http://localhost:${opts.targetPort}`],
			{ stdout: "ignore", stderr: "pipe" },
		);
		entry.process = proc;

		// Reset state when the cloudflared process exits unexpectedly.
		proc.exited.then(() => {
			log.info("Tunnel process exited", { id: opts.id });
			const current = tunnels.get(opts.id);
			if (current === entry) {
				entry.process = null;
				entry.url = null;
				entry.state = "idle";
			}
		});

		const url = await waitForUrl(proc.stderr!, URL_WAIT_TIMEOUT_MS);
		if (url) {
			entry.url = url;
			entry.state = "connected";
			log.info("Tunnel connected", { id: opts.id, url });
			return entry;
		}

		log.warn("Tunnel URL not found in stderr within timeout", { id: opts.id });
		entry.state = "failed";
		stopEntry(opts.id);
		return entry;
	} catch (err) {
		log.error("Failed to start tunnel", { id: opts.id, error: String(err) });
		entry.state = "failed";
		stopEntry(opts.id);
		return entry;
	}
}

function stopEntry(id: string): void {
	const entry = tunnels.get(id);
	if (!entry) return;
	if (entry.process) {
		try {
			entry.process.kill();
		} catch {
			// process may already be dead
		}
	}
	tunnels.delete(id);
}

export const tunnelManager = {
	start: startEntry,
	stop: stopEntry,
	get: (id: string): TunnelEntry | undefined => tunnels.get(id),
	list: (filter?: TunnelFilter): TunnelEntry[] => {
		const out: TunnelEntry[] = [];
		for (const entry of tunnels.values()) {
			if (matchesFilter(entry, filter)) out.push(entry);
		}
		return out;
	},
	stopAll: (filter?: TunnelFilter): void => {
		const ids: string[] = [];
		for (const entry of tunnels.values()) {
			if (matchesFilter(entry, filter)) ids.push(entry.id);
		}
		for (const id of ids) stopEntry(id);
	},
};

// ─────────────────────────────────────────────────────────────────────────────
// Back-compat wrappers — operate on the singleton "main" entry. These keep the
// existing `dev3 remote` web-UI tunnel callers (`remote-access.ts`,
// `headless-entry.ts`, `index.ts`) working without touching the manager API.
// ─────────────────────────────────────────────────────────────────────────────

export async function startTunnel(localPort: number): Promise<string | null> {
	const entry = await startEntry({ id: MAIN_ID, kind: "main", targetPort: localPort });
	return entry.url;
}

export function stopTunnel(): void {
	stopEntry(MAIN_ID);
}

export function getTunnelUrl(): string | null {
	return tunnels.get(MAIN_ID)?.url ?? null;
}

export function getTunnelState(): TunnelState {
	return tunnels.get(MAIN_ID)?.state ?? "idle";
}

/** Reset module state — only for tests */
export function _resetState(): void {
	tunnels.clear();
}
