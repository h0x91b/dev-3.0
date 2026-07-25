import { describe, expect, it } from "vitest";
import {
	buildSoakSummary,
	formatSoakSummary,
	SOAK_SUMMARY_SCHEMA,
	SOAK_SUMMARY_VERSION,
	type SoakSummaryInput,
} from "../summary";
import { DEFAULT_SOAK_WORKLOAD } from "../workload";

function input(overrides: Partial<SoakSummaryInput> = {}): SoakSummaryInput {
	return {
		platform: "win32",
		arch: "x64",
		bunVersion: "1.3.14",
		runtimeExecutable: "bun.exe",
		elapsedMs: 61_000,
		sessions: 4,
		reconnectCycles: 16,
		workload: DEFAULT_SOAK_WORKLOAD,
		cols: 120,
		rows: 40,
		perSession: [
			{
				sessionId: "soak-0",
				peaks: {
					hostRssPeakBytes: 240_000_000,
					journalPeakBytes: 262_144,
					snapshotPeakBytes: 2_600_000,
					drainP95PeakMs: 2,
					watermarkSeqFinal: 2_800,
					ingestedBytesFinal: 200_000,
					parserHealthFinal: "live",
					droppedChunks: 0,
					droppedBytes: 0,
					droppedResizes: 0,
				},
				hostRssBaselineBytes: 70_000_000,
				hostRssSustainedBytes: 190_000_000,
				hostRssByCycle: [200_000_000, 201_000_000, 199_000_000],
				reconnectMs: [2, 3, 2],
			},
		],
		clientRssByCycle: [100_000_000, 101_000_000],
		recovery: {
			reconnectsAttempted: 64,
			reconnectsWithStableIdentity: 64,
			reconnectsWithCorrectFinalScreen: 64,
			freshControllerReattached: true,
			freshControllerScreenCorrect: true,
			crashedSessionsClassifiedLost: 1,
		},
		cleanup: {
			ownedPidsTrackedAtCrash: 4,
			ownedPidsAliveAfterCrash: 0,
			cleanupIsIdempotent: true,
			createStopCycles: 6,
			registryDirsBaseline: 3,
			registryDirsAfterChurn: 3,
			registryDirsFinal: 0,
			ownedPidsAliveAfterTeardown: 0,
			unrelatedSentinelSurvived: true,
			tmuxSentinelSurvived: true,
			tmuxInvoked: false,
		},
		failures: [],
		...overrides,
	};
}

describe("buildSoakSummary", () => {
	it("stamps the schema and passes a clean run", () => {
		const summary = buildSoakSummary(input());
		expect(summary.schema).toBe(SOAK_SUMMARY_SCHEMA);
		expect(summary.version).toBe(SOAK_SUMMARY_VERSION);
		expect(summary.ok).toBe(true);
		expect(summary.clientRssPeakBytes).toBe(101_000_000);
	});

	it("fails as soon as there is one reason, and keeps every reason", () => {
		const summary = buildSoakSummary(
			input({ failures: [{ code: "host-rss-growth", scope: "soak-0", reason: "host RSS still grows 9 MiB per cycle" }] }),
		);
		expect(summary.ok).toBe(false);
		expect(summary.failures).toHaveLength(1);
		expect(summary.failures[0]!.reason).toContain("9 MiB");
	});

	it("carries platform, runtime, workload, peaks, recovery, and cleanup", () => {
		const summary = buildSoakSummary(input());
		expect(summary.platform).toBe("win32");
		expect(summary.bunVersion).toBe("1.3.14");
		expect(summary.workload.lines).toBe(DEFAULT_SOAK_WORKLOAD.lines);
		expect(summary.perSession[0]!.peaks.parserHealthFinal).toBe("live");
		expect(summary.recovery.freshControllerReattached).toBe(true);
		expect(summary.cleanup.tmuxInvoked).toBe(false);
	});

	it("copies its inputs, so a later mutation cannot rewrite a published summary", () => {
		const source = input();
		const summary = buildSoakSummary(source);
		source.perSession[0]!.reconnectMs.push(9_999);
		source.perSession[0]!.hostRssByCycle.push(9_999);
		source.clientRssByCycle.push(0);
		expect(summary.perSession[0]!.reconnectMs).toEqual([2, 3, 2]);
		expect(summary.perSession[0]!.hostRssByCycle).toHaveLength(3);
		expect(summary.clientRssByCycle).toHaveLength(2);
	});

	it("emits no token, endpoint, path, or terminal content", () => {
		const serialized = JSON.stringify(buildSoakSummary(input()));
		for (const forbidden of ["token", "endpoint", "127.0.0.1", "executable:", "screen", "scrollback", "env", "/Users/", "C:\\\\"]) {
			expect(serialized).not.toContain(forbidden);
		}
		// The runtime is a basename, never a path.
		expect(serialized).toContain('"runtimeExecutable":"bun.exe"');
	});
});

describe("formatSoakSummary", () => {
	it("leads with the verdict and the numbers a reviewer reads first", () => {
		expect(formatSoakSummary(buildSoakSummary(input()))).toContain("SOAK PASS");
		const failed = formatSoakSummary(
			buildSoakSummary(input({ failures: [{ code: "x", scope: "soak-0", reason: "because" }] })),
		);
		expect(failed).toContain("SOAK FAIL (1 reason(s))");
		expect(failed).toContain("bun=1.3.14");
		expect(failed).toContain("peakHostRss=");
	});
});
