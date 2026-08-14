/**
 * Gives dev3 a Desktop icon and a Start Menu entry on Windows, and keeps them
 * pointing at the app after an update moves it. Runs at startup, does nothing on
 * any other platform, and never throws.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLogger } from "../logger";
import { DEV3_HOME } from "../paths";
import { planShortcuts, shortcutFileName, type ShortcutSite, type ShortcutSlot, type ShortcutState } from "./shortcut-plan";
import { powershellShortcutSurface, type WindowsShortcutSurface } from "./powershell-surface";

const log = createLogger("windows-shortcuts");

/**
 * Sits beside the rest of `~/.dev3.0`: a new file, never a rename or a rewrite of
 * an existing one, so an older app version reading the same directory is unaffected.
 */
const STATE_FILE = join(DEV3_HOME, "windows-shortcuts.json");

function readState(): ShortcutState {
	try {
		return existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as ShortcutState) : {};
	} catch (err) {
		log.warn("Could not read the shortcut state file, treating it as empty", { error: String(err) });
		return {};
	}
}

function writeState(state: ShortcutState): void {
	try {
		mkdirSync(DEV3_HOME, { recursive: true });
		writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
	} catch (err) {
		log.warn("Could not record which shortcuts we wrote", { error: String(err) });
	}
}

/**
 * `launcher.exe` sits next to the running `bun.exe`, which is the one path that
 * cannot be wrong. Absent in a `bun run dev` tree — that is the guard that keeps
 * a development run from planting an icon.
 */
export function resolveLauncherPath(execPath: string, fileExists: (path: string) => boolean): string | null {
	const candidate = join(dirname(execPath), "launcher.exe");
	return fileExists(candidate) ? candidate : null;
}

function desktopFallback(): string | null {
	const profile = process.env.USERPROFILE;
	return profile ? join(profile, "Desktop") : null;
}

function programsFallback(): string | null {
	const appData = process.env.APPDATA;
	return appData ? join(appData, "Microsoft", "Windows", "Start Menu", "Programs") : null;
}

export interface EnsureShortcutsOptions {
	appName: string;
	identifier: string;
	channel: string;
	surface?: WindowsShortcutSurface;
}

export function ensureWindowsShortcuts(options: EnsureShortcutsOptions): void {
	if (process.platform !== "win32") return;

	const surface = options.surface ?? powershellShortcutSurface;
	try {
		const launcherPath = resolveLauncherPath(process.execPath, existsSync);
		if (!launcherPath) {
			log.info("No launcher.exe beside the running executable — not a packaged build, skipping shortcuts");
			return;
		}

		const fileName = shortcutFileName(options.appName, options.channel);
		const directories: Record<ShortcutSlot, string | null> = {
			desktop: surface.knownFolder("DesktopDirectory") ?? desktopFallback(),
			startMenu: surface.knownFolder("Programs") ?? programsFallback(),
		};

		const sites: ShortcutSite[] = [];
		for (const slot of ["desktop", "startMenu"] as ShortcutSlot[]) {
			const dir = directories[slot];
			if (!dir) {
				log.warn("Could not resolve a Windows folder for the shortcut", { slot });
				continue;
			}
			const path = join(dir, fileName);
			sites.push({ slot, path, existingTarget: surface.readShortcutTarget(path) });
		}

		const state = readState();
		const actions = planShortcuts({ sites, launcherPath, state, identifier: options.identifier });
		let changed = false;

		for (const action of actions) {
			if (action.kind === "skip") {
				log.info("Leaving a shortcut alone", { slot: action.slot, path: action.path, reason: action.reason });
				continue;
			}
			const written = surface.writeShortcut({
				lnkPath: action.path,
				target: launcherPath,
				workingDir: dirname(launcherPath),
				iconPath: launcherPath,
			});
			if (!written) {
				log.warn("Could not write the shortcut", { slot: action.slot, path: action.path, kind: action.kind });
				continue;
			}
			log.info("Wrote a Windows shortcut", { slot: action.slot, path: action.path, kind: action.kind, reason: action.reason });
			state[action.slot] = { path: action.path, target: launcherPath };
			changed = true;
		}

		if (changed) writeState(state);
	} catch (err) {
		log.warn("Windows shortcut maintenance failed (non-fatal)", { error: String(err) });
	}
}
