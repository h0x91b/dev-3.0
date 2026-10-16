// ---- Task priority ----

/**
 * Task importance, `P0` (highest) … `P4` (lowest). The numeric suffix IS the
 * rank (P0 = 0 = most important). Stored explicitly on every task; tasks created
 * before this field existed are stamped {@link DEFAULT_PRIORITY} by a load-time
 * in-place content migration (paths untouched — older app versions ignore the
 * unknown field). Each variant carries its own value: new variants inherit the
 * source's priority at creation, then change independently.
 */
export type TaskPriority = "P0" | "P1" | "P2" | "P3" | "P4";

/** All priorities, highest → lowest. */
export const ALL_PRIORITIES: TaskPriority[] = ["P0", "P1", "P2", "P3", "P4"];

/** Default priority for new tasks and for legacy tasks missing the field. */
export const DEFAULT_PRIORITY: TaskPriority = "P3";

/**
 * Sort rank of a priority: 0 (P0, highest) … 4 (P4, lowest). Missing/invalid
 * values fall back to the {@link DEFAULT_PRIORITY} rank so legacy tasks band as
 * P3. Lower rank sorts first (on top of a column).
 */
export function priorityRank(priority: TaskPriority | null | undefined): number {
	if (priority && /^P[0-4]$/.test(priority)) return Number(priority.slice(1));
	return Number(DEFAULT_PRIORITY.slice(1));
}

/**
 * Strict-band comparator: higher priority (lower rank) sorts first. This is the
 * TOPMOST sort key for a rendered column / sidebar group — all P0 above all P1,
 * etc. Within a band, callers apply their existing ordering rules unchanged.
 */
export function comparePriority(
	a: TaskPriority | null | undefined,
	b: TaskPriority | null | undefined,
): number {
	return priorityRank(a) - priorityRank(b);
}

/**
 * Normalize free-form CLI input to a {@link TaskPriority}. Case-insensitive;
 * accepts `P0`–`P4` (any case) or a bare digit `0`–`4`. Returns `null` for
 * anything else so callers can reject it with a usage error.
 */
export function normalizePriority(input: string): TaskPriority | null {
	const m = /^\s*p?([0-4])\s*$/i.exec(input);
	return m ? (`P${m[1]}` as TaskPriority) : null;
}
