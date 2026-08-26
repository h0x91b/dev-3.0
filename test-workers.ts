import { availableParallelism } from "node:os";

/**
 * `bun run test` starts three vitest processes at once and each one defaults to
 * `availableParallelism() - 1` workers, so the box gets ~3 workers per core and the
 * suite starves itself into timeouts. `DEV3_TEST_CONCURRENT=1` (set by those scripts
 * only) hands each process a share of ONE budget instead.
 *
 * The budget is deliberately quieter than the box can take — the machine stays usable
 * while the suite runs, and that is worth more than the wall-clock it costs. Numbers,
 * and why the shares are uneven: `decisions/2026/08/27/cap-total-vitest-worker-count.md`.
 */
export type TestSuite = "mainview" | "bun" | "cli";

/** The budget measured and chosen on a 16-core machine, scaled linearly from there. */
const MEASURED_CORES = 16;
const MEASURED_BUDGET = 9;

/** Relative weight of each suite, roughly its share of the repo's test files. */
const SUITE_WEIGHTS: Record<TestSuite, number> = { mainview: 7, bun: 7, cli: 2 };
const TOTAL_WEIGHT = Object.values(SUITE_WEIGHTS).reduce((sum, weight) => sum + weight, 0);

export function concurrentBudget(cores: number = availableParallelism()): number {
	return Math.max(3, Math.round((cores * MEASURED_BUDGET) / MEASURED_CORES));
}

export function concurrentShare(
	suite: TestSuite,
	cores: number = availableParallelism(),
): number {
	const budget = concurrentBudget(cores);
	const weighted = (name: TestSuite) =>
		Math.max(1, Math.round((budget * SUITE_WEIGHTS[name]) / TOTAL_WEIGHT));

	if (suite !== "cli") return weighted(suite);
	// cli takes the remainder, so the three shares always sum to exactly the budget.
	return Math.max(1, budget - weighted("mainview") - weighted("bun"));
}

/**
 * `undefined` means "keep the vitest default": a solo `test:bun` / `test:cli`, watch
 * mode, and CI (three sequential steps, one vitest at a time) all keep it.
 */
export function resolveMaxWorkers(
	suite: TestSuite,
	env: NodeJS.ProcessEnv = process.env,
): number | undefined {
	const override = Number.parseInt(env.DEV3_TEST_MAX_WORKERS ?? "", 10);
	if (Number.isFinite(override) && override > 0) return override;
	return env.DEV3_TEST_CONCURRENT ? concurrentShare(suite) : undefined;
}
