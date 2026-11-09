/**
 * Advisory file leases for tasks that share one folder (a project with its git
 * workflow off). The first live task to edit a file holds it until
 * `FILE_LEASE_TTL_MS` after its last edit there; another task's edit is refused
 * with the holder's name, so the two agents can talk instead of overwriting.
 */

/** How long a file stays claimed after the holder's last edit to it. */
export const FILE_LEASE_TTL_MS = 10 * 60 * 1000;

/** What a refused claim reports back to the agent's hook. */
export interface FileLeaseConflict {
	path: string;
	fileName: string;
	holderTaskId: string;
	holderSeq: number;
	holderTitle: string;
	minutesLeft: number;
}

export interface FileLease {
	taskId: string;
	projectId: string;
	touchedAt: number;
}

export type ClaimResult = { granted: true } | { granted: false; holder: FileLease; expiresAt: number };

/** The lease table. Pure and in memory: an app restart frees every file. */
export class FileLeaseTable {
	private readonly leases = new Map<string, FileLease>();

	constructor(private readonly ttlMs: number = FILE_LEASE_TTL_MS) {}

	/** Claim `key` for a task, or report the live holder. Re-claiming refreshes the lease. */
	claim(key: string, taskId: string, projectId: string, now: number): ClaimResult {
		const current = this.leases.get(key);
		if (current && current.taskId !== taskId && now - current.touchedAt < this.ttlMs) {
			return { granted: false, holder: current, expiresAt: current.touchedAt + this.ttlMs };
		}
		this.leases.set(key, { taskId, projectId, touchedAt: now });
		this.prune(now);
		return { granted: true };
	}

	/** Drop every lease a task holds - its run ended. */
	releaseTask(taskId: string): void {
		for (const [key, lease] of this.leases) {
			if (lease.taskId === taskId) this.leases.delete(key);
		}
	}

	private prune(now: number): void {
		for (const [key, lease] of this.leases) {
			if (now - lease.touchedAt >= this.ttlMs) this.leases.delete(key);
		}
	}
}
