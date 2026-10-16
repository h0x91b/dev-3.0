import { randomBytes } from "node:crypto";
import os from "node:os";
import { spawn, spawnSync } from "./spawn";
import { createLogger } from "./logger";
import { isProcessAlive } from "./remote-state";
import {
	buildCustomTunnelArgv,
	extractTunnelUrl,
	resolveRemoteTunnelProvider,
	tunnelCommandName,
	type ResolvedTunnelProvider,
} from "./tunnel-provider";
import { customTunnelHostIsStable, recordCustomTunnelUrl } from "./tunnel-host-memory";

const log = createLogger("tunnel");

export type TunnelState = "idle" | "starting" | "connected" | "failed";
export type TunnelKind = "main" | "task-port" | "task-shared";

/**
 * One running tunnel process (cloudflared or a custom command) + the metadata
 * we need to address it.
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
	/**
	 * Readiness probe for a custom provider, which exposes no local metrics port:
	 * its own public URL. Set once the URL is scraped, so the health monitor can
	 * watch the edge instead of trusting a live process with a dead tunnel.
	 */
	publicProbeUrl: string | null;
	/**
	 * This custom provider has been observed handing out the same hostname across
	 * restarts (see tunnel-host-memory.ts), so a self-update can stop the tunnel
	 * instead of leaking the process to keep the URL alive.
	 */
	stableHostname: boolean;
	consecutiveHealthFailures: number;
	healthCheckInFlight: boolean;
	healthCheckTimer: ReturnType<typeof setInterval> | null;
	/** Why this start failed, for every kind — recovery must not retry a misconfigured command. */
	failureReason: TunnelFailureReason | null;
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
/**
 * A custom provider is probed over the public internet rather than a local
 * metrics port, so it polls less often and gives up sooner — the URL is
 * published best-effort either way, and the tunnel is usually live on the first
 * probe.
 */
export const CUSTOM_TUNNEL_EDGE_READY = { timeoutMs: 10_000, pollMs: 750 };

/**
 * Bringing back a tunnel that was serving and went away — its process exited, or
 * a health restart could not start a successor. Retries back off and never give
 * up while the tunnel is wanted; an explicit stop cancels them. Tunable for tests.
 */
export const TUNNEL_RECOVERY = {
	retryDelaysMs: [5_000, 15_000, 30_000, 60_000, 120_000, 300_000],
	oldProcessExitTimeoutMs: 5_000,
};

const tunnels = new Map<string, TunnelEntry>();
const recoveries = new Map<string, { timer: ReturnType<typeof setTimeout>; opts: StartTunnelOptions }>();
// Bumped by every explicit stop, so a recovery or restart in flight can tell it was cancelled.
const stopGenerations = new Map<string, number>();

/**
 * Why the LAST main-tunnel start failed, for the Remote Access modal — the
 * entry itself is deleted on failure, so the reason has to outlive it.
 * `command-not-found` and `command-empty` both point the user at the tunnel
 * settings rather than a generic "failed".
 */
export type TunnelFailureReason = "command-not-found" | "command-empty" | "no-url";
let mainTunnelFailureReason: TunnelFailureReason | null = null;

export function getMainTunnelFailureReason(): TunnelFailureReason | null {
	return mainTunnelFailureReason;
}

/**
 * Availability of whatever will actually run for the MAIN remote-access
 * tunnel: `cloudflared` for the built-in provider, or the first word of the
 * user's custom command (Settings → System → Tunnel provider).
 */
