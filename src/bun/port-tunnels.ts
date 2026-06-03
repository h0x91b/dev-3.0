import type { ExposedPort } from "../shared/types";
import { tunnelManager, type TunnelEntry } from "./cloudflare-tunnel";
import { createLogger } from "./logger";

const log = createLogger("port-tunnels");

const LIVENESS_MISS_LIMIT = 2;

type PushFn = (name: "exposedPortsChanged", payload: { taskId: string; ports: ExposedPort[] }) => void;

let pushFn: PushFn | null = null;
const livenessMisses = new Map<string, number>();

export function setPortTunnelsPushHook(fn: PushFn | null): void {
	pushFn = fn;
}

function quickTunnelId(taskId: string, port: number): string {
	return `task:${taskId}:port:${port}`;
}

function sharedTunnelId(taskId: string): string {
	return `task:${taskId}:shared`;
}

function entryToExposedPort(entry: TunnelEntry): ExposedPort {
	const kind: ExposedPort["kind"] = entry.kind === "task-shared" ? "shared" : "quick";
	const ports = entry.kind === "task-shared" ? [...entry.ports] : [entry.targetPort];
	// For shared tunnels, the URL is presented to the user with the subtoken
	// prefix already baked in so they can paste it straight into a browser:
	//   https://<random>.trycloudflare.com/p/<subtoken>/<first-port>/
	// The user picks the port from the registered set — UI lists each one.
	let url = entry.url;
	if (url && entry.kind === "task-shared" && entry.ports.length > 0) {
		url = `${entry.url}/p/${entry.subToken}/${entry.ports[0]}/`;
	}
	return {
		taskId: entry.taskId ?? "",
		kind,
		ports,
		url,
		state: entry.state === "idle" ? "failed" : entry.state,
		startedAt: entry.startedAt,
	};
}

function emitChanged(taskId: string): void {
	if (!pushFn) return;
	pushFn("exposedPortsChanged", { taskId, ports: getExposedPorts(taskId) });
}

export function getExposedPorts(taskId?: string): ExposedPort[] {
	const filter = taskId !== undefined ? { taskId } : undefined;
	return tunnelManager
		.list(filter)
		.filter((entry) => entry.kind === "task-port" || entry.kind === "task-shared")
		.map(entryToExposedPort);
}

export async function exposeTaskPort(taskId: string, port: number): Promise<ExposedPort> {
	const id = quickTunnelId(taskId, port);
	const existing = tunnelManager.get(id);
	if (existing && (existing.state === "starting" || existing.state === "connected")) {
		return entryToExposedPort(existing);
	}

	livenessMisses.delete(id);
	const entry = await tunnelManager.start({
		id,
		kind: "task-port",
		targetPort: port,
		taskId,
	});
	emitChanged(taskId);
	log.info("Exposed task port", { taskId: taskId.slice(0, 8), port, url: entry.url });
	return entryToExposedPort(entry);
}

/**
 * Start (or extend) the shared tunnel for a task. The tunnel itself points at
 * `headlessProxyPort` (the dev-3.0 headless server), and the headless server's
 * `/p/<port>/*` proxy dispatches inbound requests to the registered ports on
 * localhost.
 *
 * Idempotent: if a shared tunnel for this task already exists, the new ports
 * are merged into its registered set so the proxy starts accepting them
 * without restarting cloudflared. Re-emits `exposedPortsChanged`.
 */
export async function exposeTaskPortsShared(
	taskId: string,
	ports: number[],
	headlessProxyPort: number,
): Promise<ExposedPort> {
	const id = sharedTunnelId(taskId);
	const existing = tunnelManager.get(id);
	if (existing && (existing.state === "starting" || existing.state === "connected")) {
		const merged = Array.from(new Set([...existing.ports, ...ports])).sort((a, b) => a - b);
		existing.ports = merged;
		emitChanged(taskId);
		return entryToExposedPort(existing);
	}

	livenessMisses.delete(id);
	const entry = await tunnelManager.start({
		id,
		kind: "task-shared",
		targetPort: headlessProxyPort,
		ports: Array.from(new Set(ports)).sort((a, b) => a - b),
		taskId,
	});
	emitChanged(taskId);
	log.info("Exposed task ports (shared)", { taskId: taskId.slice(0, 8), ports, url: entry.url });
	return entryToExposedPort(entry);
}

