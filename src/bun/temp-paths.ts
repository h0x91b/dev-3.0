/**
 * Runtime scratch files stay at their historical /tmp paths in the app.
 * Test runners redirect them so parallel worktrees cannot share scripts,
 * tmux configuration, shell init files, or plugin state.
 *
 * Windows has no /tmp: a launch script written there landed at `D:\tmp\...`
 * or failed outright, so it uses the OS temp directory instead.
 */

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
