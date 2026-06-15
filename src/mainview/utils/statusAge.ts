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
	return { value: Math.floor(days / 365), unit: "y" };
}

/** Compact "digit(s)+letter" form, e.g. `25s`, `5m`, `7h`, `13d`, `7M`, `3y`. */
export function compactAge(iso: string | null | undefined, now: number = Date.now()): string {
	const part = ageParts(iso, now);
	if (!part) return "";
	return `${part.value}${part.unit}`;
}
