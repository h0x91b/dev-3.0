/**
 * The watch's STATE MACHINE, which is where the pure quiet-window reducer cannot
 * help: what counts as a failed attempt, what a dead feed is allowed to erase, and
 * whether a push nobody received counts as announced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanResult } from "../self-update";
import type { UpdatePlan } from "../../shared/self-update";

vi.mock("../self-update", () => ({
	buildPlan: vi.fn(),
	runSelfUpdate: vi.fn(),
	stageUpdate: vi.fn(),
}));
vi.mock("../settings", () => ({
	loadSettings: vi.fn(async () => ({ updateChannel: "stable", remoteSilentUpdate: true })),
}));
vi.mock("../remote-state", () => ({
	readRemoteState: vi.fn(() => null),
	recordUpdateFailure: vi.fn(),
}));
vi.mock("../data", () => ({
	loadProjects: vi.fn(async () => []),
	loadVirtualProjects: vi.fn(async () => []),
	loadTasks: vi.fn(async () => []),
}));
vi.mock("../pty-server", () => ({ getActiveSessionIds: vi.fn(() => []) }));
vi.mock("../remote-access-server", () => ({ getConnectedClientCount: vi.fn(() => 0) }));

import { buildPlan, runSelfUpdate, stageUpdate } from "../self-update";
import { readRemoteState, recordUpdateFailure } from "../remote-state";
import { getConnectedClientCount } from "../remote-access-server";
import { loadSettings } from "../settings";
import { checkOnce, _resetWatchState } from "../self-update-watch";
import { QUIET_HOLD_MS } from "../../shared/self-update";

const mockBuildPlan = vi.mocked(buildPlan);
const mockRun = vi.mocked(runSelfUpdate);
const mockStage = vi.mocked(stageUpdate);
const mockReadState = vi.mocked(readRemoteState);
const mockRecordFailure = vi.mocked(recordUpdateFailure);
const mockClients = vi.mocked(getConnectedClientCount);
const mockSettings = vi.mocked(loadSettings);

const TARBALL: UpdatePlan = { kind: "tarball", version: "1.46.0", url: "https://example.invalid/x.tar.gz" };

function planResult(plan: UpdatePlan, checkError?: string): PlanResult {
	return {
		install: "tarball",
		plan,
		runningVersion: "1.45.0",
		summary: "summary",
		...(checkError ? { checkError } : {}),
	};
}

/**
 * Two ticks with the quiet hold served in between — one tick can never apply,
 * because the first quiet moment only STARTS the 10-minute clock.
 */
async function tickPastTheHold(push: () => void = vi.fn()): Promise<void> {
	await checkOnce(push);
	vi.setSystemTime(Date.now() + QUIET_HOLD_MS + 1_000);
	await checkOnce(push);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));
	_resetWatchState();
	mockSettings.mockResolvedValue({ updateChannel: "stable", remoteSilentUpdate: true } as never);
	mockReadState.mockReturnValue(null);
	mockClients.mockReturnValue(0);
	mockStage.mockResolvedValue({ ok: true, staged: { plan: TARBALL } });
	mockRun.mockResolvedValue({ ok: true, restarting: true, message: "restarting" });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a failed update CHECK", () => {
	// buildPlan turns a network error into a refusal. Lumping that in with "this
	// install can never update" cleared the pending clock, which then reset the
	// backoff, the give-up and the 72h ceiling — so a flaky uplink made every guard
	// unreachable.
	it("does not erase a pending version or its failure count", async () => {
		mockBuildPlan.mockResolvedValue(planResult(TARBALL));
		mockRun.mockResolvedValue({ ok: false, restarting: false, message: "tar extract failed" });
		await tickPastTheHold();
		expect(mockRecordFailure).toHaveBeenCalledWith("1.46.0", "tar extract failed");

		mockBuildPlan.mockResolvedValueOnce(
			planResult({ kind: "refused", reason: "Update check failed: ETIMEDOUT" }, "ETIMEDOUT"),
		);
		await checkOnce(vi.fn());

		// A later tick must still be inside the backoff — proof the counter survived
		// the blip instead of being reset to zero by it.
		mockRun.mockClear();
		await tickPastTheHold();
		expect(mockRun).not.toHaveBeenCalled();
	});

	it("does not attempt anything on the blip tick itself", async () => {
		mockBuildPlan.mockResolvedValue(
			planResult({ kind: "refused", reason: "Update check failed: ETIMEDOUT" }, "ETIMEDOUT"),
		);
		await checkOnce(vi.fn());
		expect(mockRun).not.toHaveBeenCalled();
		expect(mockStage).not.toHaveBeenCalled();
	});
});

