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

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { bifrostTarget } from "../src/shared/bifrost-release";

const ROOT = resolve(import.meta.dir, "..");
const VENDOR_DIR = `${ROOT}/vendor/bifrost`;
const DIST_DIR = `${ROOT}/dist/bifrost`;

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
	console.log(`[stage-bifrost] staged dist/bifrost/${target.binaryName}`);
	return true;
}

if (import.meta.main) stageBifrost();
