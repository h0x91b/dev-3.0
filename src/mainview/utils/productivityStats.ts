import type { ProductivityStatEvent } from "../../shared/types";

export type StatsRange = "day" | "week" | "month" | "all";

export const STATS_RANGES: readonly StatsRange[] = ["day", "week", "month", "all"] as const;

export interface HeroMetric {
	/** Current-period value. */
	value: number;
	/** Gauge max for scaling the needle. */
	max: number;
	/** Previous-period value (for the trend). Null when no previous period (range "all"). */
	previous: number | null;
	/** Percentage change vs previous period, rounded. Null when not computable. */
	trendPct: number | null;
}

export interface SeriesBucket {
	/** Short axis label, e.g. "Mon", "14", "Jun". */
	label: string;
	/** Bucket start (ms) — for keys/tooltips. */
	startMs: number;
	completed: number;
	lines: number;
}

export interface PerProjectStat {
	projectId: string;
	name: string;
	kind: "git" | "virtual";
	completed: number;
	lines: number;
	/** Share of the period's completed tasks, 0–100. */
	sharePct: number;
	busiest: boolean;
}

export interface ProductivityDashboardData {
	range: StatsRange;
	periodFrom: number;
	periodTo: number;
	hasAnyData: boolean;
	/** ISO date (YYYY-MM-DD) LOC tracking effectively started (earliest captured/live stat), or null. */
	locTrackingSince: string | null;
	hero: {
		tasksShipped: HeroMetric;
		linesChanged: HeroMetric;
		velocity: HeroMetric;
		completionRate: HeroMetric;
		streak: HeroMetric;
	};
	counters: {
		tasksTotal: number;
		projectsTouched: number;
		agentsRun: number;
		allTimeCompleted: number;
		bestStreak: number;
	};
	series: SeriesBucket[];
	perProject: PerProjectStat[];
}

const DAY_MS = 86_400_000;

/** Round up to a "nice" gauge maximum (1/2/5 × 10ⁿ), never below `floor`. */
export function niceCeil(value: number, floor = 1): number {
	const v = Math.max(value, floor);
	const magnitude = Math.pow(10, Math.floor(Math.log10(v)));
	const norm = v / magnitude;
	let nice: number;
	if (norm <= 1) nice = 1;
	else if (norm <= 2) nice = 2;
	else if (norm <= 5) nice = 5;
	else nice = 10;
	return Math.max(nice * magnitude, floor);
}

function trendPct(current: number, previous: number | null): number | null {
	if (previous == null) return null;
	if (previous === 0) return current > 0 ? 100 : 0;
	return Math.round(((current - previous) / previous) * 100);
}

