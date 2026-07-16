/**
 * Rosetta 2 detection — an Intel (x64) build running translated on an Apple
 * Silicon Mac.
 *
 * Such installs happen when the user manually downloads the Intel DMG. They
 * work, but run slower and macOS 26+ warns on every launch that Rosetta
 * support is ending ("Support Ending for Intel-based Apps"). The in-app
 * updater cannot fix this either: Electrobun's Updater bakes its architecture
 * from os.arch() at startup, which reports "x64" under Rosetta, so the install
 * stays on x64 artifacts forever. We surface a startup warning with a
 * copy-pasteable reinstall command instead — see
 * decisions/137-rosetta-warning-over-auto-migration.md.
 */

import { dirname, resolve } from "path";
import { existsSync } from "fs";
import type { RosettaWarningInfo } from "../shared/types";
import { spawnSync } from "./spawn";

// Native arm64 Homebrew always lives here; an x86_64 (Rosetta) brew lives in
// /usr/local and cannot install our arm64-only cask, so it does not count.
const ARM64_BREW = "/opt/homebrew/bin/brew";

const ARM64_DMG_URL = "https://github.com/h0x91b/dev-3.0/releases/latest/download/stable-macos-arm64-dev-3.0.dmg";

/**
 * Detects an x64 process translated by Rosetta 2 on an Apple Silicon Mac.
 * `sysctl.proc_translated` is 1 only under Rosetta; on real Intel Macs it is
 * 0 or the OID does not exist — those must never be flagged.
 */
export function detectRosetta(platform: string = process.platform, arch: string = process.arch): boolean {
	if (platform !== "darwin" || arch !== "x64") return false;
	try {
		const result = spawnSync(["sysctl", "-n", "sysctl.proc_translated"]);
		if (result.exitCode !== 0) return false;
		return result.stdout?.toString().trim() === "1";
	} catch {
		return false;
	}
}

/** macOS: the running .app bundle path (executable is at Contents/MacOS/…). */
function getRunningAppBundlePath(): string {
	return resolve(dirname(process.execPath), "..", "..");
}

/**
 * Builds the reinstall command for the warning dialog. Prefers the arm64
 * Homebrew cask (also brings the brew dependencies); falls back to
 * downloading and opening the arm64 DMG.
 */
export function buildReinstallCommand(
	brewAvailable: boolean = existsSync(ARM64_BREW),
	appBundlePath: string = getRunningAppBundlePath(),
): NonNullable<RosettaWarningInfo> {
	if (brewAvailable) {
		const bundle = appBundlePath.endsWith(".app") ? appBundlePath : "/Applications/dev-3.0.app";
		return {
			command: `rm -rf "${bundle}" && brew install --cask h0x91b/dev3/dev3`,
			kind: "brew",
		};
	}
	return {
		command: `curl -fsSL ${ARM64_DMG_URL} -o ~/Downloads/dev-3.0-arm64.dmg && open ~/Downloads/dev-3.0-arm64.dmg`,
		kind: "dmg",
	};
}

export function getRosettaWarningInfo(translated: boolean = detectRosetta()): RosettaWarningInfo {
	return translated ? buildReinstallCommand() : null;
}
