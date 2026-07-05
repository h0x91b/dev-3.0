/**
 * Minimal RFC 5545 RRULE subset engine with IANA-timezone support, used by the
 * Automations scheduler. Pure — no dependencies, no I/O — so it is unit-testable
 * and shared between the bun scheduler, the CLI, and the renderer.
 *
 * Supported grammar (everything else is a parse error, never a silent skip):
 *   FREQ=HOURLY|DAILY|WEEKLY|MONTHLY   (required)
 *   INTERVAL=n                          (default 1)
 *   BYDAY=MO,TU,...                     (WEEKLY only; plain weekdays, no ordinals)
 *   BYMONTHDAY=1..31                    (MONTHLY only)
 *   BYHOUR=0..23                        (default 9; ignored for HOURLY)
 *   BYMINUTE=0..59                      (default 0)
 *
 * The optional leading "RRULE:" prefix is accepted. Occurrences are computed as
 * wall-clock times in the automation's timezone and converted to UTC instants via
 * Intl (two-pass offset correction, so DST transitions land within the hour —
 * a nonexistent spring-forward time fires at the shifted instant, an ambiguous
 * fall-back time fires once).
 */

export type RRuleFreq = "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";

export interface RRuleSpec {
	freq: RRuleFreq;
	interval: number;
	/** 0=Sunday .. 6=Saturday (JS getDay convention). Sorted, deduped. */
	byDay: number[];
	/** 1..31. Sorted, deduped. */
	byMonthDay: number[];
	/** 0..23. Sorted, deduped. Defaults to [9] (a human-friendly morning). */
	byHour: number[];
	/** 0..59. Sorted, deduped. Defaults to [0]. */
	byMinute: number[];
}

const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

export class RRuleParseError extends Error {
	override name = "RRuleParseError";
}

function parseIntList(value: string, min: number, max: number, field: string): number[] {
	const out: number[] = [];
	for (const part of value.split(",")) {
		const n = Number(part.trim());
		if (!Number.isInteger(n) || n < min || n > max) {
			throw new RRuleParseError(`${field} value "${part.trim()}" must be an integer ${min}..${max}`);
		}
		out.push(n);
	}
	return [...new Set(out)].sort((a, b) => a - b);
}

/** Parse an RRULE string (with or without the "RRULE:" prefix). Throws {@link RRuleParseError}. */
export function parseRRule(input: string): RRuleSpec {
	const text = input.trim().replace(/^RRULE:/i, "");
	if (!text) throw new RRuleParseError("Empty RRULE");

	let freq: RRuleFreq | null = null;
	let interval = 1;
	let byDay: number[] = [];
	let byMonthDay: number[] = [];
	let byHour: number[] | null = null;
	let byMinute: number[] | null = null;

	for (const rawPart of text.split(";")) {
		const part = rawPart.trim();
		if (!part) continue;
		const eq = part.indexOf("=");
		if (eq === -1) throw new RRuleParseError(`Malformed RRULE part "${part}"`);
		const key = part.slice(0, eq).toUpperCase();
		const value = part.slice(eq + 1).trim();
		switch (key) {
			case "FREQ": {
				const v = value.toUpperCase();
				if (v !== "HOURLY" && v !== "DAILY" && v !== "WEEKLY" && v !== "MONTHLY") {
					throw new RRuleParseError(`Unsupported FREQ=${value} (supported: HOURLY, DAILY, WEEKLY, MONTHLY)`);
				}
				freq = v;
				break;
			}
			case "INTERVAL": {
				const n = Number(value);
				if (!Number.isInteger(n) || n < 1 || n > 999) {
					throw new RRuleParseError(`INTERVAL must be an integer 1..999, got "${value}"`);
				}
				interval = n;
				break;
			}
			case "BYDAY": {
				byDay = [
					...new Set(
						value.split(",").map((code) => {
							const c = code.trim().toUpperCase();
							if (!(c in WEEKDAYS)) {
								throw new RRuleParseError(`BYDAY value "${code.trim()}" must be one of ${Object.keys(WEEKDAYS).join(",")} (ordinals like 1MO are not supported)`);
							}
							return WEEKDAYS[c];
						}),
					),
				].sort((a, b) => a - b);
				break;
			}
			case "BYMONTHDAY":
				byMonthDay = parseIntList(value, 1, 31, "BYMONTHDAY");
				break;
			case "BYHOUR":
				byHour = parseIntList(value, 0, 23, "BYHOUR");
				break;
			case "BYMINUTE":
				byMinute = parseIntList(value, 0, 59, "BYMINUTE");
				break;
			default:
				throw new RRuleParseError(`Unsupported RRULE part "${key}" (supported: FREQ, INTERVAL, BYDAY, BYMONTHDAY, BYHOUR, BYMINUTE)`);
		}
	}

	if (!freq) throw new RRuleParseError("RRULE must contain FREQ=");
	if (byDay.length > 0 && freq !== "WEEKLY") {
		throw new RRuleParseError("BYDAY is only supported with FREQ=WEEKLY");
	}
	if (byMonthDay.length > 0 && freq !== "MONTHLY") {
		throw new RRuleParseError("BYMONTHDAY is only supported with FREQ=MONTHLY");
	}

	return {
		freq,
		interval,
		byDay,
		byMonthDay,
		byHour: byHour ?? [9],
		byMinute: byMinute ?? [0],
	};
}

