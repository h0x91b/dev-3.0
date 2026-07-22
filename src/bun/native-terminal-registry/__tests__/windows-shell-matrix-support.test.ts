import { describe, expect, it } from "vitest";
import { waitForProcessesToExit } from "./windows-shell-matrix-support";

describe("Windows shell matrix process teardown", () => {
	it("waits for a descendant that exits after the recorded host and shell", async () => {
		let poll = 0;
		const survivors = await waitForProcessesToExit([101, 202, 303], {
			timeoutMs: 1_000,
			pollMs: 10,
			isAlive: (pid) => pid === 303 && poll < 2,
			sleep: async () => {
				poll++;
			},
			now: () => 0,
		});

		expect(survivors).toEqual([]);
		expect(poll).toBe(2);
	});

	it("returns the surviving PIDs when the teardown deadline expires", async () => {
		let now = 0;
		const survivors = await waitForProcessesToExit([101, 202, 303], {
			timeoutMs: 20,
			pollMs: 10,
			isAlive: (pid) => pid === 303,
			sleep: async (ms) => {
				now += ms;
			},
			now: () => now,
		});

		expect(survivors).toEqual([303]);
	});
});
