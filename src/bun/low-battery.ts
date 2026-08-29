/**
 * Install and remove the `low-battery` answer-format rules dev3 ships with.
 *
 * Content comes from `src/shared/low-battery-content.generated.ts`, baked in at
 * build time from `h0x91b/toolbelt-for-agents` — nothing is fetched on the user's
 * machine. Two shapes are installed:
 *
 *  - the skill, into the same six agent config dirs dev3's own skills go into;
 *  - the Claude Code output style, plus the `outputStyle` key that selects it.
 *
 * The style is never taken away from a user who already picked one: dev3 sets the
 * key only when it is absent, `default`, or already a low-battery variant.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	LOW_BATTERY_OUTPUT_STYLE,
	LOW_BATTERY_REVISION,
	LOW_BATTERY_SKILL_FILES,
} from "../shared/low-battery-content.generated";
import {
	applyLowBatteryOutputStyle,
	LOW_BATTERY_STYLE_FILE,
	LOW_BATTERY_STYLE_NAME,
	type LowBatteryStatus,
	type OutputStyleOutcome,
} from "../shared/low-battery";
import { createLogger } from "./logger";

const log = createLogger("low-battery");

export { LOW_BATTERY_REVISION };

/** Agent config dirs that get the skill — the same six dev3's own skills use. */
export const LOW_BATTERY_SKILL_DIRS = [
	".claude/skills/low-battery",
	".cursor/skills/low-battery",
	".agents/skills/low-battery",
	".codex/skills/low-battery",
	".opencode/skills/low-battery",
	".config/opencode/skills/low-battery",
];

function safeReadSettings(path: string): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Write the output style file and patch `~/.claude/settings.json`. Non-fatal. */
function installOutputStyle(home: string): OutputStyleOutcome {
	const stylePath = join(home, ".claude", "output-styles", LOW_BATTERY_STYLE_FILE);
	try {
		mkdirSync(dirname(stylePath), { recursive: true });
		writeFileSync(stylePath, LOW_BATTERY_OUTPUT_STYLE, "utf-8");
		log.info("low-battery output style installed", { path: stylePath, revision: LOW_BATTERY_REVISION });
	} catch (err) {
		log.warn("Failed to install low-battery output style (non-fatal)", { path: stylePath, error: String(err) });
		return { kind: "left-alone" };
	}

	const settingsPath = join(home, ".claude", "settings.json");
	try {
		const settings = safeReadSettings(settingsPath);
		const { changed, outcome } = applyLowBatteryOutputStyle(settings, true);
		if (changed) {
			mkdirSync(dirname(settingsPath), { recursive: true });
			writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
			log.info("Claude settings patched (outputStyle → low-battery)", { path: settingsPath });
		}
		return outcome;
	} catch (err) {
		log.warn("Failed to select the low-battery output style (non-fatal)", { path: settingsPath, error: String(err) });
		return { kind: "left-alone" };
	}
}

function removeOutputStyle(home: string): OutputStyleOutcome {
	const stylePath = join(home, ".claude", "output-styles", LOW_BATTERY_STYLE_FILE);
	try {
		rmSync(stylePath, { force: true });
	} catch (err) {
		log.warn("Failed to remove the low-battery output style (non-fatal)", { path: stylePath, error: String(err) });
	}

	const settingsPath = join(home, ".claude", "settings.json");
	if (!existsSync(settingsPath)) return { kind: "left-alone" };
	try {
		const settings = safeReadSettings(settingsPath);
		const { changed, outcome } = applyLowBatteryOutputStyle(settings, false);
		if (changed) {
			writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
			log.info("Claude settings patched (outputStyle cleared)", { path: settingsPath });
		}
		return outcome;
	} catch (err) {
		log.warn("Failed to clear the low-battery output style (non-fatal)", { path: settingsPath, error: String(err) });
		return { kind: "left-alone" };
	}
}

function installSkill(home: string): void {
	for (const dir of LOW_BATTERY_SKILL_DIRS) {
		const skillDir = join(home, dir);
		// Only the shared `.agents` tree carries the OpenAI metadata sidecar, matching
		// how dev3 installs its own skills.
		const isShared = dir.startsWith(".agents/");
		try {
			for (const [relPath, contents] of Object.entries(LOW_BATTERY_SKILL_FILES)) {
				if (relPath.startsWith("agents/") && !isShared) continue;
				const target = join(skillDir, ...relPath.split("/"));
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, contents, "utf-8");
			}
			log.info("low-battery skill installed", { path: skillDir, revision: LOW_BATTERY_REVISION });
		} catch (err) {
			log.warn("Failed to install low-battery skill (non-fatal)", { path: skillDir, error: String(err) });
		}
	}
}

function removeSkill(home: string): void {
	for (const dir of LOW_BATTERY_SKILL_DIRS) {
		const skillDir = join(home, dir);
		if (!existsSync(skillDir)) continue;
		try {
			rmSync(skillDir, { recursive: true, force: true });
			log.info("low-battery skill removed", { path: skillDir });
		} catch (err) {
			log.warn("Failed to remove low-battery skill (non-fatal)", { path: skillDir, error: String(err) });
		}
	}
}

/** Install or fully remove low-battery, matching the toggle. Never throws. */
export function applyLowBattery(home: string, enabled: boolean): OutputStyleOutcome {
	if (!enabled) {
		removeSkill(home);
		return removeOutputStyle(home);
	}
	installSkill(home);
	return installOutputStyle(home);
}

export function lowBatteryStatus(home: string, enabled: boolean): LowBatteryStatus {
	const styleInstalled = existsSync(join(home, ".claude", "output-styles", LOW_BATTERY_STYLE_FILE));
	const skillInstalled = LOW_BATTERY_SKILL_DIRS.some((dir) => existsSync(join(home, dir, "SKILL.md")));

	const settingsPath = join(home, ".claude", "settings.json");
	const raw = existsSync(settingsPath) ? safeReadSettings(settingsPath) : {};
	const selected = typeof raw.outputStyle === "string" ? raw.outputStyle.trim() : "";

	// Re-run the decision against a copy so the status never writes anything.
	const { outcome } = applyLowBatteryOutputStyle({ ...raw }, enabled);

	return {
		enabled,
		revision: LOW_BATTERY_REVISION,
		styleInstalled,
		skillInstalled,
		selectedStyle: selected || undefined,
		outcome,
	};
}

/**
 * Force-select the style for a user who kept their own and then asked for
 * low-battery anyway — the one-click switch under the settings row. Overwrites the
 * `outputStyle` key unconditionally, because here the user asked for exactly that.
 */
export function forceSelectLowBatteryStyle(home: string): void {
	const settingsPath = join(home, ".claude", "settings.json");
	const settings = safeReadSettings(settingsPath);
	settings.outputStyle = LOW_BATTERY_STYLE_NAME;
	mkdirSync(dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
	log.info("low-battery output style selected on request", { path: settingsPath });
}

/** Every file low-battery owns, for `dev3 install-skills` to print. */
export function lowBatterySkillFiles(): string[] {
	return LOW_BATTERY_SKILL_DIRS.map((dir) => `${dir}/SKILL.md`);
}
