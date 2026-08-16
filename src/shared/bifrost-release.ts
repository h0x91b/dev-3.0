/**
 * Where the pinned proxy-sidecar binary comes from, per platform.
 *
 * dev3 never downloads this at runtime (AGENTS.md § Update channels): release CI
 * fetches it, checks its SHA-256 against the pin, and bakes it into the app. The
 * mapping lives here, pure, so the download script and its tests agree.
 */

/** Transport version dev3 is pinned to. Bumping it is a dev3 release. */
export const BIFROST_VERSION = "v1.6.10";

const DOWNLOAD_ROOT = "https://downloads.getmaxim.ai/bifrost";

/** Apache-2.0 text of the exact transport release, shipped beside the binary. */
export const BIFROST_LICENSE_URL = `https://raw.githubusercontent.com/maximhq/bifrost/transports/${BIFROST_VERSION}/LICENSE`;

/** Platform/arch names the vendor's download host uses. */
const URL_PLATFORM: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };
const URL_ARCH: Record<string, string> = { arm64: "arm64", x64: "amd64", ia32: "386" };

export interface BifrostTarget {
	platform: NodeJS.Platform;
	arch: string;
	/** File name on disk, including the Windows extension. */
	binaryName: string;
	url: string;
}

/** The download descriptor for one target, or undefined when the vendor
 *  publishes nothing for it — a caller must degrade, never guess a URL. */
export function bifrostTarget(
	platform: NodeJS.Platform,
	arch: string,
	version = BIFROST_VERSION,
): BifrostTarget | undefined {
	const urlPlatform = URL_PLATFORM[platform];
	const urlArch = URL_ARCH[arch];
	if (!urlPlatform || !urlArch) return undefined;
	// The vendor publishes no 32-bit macOS or Linux arm 32-bit build.
	if (platform === "darwin" && arch === "ia32") return undefined;
	const binaryName = platform === "win32" ? "bifrost-http.exe" : "bifrost-http";
	return {
		platform,
		arch,
		binaryName,
		url: `${DOWNLOAD_ROOT}/${version}/${urlPlatform}/${urlArch}/${binaryName}`,
	};
}

/** Every target dev3 ships, so release CI can fail on a missing artifact rather
 *  than shipping an app whose catalog silently does not work. */
export const BIFROST_TARGETS: { platform: NodeJS.Platform; arch: string }[] = [
	{ platform: "darwin", arch: "arm64" },
	{ platform: "darwin", arch: "x64" },
	{ platform: "linux", arch: "x64" },
	{ platform: "linux", arch: "arm64" },
	{ platform: "win32", arch: "x64" },
];

/** Key of one target inside the pin file. */
export function bifrostPinKey(platform: NodeJS.Platform, arch: string): string {
	return `${platform}-${arch}`;
}
