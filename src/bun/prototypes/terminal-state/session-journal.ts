/**
 * Shared journal types for the Windows shell/agent capture spike.
 *
 * A raw session journal is the ordered record of one scripted live capture:
 * output chunks, resize events, and a single detach boundary. It maps directly
 * onto the harness fixture shape — events before the detach index become
 * `events`, events after it become `afterReplay` — so a captured session can be
 * replayed and semantically compared with the same code path as the golden
 * fixtures. Nothing here touches Ghostty; conversion is pure data.
 */

import type {
	QueryKind,
} from "./terminal-query-responder";
import type {
	TerminalCaptureEvent,
	TerminalCaptureFixture,
	TerminalDimensions,
	TerminalSemanticState,
} from "./terminal-state";

export interface SessionProvenance {
	command: string;
	platform: string;
	capturedAt: string;
	exitCode: number | null;
}

export interface RawSessionJournal {
	schema: "dev3-windows-session-journal";
	version: 1;
	target: string;
	kind: "shell" | "agent";
	initial: TerminalDimensions;
	finalDimensions: { cols: number; rows: number };
	/** Number of leading events captured before the detach boundary. */
	detachIndex: number;
	events: TerminalCaptureEvent[];
	responderReplies: number;
	queryCounts: Partial<Record<QueryKind, number>>;
	provenance: SessionProvenance;
}

const JOURNAL_SCHEMA = "dev3-windows-session-journal";

export function isRawSessionJournal(value: unknown): value is RawSessionJournal {
	if (typeof value !== "object" || value === null) return false;
	const journal = value as Record<string, unknown>;
	return (
		journal.schema === JOURNAL_SCHEMA &&
		journal.version === 1 &&
		typeof journal.target === "string" &&
		(journal.kind === "shell" || journal.kind === "agent") &&
		Array.isArray(journal.events) &&
		Number.isInteger(journal.detachIndex)
	);
}

/** Split a journal into detach-boundary halves for the replay/compare harness. */
export function splitAtDetach(journal: RawSessionJournal): {
	events: TerminalCaptureEvent[];
	afterReplay: TerminalCaptureEvent[];
} {
	const index = Math.max(0, Math.min(journal.detachIndex, journal.events.length));
	return {
		events: journal.events.slice(0, index),
		afterReplay: journal.events.slice(index),
	};
}

export interface FixtureExpectations {
	expected: Partial<TerminalSemanticState>;
	expectedAfterReplay?: Partial<TerminalSemanticState>;
	source?: "captured" | "synthetic";
}

/** Convert a captured journal into a harness fixture without loading Ghostty. */
export function journalToFixture(
	journal: RawSessionJournal,
	name: string,
	expectations: FixtureExpectations,
): TerminalCaptureFixture {
	const { events, afterReplay } = splitAtDetach(journal);
	const fixture: TerminalCaptureFixture = {
		fixtureVersion: 1,
		name,
		source: expectations.source ?? "captured",
		initial: { ...journal.initial },
		events,
		expected: expectations.expected,
		provenance: {
			command: journal.provenance.command,
			platform: journal.provenance.platform,
			capturedAt: journal.provenance.capturedAt,
		},
	};
	if (afterReplay.length > 0) fixture.afterReplay = afterReplay;
	if (expectations.expectedAfterReplay) fixture.expectedAfterReplay = expectations.expectedAfterReplay;
	return fixture;
}

/** Total decoded output byte length across a journal (base64 chunks decoded). */
export function journalOutputByteLength(journal: RawSessionJournal): number {
	let total = 0;
	for (const event of journal.events) {
		if (event.type !== "output") continue;
		total +=
			event.encoding === "base64"
				? Buffer.from(event.data, "base64").byteLength
				: Buffer.byteLength(event.data, "utf8");
	}
	return total;
}
