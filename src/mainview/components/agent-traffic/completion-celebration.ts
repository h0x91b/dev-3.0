/**
 * When a card earns confetti, and what number may be printed on it.
 *
 * The only thing that counts as a completion here is a recorded
 * `TaskMovement` with `to === "completed"`. Not a button click, not a status
 * read, not terminal output: `src/bun/data.ts` funnels every rendered-column
 * change through one writer, so a manual completion and an agent-approved one
 * produce the same movement and there is no second path to special-case.
 *
 * Everything in this file is pure. The React side owns timers and the camera;
 * what may be claimed — and what must stay unsaid — is decided here so it can
 * be tested without a DOM.
 */

import type { Task, TaskMovement } from "../../../shared/types";
import { positionSeed, type TrafficNode } from "./traffic-model";
import type { TrafficTimelineEvent } from "./traffic-timeline";

/** How long one celebration stays on the card, particles or not. */
export const CELEBRATION_MS = 2400;

/**
 * How fresh a live completion must be to be celebrated. A board reload hands us
 * the whole movement log at once; without a window, opening the screen would
 * fire confetti for every task completed this week.
 */
export const LIVE_WINDOW_MS = 30_000;

/** Floor between two camera moves, so a burst of completions cannot thrash. */
export const CAMERA_COOLDOWN_MS = 1200;

/**
 * Which clock the printed duration is measuring. Two different facts, and they
 * are never presented in the same words — nor as anything resembling how long
 * an agent "worked", which nothing on disk records.
 */
export type CompletionDurationBasis = "worked" | "age";

export interface CompletionDuration {
	/** Wall-clock milliseconds. */
	ms: number;
	basis: CompletionDurationBasis;
}

export interface CompletionCelebration {
	/** The movement id — the dedup key. One movement is celebrated once. */
	key: string;
	nodeKey: string;
	seq: number | null;
	title: string;
	/** Epoch ms of the completion movement. */
	at: number;
	/** Null when the log cannot prove either clock. No number is invented. */
	duration: CompletionDuration | null;
}

function parse(at: string): number {
	const value = Date.parse(at);
	return Number.isFinite(value) ? value : Number.NaN;
}

/**
 * How long the task took, strictly from the movement log.
 *
 * Walks backwards from the completion for the move that started the current
 * delivery cycle. `lifecycleStartedAt` would be easier and is deliberately not
 * used: it is live state that a reopen resets, so replaying an old completion
 * would print a later cycle's clock against it.
 *
 * - a preceding `in-progress` move → `worked`, the current cycle's wall clock;
 * - otherwise the task's own `created` entry → `age`, which is a different
 *   claim and is labelled as one;
 * - neither (log truncated by the 50-cap, or absent) → `null`. An unprovable
 *   duration is omitted, never estimated.
 */
export function completionDuration(
	movements: readonly TaskMovement[] | undefined,
	completionId: string,
): CompletionDuration | null {
	if (!movements?.length) return null;
	const ordered = [...movements].sort((a, b) => parse(a.at) - parse(b.at));
	const end = ordered.findIndex((movement) => movement.id === completionId);
	if (end < 0) return null;
	const finished = parse(ordered[end].at);
	if (!Number.isFinite(finished)) return null;

	for (let i = end - 1; i >= 0; i--) {
		if (ordered[i].to !== "in-progress") continue;
		const started = parse(ordered[i].at);
		if (!Number.isFinite(started) || started > finished) return null;
		return { ms: finished - started, basis: "worked" };
	}
	const first = ordered[0];
	if (first.kind !== "created") return null;
	const born = parse(first.at);
	if (!Number.isFinite(born) || born > finished) return null;
	return { ms: finished - born, basis: "age" };
}

function celebration(
	node: Pick<TrafficNode, "key" | "seq" | "title">,
	task: Task | undefined,
	movement: TaskMovement,
	at: number,
): CompletionCelebration {
	return {
		key: movement.id,
		nodeKey: node.key,
		seq: node.seq,
		title: node.title,
		at,
		duration: completionDuration(task?.movements, movement.id),
	};
}

/**
 * Completions that just happened, for the live stage.
 *
 * `seen` is mutated: the caller seeds it on the first pass so that opening the
 * screen on a board full of finished tasks is silent, and a remount replays
 * nothing. Same idiom the message flights already use.
 */
export function liveCompletions(
	nodes: readonly TrafficNode[],
	seen: Set<string>,
	now: number,
	seeding: boolean,
): CompletionCelebration[] {
	const found: CompletionCelebration[] = [];
	for (const node of nodes) {
		for (const movement of node.task?.movements ?? []) {
			if (seen.has(movement.id)) continue;
			seen.add(movement.id);
			if (seeding || movement.to !== "completed") continue;
			const at = parse(movement.at);
			if (!Number.isFinite(at) || now - at > LIVE_WINDOW_MS || at > now) continue;
			found.push(celebration(node, node.task, movement, at));
		}
	}
	return found;
}

/**
 * The completion the replay cursor is standing on, if it is standing on one.
 *
 * Forward-only crossing is the caller's job (it owns the previous index):
 * scrubbing backwards over a completion is silent, and re-crossing it forward
 * celebrates again, because a re-watch is a new crossing.
 */
export function replayCompletion(
	event: TrafficTimelineEvent | null | undefined,
	nodes: readonly TrafficNode[],
): CompletionCelebration | null {
	if (!event || event.kind !== "task" || event.movement.to !== "completed")
		return null;
	const node = nodes.find((candidate) => candidate.key === event.nodeKey);
	if (!node) return null;
	return celebration(
		{ key: event.nodeKey, seq: event.seq, title: event.title },
		node.task,
		event.movement,
		event.at,
	);
}

/**
 * A stable spread for the burst, so the same completion draws the same shape on
 * every render. `Math.random()` here would reshuffle every piece on each React
 * pass and turn a bounded burst into a jitter.
 */
export function burstPieces(
	key: string,
	count = 12,
): { angle: number; distance: number; spin: number; delay: number }[] {
	let hash = positionSeed(key);
	const next = () => {
		hash = (hash * 1664525 + 1013904223) >>> 0;
		return hash / 0x1_0000_0000;
	};
	return Array.from({ length: count }, (_, index) => ({
		// Fan upwards and outwards, one piece per slice so nothing clumps.
		angle: -160 + (index + next() * 0.8) * (140 / count),
		distance: 42 + next() * 46,
		spin: -220 + next() * 440,
		// better-ui's stagger, scaled to the piece count.
		delay: Math.round(index * (100 / count) * 10) / 10,
	}));
}
