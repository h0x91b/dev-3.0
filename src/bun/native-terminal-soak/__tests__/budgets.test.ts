import { describe, expect, it } from "vitest";
import { DEFAULT_JOURNAL_MAX_BYTES } from "../../native-terminal-registry/journal";
import {
	defaultSoakBudgets,
	deriveJournalCeilingBytes,
	deriveSnapshotCeilingBytes,
	evaluateSoakBudgets,
	growthPerCycle,
	theilSenSlope,
	MIN_GROWTH_CYCLES,
	tailGrowthPerCycle,
	tailWindow,
	type SoakCycleSample,
	type SoakObservations,
	type SoakSessionObservation,
} from "../budgets";

const MIB = 1024 * 1024;

function sample(overrides: Partial<SoakCycleSample> = {}): SoakCycleSample {
	return {
		cycle: 0,
		hostRssBytes: 200 * MIB,
		snapshotBytes: 1_000,
		journalBytes: 1_000,
		reconnectMs: 5,
		...overrides,
	};
}

/** A clean run: RSS flat, artefacts bounded, everything reaped. */
function healthyObservations(): SoakObservations {
	const cycles = Array.from({ length: MIN_GROWTH_CYCLES }, (_, index) =>
		sample({ cycle: index + 1, hostRssBytes: 200 * MIB, reconnectMs: 5 }),
	);
	const session: SoakSessionObservation = {
		sessionId: "soak-0",
		baseline: sample({ hostRssBytes: 70 * MIB }),
		sustained: sample({ hostRssBytes: 190 * MIB }),
		cycles,
		parserHealth: "live",
		droppedChunks: 0,
		droppedBytes: 0,
		droppedResizes: 0,
	};
	return {
		sessions: [session],
		clientRssByCycle: cycles.map(() => 100 * MIB),
		registryDirsBaseline: 2,
		registryDirsAfterChurn: 2,
		registryDirsFinal: 0,
		ownedPidsAliveAfterCrash: 0,
		ownedPidsAliveAfterTeardown: 0,
	};
}

const budgets = defaultSoakBudgets({ cols: 128, rows: 44 });

function codes(observations: SoakObservations): string[] {
	return evaluateSoakBudgets(observations, budgets)
		.map((failure) => failure.code)
		.sort();
}

describe("derived ceilings", () => {
	it("derives the journal ceiling from the writer's own cap", () => {
		expect(deriveJournalCeilingBytes()).toBeGreaterThan(DEFAULT_JOURNAL_MAX_BYTES);
		expect(deriveJournalCeilingBytes(1_000)).toBeLessThan(deriveJournalCeilingBytes(2_000));
	});

	it("derives the snapshot ceiling from geometry plus the scrollback cap", () => {
		const narrow = deriveSnapshotCeilingBytes({ cols: 80, rows: 24 });
		const wide = deriveSnapshotCeilingBytes({ cols: 200, rows: 60 });
		expect(wide).toBeGreaterThan(narrow);
		expect(deriveSnapshotCeilingBytes({ cols: 80, rows: 24, scrollbackCap: 0 })).toBeLessThan(narrow);
	});
});

describe("growth statistics", () => {
	it("takes the second half of the series as the tail", () => {
		expect(tailWindow([1, 2, 3, 4])).toEqual([3, 4]);
		expect(tailWindow([1, 2, 3, 4, 5])).toEqual([3, 4, 5]);
	});

	it("reads a real leak, an allocator staircase, and a Windows sawtooth correctly", () => {
		// A monotone leak: the trend IS the per-cycle cost.
		expect(theilSenSlope([200, 205, 210, 215, 220, 225, 230, 235])).toBe(5);
		// macOS staircase: one step, then a plateau that dominates the window.
		expect(theilSenSlope([229, 229, 264, 264, 264, 264, 264, 264, 264, 264, 264, 264])).toBe(0);
		// HONEST LIMIT: one step dead-centre of a SHORT window is genuinely
		// indistinguishable from a slow leak, and is reported as growth. That is why
		// the tail window has a floor and the documented default runs 24 cycles.
		expect(theilSenSlope([229, 229, 229, 229, 264, 264, 264, 264])).toBeGreaterThan(4);
		// Windows working-set sawtooth, measured on real hardware: ends BELOW cycle 1.
		const sawtooth = [173.7, 213.9, 138.4, 167.6, 156.6, 181.0, 134.2, 166.3, 155.6, 181.2, 133.8, 133.2, 157.4, 181.3, 134.4, 132.8];
		expect(theilSenSlope(sawtooth)).toBeLessThan(1);
		// The endpoint mean cannot tell a staircase from a leak nearly as well.
		expect(growthPerCycle([200, 200, 200, 220, 220, 220, 220, 220])).toBeCloseTo(2.857, 2);
	});

	it("refuses to judge growth on a run that is too short", () => {
		expect(tailGrowthPerCycle([1, 2, 3, 4])).toBeNull();
		expect(tailGrowthPerCycle(Array.from({ length: MIN_GROWTH_CYCLES - 1 }, () => 1))).toBeNull();
		expect(tailGrowthPerCycle(Array.from({ length: MIN_GROWTH_CYCLES }, () => 1))).toBe(0);
	});
});