export function isTunnelBinaryAvailable(): boolean {
	const provider = resolveRemoteTunnelProvider();
	// A custom command is never pre-judged: shell-quoted paths and leading
	// VAR=value assignments defeat any string probe. Availability is derived
	// from the outcome instead — a `sh -c` that exits 127 IS "command not
	// found", measured on the exact line that runs (see startEntry).
	if (provider.kind === "custom") return true;
	if (provider.kind === "misconfigured") return false;
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
const CLOUDFLARE_URL_REGEX = /https:\/\/[a-zA-Z0-9_-]+\.trycloudflare\.com/;

export function parseTunnelUrl(line: string): string | null {
	const match = line.match(CLOUDFLARE_URL_REGEX);
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

/** Attribute a piped output line to the tool that printed it, not always cloudflared. */
function logTunnelLine(id: string, line: string, source: string): void {
	const trimmed = line.trim();
	if (!trimmed) return;
	const extra = { id, line: trimmed };
	if (/\b(ERR|ERROR|FTL|FATAL)\b/i.test(trimmed)) {
		log.error(source, extra);
	} else if (/\b(WRN|WARN|WARNING)\b/i.test(trimmed)) {
		log.warn(source, extra);
	} else {
		log.info(source, extra);
	}
}

/**
 * Drain stderr for the entire child lifetime. Previously the reader lock was
 * released as soon as the public URL appeared, which discarded every later
 * reconnect error and could eventually back-pressure the child process.
 */
function monitorOutput(entry: TunnelEntry, stream: ReadableStream, urlRegex: RegExp, source: string, parseMetrics: boolean): Promise<string | null> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let urlResolved = false;
	let resolveUrl!: (url: string | null) => void;
	const urlPromise = new Promise<string | null>((resolve) => {
		resolveUrl = resolve;
	});

	function processLine(line: string): void {
		logTunnelLine(entry.id, line, source);
		// Only cloudflared's metrics endpoint is trusted: a custom CLI that
		// happens to print a metrics-server line must not silently replace its
		// public-URL health probe with a /ready poll that is not cloudflared's.
		if (parseMetrics) {
			const metricsReadyUrl = parseTunnelMetricsUrl(line);
			if (metricsReadyUrl) entry.metricsReadyUrl = metricsReadyUrl;
		}
		if (!urlResolved) {
			const url = extractTunnelUrl(line, urlRegex);
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
			log.warn("Failed to read tunnel process output", { id: entry.id, error: String(err) });
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

/** First non-null URL across the monitored streams; null once all end without one. */
function firstUrl(promises: Promise<string | null>[]): Promise<string | null> {
	return new Promise((resolve) => {
		let pending = promises.length;
		for (const p of promises) {
			void p.then((url) => {
				if (url) resolve(url);
				else if (--pending === 0) resolve(null);
			});
		}
	});
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

/**
 * Readiness for a custom provider, which has no local metrics endpoint: probe
 * the scraped public URL until the edge answers at all. ANY HTTP status counts
 * as routable — a tunnel that gates access returns 401/403/404 from its own
 * edge, which still proves the hostname resolves and forwards. Only a transport
 * failure (DNS, refused connection, TLS, timeout) means it is not up yet.
 */
async function waitForPublicUrlReady(entry: TunnelEntry, url: string, timeoutMs: number, pollMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (entry.process === null) return false; // process exited during the wait
		try {
			await fetch(url, {
				method: "HEAD",
				redirect: "manual",
				signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
			});
			return true;
		} catch {
			// Not routable yet — keep polling until the deadline.
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

function matchesFilter(entry: Pick<TunnelEntry, "kind" | "taskId">, filter?: TunnelFilter): boolean {
	if (!filter) return true;
	if (filter.kind !== undefined && entry.kind !== filter.kind) return false;
	if (filter.taskId !== undefined && entry.taskId !== filter.taskId) return false;
	return true;
}

/**
 * A fixed-hostname custom provider can serve only one tunnel at a time — a
 * second concurrent invocation lands on the same public URL and the edge routes
 * it to whichever process won. dev3 cannot fix that, but it can say it plainly
 * instead of letting two surfaces advertise one URL that serves only one of them.
 */
function warnOnDuplicateUrl(entry: TunnelEntry): void {
	if (!entry.url) return;
	for (const other of tunnels.values()) {
		if (other !== entry && other.url === entry.url) {
			log.warn("Two live tunnels share one public URL — a fixed-hostname command cannot serve concurrent tunnels; make the hostname depend on {port}", {
				id: entry.id,
				conflictsWith: other.id,
				url: entry.url,
			});
			return;
		}
	}
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
		publicProbeUrl: null,
		stableHostname: false,
		consecutiveHealthFailures: 0,
		healthCheckInFlight: false,
		healthCheckTimer: null,
		failureReason: null,
	};
	tunnels.set(opts.id, entry);

	// One provider for every tunnel kind: the main remote-access tunnel and
	// per-task port tunnels all run through the configured provider.
	const provider: ResolvedTunnelProvider = resolveRemoteTunnelProvider();
	const isCustom = provider.kind === "custom" && !!provider.command;

	// Fail closed: "custom" with a blank command starts NOTHING. Falling back
	// to cloudflared here would hand a public quick tunnel to exactly the user
	// who selected Custom because their network forbids cloudflared.
	if (provider.kind === "misconfigured") {
		log.warn("Custom tunnel provider selected but its command is empty — not starting a tunnel", { id: opts.id });
		entry.failureReason = "command-empty";
		if (opts.kind === "main") mainTunnelFailureReason = entry.failureReason;
		entry.state = "failed";
		tunnels.delete(opts.id);
		return entry;
	}

	try {
		const argv = isCustom ? buildCustomTunnelArgv(provider.command!, opts.targetPort) : buildTunnelArgv(opts.targetPort);
		// cloudflared logs to stderr; a custom CLI may print its URL on either
		// stream, so pipe and scan both.
		const proc = spawn(argv, { stdout: isCustom ? "pipe" : "ignore", stderr: "pipe" });
		entry.process = proc;
		if (isCustom) log.info("Starting custom tunnel command", { id: opts.id, targetPort: opts.targetPort });

		// Reset state when the tunnel process exits unexpectedly. The exit code
		// is also the availability signal for a custom command: sh exits 127 for
		// "command not found" (126 for not-executable) on the line that ran.
		let lastExitCode: number | null = null;
		proc.exited.then((exitCode) => {
			lastExitCode = exitCode;
			log.info("Tunnel process exited", { id: opts.id, exitCode });
			const current = tunnels.get(opts.id);
			if (current === entry) {
				const lostUrl = entry.state === "connected" ? entry.url : null;
				if (entry.healthCheckTimer) clearInterval(entry.healthCheckTimer);
				entry.healthCheckTimer = null;
				entry.process = null;
				entry.url = null;
				entry.state = "idle";
				if (lostUrl) {
					log.warn("Tunnel process exited while serving", { id: opts.id, exitCode });
					scheduleRecovery(optionsFor(entry), lostUrl, 0, null);
				}
			}
		});

		const urlRegex = isCustom ? provider.urlRegex! : CLOUDFLARE_URL_REGEX;
		const source = isCustom ? tunnelCommandName(provider.command!) : "cloudflared";
		const urlPromises = [monitorOutput(entry, proc.stderr!, urlRegex, source, !isCustom)];
		if (isCustom && proc.stdout) urlPromises.push(monitorOutput(entry, proc.stdout as ReadableStream, urlRegex, source, !isCustom));
		const url = await waitForUrl(firstUrl(urlPromises), URL_WAIT_TIMEOUT_MS);
		if (url) {
			// Wait until the edge actually routes the hostname before publishing it,
			// so a browser scanning the QR / opening the link never hits NXDOMAIN.
			// A custom provider has no local readiness endpoint — its URL is
			// published as soon as it is printed.
			if (isCustom) entry.publicProbeUrl = url;
			const edgeReady = isCustom
				? await waitForPublicUrlReady(entry, url, CUSTOM_TUNNEL_EDGE_READY.timeoutMs, CUSTOM_TUNNEL_EDGE_READY.pollMs)
				: await waitForEdgeReady(entry, TUNNEL_EDGE_READY.timeoutMs, TUNNEL_EDGE_READY.pollMs);
			// Bail if the tunnel was stopped or its process died during the wait —
			// never resurrect a dead entry into "connected".
			if (tunnels.get(opts.id) !== entry || entry.process === null) return entry;
			entry.url = url;
			entry.state = "connected";
			if (opts.kind === "main") mainTunnelFailureReason = null;
			// Hostname-stability learning belongs to the main tunnel alone: the memory
			// holds one (command, url) pair, concurrent port tunnels would flip-flop it,
			// and the stability bit only feeds the main tunnel's self-update handoff.
			if (isCustom && opts.kind === "main") entry.stableHostname = recordCustomTunnelUrl(provider.command!, url);
			if (isCustom) warnOnDuplicateUrl(entry);
			log.info("Tunnel connected", {
				id: opts.id,
				url,
				probe: isCustom ? "public-url" : "metrics-ready",
				edgeCheck: edgeReady ? "ready" : "unconfirmed",
				...(isCustom && opts.kind === "main" ? { hostname: entry.stableHostname ? "stable" : "unproven" } : {}),
			});
			if (!edgeReady) {
				log.warn("Tunnel edge not confirmed within timeout; publishing URL best-effort", { id: opts.id, url });
			}
			startHealthMonitor(entry);
			return entry;
		}

		// The output streams close BEFORE `proc.exited` settles, so the exit code
		// is usually still null right here — give it a beat, or the not-found
		// classification below can never fire (the process is already dead when
		// the URL wait comes up empty, this is not a 30s stall).
		await Promise.race([proc.exited, delay(200)]);
		const notFound = isCustom && (lastExitCode === 127 || lastExitCode === 126);
		if (notFound) {
			log.warn("Custom tunnel command not found — sh could not run it", { id: opts.id, exitCode: lastExitCode });
		} else {
			log.warn("Tunnel URL not found in process output within timeout", { id: opts.id, provider: provider.kind });
		}
		entry.failureReason = notFound ? "command-not-found" : "no-url";
		if (opts.kind === "main") mainTunnelFailureReason = entry.failureReason;
		entry.state = "failed";
		teardownEntry(opts.id);
		return entry;
	} catch (err) {
		log.error("Failed to start tunnel", { id: opts.id, error: String(err) });
		entry.state = "failed";
		teardownEntry(opts.id);
		return entry;
	}
}

/** An explicit stop: the tunnel is no longer wanted, so pending recovery is cancelled too. */
function stopEntry(id: string): void {
	cancelRecovery(id);
	stopGenerations.set(id, stopGeneration(id) + 1);
	teardownEntry(id);
}

function stopGeneration(id: string): number {
	return stopGenerations.get(id) ?? 0;
}

/** Returns the wrapper's children it signalled, which a restart must also wait out. */
function teardownEntry(id: string): number[] {
	const entry = tunnels.get(id);
	if (!entry) return [];
	if (entry.healthCheckTimer) clearInterval(entry.healthCheckTimer);
	entry.healthCheckTimer = null;
	let childPids: number[] = [];
	if (entry.process) {
		const pid = entry.process.pid;
		// A custom command that is a pipeline keeps its wrapper shell (no exec),
		// so the kill below hits sh and the tunnel it spawned would live on.
		// Capture the children FIRST — killing sh reparents them to init, after
		// which `pkill -P <pid>` matches nothing. A plain command has none.
		if (process.platform !== "win32" && pid) {
			try {
				const out = spawnSync(["pgrep", "-P", String(pid)]).stdout?.toString() ?? "";
				childPids = out.split("\n").map((s) => Number.parseInt(s, 10)).filter((n) => Number.isFinite(n) && n > 0);
			} catch {
				// pgrep missing — the exec'd common case has no children anyway
			}
		}
		try {
			entry.process.kill();
		} catch {
			// process may already be dead
		}
		for (const child of childPids) {
			try {
				process.kill(child, "SIGTERM");
			} catch {
				// already gone
			}
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
	return childPids;
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
 * Stop the main tunnel INSTEAD of leaking it across a self-update, for a provider
 * whose hostname is known to be stable. Returns the URL the successor should come
 * back on, or null when this tunnel has to be handed over the leaky way.
 *
 * The leak exists only because a quick tunnel's hostname is random per process.
 * When the same command reliably yields the same hostname, respawning is strictly
 * better: no orphan survives an abandoned restart, the successor owns a process it
 * spawned itself (with output to scrape and an exit promise), and the session
 * cookie still matches because the host did not change.
 */
export function stopMainTunnelForStableHandoff(): string | null {
	const entry = tunnels.get(MAIN_ID);
	if (!entry || entry.state !== "connected" || !entry.url || !entry.stableHostname) return null;
	const url = entry.url;
	stopEntry(MAIN_ID);
	log.info("Stopped a stable-hostname tunnel rather than leaking it across the restart", { url });
	return url;
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
	// An adopted process has no metrics endpoint under a custom provider, and no
	// exit promise either — without a probe it would be trusted forever. Its own
	// public URL is the only health signal available, and it is a better one.
	const provider = resolveRemoteTunnelProvider();
	const custom = provider.kind === "custom" && !!provider.command;
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
		publicProbeUrl: custom && !opts.metricsReadyUrl ? opts.url : null,
		stableHostname: custom ? customTunnelHostIsStable(provider.command!) : false,
		consecutiveHealthFailures: 0,
		healthCheckInFlight: false,
		healthCheckTimer: null,
		failureReason: null,
	};
	tunnels.set(MAIN_ID, entry);
	log.info("Adopted inherited tunnel", { pid: opts.pid, url: opts.url, port: opts.targetPort });
	startHealthMonitor(entry);
}

function optionsFor(entry: TunnelEntry): StartTunnelOptions {
	return {
		id: entry.id,
		kind: entry.kind,
		targetPort: entry.targetPort,
		ports: [...entry.ports],
		taskId: entry.taskId,
	};
}

/**
 * Wait for a signalled tunnel process to be gone, escalating to SIGKILL. A
 * successor spawned while its predecessor is still in cloudflared's graceful
 * shutdown (30 s by default) can collide with whatever the old one still holds.
 * A wrapper (`flock`, a pipeline without exec) dies at once while the connector
 * it forked keeps the lock, so those children are waited out by PID as well.
 */
async function waitForProcessGone(proc: TunnelEntry["process"], pids: number[]): Promise<void> {
	const timeoutMs = TUNNEL_RECOVERY.oldProcessExitTimeoutMs;
	const deadline = Date.now() + timeoutMs;
	if (proc) {
		const exited = await Promise.race([proc.exited.then(() => true), delay(timeoutMs).then(() => false)]);
		if (!exited) {
			try {
				proc.kill(9);
			} catch {
				// already gone
			}
			await Promise.race([proc.exited, delay(timeoutMs)]);
		}
	}
	const alive = () => pids.filter(isProcessAlive);
	while (alive().length > 0 && Date.now() < deadline) await delay(100);
	for (const pid of alive()) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone, or owned by someone else
		}
	}
}

async function restartEntry(entry: TunnelEntry): Promise<void> {
	if (tunnels.get(entry.id) !== entry) return;
	const previousUrl = entry.url;
	const opts = optionsFor(entry);
	const generation = stopGeneration(entry.id);
	const { process: oldProcess, adoptedPid } = entry;
	const children = teardownEntry(entry.id);
	await waitForProcessGone(oldProcess, adoptedPid === null ? children : [adoptedPid, ...children]);
	if (stopGeneration(entry.id) !== generation) return;
	const restarted = await startEntry(opts);
	if (restarted.url) {
		log.info("Tunnel restarted", { id: entry.id, previousUrl, url: restarted.url });
		tunnelChangeHook?.(restarted, previousUrl);
	} else {
		log.error("Tunnel restart failed", { id: entry.id, previousUrl });
		if (stopGeneration(entry.id) === generation) scheduleRecovery(opts, previousUrl, 0, restarted.failureReason);
	}
}

function cancelRecovery(id: string): void {
	const pending = recoveries.get(id);
	if (!pending) return;
	clearTimeout(pending.timer);
	recoveries.delete(id);
}

function scheduleRecovery(
	opts: StartTunnelOptions,
	previousUrl: string | null,
	attempt: number,
	lastFailure: TunnelFailureReason | null,
): boolean {
	if (lastFailure === "command-not-found" || lastFailure === "command-empty") {
		log.warn("Tunnel command is misconfigured — not retrying until it is started again", { id: opts.id, reason: lastFailure });
		return false;
	}
	cancelRecovery(opts.id);
	const delays = TUNNEL_RECOVERY.retryDelaysMs;
	const delayMs = delays[Math.min(attempt, delays.length - 1)];
	const generation = stopGeneration(opts.id);
	log.warn("Tunnel down; retrying", { id: opts.id, attempt: attempt + 1, delayMs });
	const timer = setTimeout(() => {
		recoveries.delete(opts.id);
		void recoverEntry(opts, previousUrl, attempt, generation);
	}, delayMs);
	(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
	recoveries.set(opts.id, { timer, opts });
	return true;
}

async function recoverEntry(opts: StartTunnelOptions, previousUrl: string | null, attempt: number, generation: number): Promise<void> {
	if (stopGeneration(opts.id) !== generation) return;
	const existing = tunnels.get(opts.id);
	if (existing && (existing.state === "starting" || existing.state === "connected")) return;
	const entry = await startEntry(opts);
	if (stopGeneration(opts.id) !== generation) return;
	if (entry.url) {
		log.info("Tunnel recovered", { id: opts.id, attempt: attempt + 1, previousUrl, url: entry.url });
		tunnelChangeHook?.(entry, previousUrl);
		return;
	}
	scheduleRecovery(opts, previousUrl, attempt + 1, entry.failureReason);
}

/**
 * Keep trying to bring the main tunnel up in the background — for a server that
 * runs with a tunnel by intent but whose first start failed (e.g. booted offline).
 * False when the last failure was a misconfigured command, which is never retried.
 */
export function retryMainTunnel(localPort: number): boolean {
	return scheduleRecovery({ id: MAIN_ID, kind: "main", targetPort: localPort }, null, 0, mainTunnelFailureReason);
}

/**
 * Ongoing health for a custom provider: keep probing its public URL, so a live
 * command whose tunnel has silently dropped is caught instead of being trusted
 * on process liveness alone. Any HTTP answer is healthy — see
 * `waitForPublicUrlReady` for why a 401/403 still proves the edge routes.
 */
async function checkPublicUrlHealth(entry: TunnelEntry, probeUrl: string): Promise<void> {
	entry.healthCheckInFlight = true;
	try {
		let reachable = false;
		let detail = "";
		try {
			const response = await fetch(probeUrl, {
				method: "HEAD",
				redirect: "manual",
				signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
			});
			reachable = true;
			detail = `status ${response.status}`;
		} catch (err) {
			detail = String(err);
		}

		if (tunnels.get(entry.id) !== entry) return;
		if (reachable) {
			if (entry.consecutiveHealthFailures > 0) {
				log.info("Tunnel edge recovered", { id: entry.id, previousFailures: entry.consecutiveHealthFailures });
			}
			entry.consecutiveHealthFailures = 0;
			return;
		}

		entry.consecutiveHealthFailures += 1;
		log.warn("Tunnel public URL unreachable", {
			id: entry.id,
			probe: "public-url",
			detail,
			consecutiveFailures: entry.consecutiveHealthFailures,
		});
		if (entry.consecutiveHealthFailures >= HEALTH_FAILURE_LIMIT) {
			log.warn("Tunnel unhealthy; restarting", { id: entry.id, url: entry.url });
			await restartEntry(entry);
		}
	} finally {
		entry.healthCheckInFlight = false;
	}
}

async function checkHealth(id: string): Promise<void> {
	const entry = tunnels.get(id);
	if (!entry || entry.state !== "connected" || entry.healthCheckInFlight) return;

	// A custom provider has no local metrics port, but it does have a public URL,
	// which is a better signal than "the process is still alive".
	if (!entry.metricsReadyUrl && entry.publicProbeUrl) {
		await checkPublicUrlHealth(entry, entry.publicProbeUrl);
		return;
	}

	// AN ADOPTED TUNNEL WITH NO `/ready` URL IS WATCHED BY ITS PID, or not at all.
	// An entry we spawned has a `process` whose `exited` hook resets it; an inherited
	// one has `process: null`, so `metricsReadyUrl` is its only liveness signal — and
	// `startEntry` legitimately produces null there (the URL is published best-effort
	// when the edge-ready wait cannot confirm). Returning early on that left a dead
	// cloudflared recorded as "connected" forever, with the banner, `dev3 remote url`
	// and every browser advertising a hostname that resolves nowhere.
	if (!entry.metricsReadyUrl) {
		if (entry.adoptedPid === null || isProcessAlive(entry.adoptedPid)) return;
		log.warn("Adopted tunnel process is gone and it has no readiness URL; restarting", {
			id,
			pid: entry.adoptedPid,
			url: entry.url,
		});
		entry.healthCheckInFlight = true;
		try {
			await restartEntry(entry);
		} finally {
			entry.healthCheckInFlight = false;
		}
		return;
	}

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
		// A tunnel between recovery attempts has no entry, only a pending retry.
		for (const [id, pending] of recoveries) {
			if (matchesFilter(pending.opts, filter)) ids.push(id);
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
	for (const pending of recoveries.values()) clearTimeout(pending.timer);
	recoveries.clear();
	stopGenerations.clear();
	mainTunnelFailureReason = null;
}
