import type { TipState } from "../../shared/types";
import { tipStateKey, type Tip, type TipContext } from "./registry";

const COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
export const SNOOZE_MS = 4 * 60 * 60 * 1000; // 4 hours
export const ROTATION_INTERVAL_MS = 60 * 1000; // 1 minute
const TIP_SCORES: readonly number[] = [1, 2, 3, 4, 5];

/** Deterministic pseudo-random in [0, 1) seeded by an integer — keeps selectTip pure & testable. */
function seededUnit(seed: number): number {
	const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
	return x - Math.floor(x);
}

const reportedFailures = new Set<string>();

/** Once per tip and failure: every carrier re-selects on each render and rotation. */
function reportOnce(id: string, failure: string, err?: unknown): void {
	const key = `${id}\u0000${failure}`;
	if (reportedFailures.has(key)) return;
	reportedFailures.add(key);
	console.error(`[slots] tip ${id}: ${failure}; hiding it:`, err);
}

export function resetTipFailuresForTests(): void {
	reportedFailures.clear();
}

/** A tip the host can rank: its `when` lets it in, and its data cannot throw inside selection. */
function isShowable(tip: Tip): boolean {
	if (!Array.isArray(tip.contexts) || tip.contexts.length === 0 || !TIP_SCORES.includes(tip.score)) {
		reportOnce(tip.id, "malformed contexts or score");
		return false;
	}
	if (!tip.when) return true;
	try {
		return tip.when();
	} catch (err) {
		reportOnce(tip.id, "when() threw", err);
		return false;
	}
}

/** Tips that are not snoozed and either unseen or past their cooldown. */
function availableTips(tips: readonly Tip[], state: TipState, now: number): Tip[] {
	return tips.filter((t) => {
		if (!isShowable(t)) return false;
		const lastSeen = state.seen[tipStateKey(t)];
		if (!lastSeen) return true;
		return now - lastSeen > COOLDOWN_MS;
	});
}

/**
 * Pick the current tip from the registered `tips`, in registration order, based on persisted
 * state. Pure function — no side effects beyond logging a broken tip once.
 *
 * Highest-coolness tier first: all score-5 tips are shown (in pseudo-random
 * order) before any score-4 tip, and so on. As tips are seen they drop out of
 * the pool for COOLDOWN_MS, draining the top tier until it falls to the next.
 *
 * `context` is a SORT BOOST, not a filter: when supplied, tips whose `contexts`
 * include it are preferred and exhausted first (still by score tier). Only once
 * no context-matching tip is available do the remaining tips surface, so a
 * surface never runs dry — it just leads with its own relevant tips.
 */
export function selectTip(tips: readonly Tip[], state: TipState, context?: TipContext): Tip | null {
	const now = Date.now();

	if (state.snoozedUntil > now) return null;

	const available = availableTips(tips, state, now);
	if (available.length === 0) return null;

	let pool = available;
	if (context) {
		const matching = available.filter((t) => t.contexts.includes(context));
		if (matching.length > 0) pool = matching;
	}

	const maxScore = Math.max(...pool.map((t) => t.score));
	const tier = pool.filter((t) => t.score === maxScore);

	const idx = Math.floor(seededUnit(state.rotationIndex) * tier.length);
	return tier[idx];
}

/** Get available tips count for the given state. */
export function getAvailableTipsCount(tips: readonly Tip[], state: TipState): number {
	return availableTips(tips, state, Date.now()).length;
}
