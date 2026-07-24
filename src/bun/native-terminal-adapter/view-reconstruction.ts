/**
 * Bounded-snapshot view reconstruction for the native single-view adapter
 * (seq 1254).
 *
 * Capture and reconnect reconstruct a view's text from the host's BOUNDED
 * parser-state snapshot (the live Ghostty screen + capped scrollback the host
 * already maintains and persists), NOT from an unbounded journal replay. The
 * snapshot's `watermarkSeq` is applied with the sequencing rule's monotonic
 * half: a forward (or equal) watermark is accepted and cached; a stale snapshot
 * is ignored so a recovered capture never rewinds. Exactly one snapshot is read
 * per capture — there is no repeated resync loop.
 *
 * Rendering is pure over the semantic state, so it is unit-testable without any
 * WASM: the host owns Ghostty; the adapter only renders the snapshot it emits.
 */

import { readParserState, type ParserStateSnapshot } from "../native-terminal-registry/parser-state";
import type { NativeSemanticLine, NativeSemanticState } from "../native-terminal-registry/ghostty-live";

/** A snapshot reader — the registry's on-disk reader by default, faked in tests. */
export type SnapshotReader = (sessionId: string) => ParserStateSnapshot | null;

function lineText(line: NativeSemanticLine): string {
	return line.text;
}

function trimTrailingBlankLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1].trim() === "") end--;
	return lines.slice(0, end);
}

/**
 * Render a semantic screen to plain text. `includeHistory` prepends the capped
 * scrollback (oldest-first) before the visible screen, so a burst larger than
 * the viewport is fully readable in produced order. Trailing blank rows are
 * dropped for readable captures.
 */
export function renderSnapshotText(state: NativeSemanticState, includeHistory: boolean): string {
	const lines = includeHistory
		? [...state.scrollback.map(lineText), ...state.screen.map(lineText)]
		: state.screen.map(lineText);
	return trimTrailingBlankLines(lines).join("\n");
}

/**
 * A per-session capture surface over the bounded snapshot. Enforces the
 * monotonic-watermark rule: it accepts a snapshot whose `watermarkSeq` is at
 * least the last one it applied and caches the render; a stale snapshot is
 * ignored and the last good render is returned instead of rewinding.
 */
export class MonotonicSnapshotView {
	private appliedWatermark = -1;
	private cachedHistoryText: string | null = null;
	private cachedScreenText: string | null = null;

	constructor(
		readonly sessionId: string,
		private readonly read: SnapshotReader = readParserState,
	) {}

	/** Seq of the last accepted snapshot (−1 before any snapshot is applied). */
	get watermark(): number {
		return this.appliedWatermark;
	}

	/**
	 * Read the current bounded snapshot and return the rendered view text, or
	 * `null` when no parser state exists yet (the host is still booting / silent).
	 * A forward snapshot refreshes the cache; a stale one returns the cache.
	 */
	capture(includeHistory: boolean): string | null {
		const snapshot = this.read(this.sessionId);
		if (snapshot?.state && snapshot.watermarkSeq >= this.appliedWatermark) {
			this.appliedWatermark = snapshot.watermarkSeq;
			this.cachedHistoryText = renderSnapshotText(snapshot.state, true);
			this.cachedScreenText = renderSnapshotText(snapshot.state, false);
		}
		return includeHistory ? this.cachedHistoryText : this.cachedScreenText;
	}
}
