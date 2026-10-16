import { AGENT_TIME_STATUSES, FOCUS_HOUR_MS, type ProductivityStatEvent, type TaskStatus } from "../../shared/types";

/**
 * Period-clipped time accounting for the Productivity "Time invested" cards.
 * Everything here is reconstructed from timestamps that really exist on disk —
 * board movements, `statusEnteredAt`, `lifecycleStartedAt`, per-hour focus —
 * and clipped to the reporting window. Spans no timestamp covers are reported
 * as gaps, never estimated. See decisions/2026/10/16/period-clipped-time-invested.md.
 */

/** `launched` = in flight after the first launch, exact status unknown (task predates movement logging). */
export type SegmentState = TaskStatus | "launched";

export interface StatusSegment {
	state: SegmentState;
	start: number;
	end: number;
}

export interface TaskTimeline {
	/** Spans whose state is known, ascending, non-overlapping. */
	segments: StatusSegment[];
	/** Creation → close (or now): the span the task existed as an open card. */
	lifeStart: number;
	lifeEnd: number;
}

const TERMINAL = new Set<TaskStatus>(["completed", "cancelled"]);
const AGENT = new Set<SegmentState>(AGENT_TIME_STATUSES);
/** Clock drift between a write's `at` and the `statusEnteredAt` it stamps is milliseconds; this is slack, not tuning. */
const SAME_MOMENT_MS = 5_000;

function parseMs(iso: string | null | undefined): number | null {
	if (!iso) return null;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : null;
}

function isInFlight(state: SegmentState): boolean {
	return state !== "todo" && !TERMINAL.has(state as TaskStatus);
}

function push(segments: StatusSegment[], state: SegmentState, start: number, end: number): void {
	if (end > start) segments.push({ state, start, end });
}

/**
 * The known status spans of one task. With a movement log the spans are exact
 * from the first kept movement on; a move made by an older build that did not
 * log it leaves a gap up to `statusEnteredAt`. Without a log only the current
 * status (since `statusEnteredAt`) and the last delivery cycle
 * (`lifecycleStartedAt` → then, status unknown) are known.
 */
export function reconstructTimeline(e: ProductivityStatEvent, nowMs: number): TaskTimeline | null {
	const created = parseMs(e.createdAt);
	if (created == null) return null;
	const isTerminal = TERMINAL.has(e.status);
	const lifeEnd = Math.min(nowMs, isTerminal ? (parseMs(e.movedAt) ?? created) : nowMs);
	const enteredAt = parseMs(e.statusEnteredAt);
	const segments: StatusSegment[] = [];

	const moves = e.movements
		.map((m) => ({ at: parseMs(m.at), to: m.to }))
		.filter((m): m is { at: number; to: TaskStatus } => m.at != null)
		.sort((a, b) => a.at - b.at);

	if (moves.length > 0) {
		const last = moves[moves.length - 1];
		const tailIsLogged = last.to === e.status && (enteredAt == null || enteredAt <= last.at + SAME_MOMENT_MS);
		for (let i = 0; i < moves.length - 1; i++) push(segments, moves[i].to, moves[i].at, moves[i + 1].at);
		if (tailIsLogged) {
			push(segments, last.to, last.at, nowMs);
		} else if (enteredAt != null && enteredAt > last.at) {
			push(segments, e.status, enteredAt, nowMs);
		}
	} else {
		const launchedAt = parseMs(e.lifecycleStartedAt);
		const currentFrom = enteredAt ?? (isTerminal ? lifeEnd : null);
		if (launchedAt != null && currentFrom != null && launchedAt < currentFrom) {
			push(segments, "launched", launchedAt, currentFrom);
		}
		if (enteredAt != null) push(segments, e.status, enteredAt, nowMs);
	}

	return { segments, lifeStart: created, lifeEnd };
}

function overlap(start: number, end: number, from: number, to: number): number {
	return Math.max(0, Math.min(end, to) - Math.max(start, from));
}

/** Total length of a set of intervals with overlaps merged — wall-clock, not task-hours. */
export function unionMs(intervals: Array<[number, number]>): number {
	const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
	let total = 0;
	let curStart = -Infinity;
	let curEnd = -Infinity;
	for (const [s, e] of sorted) {
		if (s > curEnd) {
			if (curEnd > curStart) total += curEnd - curStart;
			curStart = s;
			curEnd = e;
		} else if (e > curEnd) {
			curEnd = e;
		}
	}
	if (curEnd > curStart) total += curEnd - curStart;
	return total;
}