describe("what counts as a failed attempt", () => {
	it("does NOT count a refusal — nothing was attempted", async () => {
		mockBuildPlan.mockResolvedValue(planResult(TARBALL));
		mockRun.mockResolvedValue({ ok: false, refused: true, restarting: false, message: "no supervisor" });

		await tickPastTheHold();
		vi.setSystemTime(Date.now() + QUIET_HOLD_MS + 1_000);
		await checkOnce(vi.fn());

		expect(mockRecordFailure).not.toHaveBeenCalled();
		// Still trying after a refusal: it must not spend the budget or start a backoff.
		expect(mockRun).toHaveBeenCalledTimes(2);
	});

	it("counts a real stage/apply failure and persists it", async () => {
		mockBuildPlan.mockResolvedValue(planResult(TARBALL));
		mockRun.mockResolvedValue({ ok: false, restarting: false, message: "HTTP 404" });

		await tickPastTheHold();

		expect(mockRecordFailure).toHaveBeenCalledWith("1.46.0", "HTTP 404");
	});

	// The rollback case: the counter is on disk because the process that held it in
	// memory is gone.
	it("honours a failure count recorded by a previous process", async () => {
		mockBuildPlan.mockResolvedValue(planResult(TARBALL));
		mockReadState.mockReturnValue({
			pid: 1,
			port: 1,
			socketPath: "/tmp/s",
			tunnelRequested: false,
			staticCode: null,
			logFile: null,
			startedAt: "",
			version: "",
			updateAttempts: { version: "1.46.0", failures: 5, lastFailureMs: Date.now() },
		});

		await tickPastTheHold();

		expect(mockRun).not.toHaveBeenCalled();
	});

	it("ignores a count left behind for a different version", async () => {
		mockBuildPlan.mockResolvedValue(planResult(TARBALL));
		mockReadState.mockReturnValue({
			pid: 1,
			port: 1,
			socketPath: "/tmp/s",
			tunnelRequested: false,
			staticCode: null,
			logFile: null,
			startedAt: "",
			version: "",
			updateAttempts: { version: "1.40.0", failures: 5, lastFailureMs: Date.now() },
		});

		await tickPastTheHold();

		expect(mockRun).toHaveBeenCalled();
	});
});

describe("announcing the plaque", () => {
	// A headless box normally has zero clients, and a push with no audience is
	// dropped — but the version was marked announced anyway, so the plaque never
	// appeared again for the life of the process.
	it("does not burn the announcement when nobody is connected", async () => {
		mockBuildPlan.mockResolvedValue(planResult(TARBALL));
		mockSettings.mockResolvedValue({ updateChannel: "stable", remoteSilentUpdate: false } as never);

		const push = vi.fn();
		await checkOnce(push);
		expect(push).not.toHaveBeenCalled();

		mockClients.mockReturnValue(1);
		await checkOnce(push);
		expect(push).toHaveBeenCalledWith("updateAvailable", { version: "1.46.0" });
	});

	it("announces a version only once to a connected browser", async () => {
		mockBuildPlan.mockResolvedValue(planResult(TARBALL));
		mockSettings.mockResolvedValue({ updateChannel: "stable", remoteSilentUpdate: false } as never);
		mockClients.mockReturnValue(2);

		const push = vi.fn();
		await checkOnce(push);
		await checkOnce(push);

		expect(push).toHaveBeenCalledTimes(1);
	});
});

describe("pre-staging", () => {
	// The Restart button runs the whole update inside one RPC call the renderer
	// abandons after 120 s. Without a warm tree it toasts a failure for an update
	// that then succeeds.
	it("fetches the release before anyone can press Restart, even with silent updates off", async () => {
		mockBuildPlan.mockResolvedValue(planResult(TARBALL));
		mockSettings.mockResolvedValue({ updateChannel: "stable", remoteSilentUpdate: false } as never);

		await checkOnce(vi.fn());

		expect(mockStage).toHaveBeenCalledWith(TARBALL);
		expect(mockRun).not.toHaveBeenCalled();
	});

	it("stages a given version once, not on every tick", async () => {
		mockBuildPlan.mockResolvedValue(planResult(TARBALL));
		mockSettings.mockResolvedValue({ updateChannel: "stable", remoteSilentUpdate: false } as never);

		await checkOnce(vi.fn());
		await checkOnce(vi.fn());

		expect(mockStage).toHaveBeenCalledTimes(1);
	});

	it("carries on when pre-staging fails — the real attempt reports it", async () => {
		mockBuildPlan.mockResolvedValue(planResult(TARBALL));
		mockStage.mockResolvedValue({ ok: false, error: "HTTP 404" });

		await tickPastTheHold();

		expect(mockRun).toHaveBeenCalled();
	});
});
