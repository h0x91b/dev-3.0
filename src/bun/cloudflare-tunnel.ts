import { randomBytes } from "node:crypto";
import os from "node:os";
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
	/**
	 * PID of a cloudflared this process did NOT spawn — inherited from the server
	 * it replaced during a self-update. There is no exit promise for it, so its
	 * liveness comes from `metricsReadyUrl` alone; `stopEntry` still has to signal
	 * it or the restart would leak a process.
	 */
	adoptedPid: number | null;
	startedAt: number;
	subToken: string;
	metricsReadyUrl: string | null;
	consecutiveHealthFailures: number;
	healthCheckInFlight: boolean;
	healthCheckTimer: ReturnType<typeof setInterval> | null;
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
const HEALTH_CHECK_INTERVAL_MS = 10_000;
const HEALTH_CHECK_TIMEOUT_MS = 3_000;
const HEALTH_FAILURE_LIMIT = 3;

// cloudflared prints the `*.trycloudflare.com` hostname a few seconds (usually
// 2-3, sometimes ~10) before Cloudflare's edge actually routes it. Publishing
// the URL at announcement time lets a browser connect too early and cache a
// DNS_PROBE_FINISHED_NXDOMAIN, which then hangs long after the tunnel is live.
// We gate "connected" on cloudflared's own /ready endpoint (200 only with a
// live edge connection). Tunable so tests don't wait the real timeout.
export const TUNNEL_EDGE_READY = { timeoutMs: 25_000, pollMs: 500 };

const tunnels = new Map<string, TunnelEntry>();

export function isCloudflaredAvailable(): boolean {
	const result = spawnSync(["which", "cloudflared"]);
	return result.exitCode === 0;
}

/**
 * Transport protocol cloudflared uses to reach Cloudflare's edge.
 *
 * We default to **http2** (TCP/443) instead of cloudflared's own default of
 * `quic` (UDP/7844). Quick tunnels pin `protocol:quic` and, on any network that
 * blocks outbound UDP/7844 — extremely common on corporate/VPN/hotel Wi-Fi —
 * cloudflared prints the `*.trycloudflare.com` URL optimistically ("it may take
 * some time to be reachable"), then fails to dial the edge over QUIC and retries
 * forever WITHOUT falling back to http2. The tunnel never registers, so the
 * hostname is never provisioned → NXDOMAIN → the QR/link silently never works
 * even though the UI shows a URL. http2 uses TCP/443, which is effectively
 * always allowed, and carries WebSockets (our RPC + PTY) transparently, so there
 * is no functional downside for the remote-access use case.
 *
 * Override via `DEV3_CLOUDFLARED_PROTOCOL` (`quic` | `http2` | `auto`) for users
 * on networks where QUIC works and lower latency is wanted. See decision 097.
 */
export function resolveTunnelProtocol(): string {
	const raw = process.env.DEV3_CLOUDFLARED_PROTOCOL?.trim().toLowerCase();
	if (raw === "quic" || raw === "http2" || raw === "auto") return raw;
	return "http2";
}

/**
 * Which local address cloudflared leaves from when it dials Cloudflare's edge.
 *
 * Unset by default, and that default is deliberate. The flag exists for one
 * situation: a VPN whose exit is far from the machine. A VPN adds a default
 * route with a higher priority than the physical interface's, so cloudflared —
 * like every program that does not ask for anything specific — leaves through
 * the VPN, Cloudflare assigns the edge nearest to the VPN's exit, and every
 * frame then crosses the VPN twice per direction. Measured on one such machine
 * (Seq 1495): 347 ms through a Dublin edge, 27 ms through a Tel Aviv one after
 * binding to the physical interface.
 *
 * It cannot be a default, for two independent reasons. The win is entirely local
 * — with no VPN, or a nearby one, there is nothing to gain — and leaving through
 * the physical interface takes that traffic out of whatever the VPN was
 * installed to do, which is the operator's decision and never ours.
 *
 * Accepts an interface name (`en0`) or a literal address (`172.16.32.163`). The
 * name is preferred: an address handed out by DHCP stops being true after a
 * reconnect, and a stale bind address makes cloudflared unable to dial at all.
 * Anything unresolvable is logged and dropped — a tunnel that starts slowly beats
 * one that does not start.
 */
