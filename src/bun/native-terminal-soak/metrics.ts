/**
 * Out-of-process metric sampling for the native-session soak (seq 1301).
 *
 * The soak drives real detached hosts, so it cannot reach into their heaps. It
 * reads only what the host ALREADY publishes: `parser-state.json` (host RSS,
 * parser health, queue overflow counters, drain latency, ingest totals) and the
 * on-disk sizes of the bounded journal / snapshot / record. No new production
 * diagnostic was needed — that is the point of sampling here rather than adding
 * a counter endpoint to the frozen protocol v1.
 *
 * Effects are injected, so the mapping from published state to a sample is pure
 * and unit-tested without a live host.
 */

import { readdirSync, statSync } from "node:fs";
import { journalFile, parserStateFile, recordFile, sessionsRootDir } from "../native-terminal-registry/paths";
import { readParserState, type ParserStateSnapshot } from "../native-terminal-registry/parser-state";

export interface SessionMetricSample {
	sessionId: string;
	cycle: number;
	hostRssBytes: number | null;
	hostHeapUsedBytes: number | null;
	journalBytes: number;
	snapshotBytes: number;
	recordBytes: number;
	watermarkSeq: number | null;
	parserHealth: string | null;
	droppedChunks: number;
	droppedBytes: number;
	droppedResizes: number;
	drainP95Ms: number | null;
	ingestedFrames: number | null;
	ingestedBytes: number | null;
}

export interface MetricSources {
	readParserState: (sessionId: string) => ParserStateSnapshot | null;
	fileBytes: (path: string) => number;
}

/** Size on disk, or 0 when the file is absent — an absent bounded file is not a failure. */
export function fileBytes(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

export const defaultMetricSources: MetricSources = { readParserState, fileBytes };

export function sampleSession(
	sessionId: string,
	cycle: number,
	sources: MetricSources = defaultMetricSources,
): SessionMetricSample {
	const state = sources.readParserState(sessionId);
	return {
		sessionId,
		cycle,
		hostRssBytes: state?.memory.rssBytes ?? null,
		hostHeapUsedBytes: state?.memory.heapUsedBytes ?? null,
		journalBytes: sources.fileBytes(journalFile(sessionId)),
		snapshotBytes: sources.fileBytes(parserStateFile(sessionId)),
		recordBytes: sources.fileBytes(recordFile(sessionId)),
		watermarkSeq: state?.watermarkSeq ?? null,
		parserHealth: state?.health.status ?? null,
		droppedChunks: state?.health.overflow.droppedChunks ?? 0,
		droppedBytes: state?.health.overflow.droppedBytes ?? 0,
		droppedResizes: state?.health.overflow.droppedResizes ?? 0,
		drainP95Ms: state?.latency.p95Ms ?? null,
		ingestedFrames: state?.ingested.frames ?? null,
		ingestedBytes: state?.ingested.bytes ?? null,
	};
}

/** Directories directly under the registry root — the metadata leak counter. */
export function sessionDirCount(): number {
	try {
		return readdirSync(sessionsRootDir(), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
	} catch {
		return 0;
	}
}

export interface SamplePeaks {
	hostRssPeakBytes: number | null;
	journalPeakBytes: number;
	snapshotPeakBytes: number;
	drainP95PeakMs: number | null;
	watermarkSeqFinal: number | null;
	ingestedBytesFinal: number | null;
	parserHealthFinal: string | null;
	droppedChunks: number;
	droppedBytes: number;
	droppedResizes: number;
}

function peakOf(values: readonly (number | null)[]): number | null {
	const defined = values.filter((value): value is number => typeof value === "number");
	return defined.length === 0 ? null : Math.max(...defined);
}

/** Fold one session's ordered samples into the peaks the summary reports. */
export function peaksOf(samples: readonly SessionMetricSample[]): SamplePeaks {
	const last = samples[samples.length - 1] ?? null;
	return {
		hostRssPeakBytes: peakOf(samples.map((sample) => sample.hostRssBytes)),
		journalPeakBytes: Math.max(0, ...samples.map((sample) => sample.journalBytes)),
		snapshotPeakBytes: Math.max(0, ...samples.map((sample) => sample.snapshotBytes)),
		drainP95PeakMs: peakOf(samples.map((sample) => sample.drainP95Ms)),
		watermarkSeqFinal: last?.watermarkSeq ?? null,
		ingestedBytesFinal: last?.ingestedBytes ?? null,
		parserHealthFinal: last?.parserHealth ?? null,
		droppedChunks: Math.max(0, ...samples.map((sample) => sample.droppedChunks)),
		droppedBytes: Math.max(0, ...samples.map((sample) => sample.droppedBytes)),
		droppedResizes: Math.max(0, ...samples.map((sample) => sample.droppedResizes)),
	};
}
