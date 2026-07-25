import { act } from "@testing-library/react";

const DEFAULT_MAX_TICKS = 60;

/**
 * Tick-bounded alternative to RTL's `waitFor` for mount/boot assertions.
 *
 * `waitFor` gives up after 1000ms of *wall clock*, so a GC pause, a swapping
 * container or a contended CI runner fails a test that is merely slow. This
 * waiter yields real macrotasks instead and gives up after a bounded number of
 * them, so the only thing that can fail it is a DOM that never settles.
 *
 * Each tick flushes microtasks, pending `setTimeout(…, 0)` work and the React
 * effects they schedule — the exact chain a component boot runs through.
 */
export async function waitForTicks<T>(query: () => T, maxTicks: number = DEFAULT_MAX_TICKS): Promise<T> {
	let lastError: unknown;
	for (let tick = 0; tick <= maxTicks; tick += 1) {
		try {
			return query();
		} catch (err) {
			lastError = err;
		}
		await act(async () => {
			await new Promise<void>(resolve => {
				setTimeout(resolve, 0);
			});
		});
	}
	throw lastError;
}
