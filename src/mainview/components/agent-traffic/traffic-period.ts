export function localDay(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function dayDate(day: string): Date {
	const [year, month, date] = day.split("-").map(Number);
	return new Date(year, month - 1, date);
}

export function isCalendarDay(value: string): boolean {
	return (
		/^\d{4}-\d{2}-\d{2}$/.test(value) && localDay(dayDate(value)) === value
	);
}

export function shiftDay(day: string, delta: number): string {
	const date = dayDate(day);
	date.setDate(date.getDate() + delta);
	return localDay(date);
}

/**
 * A hand-picked interval, encoded into the same period value the presets use.
 *
 * One state, not two: a custom range that lived beside `windowSize` would be a
 * second answer to "which window is this", and every consumer would have to know
 * which one wins. Encoding it as a period value means picking a preset replaces
 * a dragged range by simply overwriting the string, and nothing else changes.
 */
const RANGE_PREFIX = "range:";

/** The shortest interval the ruler will hand back — below a minute the band is a hairline. */
export const MIN_RANGE_MS = 60000;

export function rangePeriod(start: number, end: number): string {
	return `${RANGE_PREFIX}${Math.round(start)}-${Math.round(end)}`;
}

export function parseRangePeriod(
	period: string,
): { start: number; end: number } | null {
	if (!period.startsWith(RANGE_PREFIX)) return null;
	const [start, end] = period
		.slice(RANGE_PREFIX.length)
		.split("-")
		.map(Number);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
		return null;
	return { start, end };
}

export function isCustomRange(period: string): boolean {
	return parseRangePeriod(period) !== null;
}

export function trafficPeriodBounds(period: string, now: number) {
	const range = parseRangePeriod(period);
	if (range) return range;
	if (isCalendarDay(period)) {
		return {
			start: dayDate(period).getTime(),
			end: dayDate(shiftDay(period, 1)).getTime(),
		};
	}
	return {
		start:
			period === "hour" ? now - 3600000 : period === "day" ? now - 86400000 : 0,
		end: Infinity,
	};
}
