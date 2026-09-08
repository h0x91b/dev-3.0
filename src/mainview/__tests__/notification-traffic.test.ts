import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationLogPage, NotificationLogRow } from "../../shared/notification-log";

const readNotificationLog = vi.fn();
vi.mock("../rpc", () => ({ api: { request: { readNotificationLog: (...args: unknown[]) => readNotificationLog(...args) } } }));

import {
	getNotificationTrafficState,
	loadNotificationTraffic,
	noteNotificationArrival,
	resetNotificationTrafficStore,
	subscribeNotificationTraffic,
} from "../notification-traffic";

function row(message: string): NotificationLogRow {
	return {
		v: 1, at: "2026-09-07T10:00:00.000Z", mode: "toast", level: "info", message,
		taskId: null, taskSeq: null, projectId: null, sourceTaskId: null, sourceSeq: null,
		outcome: "delivered",
	};
}

function page(rows: NotificationLogRow[], overrides: Partial<NotificationLogPage> = {}): NotificationLogPage {
	return {
		rows,
		oldestDay: rows.length ? "2026-09-07" : null,
		newestDay: rows.length ? "2026-09-07" : null,
		retentionDays: 30,
		hasMore: false,
		...overrides,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	readNotificationLog.mockReset();
	resetNotificationTrafficStore();
});
afterEach(() => vi.useRealTimers());

describe("notification traffic store", () => {
	it("an archive that was never written reads as a null day range, not as an error", async () => {
		readNotificationLog.mockResolvedValue(page([]));
		await loadNotificationTraffic();
		const state = getNotificationTrafficState();
		expect(state).toMatchObject({ rows: [], oldestDay: null, newestDay: null, loaded: true, error: false });
	});

	it("passes the project allowlist through to the read, and omits it when there is none", async () => {
		readNotificationLog.mockResolvedValue(page([]));
		await loadNotificationTraffic({ limit: 10, projectIds: ["proj-1"] });
		expect(readNotificationLog).toHaveBeenLastCalledWith({ limit: 10, projectIds: ["proj-1"] });
		await loadNotificationTraffic({ projectIds: null });
		expect(readNotificationLog).toHaveBeenLastCalledWith({ limit: 10 });
	});

	it("ignores a slow reply that a newer load already superseded", async () => {
		let releaseFirst: (value: NotificationLogPage) => void = () => {};
		readNotificationLog.mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve; }));
		readNotificationLog.mockResolvedValueOnce(page([row("second")]));
		const first = loadNotificationTraffic();
		const second = loadNotificationTraffic();
		await second;
		releaseFirst(page([row("first")]));
		await first;
		expect(getNotificationTrafficState().rows.map(item => item.message)).toEqual(["second"]);
	});

	it("keeps what is on screen when the read fails, and says so", async () => {
		readNotificationLog.mockResolvedValueOnce(page([row("kept")]));
		await loadNotificationTraffic();
		readNotificationLog.mockRejectedValueOnce(new Error("transport"));
		await loadNotificationTraffic();
		const state = getNotificationTrafficState();
		expect(state.rows.map(item => item.message)).toEqual(["kept"]);
		expect(state.error).toBe(true);
	});

	it("coalesces a burst of appends into one re-read", async () => {
		readNotificationLog.mockResolvedValue(page([row("a")]));
		await loadNotificationTraffic();
		readNotificationLog.mockClear();
		for (let index = 0; index < 5; index += 1) noteNotificationArrival();
		await vi.advanceTimersByTimeAsync(200);
		expect(readNotificationLog).toHaveBeenCalledTimes(1);
	});

	it("a re-read after an append keeps the last query rather than resetting it", async () => {
		readNotificationLog.mockResolvedValue(page([]));
		await loadNotificationTraffic({ limit: 42, projectIds: ["proj-1"] });
		readNotificationLog.mockClear();
		noteNotificationArrival();
		await vi.advanceTimersByTimeAsync(200);
		expect(readNotificationLog).toHaveBeenCalledWith({ limit: 42, projectIds: ["proj-1"] });
	});

	it("notifies subscribers on every state change", async () => {
		const listener = vi.fn();
		subscribeNotificationTraffic(listener);
		readNotificationLog.mockResolvedValue(page([row("a")]));
		await loadNotificationTraffic();
		// One for the loading flag, one for the answer.
		expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);
	});
});
