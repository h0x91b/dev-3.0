import type { PortInfo } from "../shared/types";

/**
 * Ownership of an assigned pool port, for dev servers whose listener is NOT a
 * descendant of the dev-server pane.
 *
 * A containerised devScript (`docker compose up`, Colima, OrbStack, podman)
 * always lands here: the container runtime's daemon publishes the port, so the
 * socket belongs to `com.docker.backend`, never to the pane tree. Treating that
 * as a conflict made `--wait` unable to ever succeed for such a project and
 * printed a healthy stack as a WARNING (issue #1427).
 *
 * The discriminator is a snapshot taken immediately BEFORE the devScript
 * launches: a holder already listening then is a foreign squatter, a holder
 * that appeared afterwards was published on the dev server's behalf.
 */
export type AssignedPortOwners = {
	/** Bound after start by a process outside the tree — the dev server's port, published for it. */
	published: PortInfo[];
	/** Already bound before start (or bound while stopped) — a real squatter. */
	conflicts: PortInfo[];
};

export type DevServerStartSnapshot = {
	assignedPorts: number[];
	preStartHolders: PortInfo[];
};

// Deliberately self-contained (types only, no port-pool / fs imports): the port
// scanner is imported by a great many suites, and pulling heavier modules into
// it there breaks the ones that mock `node:fs` export by export.
const startSnapshots = new Map<string, DevServerStartSnapshot>();

/** Remember who held the task's assigned ports just before its devScript launched. */
export function recordDevServerStart(taskId: string, assignedPorts: number[], preStartHolders: PortInfo[]): void {
	startSnapshots.set(taskId, {
		assignedPorts: [...assignedPorts],
		preStartHolders: preStartHolders.map((h) => ({ ...h })),
	});
}

/** Drop the snapshot once the dev server is torn down. */
export function clearDevServerStart(taskId: string): void {
	startSnapshots.delete(taskId);
}

/**
 * The snapshot for a dev server this process started and has not torn down, or
 * null. Its absence doubles as the port scanner's stand-in for "not running" —
 * after an app restart the surviving tmux dev session loses its snapshot, so a
 * published port disappears from the UI badge until the next start, never the
 * other way round.
 */
export function getDevServerStartSnapshot(taskId: string): DevServerStartSnapshot | null {
	return startSnapshots.get(taskId) ?? null;
}

/**
 * Split foreign holders of the assigned ports into "published for this dev
 * server" and "conflicting squatter".
 *
 * `foreignHolders` must already exclude PIDs inside the dev-server tree — those
 * are plain `devPorts`. When the dev server is not running nothing can have
 * been published for it, so every holder is a conflict.
 */
export function classifyAssignedPortOwners(
	foreignHolders: PortInfo[],
	preStartHolders: PortInfo[],
	running: boolean,
): AssignedPortOwners {
	if (!running) return { published: [], conflicts: [...foreignHolders] };
	const published: PortInfo[] = [];
	const conflicts: PortInfo[] = [];
	for (const holder of foreignHolders) {
		const wasThereBefore = preStartHolders.some((p) => p.port === holder.port && p.pid === holder.pid);
		(wasThereBefore ? conflicts : published).push(holder);
	}
	return { published, conflicts };
}

/** Merge port lists, first entry per port wins. Keeps the result sorted by port. */
export function mergePortInfos(...lists: PortInfo[][]): PortInfo[] {
	const byPort = new Map<number, PortInfo>();
	for (const list of lists) {
		for (const info of list) {
			if (!byPort.has(info.port)) byPort.set(info.port, info);
		}
	}
	return [...byPort.values()].sort((a, b) => a.port - b.port);
}
