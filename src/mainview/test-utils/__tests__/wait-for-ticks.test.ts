import { waitFor } from "@testing-library/react";
import { waitForTicks } from "../wait-for-ticks";

/** Blocks the event loop synchronously, the way a GC pause or a starved CI core does. */
function stall(ms: number): void {
	const until = performance.now() + ms;
	while (performance.now() < until) {
		/* busy */
	}
}

describe("waitForTicks", () => {
	it("returns the value as soon as the query stops throwing", async () => {
		let ready = false;
		setTimeout(() => {
			ready = true;
		}, 0);

		await expect(waitForTicks(() => {
			if (!ready) {
				throw new Error("not ready");
			}
			return "ready";
		})).resolves.toBe("ready");
	});

	it("settles a value gated behind a chain of macrotasks", async () => {
		let step = 0;
		const advance = () => {
			step += 1;
			if (step < 5) {
				setTimeout(advance, 0);
			}
		};
		setTimeout(advance, 0);

		await expect(waitForTicks(() => {
			if (step < 5) {
				throw new Error(`step ${step}`);
			}
			return step;
		})).resolves.toBe(5);
	});

	// The flake this helper exists for: a boot that needs several macrotask hops
	// on a machine where every hop is stalled, so the DOM settles *after*
	// waitFor's wall-clock budget has already expired (CI shard 5, TaskDiffViewer).
	// Scaled down 10x — 5 hops × 30ms against a 100ms budget — to keep it fast
	// while matching the semantics of a slow boot against waitFor's 1000ms.
	it("settles a boot whose hops outlast a wall-clock waitFor budget", async () => {
		const startStalledBoot = () => {
			let step = 0;
			const advance = () => {
				stall(30);
				step += 1;
				if (step < 5) {
					setTimeout(advance, 0);
				}
			};
			setTimeout(advance, 0);
			return () => {
				if (step < 5) {
					throw new Error("boot did not settle");
				}
				return "booted";
			};
		};

		await expect(waitFor(startStalledBoot(), { timeout: 100 })).rejects.toThrow(/boot did not settle/);
		await expect(waitForTicks(startStalledBoot())).resolves.toBe("booted");
	});

	it("throws the last query error once the tick budget runs out", async () => {
		await expect(waitForTicks(() => {
			throw new Error("never settles");
		}, 2)).rejects.toThrow("never settles");
	});
});
