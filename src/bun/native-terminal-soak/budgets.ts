/**
 * Evidence-based budgets for the native-session soak (seq 1301).
 *
 * Every ceiling here is DERIVED, not guessed:
 *
 *   • journal — the writer caps the on-disk tail at `DEFAULT_JOURNAL_MAX_BYTES`
 *     and always keeps the newest frame even when it alone exceeds the cap, so
 *     the only honest ceiling is `cap + one maximal frame`.
 *   • parser snapshot — the snapshot is rows×cols cells plus a scrollback tail
 *     capped at `DEFAULT_SNAPSHOT_SCROLLBACK_CAP` lines, so its ceiling follows
 *     from the session geometry times a measured per-cell JSON budget.
 *   • host / client memory — no absolute magic number. The soak measures the
 *     SATURATED state (right after a burst that over-fills the parser core's
 *     scrollback) and asserts the peak stays inside `saturated × factor +
 *     slack`, and separately that per-cycle GROWTH — the median consecutive
 *     delta across the SECOND HALF of the reconnect cycles — is ~flat. Real
 *     allocators climb in steps before settling, so only the tail is evidence
 *     (see `MIN_GROWTH_CYCLES`) and only a step-immune statistic can read it
 *     (see `theilSenSlope`). A leak shows up there, and no amount of
 *     headroom can hide it.
 *
 * Pure module: no fs, no Bun, no clock. `run-soak.ts` gathers samples, this
 * turns them into pass/fail with an actionable reason per failure.
 */

import { DEFAULT_JOURNAL_MAX_BYTES } from "../native-terminal-registry/journal";
import { DEFAULT_SNAPSHOT_SCROLLBACK_CAP } from "../native-terminal-registry/live-parser";

/** One measurement round: the baseline (cycle 0) or the end of cycle N. */
export interface SoakCycleSample {
	cycle: number;
	/** Host RSS as the host itself reported it in `parser-state.json`. */
	hostRssBytes: number | null;
	/** Bytes of `parser-state.json` on disk. */
	snapshotBytes: number;
	/** Bytes of `journal.ndjson` on disk. */
	journalBytes: number;
	/** Milliseconds the reconnect that opened this cycle took; null for the baseline. */
	reconnectMs: number | null;
}

/**
 * Peaks and slopes answer different questions, so they read different series.
 * `baseline` and `sustained` bracket the run's pressure; `cycles` is the only
 * apples-to-apples series (identical short burst per cycle) and is therefore the
 * only one a slope may be computed over.
 */
export interface SoakSessionObservation {
	sessionId: string;
	/** Reference sample taken after warm-up, before any heavy output. */
	baseline: SoakCycleSample;
	/** Sample taken right after the sustained high-output burst. */
	sustained: SoakCycleSample;
	/** One sample per reconnect cycle, each after an identical short burst. */
	cycles: SoakCycleSample[];
	/** Terminal parser health at the end of the run: must stay "live". */
	parserHealth: string | null;
	droppedChunks: number;
	droppedBytes: number;
	droppedResizes: number;
}

export interface SoakObservations {
	sessions: SoakSessionObservation[];
	/** Harness-process RSS, one entry per reconnect cycle — the client-side slope. */
	clientRssByCycle: number[];
	/** Session directories present before the churn phases and after teardown. */
	registryDirsBaseline: number;
	registryDirsAfterChurn: number;
	registryDirsFinal: number;
	/** Owned host/shell/descendant PIDs still alive after crash cleanup and teardown. */
	ownedPidsAliveAfterCrash: number;
	ownedPidsAliveAfterTeardown: number;
}

export interface SoakBudgets {
	/**
	 * Peak host RSS must stay under `saturated × factor + slack`, where
	 * `saturated` is the sample taken right after the sustained burst. The COLD
	 * baseline is deliberately not the reference: at that point the parser core
	 * holds almost nothing, so anchoring to it would flag the normal cost of a
	 * full 1000-line scrollback as a blow-up.
	 */
	hostRssPeakFactor: number;
	hostRssPeakSlackBytes: number;
	/** Per-cycle growth ceilings — a real leak is growth, not headroom. */
	hostRssGrowthPerCycleBytes: number;
	clientRssGrowthPerCycleBytes: number;
	snapshotGrowthPerCycleBytes: number;
	/** Derived on-disk ceilings. */
	journalCeilingBytes: number;
	snapshotCeilingBytes: number;
	/** Reconnect must stay fast and must not degrade cycle over cycle. */
	reconnectCeilingMs: number;
	reconnectGrowthPerCycleMs: number;
}

