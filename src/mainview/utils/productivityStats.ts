import { DEFAULT_AGENTS, type ProductivityStatEvent } from "../../shared/types";

export type StatsRange = "day" | "week" | "month" | "all";

export const STATS_RANGES: readonly StatsRange[] = ["day", "week", "month", "all"] as const;

export interface HeroMetric {
	/** Current-period value. */
	value: number;
	/** Gauge max for scaling the needle. */
	max: number;
	/**
	 * Value below which the gauge paints its red zone — the user's typical output
	 * for an equivalent period (rolling lifetime average). Beating it means you're
	 * above your norm. Null when not meaningful (range "all", or no history).
	 */
	redZone: number | null;
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

export interface PerAgentStat {
	/** Raw agent id (e.g. "builtin-claude") or "unknown" when a task had none. */
	agentId: string;
	/** Human-friendly name (e.g. "Claude"). */
	name: string;
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
	perAgent: PerAgentStat[];
}

const DAY_MS = 86_400_000;

/** agentId → display name, from the builtin registry (custom ids fall back to a prettified slug). */
const AGENT_NAMES = new Map(DEFAULT_AGENTS.map((a) => [a.id, a.name]));

function agentDisplayName(agentId: string): string {
	const known = AGENT_NAMES.get(agentId);
	if (known) return known;
	if (agentId === "unknown") return "Unknown";
	// Prettify a custom id: "builtin-foo" / "my-agent" → "Foo" / "My agent".
	const slug = agentId.replace(/^builtin-/, "").replace(/[-_]+/g, " ").trim();
	return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : agentId;
}

/**
 * A "nice" gauge maximum sitting comfortably above `value` (~10% headroom so the
 * needle never pegs at full), rounded up to a 1/2/5×10ⁿ step chosen for roughly
 * ten divisions. Steps are kept ≥1 so count gauges show whole-number ticks.
 * Never below `floor`.
 */
export function gaugeMax(value: number, floor = 1): number {
	const v = Math.max(value * 1.1, floor, 1);
	const rough = v / 10;
	let magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
	if (!Number.isFinite(magnitude) || magnitude <= 0) magnitude = 1;
	const norm = rough / magnitude;
	const step = Math.max(
		norm <= 1 ? magnitude : norm <= 2 ? 2 * magnitude : norm <= 5 ? 5 * magnitude : 10 * magnitude,
		1,
	);
	return Math.max(Math.ceil(v / step) * step, floor);
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
	const perAgentMap = new Map<string, PerAgentStat>();
	const completedForSeries: Array<{ at: number; lines: number }> = [];

	// --- All-time aggregates ---
	let allTimeCompleted = 0;
	let allTimeLines = 0;
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
			allTimeLines += lines;
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

				const agentId = e.agentId || "unknown";
				const pa = perAgentMap.get(agentId) ?? {
					agentId,
					name: agentDisplayName(agentId),
					completed: 0,
					lines: 0,
					sharePct: 0,
					busiest: false,
				};
				pa.completed += 1;
				pa.lines += lines;
				perAgentMap.set(agentId, pa);
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

	// --- Per-agent share + busiest ---
	const perAgent = [...perAgentMap.values()].sort((a, b) => b.completed - a.completed || b.lines - a.lines);
	for (const pa of perAgent) pa.sharePct = completedCur > 0 ? Math.round((pa.completed / completedCur) * 100) : 0;
	if (perAgent.length > 0 && perAgent[0].completed > 0) perAgent[0].busiest = true;

	// --- Streaks ---
	const streaks = computeStreaks(allDayKeys, nowMs);

	// --- Velocity (tasks/day over the period) ---
	const periodDays = Math.max(1, (win.to - win.from) / DAY_MS);
	const velocityCur = completedCur / periodDays;
	const prevDays = win.prevFrom != null && win.prevTo != null ? Math.max(1, (win.prevTo - win.prevFrom) / DAY_MS) : null;
	const velocityPrev = prevDays != null ? completedPrev / prevDays : null;

	// --- Rolling lifetime averages (the gauge red zone = "your usual output") ---
	// avgFactor scales an all-time total down to one equivalent period. Clamped to
	// ≤1 so a short history (span < period) can't project an unreachable baseline.
	const totalSpanMs = Math.max(DAY_MS, nowMs - earliest);
	const avgFactor = range === "all" ? null : Math.min(1, (win.to - win.from) / totalSpanMs);
	const avgCompleted = avgFactor != null ? allTimeCompleted * avgFactor : null;
	const avgLines = avgFactor != null ? allTimeLines * avgFactor : null;
	const avgVelocity = range === "all" ? null : allTimeCompleted / (totalSpanMs / DAY_MS);

	// --- Completion rate (period) ---
	const ratedTotal = completedCur + cancelledCur;
	const completionRate = ratedTotal > 0 ? Math.round((completedCur / ratedTotal) * 100) : 0;

	const tasksTotal = events.length;

	const roundOrNull = (n: number | null) => (n == null ? null : Math.round(n));
	const round1OrNull = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

	const hero: ProductivityDashboardData["hero"] = {
		tasksShipped: {
			value: completedCur,
			previous: win.prevFrom != null ? completedPrev : null,
			redZone: roundOrNull(avgCompleted),
			max: gaugeMax(Math.max(completedCur, completedPrev, avgCompleted ?? 0), 4),
			trendPct: trendPct(completedCur, win.prevFrom != null ? completedPrev : null),
		},
		linesChanged: {
			value: linesCur,
			previous: win.prevFrom != null ? linesPrev : null,
			redZone: roundOrNull(avgLines),
			max: gaugeMax(Math.max(linesCur, linesPrev, avgLines ?? 0), 100),
			trendPct: trendPct(linesCur, win.prevFrom != null ? linesPrev : null),
		},
		velocity: {
			value: Math.round(velocityCur * 10) / 10,
			previous: velocityPrev != null ? Math.round(velocityPrev * 10) / 10 : null,
			redZone: round1OrNull(avgVelocity),
			max: gaugeMax(Math.max(velocityCur, velocityPrev ?? 0, avgVelocity ?? 0), 2),
			trendPct: trendPct(velocityCur, velocityPrev),
		},
		completionRate: {
			value: completionRate,
			previous: null,
			redZone: 40,
			max: 100,
			trendPct: null,
		},
		streak: {
			value: streaks.current,
			previous: null,
			redZone: null,
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
		perAgent,
	};
}
