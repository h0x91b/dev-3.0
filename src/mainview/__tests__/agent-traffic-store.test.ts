import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessageLogPage } from "../../shared/agent-message-log";
import { getTrafficState, loadTraffic, noteTrafficArrival, resetTrafficStore } from "../agent-traffic";
import { api } from "../rpc";

vi.mock("../rpc", () => ({ api: { request: { readAgentMessageLog: vi.fn() } } }));

const page = (oldestDay: string): AgentMessageLogPage => ({ rows: [], oldestDay, retentionDays: 30, hasMore: false });

afterEach(() => {
	resetTrafficStore();
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe("traffic store", () => {
	it("keeps the newer response when an older read finishes last", async () => {
		let finishOld!: (value: AgentMessageLogPage) => void;
		vi.spyOn(api.request, "readAgentMessageLog")
			.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
			.mockResolvedValueOnce(page("2026-09-05"));
		const old = loadTraffic("p");
		await loadTraffic("p");
		finishOld(page("2026-08-01"));
		await old;
		expect(getTrafficState("p").oldestDay).toBe("2026-09-05");
	});

	it("refreshes an expanded page once after a burst without reducing its limit", async () => {
		vi.useFakeTimers();
		const read = vi.spyOn(api.request, "readAgentMessageLog").mockResolvedValue(page("2026-09-05"));
		await loadTraffic("p", 2000);
		noteTrafficArrival("p");
		noteTrafficArrival("p");
		await vi.advanceTimersByTimeAsync(3000);
		expect(read).toHaveBeenCalledTimes(2);
		expect(read).toHaveBeenLastCalledWith({ projectId: "p", limit: 2000 });
	});

	it("reports transport failure while keeping the last readable page", async () => {
		vi.spyOn(api.request, "readAgentMessageLog").mockResolvedValueOnce(page("2026-09-05")).mockRejectedValueOnce(new Error("offline"));
		await loadTraffic("p");
		await loadTraffic("p");
		expect(getTrafficState("p")).toMatchObject({ oldestDay: "2026-09-05", error: true, loading: false });
	});
});