/** Widest single journal frame the writer may keep past the cap (64 KiB PTY read). */
const MAX_JOURNAL_FRAME_BYTES = 64 * 1024;
/** base64 + JSON envelope inflation of one raw PTY frame. */
const JOURNAL_FRAME_ENCODING_FACTOR = 2;

export function deriveJournalCeilingBytes(maxBytes: number = DEFAULT_JOURNAL_MAX_BYTES): number {
	return maxBytes + MAX_JOURNAL_FRAME_BYTES * JOURNAL_FRAME_ENCODING_FACTOR;
}

/**
 * Measured JSON cost of one semantic cell (text, width, fg, bg, attributes) plus
 * its share of the enclosing line envelope. Deliberately generous per cell — the
 * point of this ceiling is to catch an UNBOUNDED snapshot, not to grade encoding.
 */
const SNAPSHOT_BYTES_PER_CELL = 160;
/** Fixed overhead: schema, health, counters, latency, memory blocks. */
const SNAPSHOT_FIXED_BYTES = 8 * 1024;

export function deriveSnapshotCeilingBytes(opts: {
	cols: number;
	rows: number;
	scrollbackCap?: number;
}): number {
	const scrollback = opts.scrollbackCap ?? DEFAULT_SNAPSHOT_SCROLLBACK_CAP;
	return SNAPSHOT_FIXED_BYTES + (opts.rows + scrollback) * opts.cols * SNAPSHOT_BYTES_PER_CELL;
}

export function defaultSoakBudgets(geometry: { cols: number; rows: number }): SoakBudgets {
	return {
		hostRssPeakFactor: 2,
		hostRssPeakSlackBytes: 64 * 1024 * 1024,
		hostRssGrowthPerCycleBytes: 4 * 1024 * 1024,
		clientRssGrowthPerCycleBytes: 4 * 1024 * 1024,
		snapshotGrowthPerCycleBytes: 64 * 1024,
		journalCeilingBytes: deriveJournalCeilingBytes(),
		snapshotCeilingBytes: deriveSnapshotCeilingBytes(geometry),
		reconnectCeilingMs: 5_000,
		reconnectGrowthPerCycleMs: 250,
	};
}

/**
 * Minimum reconnect cycles before any growth verdict is trusted.
 *
 * MEASURED, NOT GUESSED, on two platforms with different memory behaviour:
 *
 *   • macOS — a STAIRCASE. A 25-cycle run measured 194 → 229 MiB by cycle 4, flat
 *     for cycles 6–12, one step to 264 MiB at cycles 13–15, then dead flat
 *     (263.9 … 264.4 MiB) for the final ten cycles.
 *   • Windows — a SAWTOOTH. Working-set trimming swings host RSS between ~133 and
 *     ~213 MiB every few cycles with no trend at all; three of four sessions in a
 *     16-cycle run ended BELOW their first cycle.
 *
 * Both shapes need a long series and a step-immune, direction-symmetric statistic
 * (`theilSenSlope` over `tailWindow`). Sixteen cycles is the shortest run whose
 * tail half (eight samples) read both shapes as flat.
 */
export const MIN_GROWTH_CYCLES = 16;

/** Floor on the tail window itself, independent of the series length. */
export const MIN_GROWTH_SAMPLES = 8;

/**
 * Mean change per cycle across an ordered series — `(last - first) / (n - 1)`.
 * Zero for series shorter than two samples, so a degenerate run cannot fail on
 * a slope it never had the data to measure.
 */
