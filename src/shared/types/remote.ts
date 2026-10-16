// ---- Remote (headless `dev3 remote`) lifecycle ----

/**
 * On-disk record of a running `dev3 remote` headless server, written to
 * `~/.dev3.0/remote/state.json` by the server on startup and removed on
 * graceful shutdown. Lets a SEPARATE `dev3 remote status/stop/url` process
 * (e.g. a fresh SSH session) discover, query, and stop a backgrounded server
 * without scraping the banner. This is an ADDITIVE path — older app versions
 * never read it, so it does not touch the frozen `~/.dev3.0/` layout invariants.
 */
export interface RemoteServerState {
	/** PID of the headless `dev3-server` process (liveness-checked via signal 0). */
	pid: number;
	/** TCP port the remote-access HTTP/WS server bound to. */
	port: number;
	/** Unix CLI socket path this server is listening on (for `url`/`status`). */
	socketPath: string;
	/** Whether a Cloudflare tunnel was requested for this run. */
	tunnelRequested: boolean;
	/** Static access code if `--static-code` was used, else null. */
	staticCode: string | null;
	/** Log file the detached server's stdout/stderr was redirected to (null if foreground). */
	logFile: string | null;
	/** ISO timestamp of when the server started. */
	startedAt: string;
	/** dev3 build version that wrote this record. */
	version: string;
	/**
	 * Written by a server that is exiting to be replaced by a newer build, read
	 * once by its successor. Absent on an ordinary start.
	 *
	 * THIS IS WHAT KEEPS THE PUBLIC LINK ALIVE ACROSS A SELF-UPDATE. The quick
	 * tunnel's hostname is random per `cloudflared` process and the session cookie
	 * is host-bound, so a stop-then-start hands the user a dead URL and a re-auth
	 * on the very device they are holding. The successor binds the same port and
	 * adopts the same still-running cloudflared instead.
	 */
	handoff?: RemoteHandoff | null;
	/**
	 * What the last self-update did, kept AFTER the restart. The renderer shows no
	 * "updating…" state, so this record is the only thing that explains an
	 * otherwise unexplained restart in `dev3 remote status`.
	 */
	lastUpdate?: RemoteUpdateRecord | null;
	/**
	 * Failed attempts at one offered version, DELIBERATELY ON DISK rather than in
	 * the watch's memory.
	 *
	 * The failure that matters most destroys the memory holding the counter: an
	 * update that applies and then does not boot leaves the old build restarted by
	 * the supervisor, with a fresh in-process counter at zero. Without this the box
	 * re-downloads and re-applies the same broken release every quiet window,
	 * forever, each round costing a full download and about a minute unreachable.
	 */
	updateAttempts?: RemoteUpdateAttempts | null;
}

/** The port + live tunnel one server hands to its replacement. */
export interface RemoteHandoff {
	/** Port to re-bind. Survives a restart nobody passed `--port` to. */
	port: number;
	/** PID of the dying server, so the successor can tell a stale record apart. */
	fromPid: number;
	/**
	 * The `cloudflared` process left running on purpose. Null when the box had no
	 * tunnel. The successor has no exit promise for an adopted process, so its
	 * liveness comes from `metricsReadyUrl` — the same endpoint the tunnel health
	 * monitor already polls.
	 */
	tunnel: { pid: number; url: string; metricsReadyUrl: string | null } | null;
	/**
	 * The URL the successor is expected to come back on, set when a custom
	 * provider's hostname is known to be stable and its tunnel was therefore
	 * STOPPED rather than leaked. The successor spawns its own tunnel and compares:
	 * an equal URL means the browser session survived, a different one means the
	 * stability observation was wrong and the QR has to be re-scanned.
	 */
	stableTunnelUrl?: string | null;
}

/** From-version, to-version and when, for `dev3 remote status` after the fact. */
export interface RemoteUpdateRecord {
	fromVersion: string;
	toVersion: string;
	/** ISO timestamp of when the update started (before the restart). */
	startedAt: string;
}

/** Failed attempts at one version, surviving the restart that lost the counter. */
export interface RemoteUpdateAttempts {
	/** The offered version these failures belong to. A new version resets them. */
	version: string;
	failures: number;
	/** Epoch ms of the most recent failure, driving the backoff. */
	lastFailureMs: number;
	/** Why the last one failed, so the journal is not the only record. */
	lastError?: string;
}

/**
 * Why the remote-access server is not serving. `port` is the port that was asked
 * for — 0 when none was pinned and the random pick itself failed.
 */
export interface RemoteAccessStartFailure {
	port: number;
	reason: "port-in-use" | "other";
	message: string;
}

/** Whether remote access is serving, and on what. `failure` is null while it is. */
export interface RemoteAccessStatus {
	running: boolean;
	port: number;
	failure: RemoteAccessStartFailure | null;
}

/**
 * One IPv4 address the headless server is reachable at, for the Remote Access
 * modal's interface picker. `internal: true` marks loopback (127.0.0.1).
 */
export interface RemoteNetInterface {
	/** Interface name (e.g. "en0", "utun3") or "loopback" for 127.0.0.1. */
	name: string;
	/** The IPv4 address. */
	address: string;
	/** True for loopback / same-machine addresses. */
	internal: boolean;
}

/**
 * Fresh access info for a running remote server, returned by the `remote.accessUrl`
 * CLI-socket method. The URL embeds a one-time QR token minted in the SERVER
 * process (where the JWT secret lives), so a detached `dev3 remote url` can print
 * a scannable URL it could never mint itself.
 */
export interface RemoteAccessInfo {
	/** Full access URL with a fresh one-time `?token=` — never the access code. */
	url: string;
	/** Public Cloudflare tunnel URL, or null if no tunnel is connected. */
	tunnelUrl: string | null;
	/** TCP port the server is bound to. */
	port: number;
	/** The permanent access code, if one is set, else null. */
	staticCode: string | null;
	/**
	 * Bookmarkable sign-in link: the access URL with the code in its FRAGMENT, so
	 * clicking the bookmark signs in with nothing typed. Null when no code is set.
	 */
	signInLink: string | null;
}
