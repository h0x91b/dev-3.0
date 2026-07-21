import { resolve } from "node:path";

export const MINIMUM_WINDOWS_CONPTY_BUN_VERSION = "1.3.14";
export const NATIVE_TERMINAL_HOST_READY_MARKER = "DEV3_PACKAGED_DETACHED_HOST_OK" as const;

export interface NativeTerminalHostIdentity {
	bunVersion: string;
	executable: string;
	entrypoint: string;
	carrier: "bun-runtime-script" | "compiled";
}

export interface NativeTerminalHostProofState {
	marker: typeof NATIVE_TERMINAL_HOST_READY_MARKER;
	bunVersion: string;
	hostPid: number;
	shellPid: number;
	executable: string;
	entrypoint: string;
	ffiModuleAvailable: boolean;
}

export function sameNativeTerminalPath(left: string, right: string): boolean {
	return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

interface RuntimeDetails {
	platform: NodeJS.Platform;
	bunVersion: unknown;
}

interface SpawnFailureDetails extends RuntimeDetails {
	command: string;
	cause: unknown;
}

interface ParsedVersion {
	core: [number, number, number];
	prerelease: string | null;
}

function parseVersion(version: unknown): ParsedVersion | null {
	if (typeof version !== "string") return null;
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
	if (!match) return null;
	return {
		core: [Number(match[1]), Number(match[2]), Number(match[3])],
		prerelease: match[4] ?? null,
	};
}

function versionAtLeast(version: unknown, minimum: string): version is string {
	const parsed = parseVersion(version);
	const floor = parseVersion(minimum);
	if (!parsed || !floor) return false;
	for (let index = 0; index < parsed.core.length; index++) {
		if (parsed.core[index] !== floor.core[index]) return parsed.core[index] > floor.core[index];
	}
	return floor.prerelease !== null || parsed.prerelease === null;
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
