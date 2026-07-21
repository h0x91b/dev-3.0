export const MINIMUM_WINDOWS_CONPTY_BUN_VERSION = "1.3.14";

interface RuntimeDetails {
	platform: NodeJS.Platform;
	bunVersion: unknown;
}

interface SpawnFailureDetails extends RuntimeDetails {
	command: string;
	cause: unknown;
}

function parseVersion(version: unknown): [number, number, number] | null {
	if (typeof version !== "string") return null;
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(version: unknown, minimum: string): version is string {
	const parsed = parseVersion(version);
	const floor = parseVersion(minimum);
	if (!parsed || !floor) return false;
	for (let index = 0; index < parsed.length; index++) {
		if (parsed[index] !== floor[index]) return parsed[index] > floor[index];
	}
	return true;
}

function displayVersion(version: unknown): string {
	return typeof version === "string" && version.trim() ? version : "missing";
}

export function assertPackagedConptyRuntime(version: unknown): string {
	if (versionAtLeast(version, MINIMUM_WINDOWS_CONPTY_BUN_VERSION)) return version;
	throw new Error(
		`Packaged native-terminal runtime is incompatible (packaged Bun: ${displayVersion(version)}). ` +
			`Set Electrobun build.bunVersion to Bun >= ${MINIMUM_WINDOWS_CONPTY_BUN_VERSION}; ` +
			"a system Bun does not change the runtime copied into the app package.",
	);
}

export function assertNativeTerminalRuntime({ platform, bunVersion }: RuntimeDetails): void {
	if (platform !== "win32" || versionAtLeast(bunVersion, MINIMUM_WINDOWS_CONPTY_BUN_VERSION)) return;
	throw new Error(
		`Native terminal runtime is incompatible: packaged Bun ${displayVersion(bunVersion)} lacks Windows ConPTY support; ` +
			`dev3 requires Bun >= ${MINIMUM_WINDOWS_CONPTY_BUN_VERSION}. Update or reinstall dev3 to obtain a compatible packaged runtime. ` +
			"Installing Bun on PATH will not change the packaged runtime.",
	);
}

export function nativeTerminalSpawnError({
	platform,
	bunVersion,
	command,
	cause,
}: SpawnFailureDetails): Error {
	const detail = cause instanceof Error ? cause.message : String(cause);
	const platformName = platform === "win32" ? "Windows" : platform;
	return new Error(
		`Native terminal runtime is unavailable on ${platformName}: packaged Bun ${displayVersion(bunVersion)} ` +
			`could not start ${command} through Bun.Terminal (${detail}). Update or reinstall dev3; ` +
			"installing another Bun on PATH will not replace the packaged runtime.",
	);
}
