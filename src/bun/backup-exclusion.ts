/**
 * Exclude the dev-3.0 worktrees root from OS-level backups.
 *
 * The worktrees root (`~/.dev3.0/worktrees`) holds per-task git worktrees with
 * full CoW-cloned `node_modules`/build dirs — easily 100GB+ of ephemeral data
 * whose committed state already lives in git. Backing it up (Time Machine on
 * macOS) is pure waste that slows every backup.
 *
 * On macOS we run `tmutil addexclusion <root>` (no `-p`): this sets a per-user
 * xattr exclusion that does NOT require root and is idempotent. On Linux this
 * is a no-op (Time Machine doesn't exist; no portable equivalent).
 */

import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";
import { spawn } from "./spawn";

const log = createLogger("backup-exclusion");

/** The directory we exclude from backups. */
export const WORKTREES_ROOT = `${DEV3_HOME}/worktrees`;

/** Roots already excluded in this process, so `tmutil` runs once per root per app session. */
const ensured = new Set<string>();

/** Reset the in-memory guard. Test-only. */
export function _resetBackupExclusionGuard(): void {
	ensured.clear();
}

/** Ensure the home worktrees root exists and is excluded from OS backups. */
export async function ensureWorktreesBackupExclusion(): Promise<void> {
	await excludeFromBackups(WORKTREES_ROOT);
}

/**
 * Ensure `root` exists and is excluded from Time Machine. Cheap and idempotent;
 * never throws — backup exclusion is best-effort and must not block worktree creation.
 */
export async function excludeFromBackups(root: string): Promise<void> {
	if (ensured.has(root)) return;

	// Time Machine is macOS-only; nothing portable to do elsewhere.
	if (process.platform !== "darwin") {
		ensured.add(root);
		return;
	}

	try {
		// Ensure the root exists so tmutil has a target.
		await spawn(["mkdir", "-p", root]).exited;

		const proc = spawn(["tmutil", "addexclusion", root]);
		const code = await proc.exited;
		if (code === 0) {
			log.info("Excluded worktrees root from Time Machine", { path: root });
			ensured.add(root);
		} else {
			// Leave it unmarked so a later worktree creation retries.
			log.warn("tmutil addexclusion failed", { path: root, code });
		}
	} catch (err) {
		log.warn("Failed to apply backup exclusion", { error: String(err) });
	}
}
