/**
 * Pure half of the low-battery feature: the names dev3 writes, and the decision
 * about whether it may touch the Claude Code `outputStyle` key at all.
 *
 * Kept out of `src/bun/low-battery.ts` so the three-case rule (key absent / already
 * low-battery / the user's own style) is testable with no filesystem, and so the
 * renderer can share the status shape without importing host code.
 */

/** Filename dev3 writes into `~/.claude/output-styles/`. */
export const LOW_BATTERY_STYLE_FILE = "low-battery.md";

/**
 * The name Claude Code registers this style under. Frontmatter `name` REPLACES the
 * filename slug (see `registeredOutputStyleName` in agent-accounts.ts), and the
 * shipped file declares `name: Low Battery` — so this is the only string the
 * `outputStyle` key may hold for dev3's copy.
 */
export const LOW_BATTERY_STYLE_NAME = "Low Battery";

/**
 * Recognise the style whatever installed it. A Claude Code plugin registers the
 * same rules namespaced (`low-battery:Low Battery`), so a user who already has the
 * upstream plugin reads as "already on" instead of getting a second copy under a
 * second name.
 */
export function isLowBatteryStyle(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const name = value.trim().toLowerCase();
	if (!name) return false;
	const bare = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1).trim() : name;
	return bare === "low battery" || bare === "low-battery";
}

/** What the `outputStyle` decision did, so the settings row can explain itself. */
export type OutputStyleOutcome =
	/** dev3 wrote its own style name into an empty or `default` slot. */
	| { kind: "selected" }
	/** The key already names a low-battery variant — dev3 changed nothing. */
	| { kind: "already-on"; style: string }
	/** The user picked their own style — dev3 changed nothing and says which. */
	| { kind: "user-style-kept"; style: string }
	/** dev3's own value was cleared on uninstall. */
	| { kind: "cleared" }
	/** Nothing to clear: the key was absent, or held a style dev3 did not write. */
	| { kind: "left-alone"; style?: string };

/**
 * Pure: decide what the `outputStyle` key should hold. Mutates `settings` in place
 * and reports both whether a write is needed and what happened, because the settings
 * row has to tell the user plainly when their own style was left selected.
 */
export function applyLowBatteryOutputStyle(
	settings: Record<string, unknown>,
	enabled: boolean,
): { changed: boolean; outcome: OutputStyleOutcome } {
	const current = typeof settings.outputStyle === "string" ? settings.outputStyle.trim() : "";

	if (!enabled) {
		// Remove only what dev3 wrote. A plugin-namespaced value belongs to the
		// plugin, and anything else belongs to the user.
		if (current === LOW_BATTERY_STYLE_NAME) {
			delete settings.outputStyle;
			return { changed: true, outcome: { kind: "cleared" } };
		}
		return { changed: false, outcome: { kind: "left-alone", style: current || undefined } };
	}

	if (isLowBatteryStyle(current)) {
		return { changed: false, outcome: { kind: "already-on", style: current } };
	}
	if (current && current.toLowerCase() !== "default") {
		return { changed: false, outcome: { kind: "user-style-kept", style: current } };
	}

	settings.outputStyle = LOW_BATTERY_STYLE_NAME;
	return { changed: true, outcome: { kind: "selected" } };
}

/** What the Global Settings row and `dev3 doctor` report. */
export interface LowBatteryStatus {
	enabled: boolean;
	/** Upstream commit baked into this build. */
	revision: string;
	/** Whether the style file dev3 writes is on disk. */
	styleInstalled: boolean;
	/** Whether the skill reached at least one agent config dir. */
	skillInstalled: boolean;
	/** What `~/.claude/settings.json` currently selects, if anything. */
	selectedStyle?: string;
	outcome: OutputStyleOutcome;
}
