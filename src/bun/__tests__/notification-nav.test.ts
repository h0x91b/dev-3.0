import { describe, it, expect, beforeEach } from "vitest";
import {
	markPendingNotificationNav,
	consumePendingNotificationNav,
	__resetPendingNotificationNavForTests,
} from "../notification-nav";

describe("pending notification navigation slot", () => {
	beforeEach(() => {
		__resetPendingNotificationNavForTests();
	});

	it("is empty by default", () => {
		expect(consumePendingNotificationNav()).toBeNull();
	});

	it("returns the marked target exactly once", () => {
		markPendingNotificationNav({ taskId: "t-1", projectId: "p-1" });
		expect(consumePendingNotificationNav()).toEqual({ taskId: "t-1", projectId: "p-1" });
		expect(consumePendingNotificationNav()).toBeNull();
	});

	it("keeps only the most recent target", () => {
		markPendingNotificationNav({ taskId: "t-1", projectId: "p-1" });
		markPendingNotificationNav({ taskId: "t-2", projectId: "p-2" });
		expect(consumePendingNotificationNav()).toEqual({ taskId: "t-2", projectId: "p-2" });
	});
});
