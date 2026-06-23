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

/**
 * Cleared once the exclusion has been applied (or definitively skipped) in this
 * process, so we only spawn `tmutil` once per app session.
 */
let ensured = false;

/** Reset the in-memory guard. Test-only. */
export function _resetBackupExclusionGuard(): void {
	ensured = false;
}

/**
 * Ensure the worktrees root exists and is excluded from OS backups.
 *
 * Cheap and idempotent: returns immediately after the first successful run in a
 * process. Never throws — backup exclusion is best-effort and must not block
 * worktree creation.
 */
export async function ensureWorktreesBackupExclusion(): Promise<void> {
	if (ensured) return;

	// Time Machine is macOS-only; nothing portable to do elsewhere.
	if (process.platform !== "darwin") {
		ensured = true;
		return;
	}

	try {
		// Ensure the root exists so tmutil has a target.
		await spawn(["mkdir", "-p", WORKTREES_ROOT]).exited;

		const proc = spawn(["tmutil", "addexclusion", WORKTREES_ROOT]);
		const code = await proc.exited;
		if (code === 0) {
			log.info("Excluded worktrees root from Time Machine", { path: WORKTREES_ROOT });
			ensured = true;
		} else {
			// Leave `ensured` false so a later worktree creation retries.
			log.warn("tmutil addexclusion failed", { path: WORKTREES_ROOT, code });
		}
	} catch (err) {
		log.warn("Failed to apply backup exclusion", { error: String(err) });
	}
}
