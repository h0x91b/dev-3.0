/**
 * Read side of a session's independent journal (seq 1214). Kept apart from the
 * writer so a reattaching client can replay the persisted output tail without
 * pulling in the buffered-writer machinery.
 */

import { readFileSync } from "node:fs";
import { parseJournal } from "./journal";
import { journalFile } from "./paths";

/** Decoded output chunks persisted for `sessionId`, oldest first ([] if none). */
export function readJournalTail(sessionId: string): Uint8Array[] {
	try {
		return parseJournal(readFileSync(journalFile(sessionId), "utf8")).map((frame) => frame.data);
	} catch {
		return [];
	}
}