/** Serialize a spec back to a canonical RRULE string. */
export function formatRRule(spec: RRuleSpec): string {
	const parts = [`FREQ=${spec.freq}`];
	if (spec.interval !== 1) parts.push(`INTERVAL=${spec.interval}`);
	if (spec.byDay.length > 0) parts.push(`BYDAY=${spec.byDay.map((d) => WEEKDAY_CODES[d]).join(",")}`);
	if (spec.byMonthDay.length > 0) parts.push(`BYMONTHDAY=${spec.byMonthDay.join(",")}`);
	parts.push(`BYHOUR=${spec.byHour.join(",")}`);
	parts.push(`BYMINUTE=${spec.byMinute.join(",")}`);
	return parts.join(";");
}

/** True if `tz` is a usable IANA timezone name on this runtime. */
export function isValidTimezone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

// ---- Timezone math (no deps) ----

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getDtf(tz: string): Intl.DateTimeFormat {
	let dtf = dtfCache.get(tz);
	if (!dtf) {
		dtf = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		});
		dtfCache.set(tz, dtf);
	}
	return dtf;
}

interface WallClock {
	year: number;
	month: number; // 1..12
	day: number; // 1..31
	hour: number; // 0..23
	minute: number;
	second: number;
}

/** Wall-clock components of a UTC instant, as seen in `tz`. */
export function wallClockInZone(instant: Date, tz: string): WallClock {
	const parts = getDtf(tz).formatToParts(instant);
	const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
	// Intl uses hour "24" for midnight in some environments; normalize.
	const hour = get("hour") % 24;
	return { year: get("year"), month: get("month"), day: get("day"), hour, minute: get("minute"), second: get("second") };
}

/** UTC offset of `tz` at a given instant, in milliseconds (east positive). */
function tzOffsetMs(instant: Date, tz: string): number {
	const w = wallClockInZone(instant, tz);
	const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
	return asUtc - instant.getTime();
}

/**
 * Convert a wall-clock time in `tz` to a UTC instant. Two-pass offset
 * correction: exact for all normal times; DST-nonexistent times resolve to the
 * shifted instant, DST-ambiguous times resolve to one of the two candidates.
 */
export function zonedTimeToUtc(
	year: number,
	month: number, // 1..12
	day: number,
	hour: number,
	minute: number,
	tz: string,
): Date {
	const guessMs = Date.UTC(year, month - 1, day, hour, minute, 0);
	const offset1 = tzOffsetMs(new Date(guessMs), tz);
	const candidate = guessMs - offset1;
	const offset2 = tzOffsetMs(new Date(candidate), tz);
	return new Date(guessMs - offset2);
}

// ---- Occurrence computation ----

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAY_SCAN = 800; // > 2 years of daily candidates
const MAX_HOUR_SCAN = 24 * 800;

