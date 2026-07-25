import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { DEV3_HOME } from "./paths";
import { createLogger } from "./logger";
import { isCliEndpointHandle, parseCliEndpointRecord, pidFromCliEndpointFileName } from "../shared/cli-endpoint";

const log = createLogger("instance-broadcast");

const SOCKETS_DIR = `${DEV3_HOME}/sockets`;
const NOTIFY_TIMEOUT_MS = 2000;
const DEBOUNCE_MS = 50;

/**
 * Discover all alive peer endpoint handles (excluding our own PID): `<pid>.sock`
 * on POSIX, `<pid>.endpoint.json` loopback records on Windows. Without the
 * records, cross-instance data-change notifications would silently stop working
 * on Windows even though the CLI transport itself works.
 */
export function discoverPeerSockets(): string[] {
	if (!existsSync(SOCKETS_DIR)) return [];

	const myPid = process.pid;
	const peers: string[] = [];

	for (const file of readdirSync(SOCKETS_DIR)) {
		const unix = file.endsWith(".sock");
		if (!unix && !isCliEndpointHandle(file)) continue;
		const pid = unix ? parseInt(file.replace(".sock", ""), 10) : (pidFromCliEndpointFileName(file) ?? NaN);
		if (isNaN(pid) || pid === myPid) continue;

		try {
			process.kill(pid, 0); // Check if alive (signal 0 = no-op probe)
			peers.push(`${SOCKETS_DIR}/${file}`);
		} catch {
			// Process is dead — clean up stale socket
			const stalePath = `${SOCKETS_DIR}/${file}`;
			try {
				unlinkSync(stalePath);
			} catch { /* already gone */ }
			log.debug("Removed stale peer socket", { pid });
		}
	}

	return peers;
}

function readPeerRecord(recordPath: string): ReturnType<typeof parseCliEndpointRecord> {
	try {
		return parseCliEndpointRecord(readFileSync(recordPath, "utf-8"));
	} catch {
		return null;
	}
}

/** Fire-and-forget: send a _notify message to a single peer endpoint. */
async function notifySocket(
	socketPath: string,
	event: string,
	params: Record<string, string>,
): Promise<void> {
	// A loopback peer requires the token from its endpoint record; an unusable
	// record means that peer is not reachable, so skip it silently.
	const record = isCliEndpointHandle(socketPath) ? readPeerRecord(socketPath) : null;
	if (isCliEndpointHandle(socketPath) && !record) {
		log.debug("Skipping peer with an unusable endpoint record", { socketPath });
		return;
	}
	const payload = JSON.stringify({
		id: "_notify",
		method: "_notify",
		params: { event, ...params },
		...(record ? { token: record.token } : {}),
	}) + "\n";

	return new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			log.debug("Notify timed out", { socketPath });
			resolve();
		}, NOTIFY_TIMEOUT_MS);

		const handlers = {
			open(socket: { write(data: string): unknown; end(): unknown }) {
				socket.write(payload);
				socket.end();
			},
			data() { /* ignore response */ },
			close() {
				clearTimeout(timer);
				resolve();
			},
			error(_socket: unknown, error: unknown) {
				clearTimeout(timer);
				cleanupIfStale(socketPath, error);
				resolve();
			},
			drain() { /* no-op */ },
		};

		try {
			const connecting = record
				? Bun.connect({ hostname: record.host, port: record.port, socket: handlers } as never)
				: Bun.connect({ unix: socketPath, socket: handlers } as never);
			connecting.catch((err) => {
				clearTimeout(timer);
				cleanupIfStale(socketPath, err);
				resolve();
			});
		} catch (err) {
			clearTimeout(timer);
			cleanupIfStale(socketPath, err);
			resolve();
		}
	});
}

function cleanupIfStale(socketPath: string, err: unknown): void {
	const msg = err instanceof Error ? err.message : String(err);
	if (/ECONNREFUSED|ENOENT/.test(msg)) {
		try {
			unlinkSync(socketPath);
		} catch { /* already gone */ }
		log.debug("Cleaned up stale socket on connect error", { socketPath });
	} else {
		log.debug("Notify error (non-fatal)", { socketPath, error: msg });
	}
}

// ---- Debounced broadcast ----

const pendingBroadcasts = new Map<string, ReturnType<typeof setTimeout>>();

async function broadcastNow(event: string, params: Record<string, string>): Promise<void> {
	const peers = discoverPeerSockets();
	if (peers.length === 0) return;

	log.debug("Broadcasting to peers", { event, peerCount: peers.length });
	await Promise.allSettled(peers.map((p) => notifySocket(p, event, params)));
}

/**
 * Broadcast a data-change notification to all other running dev-3.0 instances.
 * Debounced: rapid-fire updates for the same entity coalesce into one notification.
 */
export function broadcastToOtherInstances(event: string, params: Record<string, string>): void {
	const key = `${event}:${params.projectId ?? ""}:${params.taskId ?? ""}`;
	const existing = pendingBroadcasts.get(key);
	if (existing) clearTimeout(existing);

	pendingBroadcasts.set(
		key,
		setTimeout(() => {
			pendingBroadcasts.delete(key);
			broadcastNow(event, params).catch((err) => {
				log.debug("Broadcast failed (non-fatal)", { error: String(err) });
			});
		}, DEBOUNCE_MS),
	);
}
