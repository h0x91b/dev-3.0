import type { TranslationKey } from "../i18n/translations/en";
import type { SettingsRouteSectionId } from "../settings-registry";
import { defineAppSlot } from "../plugins/root";
import { SlotRegistry, type SlotItem } from "../plugins/slot-registry";

// Internal for now: no manifest kind declares `tips`, so the extension guard unloads any
// extension that registers here. Rotation, cool-down and snooze stay in the host (rotation.ts).
declare module "cordis" {
	interface Context {
		tips: TipRegistry;
	}
}

/**
 * Surface where a tip is most relevant. Used by selectTip() as a SORT BOOST,
 * never as a filter: tips matching the current surface are shown first (by
 * score tier); once they are exhausted (all seen / on cooldown) the rest of
 * the pool surfaces. Every tip MUST declare at least one context.
 */
export type TipContext = "board" | "terminal" | "diff" | "settings" | "preparing";

/**
 * Coolness tier, surfaced highest-tier-first (all 5s before any 4), random
 * within a tier — see selectTip(). Self-assess honestly; never ask the user:
 *
 * - 5 — flagship demo-reel "wow" that sells the product: multi-agent variants,
 *       bug-hunter swarm, CoW worktree deps, AI Review, live terminal preview.
 * - 4 — strong distinctive capability most users will love: agent-driven PRs,
 *       command palette, OSC52 clipboard, port auto-allocation, image paste.
 * - 3 — useful everyday convenience that is still non-obvious: search
 *       operators, right-click open, hover previews. Lowest tier worth adding.
 * - 2 — minor convenience or a settings toggle. Below the bar: normally no tip.
 * - 1 — niche/power-user trivia. Never add.
 *
 * Torn between two tiers? Pick the lower. Below 3 the answer is usually "no
 * tip at all" — see AGENTS.md "Feature discovery tips" for when one is earned.
 */
export type TipScore = 1 | 2 | 3 | 4 | 5;

/** One "Did you know?" tip. A built-in's id is `builtin:tip.<key>`; `<key>` is what TipState remembers. */
export interface Tip extends SlotItem {
	titleKey: TranslationKey;
	bodyKey: TranslationKey;
	icon: string; // Nerd Font codepoint
	score: TipScore;
	/**
	 * Surfaces where this tip is most relevant (required, non-empty). The tip
	 * carrier for a given surface passes its context to selectTip(), which
	 * shows context-matching tips first. A tip still appears on other surfaces
	 * once the matching pool drains — context boosts ordering, it never hides.
	 * Global/cross-surface tips (palette, shortcuts, sleep toggle) list several.
	 */
	contexts: TipContext[];
	/**
	 * Settings category this tip sends the reader to. Never spell a settings
	 * path out in prose — it rots the moment a category is renamed (three tips
	 * shipped pointing at a "Behavior" category that no longer existed).
	 * Declare the destination here and TipCard renders the link.
	 */
	settingsSection?: SettingsRouteSectionId;
	/** Keeps the tip out of the pool while false: never advertise a feature the user switched off. */
	when?: () => boolean;
}

export const BUILTIN_TIP_PREFIX = "builtin:tip.";

/** The key TipState's `seen` map stores for a tip: the bare key for a built-in, as before the slot. */
export function tipStateKey(tip: Pick<Tip, "id">): string {
	return tip.id.startsWith(BUILTIN_TIP_PREFIX) ? tip.id.slice(BUILTIN_TIP_PREFIX.length) : tip.id;
}

export class TipRegistry extends SlotRegistry<Tip> {
	constructor(ctx: import("cordis").Context) {
		super(ctx, "tips", { kind: "contribute", noun: "tip" });
	}
}

export const getTipRegistry = defineAppSlot((root) => new TipRegistry(root));