export function resolveTunnelEdgeBind(): string | null {
	const raw = process.env.DEV3_CLOUDFLARED_EDGE_BIND?.trim();
	if (!raw) return null;
	// A literal address is passed straight through: the user named exactly what
	// they meant, and validating it further would only reject forms cloudflared
	// accepts (scoped IPv6, for one).
	if (/^[0-9.]+$/.test(raw) || raw.includes(":")) return raw;

	// Own-property lookup only: indexing with the raw env string would let
	// `__proto__` reach `Object.prototype`, where `.find` is not a function.
	const interfaces = os.networkInterfaces();
	const iface = Object.prototype.hasOwnProperty.call(interfaces, raw) ? interfaces[raw] : undefined;
	const usable = iface?.find((addr) => addr.family === "IPv4" && !addr.internal);
	if (usable) return usable.address;
	log.warn("DEV3_CLOUDFLARED_EDGE_BIND names no usable interface — starting the tunnel without it", {
		value: raw,
		known: Object.keys(os.networkInterfaces()).join(","),
	});
	return null;
}

/**
 * The exact command line for a quick tunnel.
 *
 * Argument ORDER is load-bearing, not style. `--edge-bind-address` placed before
 * `--url` makes cloudflared print its help text and exit its argument parser
 * without ever registering; the URL never appears, so the failure reads as "the
 * tunnel is just slow" rather than "the flag is misplaced". Keep the bind flag
 * last.
 */
export function buildTunnelArgv(targetPort: number): string[] {
	const argv = ["cloudflared", "tunnel", "--protocol", resolveTunnelProtocol(), "--url", `http://localhost:${targetPort}`];
	const bind = resolveTunnelEdgeBind();
	if (bind) {
		argv.push("--edge-bind-address", bind);
		log.info("Tunnel will dial the edge from a specific local address", { bind });
	}
	return argv;
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

/**
 * Parse cloudflared's local management endpoint from its startup output.
 * `/ready` reports 200 only while at least one edge connection is active;
 * a running process alone is not a tunnel-liveness signal.
 */
export function parseTunnelMetricsUrl(line: string): string | null {
	const match = line.match(/Starting metrics server on\s+(\S+)/i);
	if (!match) return null;
	let address = match[1].replace(/[),;]+$/, "").replace(/\/metrics\/?$/, "");
	if (address.startsWith("0.0.0.0:")) address = `127.0.0.1:${address.slice("0.0.0.0:".length)}`;
	if (address.startsWith("[::]:")) address = `[::1]:${address.slice("[::]:".length)}`;
	const base = /^https?:\/\//i.test(address) ? address : `http://${address}`;
	return `${base}/ready`;
}

function logCloudflaredLine(id: string, line: string): void {
	const trimmed = line.trim();
	if (!trimmed) return;
	const extra = { id, line: trimmed };
	if (/\b(ERR|ERROR|FTL|FATAL)\b/i.test(trimmed)) {
		log.error("cloudflared", extra);
	} else if (/\b(WRN|WARN|WARNING)\b/i.test(trimmed)) {
		log.warn("cloudflared", extra);
	} else {
		log.info("cloudflared", extra);
	}
}

/**
 * Drain stderr for the entire child lifetime. Previously the reader lock was
 * released as soon as the public URL appeared, which discarded every later
 * reconnect error and could eventually back-pressure the child process.
 */
function monitorStderr(entry: TunnelEntry, stderr: ReadableStream): Promise<string | null> {
	const reader = stderr.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let urlResolved = false;
	let resolveUrl!: (url: string | null) => void;
	const urlPromise = new Promise<string | null>((resolve) => {
		resolveUrl = resolve;
	});

	function processLine(line: string): void {
		logCloudflaredLine(entry.id, line);
		const metricsReadyUrl = parseTunnelMetricsUrl(line);
		if (metricsReadyUrl) entry.metricsReadyUrl = metricsReadyUrl;
		if (!urlResolved) {
			const url = parseTunnelUrl(line);
			if (url) {
				urlResolved = true;
				resolveUrl(url);
			}
		}
	}

	void (async () => {
		try {
			while (true) {
				const result = await reader.read();
				if (result.done) break;
				buffer += decoder.decode(result.value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			}
			buffer += decoder.decode();
			if (buffer) processLine(buffer);
		} catch (err) {
			log.warn("Failed to read cloudflared stderr", { id: entry.id, error: String(err) });
		} finally {
			if (!urlResolved) resolveUrl(null);
			try { reader.releaseLock(); } catch { /* already released */ }
		}
	})();

	return urlPromise;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll cloudflared's local /ready endpoint until it reports a live edge
 * connection (HTTP 200) — the authoritative "the hostname is now routable"
 * signal, checked locally (no external DNS round-trip). Returns false on
 * timeout or if the process died mid-wait; the caller then publishes the URL
 * best-effort and the health monitor recovers a genuinely dead edge.
 */
async function waitForEdgeReady(entry: TunnelEntry, timeoutMs: number, pollMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (entry.process === null) return false; // process exited during the wait
		if (entry.metricsReadyUrl) {
			try {
				const resp = await fetch(entry.metricsReadyUrl, { signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS) });
				if (resp.ok) return true;
			} catch {
				// Edge connection not up yet (connection refused / timeout) — keep polling.
			}
		}
		await delay(pollMs);
	}
	return false;
}

