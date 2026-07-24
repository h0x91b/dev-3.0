/**
 * The native adapter's corpus partition must account for EVERY scenario — the
 * single-view scenarios it runs, the multi-view scenarios it defers, the pure
 * scenarios, and the documented gaps must together equal the whole corpus with
 * no overlaps. This is the enforced "record exactly what is deferred" guard: a
 * new corpus scenario fails this test until it is explicitly classified.
 */
import { describe, expect, it } from "vitest";
import { PARITY_CORPUS, getScenario } from "../../terminal-parity/corpus";
import {
	NATIVE_DEFERRED_MULTI_VIEW_SCENARIOS,
	NATIVE_GAP_SCENARIOS,
	NATIVE_PURE_SCENARIOS,
	NATIVE_SINGLE_VIEW_LIVE_SCENARIOS,
} from "../scenario-partition";

const sorted = (ids: readonly string[]): string[] => [...ids].sort();
const idsByMode = (mode: string): string[] =>
	sorted(PARITY_CORPUS.filter((s) => s.verification.mode === mode).map((s) => s.id));

describe("native adapter scenario partition", () => {
	it("runs + defers exactly the corpus's live scenarios (disjoint, complete)", () => {
		const run = NATIVE_SINGLE_VIEW_LIVE_SCENARIOS;
		const deferred = NATIVE_DEFERRED_MULTI_VIEW_SCENARIOS;
		expect(sorted([...run, ...deferred])).toEqual(idsByMode("live"));
		const overlap = run.filter((id) => (deferred as readonly string[]).includes(id));
		expect(overlap).toEqual([]);
	});

	it("maps the pure and gap scenarios to the corpus exactly", () => {
		expect(sorted(NATIVE_PURE_SCENARIOS)).toEqual(idsByMode("pure"));
		expect(sorted(NATIVE_GAP_SCENARIOS)).toEqual(idsByMode("gap"));
	});

	it("classifies every corpus scenario exactly once across the four buckets", () => {
		const all = sorted([
			...NATIVE_SINGLE_VIEW_LIVE_SCENARIOS,
			...NATIVE_DEFERRED_MULTI_VIEW_SCENARIOS,
			...NATIVE_PURE_SCENARIOS,
			...NATIVE_GAP_SCENARIOS,
		]);
		expect(all).toEqual(sorted(PARITY_CORPUS.map((s) => s.id)));
		expect(new Set(all).size).toBe(all.length);
	});

	it("references only real scenarios with the expected verification mode", () => {
		for (const id of [...NATIVE_SINGLE_VIEW_LIVE_SCENARIOS, ...NATIVE_DEFERRED_MULTI_VIEW_SCENARIOS]) {
			expect(getScenario(id).verification.mode).toBe("live");
		}
		for (const id of NATIVE_PURE_SCENARIOS) expect(getScenario(id).verification.mode).toBe("pure");
		for (const id of NATIVE_GAP_SCENARIOS) expect(getScenario(id).verification.mode).toBe("gap");
	});
});
