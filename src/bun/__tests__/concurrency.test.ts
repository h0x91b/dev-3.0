import { describe, it, expect } from "vitest";
import { Semaphore } from "../concurrency";

function deferred<T = void>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

describe("Semaphore", () => {
	it("never runs more than `max` tasks at once", async () => {
		const sem = new Semaphore(2);
		let active = 0;
		let peak = 0;
		const gates = [deferred(), deferred(), deferred(), deferred()];

		const runs = gates.map((g) =>
			sem.run(async () => {
				active += 1;
				peak = Math.max(peak, active);
				await g.promise;
				active -= 1;
			}),
		);

		// Let the first batch acquire slots.
		await Promise.resolve();
		await Promise.resolve();
		expect(peak).toBe(2);
		expect(sem.waiting).toBe(2);

		// Release one — a waiter should take the freed slot.
		gates[0].resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(peak).toBe(2);

		gates[1].resolve();
		gates[2].resolve();
		gates[3].resolve();
		await Promise.all(runs);
		expect(active).toBe(0);
		expect(sem.free).toBe(2);
	});

	it("releases the slot even when the task throws", async () => {
		const sem = new Semaphore(1);
		await expect(sem.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
		// Slot must be free again for the next caller.
		const result = await sem.run(async () => 42);
		expect(result).toBe(42);
		expect(sem.free).toBe(1);
	});

	it("coerces max to at least 1", async () => {
		const sem = new Semaphore(0);
		expect(sem.free).toBe(1);
		expect(await sem.run(async () => "ok")).toBe("ok");
	});

	it("preserves FIFO order among waiters", async () => {
		const sem = new Semaphore(1);
		const order: number[] = [];
		const block = deferred();

		const first = sem.run(async () => { await block.promise; order.push(0); });
		const second = sem.run(async () => { order.push(1); });
		const third = sem.run(async () => { order.push(2); });

		block.resolve();
		await Promise.all([first, second, third]);
		expect(order).toEqual([0, 1, 2]);
	});
});
