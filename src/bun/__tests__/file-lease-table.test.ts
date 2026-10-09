import { describe, expect, it } from "vitest";
import { FileLeaseTable } from "../../shared/file-leases";

const TTL = 10_000;

describe("FileLeaseTable", () => {
	it("gives a free file to the first task and refuses a second one", () => {
		const table = new FileLeaseTable(TTL);
		expect(table.claim("/f/a.md", "t1", "p", 0)).toEqual({ granted: true });
		expect(table.claim("/f/a.md", "t2", "p", 1_000)).toMatchObject({ granted: false, holder: { taskId: "t1" }, expiresAt: TTL });
	});

	it("lets the holder keep editing and refreshes its lease", () => {
		const table = new FileLeaseTable(TTL);
		table.claim("/f/a.md", "t1", "p", 0);
		expect(table.claim("/f/a.md", "t1", "p", 8_000)).toEqual({ granted: true });
		expect(table.claim("/f/a.md", "t2", "p", 12_000)).toMatchObject({ granted: false, expiresAt: 18_000 });
	});

	it("frees a file once the holder has not touched it for the TTL", () => {
		const table = new FileLeaseTable(TTL);
		table.claim("/f/a.md", "t1", "p", 0);
		expect(table.claim("/f/a.md", "t2", "p", TTL)).toEqual({ granted: true });
	});

	it("never blocks two different files", () => {
		const table = new FileLeaseTable(TTL);
		table.claim("/f/a.md", "t1", "p", 0);
		expect(table.claim("/f/b.md", "t2", "p", 1)).toEqual({ granted: true });
	});

	it("releases everything a task holds", () => {
		const table = new FileLeaseTable(TTL);
		table.claim("/f/a.md", "t1", "p", 0);
		table.releaseTask("t1");
		expect(table.claim("/f/a.md", "t2", "p", 1)).toEqual({ granted: true });
	});
});
