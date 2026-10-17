import { existsSync } from "node:fs";
import { spawn, spawnSync } from "./spawn";
import { whichSync } from "./which";

/**
 * Opens a file on the Windows desktop a WSL-hosted dev3 runs under, in place
 * through the `\\wsl.localhost\<distro>\…` share.
 */

const INTEROP_FLAGS = ["/proc/sys/fs/binfmt_misc/WSLInterop", "/proc/sys/fs/binfmt_misc/WSLInterop-late"];
const OPEN_PATH_VAR = "DEV3_OPEN_PATH";
/** A hung interop or PowerShell must not hold the RPC until its 2-minute timeout. */
const OPEN_TIMEOUT_MS = 15_000;

let cachedIsWsl: boolean | null = null;

/** Interop registered, not just a WSL environment: without it no Windows program can start. */
export function isWslHost(): boolean {
	cachedIsWsl ??= process.platform === "linux" && INTEROP_FLAGS.some((flag) => existsSync(flag));
	return cachedIsWsl;
}

/** On PATH only when WSL appends the Windows PATH; asking wslpath for C:\ honours a custom automount root. */
function powershellBinary(): string {
	const onPath = whichSync("powershell.exe");
	if (onPath) return onPath;
	const result = spawnSync(["wslpath", "-u", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"], { stdout: "pipe", stderr: "pipe" });
	const out = result.stdout?.toString().trim() ?? "";
	if (result.exitCode !== 0 || !out) throw new Error("Windows PowerShell not found");
	return out;
}

/**
 * Opens `path` with its Windows default app. The path travels in an env var that
 * WSLENV `/p` translates, read with `-LiteralPath`: as an argument, explorer.exe
 * would split it at a comma and interop would not quote it.
 */
export async function openOnWindowsHost(path: string): Promise<void> {
	const proc = spawn([powershellBinary(), "-NoProfile", "-NonInteractive", "-Command", `Invoke-Item -LiteralPath $env:${OPEN_PATH_VAR}`], {
		stdout: "ignore",
		stderr: "ignore",
		env: { [OPEN_PATH_VAR]: path, WSLENV: [process.env.WSLENV, `${OPEN_PATH_VAR}/p`].filter(Boolean).join(":") },
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), OPEN_TIMEOUT_MS);
	});
	const outcome = await Promise.race([proc.exited, timedOut]);
	clearTimeout(timer);
	if (outcome === "timeout") {
		proc.kill();
		throw new Error("Windows did not respond");
	}
	if (outcome !== 0) throw new Error("Windows could not open the file");
}

/** Test hook. */
export function resetWslHostCache(): void {
	cachedIsWsl = null;
}
