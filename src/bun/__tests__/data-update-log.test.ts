import { describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../paths", () => ({ DEV3_HOME: `${process.env.DEV3_TEST_ROOT}/data-update-log` }));

import { summarizeTaskUpdate } from "../data";

describe("summarizeTaskUpdate", () => {
	it("logs field names and the status, never the values", () => {
		const summary = summarizeTaskUpdate("task-1", {
			status: "review-by-user",
			prNumber: 7,
			prStatusCache: { checks: [{ name: "lint", detailsUrl: "https://example.test/run/1" }] } as never,
		});

		expect(summary).toEqual({ taskId: "task-1", fields: ["status", "prNumber", "prStatusCache"], status: "review-by-user" });
		expect(JSON.stringify(summary)).not.toContain("example.test");
	});

	it("omits status when the update does not touch it", () => {
		expect(summarizeTaskUpdate("task-1", { prNumber: 7 })).toEqual({ taskId: "task-1", fields: ["prNumber"] });
	});
});
