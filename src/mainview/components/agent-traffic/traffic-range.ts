/**
 * The arithmetic behind dragging a time range on the traffic ruler.
 *
 * Kept away from the component on purpose: every rule that is easy to get wrong
 * about a draggable interval — a backwards drag, a handle dragged past its
 * partner, a band pushed off the end of history, an interval squeezed to nothing
 * — is a pure function here with a test, rather than a branch inside a pointer
 * handler nobody can reproduce.
 *
 * Every function takes the domain (the span of history the ruler draws) and
 * returns an interval that is inside it. Nothing here knows about pixels.
 */

import { MIN_RANGE_MS } from "./traffic-period";

export interface TimeRange {
	start: number;
	end: number;
}

/** Which end of the band the pointer currently owns. */
export type RangeEdge = "start" | "end";

/** The floor, lowered when the whole domain is shorter than it. */
function floorMs(domain: TimeRange): number {
	return Math.min(MIN_RANGE_MS, Math.max(1, domain.end - domain.start));
}

function clampTime(at: number, domain: TimeRange): number {
	return Math.min(domain.end, Math.max(domain.start, at));
}

/**
 * Two instants from one drag turned into an interval: ordered, clamped, and at
 * least a minute long.
 *
 * A backwards drag is not an error state — it is the same interval — so it is
 * simply sorted. `anchor` names the end that must not move when the floor has to
 * grow the interval: dragging the start handle up against the end must push the
 * start away, never drag the end along with it.
 */
export function normalizeRange(
	a: number,
	b: number,
	domain: TimeRange,
	anchor?: number,
): TimeRange {
	const low = clampTime(Math.min(a, b), domain);
	const high = clampTime(Math.max(a, b), domain);
	const floor = floorMs(domain);
	if (high - low >= floor) return { start: low, end: high };
	const keepLow =
		anchor === undefined
			? true
			: Math.abs(anchor - low) <= Math.abs(anchor - high);
	let start = keepLow ? low : high - floor;
	let end = keepLow ? low + floor : high;
	if (end > domain.end) {
		end = domain.end;
		start = end - floor;
	}
	if (start < domain.start) {
		start = domain.start;
		end = start + floor;
	}
	return { start, end };
}

/**
 * Slide the whole interval, keeping its length.
 *
 * The length is what the reader is holding on to, so hitting the edge of history
 * stops the interval rather than shortening it.
 */
export function moveRange(
	range: TimeRange,
	deltaMs: number,
	domain: TimeRange,
): TimeRange {
	const span = Math.min(range.end - range.start, domain.end - domain.start);
	let start = range.start + deltaMs;
	if (start < domain.start) start = domain.start;
	if (start + span > domain.end) start = domain.end - span;
	return { start, end: start + span };
}

/**
 * Drag one handle. Crossing over the other one hands the pointer the opposite
 * edge instead of refusing the gesture, which is what every timeline editor does
 * and what a reader who overshoots expects.
 */
export function resizeRange(
	range: TimeRange,
	edge: RangeEdge,
	at: number,
	domain: TimeRange,
): { range: TimeRange; edge: RangeEdge } {
	const anchor = edge === "start" ? range.end : range.start;
	const moved = clampTime(at, domain);
	return {
		range: normalizeRange(anchor, moved, domain, anchor),
		edge: moved < anchor ? "start" : "end",
	};
}

/** Where an instant sits across the ruler, 0 at its left edge and 1 at its right. */
export function rangeFraction(at: number, domain: TimeRange): number {
	const span = domain.end - domain.start;
	if (span <= 0) return 0;
	return Math.min(1, Math.max(0, (at - domain.start) / span));
}

/** The instant a fraction of the way across the ruler. */
export function timeAtFraction(fraction: number, domain: TimeRange): number {
	const clamped = Math.min(1, Math.max(0, fraction));
	return domain.start + clamped * (domain.end - domain.start);
}

/**
 * The keyboard step: a hundredth of the drawn history, never finer than the
 * floor. A fixed step would be a crawl across a week and a jump across an hour.
 */
export function rangeStep(domain: TimeRange): number {
	return Math.max(MIN_RANGE_MS, Math.round((domain.end - domain.start) / 100));
}

