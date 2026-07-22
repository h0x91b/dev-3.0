/**
 * Versioned, bounded parser-state snapshot for the live-parser proof (seq 1228).
 *
 * The host's live parser periodically persists its semantic screen plus health
 * and cost accounting into `parser-state.json` (atomic tmp+rename, like
 * record.json). A fresh client reconstructs the screen after detach by reading
 * this file — no protocol change, no unbounded replay. Parsing is fail-closed:
 * unknown schema/version/parser identities are rejected, mirroring the spike's
 * snapshot discipline (decision 146).
 *
 * Boundedness is explicit: the screen is rows×cols, scrollback is capped by the
 * writer (`scrollback` vs total `scrollbackLength`), and the health block
 * reports queue overflow instead of ever growing past its caps.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { LIVE_PARSER_ID, type NativeSemanticState } from "./ghostty-live";
import { parserStateFile, sessionDir } from "./paths";
import type { ParserQueueOverflow } from "./parser-queue";

export const PARSER_STATE_SCHEMA = "dev3-native-session-parser-state" as const;
export const PARSER_STATE_VERSION = 1 as const;

export type ParserHealthStatus = "live" | "overflowed" | "failed";

export interface ParserHealth {
	status: ParserHealthStatus;
	/** Present only for `failed` — the contained parser error, never a crash. */
	error?: string;
	overflow: ParserQueueOverflow;
}

export interface ParserIngestTotals {
	frames: number;
	bytes: number;
	resizes: number;
	replies: number;
}

export interface ParserLatencyStats {
	drains: number;
	totalMs: number;
	maxMs: number;
	p50Ms: number;
	p95Ms: number;
}

export interface ParserMemoryStats {
	rssBytes: number;
	heapUsedBytes: number;
}

export interface ParserStateSnapshot {
	schema: typeof PARSER_STATE_SCHEMA;
	version: typeof PARSER_STATE_VERSION;
	parser: typeof LIVE_PARSER_ID;
	sessionId: string;
	/** Queue sequence number of the last event the parser ingested. */
	watermarkSeq: number;
	health: ParserHealth;
	ingested: ParserIngestTotals;
	latency: ParserLatencyStats;
	memory: ParserMemoryStats;
	/** Last successfully parsed semantic screen (kept through overflow/failure). */
	state: NativeSemanticState | null;
	updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isParserStateSnapshot(value: unknown): value is ParserStateSnapshot {
	if (!isRecord(value)) return false;
	if (value.schema !== PARSER_STATE_SCHEMA || value.version !== PARSER_STATE_VERSION) return false;
	if (value.parser !== LIVE_PARSER_ID) return false;
	if (typeof value.sessionId !== "string" || typeof value.watermarkSeq !== "number") return false;
	if (!isRecord(value.health) || !isRecord(value.ingested) || !isRecord(value.latency) || !isRecord(value.memory)) {
		return false;
	}
	const status = (value.health as Record<string, unknown>).status;
	if (status !== "live" && status !== "overflowed" && status !== "failed") return false;
	return value.state === null || isRecord(value.state);
}

export function parseParserStateSnapshot(serialized: string): ParserStateSnapshot {
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		throw new Error("Unsupported parser-state snapshot: invalid JSON");
	}
	if (!isParserStateSnapshot(value)) {
		throw new Error("Unsupported parser-state snapshot schema, version, or parser identity");
	}
	return value;
}

/** Atomic write (tmp+rename) so a reader never observes a torn snapshot. */
export function writeParserStateAtomic(sessionId: string, snapshot: ParserStateSnapshot): void {
	mkdirSync(sessionDir(sessionId), { recursive: true, mode: 0o700 });
	const target = parserStateFile(sessionId);
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
	renameSync(tmp, target);
}

export function readParserState(sessionId: string): ParserStateSnapshot | null {
	try {
		return parseParserStateSnapshot(readFileSync(parserStateFile(sessionId), "utf8"));
	} catch {
		return null;
	}
}

export function removeParserState(sessionId: string): void {
	try {
		unlinkSync(parserStateFile(sessionId));
	} catch {
		// already absent
	}
}

/** Evidence snapshot for a parser that failed to BOOT (host keeps running raw). */
export function bootFailedParserState(sessionId: string, error: unknown): ParserStateSnapshot {
	return {
		schema: PARSER_STATE_SCHEMA,
		version: PARSER_STATE_VERSION,
		parser: LIVE_PARSER_ID,
		sessionId,
		watermarkSeq: 0,
		health: {
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
			overflow: { droppedChunks: 0, droppedBytes: 0, droppedResizes: 0 },
		},
		ingested: { frames: 0, bytes: 0, resizes: 0, replies: 0 },
		latency: { drains: 0, totalMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0 },
		memory: { rssBytes: 0, heapUsedBytes: 0 },
		state: null,
		updatedAt: new Date().toISOString(),
	};
}