async function waitForUrl(urlPromise: Promise<string | null>, timeoutMs: number): Promise<string | null> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			urlPromise,
			new Promise<null>((resolve) => {
				timeout = setTimeout(() => resolve(null), timeoutMs);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

interface TunnelFilter {
	kind?: TunnelKind;
	taskId?: string;
}

type TunnelChangeHook = (entry: TunnelEntry, previousUrl: string | null) => void;
let tunnelChangeHook: TunnelChangeHook | null = null;

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
		adoptedPid: null,
		startedAt: Date.now(),
		subToken: randomBytes(24).toString("base64url"),
		metricsReadyUrl: null,
		consecutiveHealthFailures: 0,
		healthCheckInFlight: false,
		healthCheckTimer: null,
	};
	tunnels.set(opts.id, entry);

	try {
		const proc = spawn(buildTunnelArgv(opts.targetPort), { stdout: "ignore", stderr: "pipe" });
		entry.process = proc;

		// Reset state when the cloudflared process exits unexpectedly.
		proc.exited.then((exitCode) => {
			log.info("Tunnel process exited", { id: opts.id, exitCode });
			const current = tunnels.get(opts.id);
			if (current === entry) {
				if (entry.healthCheckTimer) clearInterval(entry.healthCheckTimer);
				entry.healthCheckTimer = null;
				entry.process = null;
				entry.url = null;
				entry.state = "idle";
			}
		});

		const url = await waitForUrl(monitorStderr(entry, proc.stderr!), URL_WAIT_TIMEOUT_MS);
		if (url) {
			// Wait until the edge actually routes the hostname before publishing it,
			// so a browser scanning the QR / opening the link never hits NXDOMAIN.
			const edgeReady = await waitForEdgeReady(entry, TUNNEL_EDGE_READY.timeoutMs, TUNNEL_EDGE_READY.pollMs);
			// Bail if the tunnel was stopped or its process died during the wait —
			// never resurrect a dead entry into "connected".
			if (tunnels.get(opts.id) !== entry || entry.process === null) return entry;
			entry.url = url;
			entry.state = "connected";
			log.info("Tunnel connected", { id: opts.id, url, edgeReady });
			if (!edgeReady) {
				log.warn("Tunnel /ready not confirmed within timeout; publishing URL best-effort", { id: opts.id, url });
			}
			startHealthMonitor(entry);
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
	if (entry.healthCheckTimer) clearInterval(entry.healthCheckTimer);
	entry.healthCheckTimer = null;
	if (entry.process) {
		try {
			entry.process.kill();
		} catch {
			// process may already be dead
		}
	}
	if (entry.adoptedPid !== null) {
		try {
			process.kill(entry.adoptedPid, "SIGTERM");
		} catch {
			// already gone, or owned by someone else — nothing we can do about it
		}
	}
	tunnels.delete(id);
}

/**
 * Forget the main tunnel WITHOUT killing cloudflared, and report what a successor
 * needs to adopt it. Returns null when there is nothing live to hand over.
 *
 * This is the one place that deliberately leaks a child process, and it is what
 * makes a self-update invisible from the browser: the quick tunnel's hostname is
 * random per cloudflared process, so killing it would change the public URL and
 * invalidate the host-bound session cookie. The successor re-binds the same local
 * port and re-registers this same process; if it cannot, it kills the pid.
 */
export function releaseMainTunnelForHandoff(): { pid: number; url: string; metricsReadyUrl: string | null } | null {
	const entry = tunnels.get(MAIN_ID);
	if (!entry || entry.state !== "connected" || !entry.url) return null;
	const pid = entry.process?.pid ?? entry.adoptedPid;
	if (!pid) return null;
	if (entry.healthCheckTimer) clearInterval(entry.healthCheckTimer);
	entry.healthCheckTimer = null;
	// Drop the map entry rather than stopEntry() — that would signal the child.
	tunnels.delete(MAIN_ID);
	log.info("Released main tunnel for handoff", { pid, url: entry.url });
	return { pid, url: entry.url, metricsReadyUrl: entry.metricsReadyUrl };
}

/**
 * Register a cloudflared this process did not spawn as the main tunnel.
 *
 * The URL is taken on trust from the handoff record (its writer had it from
 * cloudflared's own stderr, which we can no longer read), and liveness is
 * re-established from `/ready` by the ordinary health monitor — which will
 * restart the tunnel for real if the inherited process turns out to be wedged.
 */
export function adoptMainTunnel(opts: {
	pid: number;
	url: string;
	metricsReadyUrl: string | null;
	targetPort: number;
}): void {
	stopEntry(MAIN_ID);
	const entry: TunnelEntry = {
		id: MAIN_ID,
		kind: "main",
		targetPort: opts.targetPort,
		ports: [],
		taskId: undefined,
		state: "connected",
		url: opts.url,
		process: null,
		adoptedPid: opts.pid,
		startedAt: Date.now(),
		subToken: randomBytes(24).toString("base64url"),
		metricsReadyUrl: opts.metricsReadyUrl,
		consecutiveHealthFailures: 0,
		healthCheckInFlight: false,
		healthCheckTimer: null,
	};
	tunnels.set(MAIN_ID, entry);
	log.info("Adopted inherited tunnel", { pid: opts.pid, url: opts.url, port: opts.targetPort });
	startHealthMonitor(entry);
}

async function restartEntry(entry: TunnelEntry): Promise<void> {
	if (tunnels.get(entry.id) !== entry) return;
	const previousUrl = entry.url;
	const opts: StartTunnelOptions = {
		id: entry.id,
		kind: entry.kind,
		targetPort: entry.targetPort,
		ports: [...entry.ports],
		taskId: entry.taskId,
	};
	stopEntry(entry.id);
	const restarted = await startEntry(opts);
	if (restarted.url) {
		log.info("Tunnel restarted", { id: entry.id, previousUrl, url: restarted.url });
		tunnelChangeHook?.(restarted, previousUrl);
	} else {
		log.error("Tunnel restart failed", { id: entry.id, previousUrl });
	}
}

async function checkHealth(id: string): Promise<void> {
	const entry = tunnels.get(id);
	if (!entry || entry.state !== "connected" || !entry.metricsReadyUrl || entry.healthCheckInFlight) return;
	entry.healthCheckInFlight = true;
	try {
		let response: Response | null = null;
		let detail = "";
		try {
			response = await fetch(entry.metricsReadyUrl, {
				signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
			});
			detail = (await response.text()).slice(0, 500);
		} catch (err) {
			detail = String(err);
		}

		if (tunnels.get(id) !== entry) return;
		if (response?.ok) {
			if (entry.consecutiveHealthFailures > 0) {
				log.info("Tunnel edge connection recovered", {
					id,
					previousFailures: entry.consecutiveHealthFailures,
				});
			}
			entry.consecutiveHealthFailures = 0;
			return;
		}

		entry.consecutiveHealthFailures += 1;
		log.warn("Tunnel edge readiness check failed", {
			id,
			status: response?.status ?? null,
			detail,
			consecutiveFailures: entry.consecutiveHealthFailures,
		});
		if (entry.consecutiveHealthFailures >= HEALTH_FAILURE_LIMIT) {
			log.warn("Tunnel unhealthy; restarting", {
				id,
				url: entry.url,
				consecutiveFailures: entry.consecutiveHealthFailures,
			});
			await restartEntry(entry);
		}
	} finally {
		entry.healthCheckInFlight = false;
	}
}

function startHealthMonitor(entry: TunnelEntry): void {
	if (entry.healthCheckTimer) clearInterval(entry.healthCheckTimer);
	entry.healthCheckTimer = setInterval(() => {
		void checkHealth(entry.id);
	}, HEALTH_CHECK_INTERVAL_MS);
	(entry.healthCheckTimer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
}

export const tunnelManager = {
	start: startEntry,
	stop: stopEntry,
	get: (id: string): TunnelEntry | undefined => tunnels.get(id),
	checkHealth,
	setChangeHook: (hook: TunnelChangeHook | null): void => {
		tunnelChangeHook = hook;
	},
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
	for (const entry of tunnels.values()) {
		if (entry.healthCheckTimer) clearInterval(entry.healthCheckTimer);
	}
	tunnels.clear();
}
