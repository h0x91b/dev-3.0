/**
 * Resync modelling for the native-terminal load/budget harness, built on the
 * real journal primitives (encodeJournalFrame / pushFrameCapped / parseJournal).
 *
 * The registry's per-session journal is a byte-capped rolling tail: when a
 * client stalls long enough, the oldest frames roll off before it reattaches.
 * The reattaching client then observes a SEQUENCE GAP between the last frame it
 * saw and the earliest frame still retained, and must resync forward from that
 * earliest retained frame rather than replaying a hole. This module reproduces
 * that entirely in memory (no disk, no socket) so a gap-then-resync is a pinned,
 * deterministic measurement.
 */

import { encodeJournalFrame, parseJournal, pushFrameCapped } from "../journal";

/** Fixed epoch so journal timestamps are deterministic without touching the clock. */
const JOURNAL_EPOCH_MS = 1_753_000_000_000;

export function journalIsoAt(seq: number): string {
	return new Date(JOURNAL_EPOCH_MS + seq * 1000).toISOString();
}

export interface RollingJournal {
	frames: string[];
	bytes: number;
}

export function emptyJournal(): RollingJournal {
	return { frames: [], bytes: 0 };
}

/** Record one frame into the rolling tail, dropping the oldest to stay under `maxBytes`. */
export function recordJournalFrame(
	journal: RollingJournal,
	seq: number,
	data: Uint8Array,
	maxBytes: number,
): RollingJournal {
	const line = encodeJournalFrame(seq, journalIsoAt(seq), data);
	return pushFrameCapped(journal.frames, journal.bytes, line, maxBytes);
}

export interface ResyncPlan {
	/** Highest seq the stalled observer had processed before it detached. */
	observerWatermark: number;
	/** Earliest seq still in the journal tail, or null when the tail is empty. */
	firstRetainedSeq: number | null;
	/** Latest seq in the journal tail, or null when the tail is empty. */
	lastRetainedSeq: number | null;
	/** Frames lost to the roll between the watermark and the retained tail. */
	gap: number;
	/** Seq the resynced observer resumes from (one past its watermark, or the tail head). */
	resumeSeq: number | null;
	/** Frames the observer replays to catch up. */
	replayedFrames: number;
	retainedBytes: number;
}

/**
 * Compute how a client with `observerWatermark` resyncs against the current
 * journal tail. `gap` is the count of frames that rolled off between what the
 * client last saw and what the journal can still replay; it is zero when the
 * tail still covers the watermark contiguously.
 */
export function planResync(journal: RollingJournal, observerWatermark: number): ResyncPlan {
	const parsed = parseJournal(journal.frames.join(""));
	if (parsed.length === 0) {
		return {
			observerWatermark,
			firstRetainedSeq: null,
			lastRetainedSeq: null,
			gap: 0,
			resumeSeq: null,
			replayedFrames: 0,
			retainedBytes: journal.bytes,
		};
	}
	const firstRetainedSeq = parsed[0].seq;
	const lastRetainedSeq = parsed[parsed.length - 1].seq;
	const gap = Math.max(0, firstRetainedSeq - (observerWatermark + 1));
	const resumeSeq = Math.max(observerWatermark + 1, firstRetainedSeq);
	const replayedFrames = parsed.filter((frame) => frame.seq >= resumeSeq).length;
	return {
		observerWatermark,
		firstRetainedSeq,
		lastRetainedSeq,
		gap,
		resumeSeq,
		replayedFrames,
		retainedBytes: journal.bytes,
	};
}
