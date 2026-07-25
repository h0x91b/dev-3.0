/**
 * Endpoint record for the Windows CLI control transport:
 * `<dev3Home>/sockets/<pid>.endpoint.json`.
 *
 * Windows has no Unix-domain socket for `Bun.listen`, so the app binds a
 * loopback-only TCP listener on an ephemeral port and publishes the port in this
 * record. The record's own PATH is the endpoint handle threaded through the CLI
 * (`CliContext.socketPath`, `sendRequest`, `doctor`) — a real file path, so every
 * existing `existsSync`/display/persist assumption keeps working unchanged and
 * `.sock` handles stay byte-for-byte what they were on POSIX.
 *
 * Additive and safe across versions: every existing socket-dir scan filters on
 * `.sock`, so older builds ignore these records entirely (same argument as the
 * `.meta.json` sidecar). `hostTaskId` is inlined here rather than read from a
 * separate sidecar, so guest deprioritization works from one file.
 *
 * `token` exists because a loopback port has none of a socket file's access
 * control: any local process can connect to it. The CLI reads the token from
 * this record — which already requires being the owning user — and echoes it on
 * every request. One string comparison, not an authorization framework; it is
 * also what tells a live instance apart from a stale record whose port has been
 * taken over by an unrelated process. See decision 172.
 */

/** Suffix that identifies a loopback-TCP endpoint handle (vs a `.sock` path). */
export const CLI_ENDPOINT_SUFFIX = ".endpoint.json";

export const CLI_ENDPOINT_VERSION = 1;

/** The only address the app ever binds or the CLI ever dials. */
export const CLI_LOOPBACK_HOST = "127.0.0.1";

/**
 * Error text returned when a request's token does not match the listening
 * instance. Means "this endpoint record is stale or not ours" — the CLI reports
 * it as an unreachable app rather than a command failure.
 */
export const CLI_ENDPOINT_TOKEN_MISMATCH = "Endpoint token mismatch (stale endpoint record)";

export interface CliEndpointRecord {
	v: number;
	pid: number;
	host: string;
	port: number;
	token: string;
	/** Full task UUID whose context launched this instance, or null for a primary. */
	hostTaskId: string | null;
	startedAt: string;
}

export function cliEndpointFileName(pid: number): string {
	return `${pid}${CLI_ENDPOINT_SUFFIX}`;
}

/** True when a CLI endpoint handle addresses loopback TCP rather than a socket file. */
export function isCliEndpointHandle(handle: string): boolean {
	return handle.endsWith(CLI_ENDPOINT_SUFFIX);
}

/** `<pid>.endpoint.json` → pid, or null when the name is not a record. */
export function pidFromCliEndpointFileName(file: string): number | null {
	if (!isCliEndpointHandle(file)) return null;
	const pid = parseInt(file.slice(0, -CLI_ENDPOINT_SUFFIX.length), 10);
	return Number.isNaN(pid) ? null : pid;
}

export function serializeCliEndpointRecord(record: CliEndpointRecord): string {
	return JSON.stringify(record);
}

/**
 * Parse a record, returning null for anything unusable. A non-loopback `host`
 * is rejected here too: a hand-edited or corrupted record must never be able to
 * make the CLI dial a LAN address.
 */
export function parseCliEndpointRecord(raw: string): CliEndpointRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const candidate = parsed as Partial<CliEndpointRecord>;
	if (candidate.v !== CLI_ENDPOINT_VERSION) return null;
	if (typeof candidate.pid !== "number" || !Number.isInteger(candidate.pid) || candidate.pid <= 0) return null;
	if (candidate.host !== CLI_LOOPBACK_HOST) return null;
	if (typeof candidate.port !== "number" || !Number.isInteger(candidate.port) || candidate.port <= 0 || candidate.port > 65535) return null;
	if (typeof candidate.token !== "string" || candidate.token.length === 0) return null;
	return {
		v: CLI_ENDPOINT_VERSION,
		pid: candidate.pid,
		host: CLI_LOOPBACK_HOST,
		port: candidate.port,
		token: candidate.token,
		hostTaskId: typeof candidate.hostTaskId === "string" && candidate.hostTaskId ? candidate.hostTaskId : null,
		startedAt: typeof candidate.startedAt === "string" ? candidate.startedAt : "",
	};
}
