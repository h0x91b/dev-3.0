/**
 * Deterministic byte and frame generators for the native-terminal load/budget
 * harness. Every generator is a pure function of a seeded Rng, so a given seed
 * reproduces the exact same PTY-output shape — the precondition for pinned
 * budget numbers.
 *
 * A "frame" mirrors what the parser pipeline ingests: an output chunk or a
 * resize marker, in stream order. Bytes are printable ASCII so a real parser
 * could interpret them, but the harness only counts them.
 */

import { randomInt, type Rng } from "./prng";

export type HarnessFrame =
	| { kind: "output"; bytes: Uint8Array }
	| { kind: "resize"; cols: number; rows: number };

/** A device-status-report query — the pipeline answers each with exactly one reply. */
export const DSR_QUERY = new TextEncoder().encode("\x1b[6n");

/** Fill a chunk with deterministic printable ASCII (0x20–0x7d). */
export function steadyChunk(rng: Rng, size: number): Uint8Array {
	const chunk = new Uint8Array(size);
	for (let i = 0; i < size; i++) chunk[i] = 0x20 + Math.floor(rng() * 0x5e);
	return chunk;
}

/** N equal-sized output frames — models sustained line-oriented output. */
export function steadyFrames(rng: Rng, opts: { frames: number; bytesPerFrame: number }): HarnessFrame[] {
	const frames: HarnessFrame[] = [];
	for (let i = 0; i < opts.frames; i++) frames.push({ kind: "output", bytes: steadyChunk(rng, opts.bytesPerFrame) });
	return frames;
}

/**
 * Alternating quiet spans and large bursts — models a TUI repaint or a `cat` of
 * a big file punctuating otherwise calm output. Bursts drive the queue
 * high-water mark; the quiet spans let a drain catch back up.
 */
export function burstFrames(
	rng: Rng,
	opts: { cycles: number; quietFrames: number; quietBytes: number; burstFrames: number; burstBytes: number },
): HarnessFrame[] {
	const frames: HarnessFrame[] = [];
	for (let c = 0; c < opts.cycles; c++) {
		for (let i = 0; i < opts.quietFrames; i++) frames.push({ kind: "output", bytes: steadyChunk(rng, opts.quietBytes) });
		for (let i = 0; i < opts.burstFrames; i++) frames.push({ kind: "output", bytes: steadyChunk(rng, opts.burstBytes) });
	}
	return frames;
}

/** A resize marker at a deterministic-but-varied geometry. */
export function resizeFrame(rng: Rng): HarnessFrame {
	return { kind: "resize", cols: randomInt(rng, 40, 200), rows: randomInt(rng, 10, 60) };
}

/** Total output bytes across a frame list — the expected `bytes` budget. */
export function totalOutputBytes(frames: HarnessFrame[]): number {
	let total = 0;
	for (const frame of frames) if (frame.kind === "output") total += frame.bytes.length;
	return total;
}

/** Output-frame count across a frame list — the expected `frames` budget. */
export function totalOutputFrames(frames: HarnessFrame[]): number {
	let count = 0;
	for (const frame of frames) if (frame.kind === "output") count++;
	return count;
}