/** Day index (days since epoch) of a wall-clock date — used for interval math. */
function dayIndex(year: number, month: number, day: number): number {
	return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

/** Monday-based week index of a wall-clock date. */
function weekIndex(year: number, month: number, day: number): number {
	const di = dayIndex(year, month, day);
	// Epoch day 0 = Thursday 1970-01-01; shift so weeks split on Monday.
	return Math.floor((di + 3) / 7);
}

function monthIndex(year: number, month: number): number {
	return year * 12 + (month - 1);
}

/**
 * Compute the next occurrence of `spec` strictly after `after`, evaluated as
 * wall-clock in `tz`. `anchor` fixes the phase of INTERVAL>1 rules (the
 * automation's creation time). Returns null if nothing matches within the scan
 * horizon (~2 years) — possible only for impossible combos like BYMONTHDAY=31
 * with INTERVAL months that never have 31 days... which still matches within
 * horizon, so null is effectively "malformed rule".
 */
export function nextOccurrence(spec: RRuleSpec, after: Date, tz: string, anchor: Date): Date | null {
	if (spec.freq === "HOURLY") {
		return nextHourly(spec, after, tz, anchor);
	}

	const anchorWall = wallClockInZone(anchor, tz);
	const afterWall = wallClockInZone(after, tz);

	// Start scanning from the day of `after` in tz (an occurrence later the same
	// day may still qualify).
	let cursor = Date.UTC(afterWall.year, afterWall.month - 1, afterWall.day);

	for (let i = 0; i < MAX_DAY_SCAN; i++) {
		const d = new Date(cursor + i * DAY_MS);
		const year = d.getUTCFullYear();
		const month = d.getUTCMonth() + 1;
		const day = d.getUTCDate();
		const dow = d.getUTCDay();

		if (!dayMatches(spec, { year, month, day, dow }, anchorWall)) continue;

		for (const hour of spec.byHour) {
			for (const minute of spec.byMinute) {
				const instant = zonedTimeToUtc(year, month, day, hour, minute, tz);
				if (instant.getTime() > after.getTime()) return instant;
			}
		}
	}
	return null;
}

function dayMatches(
	spec: RRuleSpec,
	candidate: { year: number; month: number; day: number; dow: number },
	anchorWall: WallClock,
): boolean {
	switch (spec.freq) {
		case "DAILY": {
			if (spec.interval === 1) return true;
			const diff = dayIndex(candidate.year, candidate.month, candidate.day) - dayIndex(anchorWall.year, anchorWall.month, anchorWall.day);
			return diff >= 0 && diff % spec.interval === 0;
		}
		case "WEEKLY": {
			const days = spec.byDay.length > 0 ? spec.byDay : [dowOfWall(anchorWall)];
			if (!days.includes(candidate.dow)) return false;
			if (spec.interval === 1) return true;
			const diff = weekIndex(candidate.year, candidate.month, candidate.day) - weekIndex(anchorWall.year, anchorWall.month, anchorWall.day);
			return diff >= 0 && diff % spec.interval === 0;
		}
		case "MONTHLY": {
			const days = spec.byMonthDay.length > 0 ? spec.byMonthDay : [anchorWall.day];
			if (!days.includes(candidate.day)) return false;
			if (spec.interval === 1) return true;
			const diff = monthIndex(candidate.year, candidate.month) - monthIndex(anchorWall.year, anchorWall.month);
			return diff >= 0 && diff % spec.interval === 0;
		}
		default:
			return false;
	}
}

function dowOfWall(w: WallClock): number {
	return new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
}

function nextHourly(spec: RRuleSpec, after: Date, tz: string, anchor: Date): Date | null {
	const minute = spec.byMinute[0] ?? 0;
	// Hourly cadence is timezone-independent apart from the minute alignment;
	// anchor the interval phase on the anchor's hour (UTC hours are fine —
	// an hour boundary is an hour boundary in every zone with whole-hour offsets;
	// half-hour zones shift the phase but keep the cadence).
	void tz;
	const HOUR_MS = 60 * 60 * 1000;
	const anchorHour = Math.floor(anchor.getTime() / HOUR_MS);
	let hourCursor = Math.floor(after.getTime() / HOUR_MS);
	for (let i = 0; i < MAX_HOUR_SCAN; i++) {
		const h = hourCursor + i;
		const diff = h - anchorHour;
		if (diff >= 0 && diff % spec.interval === 0) {
			const instant = new Date(h * HOUR_MS + minute * 60 * 1000);
			if (instant.getTime() > after.getTime()) return instant;
		}
	}
	return null;
}

/**
 * List every occurrence in the half-open interval (`from`, `to`] — used by the
 * scheduler to count runs missed while the app was offline. Capped at `limit`
 * (default 50) to bound pathological rules; the count is exact up to the cap.
 */
export function occurrencesBetween(
	spec: RRuleSpec,
	from: Date,
	to: Date,
	tz: string,
	anchor: Date,
	limit = 50,
): Date[] {
	const out: Date[] = [];
	let cursor = from;
	while (out.length < limit) {
		const next = nextOccurrence(spec, cursor, tz, anchor);
		if (!next || next.getTime() > to.getTime()) break;
		out.push(next);
		cursor = next;
	}
	return out;
}
