import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { DEV3_HOME } from "./paths";
import { createLogger } from "./logger";

const log = createLogger("instance-broadcast");

const SOCKETS_DIR = `${DEV3_HOME}/sockets`;
const NOTIFY_TIMEOUT_MS = 2000;
const DEBOUNCE_MS = 50;

/** Discover all alive peer socket paths (excluding our own PID). */
export function discoverPeerSockets(): string[] {
	if (!existsSync(SOCKETS_DIR)) return [];

	const myPid = process.pid;
	const peers: string[] = [];

	for (const file of readdirSync(SOCKETS_DIR)) {
		if (!file.endsWith(".sock")) continue;
		const pid = parseInt(file.replace(".sock", ""), 10);
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

/** Fire-and-forget: send a _notify message to a single socket. */
async function notifySocket(
	socketPath: string,
	event: string,
	params: Record<string, string>,
): Promise<void> {
	const payload = JSON.stringify({
		id: "_notify",
		method: "_notify",
		params: { event, ...params },
	}) + "\n";

	return new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			log.debug("Notify timed out", { socketPath });
			resolve();
		}, NOTIFY_TIMEOUT_MS);

		try {
			Bun.connect({
				unix: socketPath,
				socket: {
					open(socket) {
						socket.write(payload);
						socket.end();
					},
					data() { /* ignore response */ },
					close() {
						clearTimeout(timer);
						resolve();
					},
					error(_, error) {
						clearTimeout(timer);
						cleanupIfStale(socketPath, error);
						resolve();
					},
					drain() { /* no-op */ },
				},
			}).catch((err) => {
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