export function unexposeTaskPort(taskId: string, port: number): void {
	const id = quickTunnelId(taskId, port);
	if (!tunnelManager.get(id)) return;
	tunnelManager.stop(id);
	livenessMisses.delete(id);
	emitChanged(taskId);
	log.info("Unexposed task port", { taskId: taskId.slice(0, 8), port });
}

export function unexposeShared(taskId: string): void {
	const id = sharedTunnelId(taskId);
	if (!tunnelManager.get(id)) return;
	tunnelManager.stop(id);
	livenessMisses.delete(id);
	emitChanged(taskId);
	log.info("Unexposed shared tunnel", { taskId: taskId.slice(0, 8) });
}

/**
 * Lookup the shared tunnel's registered port set for a given subToken-bearing
 * request. Used by the `/p/<port>/*` proxy in remote-access-server to validate
 * inbound traffic against the tunnel that owns it.
 */
export function findSharedTunnelByPort(port: number): TunnelEntry | undefined {
	return tunnelManager.list({ kind: "task-shared" }).find((entry) => entry.ports.includes(port));
}

/**
 * Called by the port-scan poller every ~10 s with the live port set for a task.
 * Increments a per-tunnel miss counter; after `LIVENESS_MISS_LIMIT` consecutive
 * misses (~20 s) the tunnel is stopped automatically — keeps stale cloudflared
 * processes from outliving the dev-server they were exposing.
 *
 * Synthetic taskId `__headless__` (used by `--expose-ports`) is intentionally
 * not driven by this poller — those tunnels persist until explicit stop or
 * shutdown.
 */
export function onTaskPortScanUpdate(taskId: string, livePorts: number[]): void {
	if (taskId === HEADLESS_TASK_ID) return;
	const liveSet = new Set(livePorts);
	const taskTunnels = tunnelManager.list({ taskId });
	let changed = false;
	for (const entry of taskTunnels) {
		const isAlive =
			entry.kind === "task-port"
				? liveSet.has(entry.targetPort)
				: entry.kind === "task-shared"
				? entry.ports.some((p) => liveSet.has(p))
				: true;

		if (isAlive) {
			livenessMisses.delete(entry.id);
			continue;
		}

		const misses = (livenessMisses.get(entry.id) ?? 0) + 1;
		livenessMisses.set(entry.id, misses);
		if (misses >= LIVENESS_MISS_LIMIT) {
			log.info("Auto-stopping tunnel after liveness misses", {
				id: entry.id,
				taskId: taskId.slice(0, 8),
				misses,
			});
			tunnelManager.stop(entry.id);
			livenessMisses.delete(entry.id);
			changed = true;
		}
	}
	if (changed) emitChanged(taskId);
}

export function cleanupTaskTunnels(taskId: string): void {
	const taskTunnels = tunnelManager.list({ taskId });
	if (taskTunnels.length === 0) return;
	for (const entry of taskTunnels) {
		tunnelManager.stop(entry.id);
		livenessMisses.delete(entry.id);
	}
	emitChanged(taskId);
	log.info("Cleaned up tunnels for task", { taskId: taskId.slice(0, 8), count: taskTunnels.length });
}

/**
 * Stop every per-task tunnel (both quick and shared). Preserves the "main"
 * headless-UI tunnel — that one is owned by the headless server's lifecycle.
 * Called on app shutdown.
 */
export function cleanupAllTunnels(): void {
	tunnelManager.stopAll({ kind: "task-port" });
	tunnelManager.stopAll({ kind: "task-shared" });
	livenessMisses.clear();
	log.info("Cleaned up all task tunnels");
}

/** Synthetic taskId used when `dev3 remote --expose-ports` exposes ports without an active task. */
export const HEADLESS_TASK_ID = "__headless__";

/** Test-only reset. */
export function _resetPortTunnels(): void {
	livenessMisses.clear();
	pushFn = null;
}