describe("evaluateSoakBudgets", () => {
	it("passes a clean run", () => {
		expect(evaluateSoakBudgets(healthyObservations(), budgets)).toEqual([]);
	});

	it("refuses to certify a run with too few reconnect cycles", () => {
		const observations = healthyObservations();
		observations.sessions[0]!.cycles = observations.sessions[0]!.cycles.slice(0, 3);
		observations.clientRssByCycle = observations.clientRssByCycle.slice(0, 3);
		expect(codes(observations)).toContain("growth-unmeasurable");
	});

	it("flags a host RSS peak far above the saturated state", () => {
		const observations = healthyObservations();
		observations.sessions[0]!.cycles[5]!.hostRssBytes = 2_000 * MIB;
		expect(codes(observations)).toContain("host-rss-peak");
	});

	it("flags steady per-cycle host and client retention", () => {
		const observations = healthyObservations();
		observations.sessions[0]!.cycles = observations.sessions[0]!.cycles.map((entry, index) => ({
			...entry,
			hostRssBytes: (200 + index * 10) * MIB,
		}));
		observations.clientRssByCycle = observations.clientRssByCycle.map((_, index) => (100 + index * 10) * MIB);
		expect(codes(observations)).toEqual(expect.arrayContaining(["host-rss-growth", "client-rss-growth"]));
	});

	it("flags unbounded on-disk artefacts", () => {
		const observations = healthyObservations();
		observations.sessions[0]!.sustained.journalBytes = budgets.journalCeilingBytes + 1;
		observations.sessions[0]!.sustained.snapshotBytes = budgets.snapshotCeilingBytes + 1;
		expect(codes(observations)).toEqual(expect.arrayContaining(["journal-size", "snapshot-size"]));
	});

	it("flags a degraded parser and a dropping queue", () => {
		const observations = healthyObservations();
		observations.sessions[0]!.parserHealth = "overflowed";
		observations.sessions[0]!.droppedChunks = 3;
		expect(codes(observations)).toEqual(expect.arrayContaining(["parser-health", "queue-overflow"]));
	});

	it("flags slow and degrading reconnects", () => {
		const slow = healthyObservations();
		slow.sessions[0]!.cycles[0]!.reconnectMs = budgets.reconnectCeilingMs + 1;
		expect(codes(slow)).toContain("reconnect-latency");

		const degrading = healthyObservations();
		degrading.sessions[0]!.cycles = degrading.sessions[0]!.cycles.map((entry, index) => ({
			...entry,
			reconnectMs: 5 + index * 500,
		}));
		expect(codes(degrading)).toContain("reconnect-degradation");
	});

	it("flags leaked registry state and surviving owned processes", () => {
		const observations = healthyObservations();
		observations.registryDirsAfterChurn = 5;
		observations.registryDirsFinal = 1;
		observations.ownedPidsAliveAfterCrash = 1;
		observations.ownedPidsAliveAfterTeardown = 2;
		expect(codes(observations)).toEqual(
			expect.arrayContaining(["registry-churn-leak", "registry-teardown-leak", "crash-process-leak", "teardown-process-leak"]),
		);
	});

	it("says so when no host memory sample was ever published", () => {
		const observations = healthyObservations();
		observations.sessions[0]!.baseline.hostRssBytes = null;
		observations.sessions[0]!.sustained.hostRssBytes = null;
		observations.sessions[0]!.cycles = observations.sessions[0]!.cycles.map((entry) => ({ ...entry, hostRssBytes: null }));
		expect(codes(observations)).toContain("host-rss-missing");
	});

	it("gives every failure an actionable reason", () => {
		const observations = healthyObservations();
		observations.sessions[0]!.parserHealth = "failed";
		for (const failure of evaluateSoakBudgets(observations, budgets)) {
			expect(failure.reason.length).toBeGreaterThan(20);
			expect(failure.scope.length).toBeGreaterThan(0);
		}
	});
});