export function growthPerCycle(series: readonly number[]): number {
	if (series.length < 2) return 0;
	return (series[series.length - 1]! - series[0]!) / (series.length - 1);
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = sorted.length >> 1;
	return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Theil–Sen trend: the median slope over EVERY pair of samples.
 *
 * Two simpler statistics were measured and rejected against real series:
 *
 *   • Least squares — one ~20 MiB allocator step inside the window drags the fit
 *     up by 4–5 MiB/cycle even when every other cycle is flat.
 *   • Median of consecutive deltas — direction-asymmetric. Windows working-set
 *     trimming makes host RSS a SAWTOOTH (measured 133 → 213 → 133 MiB with no
 *     trend, ending below where it started); such a series has many small up
 *     deltas and few large down deltas, so the median delta reported a phantom
 *     10–15 MiB/cycle "leak".
 *
 * Theil–Sen reads both real series correctly (≈0 on the Windows sawtooth, ≈0 on
 * the macOS post-ramp plateau) and still reports the exact per-cycle cost of a
 * monotone leak.
 */
export function theilSenSlope(series: readonly number[]): number {
	if (series.length < 2) return 0;
	const slopes: number[] = [];
	for (let i = 0; i < series.length; i++) {
		for (let j = i + 1; j < series.length; j++) slopes.push((series[j]! - series[i]!) / (j - i));
	}
	return median(slopes);
}

/** The second half of a series — self-scaling, so a longer run judges a longer tail. */
export function tailWindow(series: readonly number[]): readonly number[] {
	return series.slice(Math.floor(series.length / 2));
}

/**
 * Per-cycle growth across the second half of a series, or null when the run was
 * too short for a growth verdict at all. Null is never silently a pass:
 * `evaluateSoakBudgets` reports one explicit run-level failure telling the caller
 * to use more cycles.
 */
export function tailGrowthPerCycle(series: readonly number[]): number | null {
	if (series.length < MIN_GROWTH_CYCLES) return null;
	const tail = tailWindow(series);
	if (tail.length < MIN_GROWTH_SAMPLES) return null;
	return theilSenSlope(tail);
}

export interface SoakFailure {
	/** Stable machine key, e.g. `host-rss-growth`. */
	code: string;
	/** Session id, or "harness" for run-wide facts. */
	scope: string;
	/** One actionable sentence: what exceeded what, and by how much. */
	reason: string;
}

function mib(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function kib(bytes: number): string {
	return `${(bytes / 1024).toFixed(1)} KiB`;
}

function definedNumbers(values: readonly (number | null)[]): number[] {
	return values.filter((value): value is number => typeof value === "number");
}

export function evaluateSoakBudgets(observations: SoakObservations, budgets: SoakBudgets): SoakFailure[] {
	const failures: SoakFailure[] = [];
	const cycleCount = Math.min(
		observations.clientRssByCycle.length,
		...observations.sessions.map((session) => session.cycles.length),
	);
	if (!Number.isFinite(cycleCount) || cycleCount < MIN_GROWTH_CYCLES) {
		failures.push({
			code: "growth-unmeasurable",
			scope: "harness",
			reason: `only ${Number.isFinite(cycleCount) ? cycleCount : 0} reconnect cycle(s) — memory, snapshot, and latency growth verdicts need at least ${MIN_GROWTH_CYCLES}; re-run with --reconnects ${MIN_GROWTH_CYCLES} or more`,
		});
	}

	for (const session of observations.sessions) {
		const scope = session.sessionId;
		const allSamples = [session.baseline, session.sustained, ...session.cycles];
		const hostRss = definedNumbers(allSamples.map((sample) => sample.hostRssBytes));
		if (hostRss.length === 0) {
			failures.push({
				code: "host-rss-missing",
				scope,
				reason: "no host RSS sample was published — the live parser never wrote parser-state.json, so memory is unproven",
			});
		} else {
			const saturated = session.sustained.hostRssBytes ?? session.baseline.hostRssBytes ?? hostRss[0]!;
			const peak = Math.max(...hostRss);
			const ceiling = saturated * budgets.hostRssPeakFactor + budgets.hostRssPeakSlackBytes;
			if (peak > ceiling) {
				failures.push({
					code: "host-rss-peak",
					scope,
					reason: `peak host RSS ${mib(peak)} exceeds ${mib(ceiling)} (saturated ${mib(saturated)} × ${budgets.hostRssPeakFactor} + ${mib(budgets.hostRssPeakSlackBytes)} slack)`,
				});
			}
			const cycleRss = definedNumbers(session.cycles.map((sample) => sample.hostRssBytes));
			const growth = tailGrowthPerCycle(cycleRss);
			if (growth !== null && growth > budgets.hostRssGrowthPerCycleBytes) {
				failures.push({
					code: "host-rss-growth",
					scope,
					reason: `host RSS still grows ${mib(growth)} per cycle (Theil–Sen) across the second half of ${cycleRss.length} cycles (budget ${mib(budgets.hostRssGrowthPerCycleBytes)}) — reconnects are retaining state`,
				});
			}
		}

		const snapshots = allSamples.map((sample) => sample.snapshotBytes);
		const snapshotPeak = Math.max(0, ...snapshots);
		if (snapshotPeak > budgets.snapshotCeilingBytes) {
			failures.push({
				code: "snapshot-size",
				scope,
				reason: `parser-state.json peaked at ${mib(snapshotPeak)}, over the geometry-derived ceiling ${mib(budgets.snapshotCeilingBytes)} — the snapshot is not bounded by rows×cols + scrollback cap`,
			});
		}
		const snapshotSlope = tailGrowthPerCycle(session.cycles.map((sample) => sample.snapshotBytes));
		if (snapshotSlope !== null && snapshotSlope > budgets.snapshotGrowthPerCycleBytes) {
			failures.push({
				code: "snapshot-growth",
				scope,
				reason: `parser-state.json still grows ${kib(snapshotSlope)} per cycle across the second half of the run (budget ${kib(budgets.snapshotGrowthPerCycleBytes)})`,
			});
		}

		const journalPeak = Math.max(0, ...allSamples.map((sample) => sample.journalBytes));
		if (journalPeak > budgets.journalCeilingBytes) {
			failures.push({
				code: "journal-size",
				scope,
				reason: `journal.ndjson peaked at ${kib(journalPeak)}, over the cap-derived ceiling ${kib(budgets.journalCeilingBytes)} — the rolling tail is not being trimmed`,
			});
		}

		if (session.parserHealth !== "live") {
			failures.push({
				code: "parser-health",
				scope,
				reason: `parser health ended as ${session.parserHealth ?? "unknown"} instead of live — sustained output overwhelmed or faulted the pipeline`,
			});
		}
		if (session.droppedChunks > 0 || session.droppedBytes > 0 || session.droppedResizes > 0) {
			failures.push({
				code: "queue-overflow",
				scope,
				reason: `parser queue dropped ${session.droppedChunks} chunk(s) / ${session.droppedBytes} byte(s) / ${session.droppedResizes} resize(s) — the consumer fell behind the PTY`,
			});
		}

		const reconnects = definedNumbers(session.cycles.map((sample) => sample.reconnectMs));
		const slowest = Math.max(0, ...reconnects);
		if (slowest > budgets.reconnectCeilingMs) {
			failures.push({
				code: "reconnect-latency",
				scope,
				reason: `slowest reconnect took ${slowest} ms, over the ${budgets.reconnectCeilingMs} ms ceiling`,
			});
		}
		const reconnectSlope = tailGrowthPerCycle(reconnects);
		if (reconnectSlope !== null && reconnectSlope > budgets.reconnectGrowthPerCycleMs) {
			failures.push({
				code: "reconnect-degradation",
				scope,
				reason: `reconnect latency grows ${reconnectSlope.toFixed(0)} ms per cycle across the second half of the run (budget ${budgets.reconnectGrowthPerCycleMs} ms) — attach cost scales with history`,
			});
		}
	}

	const clientSlope = tailGrowthPerCycle(observations.clientRssByCycle);
	if (clientSlope !== null && clientSlope > budgets.clientRssGrowthPerCycleBytes) {
		failures.push({
			code: "client-rss-growth",
			scope: "harness",
			reason: `client-side RSS still grows ${mib(clientSlope)} per cycle across the second half of the run (budget ${mib(budgets.clientRssGrowthPerCycleBytes)}) — disconnected clients are not being released`,
		});
	}

	if (observations.registryDirsAfterChurn !== observations.registryDirsBaseline) {
		failures.push({
			code: "registry-churn-leak",
			scope: "harness",
			reason: `repeated create/stop left ${observations.registryDirsAfterChurn} session directories, expected the baseline ${observations.registryDirsBaseline}`,
		});
	}
	if (observations.registryDirsFinal !== 0) {
		failures.push({
			code: "registry-teardown-leak",
			scope: "harness",
			reason: `${observations.registryDirsFinal} session directory(ies) survived teardown — cleanup is not removing owned metadata`,
		});
	}
	if (observations.ownedPidsAliveAfterCrash !== 0) {
		failures.push({
			code: "crash-process-leak",
			scope: "harness",
			reason: `${observations.ownedPidsAliveAfterCrash} owned process(es) survived the host crash — the ownership boundary did not reap the tree`,
		});
	}
	if (observations.ownedPidsAliveAfterTeardown !== 0) {
		failures.push({
			code: "teardown-process-leak",
			scope: "harness",
			reason: `${observations.ownedPidsAliveAfterTeardown} owned process(es) survived explicit stop`,
		});
	}

	return failures;
}
