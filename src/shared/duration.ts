/**
 * Human-friendly delay parsing/formatting for the "Start in…" deferred-launch
 * UI (Launch modal → schedule picker; task-card countdown badge).
 * Shared so the mainview and any future CLI surface agree on the grammar.
 */

const UNIT_MS: Record<string, number> = {
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

/**
 * Parse a delay like `45m`, `2h`, `1h30m`, `1d2h` into milliseconds.
 * A bare number means minutes (`90` → 90 min). Whitespace is ignored.
 * Returns null for anything unparseable or non-positive.
 */
export function parseDelay(input: string): number | null {
	const s = input.trim().toLowerCase().replace(/\s+/g, "");
	if (!s) return null;
	// Bare number → minutes
	if (/^\d+$/.test(s)) {
		const min = Number.parseInt(s, 10);
		return min > 0 ? min * UNIT_MS.m : null;
	}
	// Sequence of <number><unit> segments, each unit at most once (m/h/d)
	if (!/^(\d+[mhd])+$/.test(s)) return null;
	let total = 0;
	const seen = new Set<string>();
	for (const match of s.matchAll(/(\d+)([mhd])/g)) {
		const unit = match[2];
		if (seen.has(unit)) return null;
		seen.add(unit);
		total += Number.parseInt(match[1], 10) * UNIT_MS[unit];
	}
	return total > 0 ? total : null;
}

/**
 * Compact countdown for the task-card badge: `2d 3h`, `1h 05m`, `12m`, `<1m`.
 * Clamps at zero (a due-but-not-yet-fired launch shows `<1m`, never negative).
 */
export function formatCountdown(ms: number): string {
	if (ms < UNIT_MS.m) return "<1m";
	const d = Math.floor(ms / UNIT_MS.d);
	const h = Math.floor((ms % UNIT_MS.d) / UNIT_MS.h);
	const m = Math.floor((ms % UNIT_MS.h) / UNIT_MS.m);
	if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
	if (h > 0) return m > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${h}h`;
	return `${m}m`;
}