/** Local YYYY-MM-DD key for a timestamp. */
function dayKey(ms: number): string {
	const d = new Date(ms);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

function isCompleted(e: ProductivityStatEvent): boolean {
	return e.status === "completed";
}

/** Completion timestamp (ms) for a terminal task, else null. */
function completedAtMs(e: ProductivityStatEvent): number | null {
	if (e.status !== "completed" && e.status !== "cancelled") return null;
	if (!e.movedAt) return null;
	const t = Date.parse(e.movedAt);
	return Number.isFinite(t) ? t : null;
}

interface Window {
	from: number;
	to: number;
	prevFrom: number | null;
	prevTo: number | null;
}

function rangeWindow(range: StatsRange, nowMs: number, earliestMs: number): Window {
	switch (range) {
		case "day":
			return { from: nowMs - DAY_MS, to: nowMs, prevFrom: nowMs - 2 * DAY_MS, prevTo: nowMs - DAY_MS };
		case "week":
			return { from: nowMs - 7 * DAY_MS, to: nowMs, prevFrom: nowMs - 14 * DAY_MS, prevTo: nowMs - 7 * DAY_MS };
		case "month":
			return { from: nowMs - 30 * DAY_MS, to: nowMs, prevFrom: nowMs - 60 * DAY_MS, prevTo: nowMs - 30 * DAY_MS };
		case "all":
			return { from: earliestMs, to: nowMs, prevFrom: null, prevTo: null };
	}
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Build the time-series buckets for the range, summing completed-count and lines per bucket. */
function buildSeries(
	range: StatsRange,
	win: Window,
	completedEvents: Array<{ at: number; lines: number }>,
): SeriesBucket[] {
	const buckets: SeriesBucket[] = [];

	const push = (startMs: number, label: string) => buckets.push({ startMs, label, completed: 0, lines: 0 });

	if (range === "day") {
		// 24 hourly buckets ending at the current hour.
		const end = new Date(win.to);
		end.setMinutes(0, 0, 0);
		const endHour = end.getTime();
		for (let i = 23; i >= 0; i--) {
			const start = endHour - i * 3_600_000;
			push(start, `${new Date(start).getHours()}`);
		}
		assign(buckets, completedEvents, 3_600_000);
	} else if (range === "week" || range === "month") {
		const days = range === "week" ? 7 : 30;
		const today = new Date(win.to);
		today.setHours(0, 0, 0, 0);
		const startToday = today.getTime();
		for (let i = days - 1; i >= 0; i--) {
			const start = startToday - i * DAY_MS;
			const d = new Date(start);
			push(start, range === "week" ? WEEKDAYS[d.getDay()] : `${d.getDate()}`);
		}
		assignByDay(buckets, completedEvents);
	} else {
		// "all": monthly buckets from the first event month to the current month.
		const first = new Date(win.from);
		const last = new Date(win.to);
		let y = first.getFullYear();
		let m = first.getMonth();
		const endY = last.getFullYear();
		const endM = last.getMonth();
		// Cap at 36 months to keep the chart readable.
		const all: Array<{ start: number; label: string }> = [];
		while (y < endY || (y === endY && m <= endM)) {
			const start = new Date(y, m, 1).getTime();
			all.push({ start, label: MONTHS[m] });
			m++;
			if (m > 11) {
				m = 0;
				y++;
			}
		}
		const trimmed = all.slice(-36);
		for (const b of trimmed) push(b.start, b.label);
		assignByMonth(buckets, completedEvents);
	}

	return buckets;
}

function assign(buckets: SeriesBucket[], events: Array<{ at: number; lines: number }>, bucketMs: number): void {
	if (buckets.length === 0) return;
	const first = buckets[0].startMs;
	const last = buckets[buckets.length - 1].startMs + bucketMs;
	for (const e of events) {
		if (e.at < first || e.at >= last) continue;
		const idx = Math.floor((e.at - first) / bucketMs);
		if (idx >= 0 && idx < buckets.length) {
			buckets[idx].completed += 1;
			buckets[idx].lines += e.lines;
		}
	}
}

function assignByDay(buckets: SeriesBucket[], events: Array<{ at: number; lines: number }>): void {
	const index = new Map<string, SeriesBucket>();
	for (const b of buckets) index.set(dayKey(b.startMs), b);
	for (const e of events) {
		const b = index.get(dayKey(e.at));
		if (b) {
			b.completed += 1;
			b.lines += e.lines;
		}
	}
}

function assignByMonth(buckets: SeriesBucket[], events: Array<{ at: number; lines: number }>): void {
	const monthKey = (ms: number) => {
		const d = new Date(ms);
		return `${d.getFullYear()}-${d.getMonth()}`;
	};
	const index = new Map<string, SeriesBucket>();
	for (const b of buckets) index.set(monthKey(b.startMs), b);
	for (const e of events) {
		const b = index.get(monthKey(e.at));
		if (b) {
			b.completed += 1;
			b.lines += e.lines;
		}
	}
}

/** Longest run + current run (ending today or yesterday) of consecutive days with ≥1 completed task. */
function computeStreaks(completedDayKeys: Set<string>, nowMs: number): { current: number; best: number } {
	if (completedDayKeys.size === 0) return { current: 0, best: 0 };

	// Best streak: scan sorted day timestamps.
	const days = [...completedDayKeys]
		.map((k) => Date.parse(`${k}T00:00:00`))
		.filter((t) => Number.isFinite(t))
		.sort((a, b) => a - b);
	let best = 1;
	let run = 1;
	for (let i = 1; i < days.length; i++) {
		const gap = Math.round((days[i] - days[i - 1]) / DAY_MS);
		if (gap === 1) run += 1;
		else if (gap > 1) run = 1;
		best = Math.max(best, run);
	}

	// Current streak: walk back from today; allow it to "start" yesterday.
	let current = 0;
	let cursor = new Date(nowMs);
	cursor.setHours(0, 0, 0, 0);
	if (!completedDayKeys.has(dayKey(cursor.getTime()))) {
		// No activity today — let the streak count up to yesterday.
		cursor = new Date(cursor.getTime() - DAY_MS);
	}
	while (completedDayKeys.has(dayKey(cursor.getTime()))) {
		current += 1;
		cursor = new Date(cursor.getTime() - DAY_MS);
	}

	return { current, best: Math.max(best, current) };
}

/**
 * Pure aggregation of raw stat events into everything the dashboard renders, for
 * the selected time range. `nowMs` is injected for determinism/testability.
 */
export function computeProductivityStats(
	events: ProductivityStatEvent[],
	range: StatsRange,
	nowMs: number,
): ProductivityDashboardData {
	// Earliest event (creation or completion) — anchors the "all" window.
	let earliest = nowMs;
	for (const e of events) {
		const c = Date.parse(e.createdAt);
		if (Number.isFinite(c)) earliest = Math.min(earliest, c);
		const m = completedAtMs(e);
		if (m != null) earliest = Math.min(earliest, m);
	}

	const win = rangeWindow(range, nowMs, earliest);

	const inPeriod = (at: number | null, from: number, to: number) => at != null && at >= from && at < to;

	// --- Per-period aggregates ---
	let completedCur = 0;
	let completedPrev = 0;
	let linesCur = 0;
	let linesPrev = 0;
	let cancelledCur = 0;
	const projectsTouched = new Set<string>();
	const perProjectMap = new Map<string, PerProjectStat>();
	const completedForSeries: Array<{ at: number; lines: number }> = [];

	// --- All-time aggregates ---
	let allTimeCompleted = 0;
	let agentsRun = 0;
	const allDayKeys = new Set<string>();
	let locTrackingSince: number | null = null;

	for (const e of events) {
		if (e.agentId) agentsRun += 1;
		const at = completedAtMs(e);
		const lines = e.insertions + e.deletions;
		// LOC tracking "started" at the earliest completed task that has real diff
		// data (lines > 0) — used to show an honest "tracking since" hint.
		if (isCompleted(e) && lines > 0 && at != null) {
			if (locTrackingSince == null || at < locTrackingSince) locTrackingSince = at;
		}

		if (isCompleted(e) && at != null) {
			allTimeCompleted += 1;
			allDayKeys.add(dayKey(at));
			completedForSeries.push({ at, lines });

			if (inPeriod(at, win.from, win.to)) {
				completedCur += 1;
				linesCur += lines;
				projectsTouched.add(e.projectId);
				const pp = perProjectMap.get(e.projectId) ?? {
					projectId: e.projectId,
					name: e.projectName,
					kind: e.projectKind,
					completed: 0,
					lines: 0,
					sharePct: 0,
					busiest: false,
				};
				pp.completed += 1;
				pp.lines += lines;
				perProjectMap.set(e.projectId, pp);
			}
			if (win.prevFrom != null && win.prevTo != null && inPeriod(at, win.prevFrom, win.prevTo)) {
				completedPrev += 1;
				linesPrev += lines;
			}
		}
		if (e.status === "cancelled" && at != null && inPeriod(at, win.from, win.to)) {
			cancelledCur += 1;
		}
	}

	// --- Series ---
	const seriesEvents = range === "all" ? completedForSeries : completedForSeries.filter((e) => inPeriod(e.at, win.from, win.to));
	const series = buildSeries(range, win, seriesEvents);

	// --- Per-project share + busiest ---
	const perProject = [...perProjectMap.values()].sort((a, b) => b.completed - a.completed || b.lines - a.lines);
	for (const pp of perProject) pp.sharePct = completedCur > 0 ? Math.round((pp.completed / completedCur) * 100) : 0;
	if (perProject.length > 0 && perProject[0].completed > 0) perProject[0].busiest = true;

	// --- Streaks ---
	const streaks = computeStreaks(allDayKeys, nowMs);

	// --- Velocity (tasks/day over the period) ---
	const periodDays = Math.max(1, (win.to - win.from) / DAY_MS);
	const velocityCur = completedCur / periodDays;
	const prevDays = win.prevFrom != null && win.prevTo != null ? Math.max(1, (win.prevTo - win.prevFrom) / DAY_MS) : null;
	const velocityPrev = prevDays != null ? completedPrev / prevDays : null;

	// --- Completion rate (period) ---
	const ratedTotal = completedCur + cancelledCur;
	const completionRate = ratedTotal > 0 ? Math.round((completedCur / ratedTotal) * 100) : 0;

	const tasksTotal = events.length;

	const hero: ProductivityDashboardData["hero"] = {
		tasksShipped: {
			value: completedCur,
			previous: win.prevFrom != null ? completedPrev : null,
			max: niceCeil(Math.max(completedCur, completedPrev) * 1.25, 4),
			trendPct: trendPct(completedCur, win.prevFrom != null ? completedPrev : null),
		},
		linesChanged: {
			value: linesCur,
			previous: win.prevFrom != null ? linesPrev : null,
			max: niceCeil(Math.max(linesCur, linesPrev) * 1.25, 100),
			trendPct: trendPct(linesCur, win.prevFrom != null ? linesPrev : null),
		},
		velocity: {
			value: Math.round(velocityCur * 10) / 10,
			previous: velocityPrev != null ? Math.round(velocityPrev * 10) / 10 : null,
			max: niceCeil(Math.max(velocityCur, velocityPrev ?? 0) * 1.25, 2),
			trendPct: trendPct(velocityCur, velocityPrev),
		},
		completionRate: {
			value: completionRate,
			previous: null,
			max: 100,
			trendPct: null,
		},
		streak: {
			value: streaks.current,
			previous: null,
			max: Math.max(streaks.best, 7),
			trendPct: null,
		},
	};

	return {
		range,
		periodFrom: win.from,
		periodTo: win.to,
		hasAnyData: events.length > 0,
		locTrackingSince: locTrackingSince != null ? dayKey(locTrackingSince) : null,
		hero,
		counters: {
			tasksTotal,
			projectsTouched: projectsTouched.size,
			agentsRun,
			allTimeCompleted,
			bestStreak: streaks.best,
		},
		series,
		perProject,
	};
}
