import { describe, expect, it } from "vitest";
import { FileLeaseTable } from "../../shared/file-leases";

const TTL = 10_000;

describe("FileLeaseTable", () => {
	it("gives a free file to the first task, refuses a second, refreshes the holder and frees it after the TTL", () => {
		const table = new FileLeaseTable(TTL);
		expect(table.claim("/f/a.md", "t1", "p", 0)).toEqual({ granted: true });
		expect(table.claim("/f/a.md", "t2", "p", 1_000)).toMatchObject({ granted: false, holder: { taskId: "t1" }, expiresAt: TTL });
		// The holder keeps editing and its lease is refreshed.
		expect(table.claim("/f/a.md", "t1", "p", 8_000)).toEqual({ granted: true });
		expect(table.claim("/f/a.md", "t2", "p", 12_000)).toMatchObject({ granted: false, expiresAt: 18_000 });
		// Untouched for the TTL, the file is free again.
		expect(table.claim("/f/a.md", "t2", "p", 8_000 + TTL)).toEqual({ granted: true });
	});

	it("never blocks two different files, and releases everything a task holds", () => {
		const table = new FileLeaseTable(TTL);
		table.claim("/f/a.md", "t1", "p", 0);
		expect(table.claim("/f/b.md", "t2", "p", 1)).toEqual({ granted: true });
		table.releaseTask("t1");
		expect(table.claim("/f/a.md", "t3", "p", 2)).toEqual({ granted: true });
	});
});
