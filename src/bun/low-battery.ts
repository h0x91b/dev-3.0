/**
 * Retire the `low-battery` answer format earlier dev3 builds installed. The feature
 * is gone; this only cleans up after it. See
 * `decisions/2026/10/07/remove-low-battery.md`.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger";
import { loadSettings, saveSettings } from "./settings";

const log = createLogger("low-battery");

/** The `outputStyle` value dev3's own copy registered under. A plugin's copy is namespaced. */
export const LOW_BATTERY_STYLE_NAME = "Low Battery";

const STYLE_FILE = join(".claude", "output-styles", "low-battery.md");

export const LOW_BATTERY_SKILL_DIRS = [
	".claude/skills/low-battery",
	".cursor/skills/low-battery",
	".agents/skills/low-battery",
	".codex/skills/low-battery",
	".opencode/skills/low-battery",
	".config/opencode/skills/low-battery",
	".omp/agent/skills/low-battery",
];

/** Reset `outputStyle` to the default when it still selects dev3's style. Never throws. */
function resetOutputStyle(home: string): void {
	const settingsPath = join(home, ".claude", "settings.json");
	if (!existsSync(settingsPath)) return;
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
		if (typeof settings.outputStyle !== "string" || settings.outputStyle.trim() !== LOW_BATTERY_STYLE_NAME) return;
		delete settings.outputStyle;
		writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
		log.info("Claude outputStyle reset to default (low-battery retired)", { path: settingsPath });
	} catch (err) {
		log.warn("Failed to reset the low-battery output style (non-fatal)", { path: settingsPath, error: String(err) });
	}
}

/**
 * `ownsFiles` is true only when settings prove dev3 installed the files — an untouched
 * `low-battery` skill dir or style file may be the user's own copy from upstream.
 */
export function removeLowBattery(home: string, ownsFiles: boolean): void {
	resetOutputStyle(home);
	if (!ownsFiles) return;
	for (const rel of [STYLE_FILE, ...LOW_BATTERY_SKILL_DIRS]) {
		const target = join(home, rel);
		if (!existsSync(target)) continue;
		try {
			rmSync(target, { recursive: true, force: true });
			log.info("low-battery leftover removed", { path: target });
		} catch (err) {
			log.warn("Failed to remove low-battery leftover (non-fatal)", { path: target, error: String(err) });
		}
	}
}

/** Startup hook: clean up, then record `lowBatteryEnabled: false` so it runs once. Never throws. */
export async function retireLowBattery(home: string): Promise<void> {
	try {
		const settings = await loadSettings();
		const ownsFiles = settings.lowBatteryEnabled === true;
		removeLowBattery(home, ownsFiles);
		// `false` is what older co-installed builds read as "uninstalled", so they keep it off too.
		if (ownsFiles) await saveSettings({ ...settings, lowBatteryEnabled: false });
	} catch (err) {
		log.warn("low-battery retirement failed (non-fatal)", { error: String(err) });
	}
}
