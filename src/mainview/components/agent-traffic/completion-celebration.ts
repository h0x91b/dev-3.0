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

/**
 * How long one celebration stays on the card, particles or not.
 *
 * Three seconds is the whole show: two confetti waves, three small fireworks
 * staggered behind them, then a short fade so the overlay leaves instead of
 * being cut. Every generator below is sized against this number — the last
 * particle must finish before the fade starts, or it disappears mid-flight.
 */
export const CELEBRATION_MS = 3000;

/** When the overlay starts fading out, leaving {@link CELEBRATION_MS} clean. */
export const CELEBRATION_FADE_MS = 320;

/**
 * How fresh a live completion must be to be celebrated. A board reload hands us
 * the whole movement log at once; without a window, opening the screen would
 * fire confetti for every task completed this week.
 */
export const LIVE_WINDOW_MS = 30_000;

/** Floor between two camera moves, so a burst of completions cannot thrash. */
export const CAMERA_COOLDOWN_MS = 1200;

/**
 * Which anchor the printed duration is measured FROM. Two different facts, and
 * they are never presented in the same words.
 *
 * Both are **elapsed wall clock**, never active labour: nothing on disk records
 * how long an agent actually worked, so neither value may be worded as if it
 * did. The copy names the anchor for exactly this reason.
 */
export type CompletionDurationBasis = "work-start" | "created";

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

/** A terminal move closes a delivery cycle; the next movement opens a new one. */
function closesCycle(movement: TaskMovement): boolean {
	return movement.to === "completed" || movement.to === "cancelled";
}

/**
 * Elapsed wall clock for one completion, strictly from the movement log.
 *
 * The window is **the delivery cycle this completion ends** — everything after
 * the previous terminal move. Inside it the anchor is the **first** recorded
 * `in-progress`, not the nearest one: a task that bounces review → in-progress
 * three times before landing did not start work on the third bounce, and
 * measuring from there would quietly shrink every hard task's number.
 *
 * `lifecycleStartedAt` would be easier and is deliberately not used: it is live
 * state that a reopen resets, so replaying an older completion would print a
 * later cycle's clock against it.
 *
 * - first `in-progress` of the cycle → `work-start`;
 * - no work start, and the cycle is the task's first (its own `created` entry
 *   opens it) → `created`, a different claim, labelled as one;
 * - anything else → `null`. That includes a reopened task with no recorded work
 *   start: `created` sits in an EARLIER cycle, and reaching across the previous
 *   completion would measure a span nobody worked. An unprovable duration is
 *   omitted, never estimated.
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

	let cycleStart = 0;
	for (let i = end - 1; i >= 0; i--) {
		if (closesCycle(ordered[i])) {
			cycleStart = i + 1;
			break;
		}
	}
	for (let i = cycleStart; i < end; i++) {
		if (ordered[i].to !== "in-progress") continue;
		const started = parse(ordered[i].at);
		if (!Number.isFinite(started) || started > finished) return null;
		return { ms: finished - started, basis: "work-start" };
	}
	// Only the task's own birth may stand in, and only when it opens THIS cycle.
	const first = ordered[cycleStart];
	if (cycleStart !== 0 || !first || first.kind !== "created") return null;
	const born = parse(first.at);
	if (!Number.isFinite(born) || born > finished) return null;
	return { ms: finished - born, basis: "created" };
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

/** One confetti flight, so a piece never outlives the fade. */
export const PIECE_FLIGHT_MS = 1200;

/** Gap between the two confetti waves. The second re-lights a dying burst. */
export const PIECE_WAVE_GAP_MS = 760;

/** One firework: the sparks all fly within this. */
export const FIREWORK_FLIGHT_MS = 760;

/**
 * When each firework goes off, measured from the start of the celebration.
 *
 * The last one is timed to land right before the fade: with nothing after ~2.4s
 * the final half-second read as the show being over early, badge and ring alone.
 */
export const FIREWORK_DELAYS_MS = [380, 1040, 1580, 1900] as const;

function seededRandom(key: string): () => number {
	let hash = positionSeed(key);
	return () => {
		hash = (hash * 1664525 + 1013904223) >>> 0;
		return hash / 0x1_0000_0000;
	};
}

/**
 * A stable spread for the burst, so the same completion draws the same shape on
 * every render. `Math.random()` here would reshuffle every piece on each React
 * pass and turn a bounded burst into a jitter.
 *
 * Two waves, not one long one: a single burst stretched over three seconds
 * reads as slow motion, while a second wave landing while the first is still
 * falling reads as a celebration that keeps going. Even indices fly in wave
 * one, odd in wave two, so each wave is a full fan rather than half a fan.
 */
export function burstPieces(
	key: string,
	count = 18,
): { angle: number; distance: number; spin: number; delay: number }[] {
	const next = seededRandom(key);
	return Array.from({ length: count }, (_, index) => {
		const wave = index % 2;
		const slot = Math.floor(index / 2);
		const perWave = Math.ceil(count / 2);
		return {
			// Fan upwards and outwards, one piece per slice so nothing clumps.
			angle: -160 + (slot + next() * 0.8) * (140 / perWave),
			distance: 46 + next() * 62,
			spin: -260 + next() * 520,
			// better-ui's stagger inside a wave, plus the wave's own offset.
			delay:
				wave * PIECE_WAVE_GAP_MS +
				Math.round(slot * (110 / perWave) * 10) / 10,
		};
	});
}

export interface FireworkBurst {
	/** Fraction of the card box, so a burst follows the card it belongs to. */
	x: number;
	y: number;
	delay: number;
	sparks: { angle: number; distance: number }[];
}

/**
 * Small radial bursts around the card, staggered behind the confetti.
 *
 * Deliberately small and off to the sides: the badge owns the top centre and
 * the card owns its own title, so a burst is placed in the margin around them
 * and never over readable text. Seeded from the same key as the confetti, so a
 * replayed completion draws the identical show.
 */
export function fireworkBursts(key: string, sparks = 9): FireworkBurst[] {
	const next = seededRandom(`${key}:fireworks`);
	// Left and right shoulders, then one high above — never the top centre,
	// where the badge sits.
	const spots = [
		{ x: 0.1, y: 0.16 },
		{ x: 0.9, y: 0.08 },
		{ x: 0.46, y: -0.26 },
		{ x: 0.82, y: -0.2 },
	];
	return spots.map((spot, index) => ({
		x: spot.x + (next() - 0.5) * 0.08,
		y: spot.y + (next() - 0.5) * 0.08,
		delay: FIREWORK_DELAYS_MS[index],
		sparks: Array.from({ length: sparks }, (_, spark) => ({
			// A full ring, jittered so it reads as a burst and not as a gear.
			angle: (spark + next() * 0.6) * (360 / sparks),
			distance: 22 + next() * 26,
		})),
	}));
}
