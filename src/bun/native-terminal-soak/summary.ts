/**
 * Machine-readable verdict for the native-session soak (seq 1301).
 *
 * REDACTION IS STRUCTURAL, same discipline as the diagnostics snapshot: the
 * builder reads a fixed allowlist of fields — ids, counts, sizes, durations,
 * booleans, and failure reasons it composed itself. It never accepts, and
 * therefore can never emit, a bearer token, an endpoint, a shell command line,
 * an environment, or a single byte of terminal output. A soak summary is safe to
 * paste into a PR or an issue.
 *
 * Pure module: no fs, no clock, no Bun. `run-soak.ts` supplies the facts.
 */

import type { SoakFailure } from "./budgets";
import type { SamplePeaks } from "./metrics";
import type { SoakWorkloadShape } from "./workload";

export const SOAK_SUMMARY_SCHEMA = "dev3-native-terminal-soak" as const;
export const SOAK_SUMMARY_VERSION = 1 as const;
/** stdout line prefix so a caller can lift the JSON out of a noisy transcript. */
export const SOAK_SUMMARY_SENTINEL = "__DEV3_NATIVE_SOAK_JSON__";

export interface SoakSessionReport {
	sessionId: string;
	peaks: SamplePeaks;
	/** Cold host RSS after warm-up — the "empty parser core" reference. */
	hostRssBaselineBytes: number | null;
	/** Host RSS after the burst that over-fills the scrollback — the peak reference. */
	hostRssSustainedBytes: number | null;
	/** Full per-cycle host RSS series — the evidence the growth verdict is read from. */
	hostRssByCycle: (number | null)[];
	/** Reconnect durations in cycle order — the degradation series. */
	reconnectMs: number[];
}

export interface SoakRecoveryReport {
	/** Reconnects that reattached to the same host PID, shell PID, session and pane id. */
	reconnectsWithStableIdentity: number;
	reconnectsAttempted: number;
	/** Reconnects whose replay + snapshot both contained the burst's final marker. */
	reconnectsWithCorrectFinalScreen: number;
	/** A genuinely separate controller process reattached and saw the same identity. */
	freshControllerReattached: boolean;
	freshControllerScreenCorrect: boolean;
	/** Sessions the crashed host left behind, classified honestly as lost. */
	crashedSessionsClassifiedLost: number;
}

export interface SoakCleanupReport {
	/** Owned host/shell/child/grandchild PIDs the crash phase watched die. */
	ownedPidsTrackedAtCrash: number;
	ownedPidsAliveAfterCrash: number;
	/** Repeating cleanup must be a no-op, not an error. */
	cleanupIsIdempotent: boolean;
	createStopCycles: number;
	registryDirsBaseline: number;
	registryDirsAfterChurn: number;
	registryDirsFinal: number;
	ownedPidsAliveAfterTeardown: number;
	unrelatedSentinelSurvived: boolean;
	tmuxSentinelSurvived: boolean;
	tmuxInvoked: boolean;
}

export interface SoakSummaryInput {
	platform: string;
	arch: string;
	bunVersion: string;
	/** Basename only — never a path, so the summary leaks no home directory. */
	runtimeExecutable: string;
	elapsedMs: number;
	sessions: number;
	reconnectCycles: number;
	workload: SoakWorkloadShape;
	cols: number;
	rows: number;
	perSession: SoakSessionReport[];
	clientRssByCycle: number[];
	recovery: SoakRecoveryReport;
	cleanup: SoakCleanupReport;
	/** Budget verdicts plus any correctness check the run failed. */
	failures: SoakFailure[];
}

export interface SoakSummary extends SoakSummaryInput {
	schema: typeof SOAK_SUMMARY_SCHEMA;
	version: typeof SOAK_SUMMARY_VERSION;
	clientRssPeakBytes: number;
	ok: boolean;
}

export function buildSoakSummary(input: SoakSummaryInput): SoakSummary {
	return {
		schema: SOAK_SUMMARY_SCHEMA,
		version: SOAK_SUMMARY_VERSION,
		platform: input.platform,
		arch: input.arch,
		bunVersion: input.bunVersion,
		runtimeExecutable: input.runtimeExecutable,
		elapsedMs: input.elapsedMs,
		sessions: input.sessions,
		reconnectCycles: input.reconnectCycles,
		workload: { ...input.workload },
		cols: input.cols,
		rows: input.rows,
		perSession: input.perSession.map((session) => ({
			sessionId: session.sessionId,
			peaks: { ...session.peaks },
			hostRssBaselineBytes: session.hostRssBaselineBytes,
			hostRssSustainedBytes: session.hostRssSustainedBytes,
			hostRssByCycle: [...session.hostRssByCycle],
			reconnectMs: [...session.reconnectMs],
		})),
		clientRssByCycle: [...input.clientRssByCycle],
		clientRssPeakBytes: Math.max(0, ...input.clientRssByCycle),
		recovery: { ...input.recovery },
		cleanup: { ...input.cleanup },
		failures: input.failures.map((failure) => ({ ...failure })),
		ok: input.failures.length === 0,
	};
}

/** One compact human line per summary — the thing a reviewer reads first. */
export function formatSoakSummary(summary: SoakSummary): string {
	const rss = summary.perSession
		.map((session) => session.peaks.hostRssPeakBytes)
		.filter((value): value is number => typeof value === "number");
	const peakHostRss = rss.length === 0 ? 0 : Math.max(...rss);
	return [
		summary.ok ? "SOAK PASS" : `SOAK FAIL (${summary.failures.length} reason(s))`,
		`${summary.platform}/${summary.arch} bun=${summary.bunVersion} runtime=${summary.runtimeExecutable}`,
		`sessions=${summary.sessions} reconnects=${summary.reconnectCycles} createStop=${summary.cleanup.createStopCycles}`,
		`peakHostRss=${(peakHostRss / (1024 * 1024)).toFixed(1)}MiB peakClientRss=${(summary.clientRssPeakBytes / (1024 * 1024)).toFixed(1)}MiB`,
		`elapsed=${(summary.elapsedMs / 1000).toFixed(1)}s`,
	].join(" | ");
}
