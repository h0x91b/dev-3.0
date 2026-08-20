/**
 * Stage the vendored proxy-sidecar binary (fetched by scripts/fetch-bifrost.ts
 * into vendor/bifrost/) into dist/bifrost/, where the electrobun copy rule
 * ("dist/bifrost" → Resources/app/bifrost) picks it up.
 *
 * Mirrors stage-bundled-tmux.sh, but in TypeScript because Windows is a shipped
 * target and has no bash. The directory is ALWAYS created so the copy rule has a
 * source; a dev build without the fetch step leaves it empty and the app reports
 * "no proxy in this build" instead of crashing.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bifrostTarget } from "../src/shared/bifrost-release";
import { formatVersion, raiseMinMacOSVersion, readMinMacOSVersion } from "../src/bun/macho-min-version";

const ROOT = resolve(import.meta.dir, "..");
const VENDOR_DIR = `${ROOT}/vendor/bifrost`;
const DIST_DIR = `${ROOT}/dist/bifrost`;

/** What the staged macOS binary must declare. Apple's notary floor is 10.9;
 *  Go's own darwin/amd64 runtime needs 10.15, so declaring less would lie. */
const STAGED_MIN_MACOS = { major: 10, minor: 15 };

/**
 * The vendor's darwin/amd64 build declares `sdk 10.4`, which makes Apple's notary
 * reject the ENTIRE app archive ("The binary uses an SDK older than the 10.9 SDK").
 * Patched on the staged copy, never in vendor/, so fetch-bifrost.ts still checks the
 * pristine bytes against the pin. See decisions/2026/08/20/raise-bifrost-macos-min-version.md.
 */
function patchDarwinMinVersion(binaryPath: string): void {
	const raw = new Uint8Array(readFileSync(binaryPath));
	const before = readMinMacOSVersion(raw);
	if (!before || before.commandOffset === null) return;
	const patched = raiseMinMacOSVersion(raw, STAGED_MIN_MACOS.major, STAGED_MIN_MACOS.minor);
	if (!patched) return;
	writeFileSync(binaryPath, patched, { mode: 0o755 });
	console.log(
		`[stage-bifrost] raised declared macOS minimum ${formatVersion(before.sdk ?? 0)} -> ${STAGED_MIN_MACOS.major}.${STAGED_MIN_MACOS.minor} (Apple notary rejects below 10.9)`,
	);
}

export function stageBifrost(): boolean {
	const target = bifrostTarget(process.platform, process.arch);
	mkdirSync(DIST_DIR, { recursive: true });
	if (!target || !existsSync(`${VENDOR_DIR}/${target.binaryName}`)) {
		console.log("[stage-bifrost] vendor/bifrost is empty — the model catalog is unavailable in this build");
		return false;
	}
	rmSync(DIST_DIR, { recursive: true, force: true });
	// The whole directory travels: the binary plus its licence notices.
	cpSync(VENDOR_DIR, DIST_DIR, { recursive: true });
	if (target.platform === "darwin") patchDarwinMinVersion(`${DIST_DIR}/${target.binaryName}`);
	console.log(`[stage-bifrost] staged dist/bifrost/${target.binaryName}`);
	return true;
}

if (import.meta.main) stageBifrost();