export interface PeriodTimeTotals {
	/** Σ over tasks of wall-clock spent launched and not yet closed (task-hours; parallel tasks add up). */
	inFlightMs: number;
	/** Σ over tasks of wall-clock in an agent column (In Progress + AI Review). */
	agentMs: number;
	focusMs: number;
}

export interface PeriodTime extends PeriodTimeTotals {
	/** Wall-clock during which at least one task sat in an agent column (overlaps merged). */
	agentWallMs: number;
	/** Tasks with any in-flight time inside the window. */
	activeTasks: number;
	/** Tasks alive in the window with a stretch no recorded timestamp covers. */
	gapTasks: number;
	/** Tasks alive in the window holding focus with no recorded hour (only counted in "all"). */
	untimedFocusTasks: number;
	/** Hibernated tasks whose agent-column time falls in the window (their agent was not running). */
	hibernatedAgentTasks: number;
	/** Start (ms) of the earliest recorded focus hour across all tasks, or null. */
	focusSinceMs: number | null;
	perProject: Map<string, PeriodTimeTotals>;
}

/** A gap shorter than this is write latency between two stamps, not missing history. */
const GAP_TOLERANCE_MS = 60_000;

/**
 * Clip every task's recoverable time to [from, to) (and to `nowMs`). Focus
 * comes from per-hour buckets, attributed by the bucket's start hour, so a
 * window edge can shift up to one hour of focus. `lifetimeFocus` (range "all")
 * sums the whole `focusMs` counter instead — the only window it is exact for.
 */
export function computePeriodTime(
	events: ProductivityStatEvent[],
	from: number,
	to: number,
	nowMs: number,
	lifetimeFocus = false,
): PeriodTime {
	const end = Math.min(to, nowMs);
	const result: PeriodTime = {
		inFlightMs: 0,
		agentMs: 0,
		focusMs: 0,
		agentWallMs: 0,
		activeTasks: 0,
		gapTasks: 0,
		untimedFocusTasks: 0,
		hibernatedAgentTasks: 0,
		focusSinceMs: null,
		perProject: new Map(),
	};
	const agentIntervals: Array<[number, number]> = [];

	for (const e of events) {
		let bucketedFocus = 0;
		let focusInWindow = 0;
		for (const [key, ms] of Object.entries(e.focusByHour)) {
			const hourStart = Number(key) * FOCUS_HOUR_MS;
			if (!Number.isFinite(hourStart) || !(ms > 0)) continue;
			bucketedFocus += ms;
			if (result.focusSinceMs == null || hourStart < result.focusSinceMs) result.focusSinceMs = hourStart;
			if (hourStart >= from && hourStart < end) focusInWindow += ms;
		}
		const untimedFocus = Math.max(0, e.focusMs - bucketedFocus);
		const focus = lifetimeFocus ? e.focusMs : focusInWindow;

		const timeline = reconstructTimeline(e, nowMs);
		let inFlight = 0;
		let agent = 0;
		let aliveInWindow = 0;
		if (timeline) {
			aliveInWindow = overlap(timeline.lifeStart, timeline.lifeEnd, from, end);
			let known = 0;
			for (const seg of timeline.segments) {
				const ms = overlap(seg.start, seg.end, from, end);
				if (ms === 0) continue;
				known += overlap(seg.start, Math.min(seg.end, timeline.lifeEnd), from, end);
				if (isInFlight(seg.state)) inFlight += ms;
				if (AGENT.has(seg.state)) {
					agent += ms;
					agentIntervals.push([Math.max(seg.start, from), Math.min(seg.end, end)]);
				}
			}
			if (aliveInWindow - known > GAP_TOLERANCE_MS) result.gapTasks += 1;
		}
		if (!lifetimeFocus && untimedFocus > 0 && aliveInWindow > 0) result.untimedFocusTasks += 1;
		if (e.hibernated && agent > 0) result.hibernatedAgentTasks += 1;
		if (inFlight > 0) result.activeTasks += 1;

		result.inFlightMs += inFlight;
		result.agentMs += agent;
		result.focusMs += focus;
		if (inFlight + agent + focus > 0) {
			const pp = result.perProject.get(e.projectId) ?? { inFlightMs: 0, agentMs: 0, focusMs: 0 };
			pp.inFlightMs += inFlight;
			pp.agentMs += agent;
			pp.focusMs += focus;
			result.perProject.set(e.projectId, pp);
		}
	}

	result.agentWallMs = unionMs(agentIntervals);
	return result;
}
