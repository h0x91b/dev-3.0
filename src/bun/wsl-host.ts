import { existsSync } from "node:fs";
import { spawn, spawnSync } from "./spawn";

/**
 * WSL can start Windows programs (interop), so a dev3 running inside WSL can
 * open a file on the Windows desktop the user's browser is on. Windows reaches
 * the Linux filesystem through the `\\wsl.localhost\<distro>\...` share, so the
 * file is opened in place — nothing is copied.
 */

let cachedIsWsl: boolean | null = null;

export function isWslHost(): boolean {
	cachedIsWsl ??= process.platform === "linux" && (!!process.env.WSL_DISTRO_NAME || existsSync("/proc/sys/fs/binfmt_misc/WSLInterop"));
	return cachedIsWsl;
}

function wslpath(flag: "-w" | "-u", path: string): string {
	const result = spawnSync(["wslpath", flag, path], { stdout: "pipe", stderr: "pipe" });
	const out = result.stdout?.toString().trim() ?? "";
	if (result.exitCode !== 0 || !out) throw new Error(`wslpath failed: ${result.stderr?.toString().trim() || "no output"}`);
	return out;
}

/**
 * `explorer.exe` is on PATH only when WSL appends the Windows PATH, which users
 * often turn off (`appendWindowsPath=false`); asking wslpath for `C:\Windows`
 * also honours a custom automount root.
 */
function explorerBinary(): string {
	const onPath = spawnSync(["which", "explorer.exe"], { stdout: "pipe", stderr: "pipe" });
	const found = onPath.exitCode === 0 ? onPath.stdout?.toString().trim() : "";
	if (found) return found;
	return `${wslpath("-u", "C:\\Windows")}/explorer.exe`;
}

/** Opens `path` with its Windows default app. explorer.exe exits 1 even on success, so only a failed launch throws. */
export function openOnWindowsHost(path: string): void {
	const windowsPath = wslpath("-w", path);
	spawn([explorerBinary(), windowsPath], { stdout: "ignore", stderr: "ignore" });
}

/** Test hook. */
export function resetWslHostCache(): void {
	cachedIsWsl = null;
}
