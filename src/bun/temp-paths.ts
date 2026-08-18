/**
 * Runtime scratch files stay at their historical /tmp paths in the app.
 * Test runners redirect them so parallel worktrees cannot share scripts,
 * tmux configuration, shell init files, or plugin state.
 *
 * Windows has no /tmp: a launch script written there landed at `D:\tmp\...`
 * or failed outright, so it uses the OS temp directory instead.
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { toPosixSeparators } from "../shared/project-storage-key";

function defaultTempRoot(): string {
	return process.platform === "win32" ? toPosixSeparators(tmpdir()) : "/tmp";
}

export const DEV3_TEMP_ROOT = process.env.DEV3_TEST_ROOT?.trim() || defaultTempRoot();

export function dev3TempPath(name: string): string {
	return `${DEV3_TEMP_ROOT}/${name}`;
}

export function dev3TaskTempPath(taskId: string, suffix?: string): string {
	return dev3TempPath(`dev3-${taskId}${suffix ? `-${suffix}` : ""}`);
}

/**
 * Where a failed `setupScript` leaves its exit code. The setup wrapper runs
 * inside the pane, so this file plus the `dev3 hook setup-failed` ping is the
 * only channel by which the app learns the script failed.
 */
export function setupExitCodePath(taskId: string): string {
	return dev3TaskTempPath(taskId, "setup-exit");
}

/** Drop a previous run's recorded code so a later read cannot pick up a stale one. */
export function clearSetupExitCode(taskId: string): void {
	rmSync(setupExitCodePath(taskId), { force: true });
}
