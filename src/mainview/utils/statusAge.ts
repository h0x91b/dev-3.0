export type AgeUnit = "s" | "m" | "h" | "d" | "M" | "y";

export interface AgePart {
	value: number;
	/** Lowercase `m` = minutes, uppercase `M` = months. */
	unit: AgeUnit;
}

/**
 * Break an elapsed duration into the single most-significant unit, so the badge
 * never shows more than two digits: seconds → minutes → hours → days → months
 * (~30d) → years (~365d). Returns null when there is no timestamp.
 */
export function ageParts(iso: string | null | undefined, now: number = Date.now()): AgePart | null {
	if (!iso) return null;
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return null;
	const secs = Math.max(0, Math.floor((now - then) / 1000));
	if (secs < 60) return { value: secs, unit: "s" };
	const mins = Math.floor(secs / 60);
	if (mins < 60) return { value: mins, unit: "m" };
	const hours = Math.floor(mins / 60);
	if (hours < 24) return { value: hours, unit: "h" };
	const days = Math.floor(hours / 24);
	if (days < 30) return { value: days, unit: "d" };
	const months = Math.floor(days / 30);
	if (months < 12) return { value: months, unit: "M" };
	// Years are derived from the same 30-day months (12 months = 1 year), not a
	// separate 365-day divisor — otherwise the 360–364 day window (months === 12,
	// days < 365) fell through to `floor(days / 365) === 0` and rendered "0y".
	return { value: Math.floor(months / 12), unit: "y" };
}

/** Compact form, e.g. `25s`, `5m`, `7h`, `13d`, `7mo`, `3y`. Months spell `mo`: a small `M` reads as minutes. */
export function compactAge(iso: string | null | undefined, now: number = Date.now()): string {
	const part = ageParts(iso, now);
	if (!part) return "";
	return `${part.value}${part.unit === "M" ? "mo" : part.unit}`;
}

export type Freshness = "live" | "recent" | "today" | "stale";

const MINUTE_MS = 60_000;

/** How recently something happened, in the four tiers the age stamps colour by. */
export function freshness(iso: string | null | undefined, now: number = Date.now()): Freshness | null {
	if (!iso) return null;
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return null;
	const elapsed = Math.max(0, now - then);
	if (elapsed < 15 * MINUTE_MS) return "live";
	if (elapsed < 120 * MINUTE_MS) return "recent";
	if (elapsed < 24 * 60 * MINUTE_MS) return "today";
	return "stale";
}