/**
 * The spans the ruler is allowed to draw — round units, so the axis reads as a
 * span a person would name rather than an arbitrary multiple of the window.
 */
const RULER_SPANS = [
	3600000, 10800000, 21600000, 43200000, 86400000, 259200000, 604800000,
	1209600000, 2592000000, 7776000000,
];

/**
 * How much history the ruler draws around the window on screen.
 *
 * Not "everything loaded", which was the first shape and the wrong one: paging
 * pulls whole weeks for a quiet project, so the trailing hour the screen opens on
 * came out as a band two pixels wide that nothing could grab. The ruler shows
 * roughly three times the window instead — enough context to see where the
 * window sits and to drag it somewhere else, at a size a pointer can hit.
 *
 * Two clamps keep it honest. It never draws earlier than the oldest instant
 * actually loaded, so a band cannot be dragged into history nobody has read; and
 * it never draws later than now. When the window already covers everything
 * loaded, both clamps bite and the band simply fills the ruler.
 */
export function rulerDomain(
	window: TimeRange,
	loadedOldest: number | null,
	now: number,
): TimeRange {
	const windowSpan = Math.max(MIN_RANGE_MS, window.end - window.start);
	const span =
		RULER_SPANS.find((candidate) => candidate >= windowSpan * 3) ??
		Math.round(windowSpan * 1.5);
	let end = Math.max(window.end, Math.min(now, window.end + (span - windowSpan) / 2));
	let start = end - span;
	if (start > window.start) {
		start = window.start;
		end = start + span;
	}
	const oldest =
		loadedOldest === null ? start : Math.min(loadedOldest, window.start);
	start = Math.max(start, oldest);
	end = Math.min(end, Math.max(now, window.end));
	if (end - start < MIN_RANGE_MS) end = start + MIN_RANGE_MS;
	return { start, end };
}

/**
 * Whether a ruler already on screen can keep its scale for a new window.
 *
 * Rescaling on every commit is what makes a selector feel like it is fighting
 * back: the reader drags an interval, lets go, and the axis under it jumps. A
 * ruler that still holds the window, and still draws it big enough to grab, has
 * no reason to move — so it does not.
 */
export function domainHolds(domain: TimeRange, range: TimeRange): boolean {
	const span = domain.end - domain.start;
	if (span <= 0) return false;
	if (range.start < domain.start || range.end > domain.end) return false;
	return (range.end - range.start) / span >= 0.08;
}

/**
 * One interval as a label: times alone inside a single day, dates as well when
 * the two ends fall on different ones.
 */
export function formatRangeLabel(
	range: TimeRange,
	locale: string,
	today = new Date(),
): string {
	const from = new Date(range.start);
	const to = new Date(range.end);
	const time = (at: Date) =>
		at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
	const date = (at: Date) =>
		at.toLocaleDateString(locale, { month: "short", day: "numeric" });
	const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
	if (!sameDay(from, to))
		return `${date(from)} ${time(from)} – ${date(to)} ${time(to)}`;
	const day = sameDay(from, today) ? "" : `${date(from)}, `;
	return `${day}${time(from)} – ${time(to)}`;
}

const TICK_STEPS = [
	60000, 300000, 900000, 1800000, 3600000, 10800000, 21600000, 43200000,
	86400000, 172800000, 604800000,
];

/**
 * Round label instants across the ruler — on the local clock, so a tick reads
 * `15:00` rather than an arbitrary offset from whenever history happens to start.
 */
export function rulerTickStep(domain: TimeRange, count = 4): number {
	const span = domain.end - domain.start;
	if (span <= 0 || count < 1) return 0;
	return (
		TICK_STEPS.find((candidate) => span / candidate <= count) ??
		Math.ceil(span / count)
	);
}

export function rulerTicks(domain: TimeRange, count = 4): number[] {
	const step = rulerTickStep(domain, count);
	if (!step) return [];
	const offset = new Date(domain.start).getTimezoneOffset() * 60000;
	const ticks: number[] = [];
	for (
		let at = Math.ceil((domain.start - offset) / step) * step + offset;
		at <= domain.end;
		at += step
	)
		ticks.push(at);
	return ticks;
}
