import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Electrobun's real Updater.checkForUpdate() overwrites its in-memory state
// with the parsed remote update.json, which only contains {version, hash} —
// so every check wipes the `updateReady` flag (issue #813). These mocks
// reproduce that exact behavior so the tests exercise the real failure mode.
const { mockUpdater, markQuitConfirmed } = vi.hoisted(() => ({
	mockUpdater: {
		localInfo: {
			version: vi.fn(async () => "1.29.0"),
			hash: vi.fn(async () => "aaaa1111aaaa1111"),
			channel: vi.fn(async () => "stable"),
		},
		updateInfo: vi.fn(),
		checkForUpdate: vi.fn(),
		downloadUpdate: vi.fn(),
		applyUpdate: vi.fn(),
	},
	markQuitConfirmed: vi.fn(),
}));

vi.mock("../electrobun-platform", () => ({
	Updater: mockUpdater,
	Utils: {},
	PATHS: {},
}));
vi.mock("../quit-manager", () => ({ markQuitConfirmed }));

import { applyUpdate, downloadUpdateForChannel, checkForUpdateWithChannel } from "../updater";

/** Remote state as Electrobun's checkForUpdate() returns it: no updateReady. */
const remoteState = {
	version: "1.30.0",
	hash: "bbbb2222bbbb2222",
	updateAvailable: true,
	updateReady: undefined as boolean | undefined,
	error: "",
};

describe("applyUpdate", () => {
	let ready: boolean;

	beforeEach(() => {
		vi.clearAllMocks();
		ready = false;
		mockUpdater.updateInfo.mockImplementation(() => ({ ...remoteState, updateReady: ready }));
		// checkForUpdate can never restore updateReady — update.json has no such field
		mockUpdater.checkForUpdate.mockImplementation(async () => {
			ready = false;
			return { ...remoteState };
		});
		// downloadUpdate finds the tar on disk (or re-downloads) and re-marks ready
		mockUpdater.downloadUpdate.mockImplementation(async () => {
			ready = true;
		});
	});

	it("recovers when updateReady was wiped by a later checkForUpdate (issue #813)", async () => {
		ready = false;

		await applyUpdate();

		expect(mockUpdater.downloadUpdate).toHaveBeenCalled();
		expect(mockUpdater.applyUpdate).toHaveBeenCalledOnce();
		expect(markQuitConfirmed).toHaveBeenCalledOnce();
	});

	it("re-validates the downloaded artifact even when updateReady is already true", async () => {
		// A newer release may have shipped since the download: the ready flag is
		// stale and Electrobun's applyUpdate would silently no-op on the missing
		// tar. The repair download must always run before applying.
		ready = true;

		await applyUpdate();

		expect(mockUpdater.downloadUpdate).toHaveBeenCalledOnce();
		expect(mockUpdater.applyUpdate).toHaveBeenCalledOnce();
		const dlOrder = mockUpdater.downloadUpdate.mock.invocationCallOrder[0];
		const applyOrder = mockUpdater.applyUpdate.mock.invocationCallOrder[0];
		expect(dlOrder).toBeLessThan(applyOrder);
	});

	it("throws and does not restart when the repair download fails to produce a ready update", async () => {
		ready = false;
		mockUpdater.downloadUpdate.mockImplementation(async () => {
			// download failed — ready flag stays false
		});

		await expect(applyUpdate()).rejects.toThrow("Update not ready");

		expect(mockUpdater.applyUpdate).not.toHaveBeenCalled();
		expect(markQuitConfirmed).not.toHaveBeenCalled();
	});

	it("propagates a repair download crash without restarting", async () => {
		ready = false;
		mockUpdater.downloadUpdate.mockRejectedValue(new Error("network down"));

		await expect(applyUpdate()).rejects.toThrow("network down");

		expect(mockUpdater.applyUpdate).not.toHaveBeenCalled();
		expect(markQuitConfirmed).not.toHaveBeenCalled();
	});
});

describe("downloadUpdateForChannel (same channel)", () => {
	let ready: boolean;

	beforeEach(() => {
		vi.clearAllMocks();
		ready = false;
		mockUpdater.updateInfo.mockImplementation(() => ({ ...remoteState, updateReady: ready }));
		mockUpdater.checkForUpdate.mockImplementation(async () => {
			ready = false;
			return { ...remoteState };
		});
		mockUpdater.downloadUpdate.mockImplementation(async () => {
			ready = true;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("reports ok when the download marks the update ready", async () => {
		const onProgress = vi.fn();

		const result = await downloadUpdateForChannel("stable", onProgress);

		expect(result.ok).toBe(true);
		expect(onProgress).toHaveBeenCalledWith("complete", 100);
	});

	it("never polls readiness via checkForUpdate — that call itself wipes the flag", async () => {
		vi.useFakeTimers();
		// Ready flag appears only after one poll interval (slow propagation)
		mockUpdater.downloadUpdate.mockImplementation(async () => {
			setTimeout(() => {
				ready = true;
			}, 400);
		});

		const promise = downloadUpdateForChannel("stable", vi.fn());
		await vi.advanceTimersByTimeAsync(2000);
		const result = await promise;

		expect(result.ok).toBe(true);
		// Exactly one check (the initial state-populating one) — polling must
		// use updateInfo(), because checkForUpdate resets updateReady.
		expect(mockUpdater.checkForUpdate).toHaveBeenCalledOnce();
	});
});

describe("dev channel guard", () => {
	// Running from source builds the app on the "dev" channel. Electrobun's
	// built-in updater disables updates on dev: checkForUpdate() early-returns
	// WITHOUT initializing its module-level updateInfo, so a later
	// downloadUpdate() dereferences undefined ("updateInfo.error = …") and
	// throws a TypeError. Our flow must never reach that call on dev.
	beforeEach(() => {
		vi.clearAllMocks();
		mockUpdater.localInfo.channel.mockResolvedValue("dev");
		mockUpdater.checkForUpdate.mockImplementation(async () => {
			throw new TypeError("undefined is not an object (evaluating 'updateInfo.error = ...')");
		});
		mockUpdater.downloadUpdate.mockImplementation(async () => {
			throw new TypeError("undefined is not an object (evaluating 'updateInfo.error = ...')");
		});
	});

	afterEach(() => {
		mockUpdater.localInfo.channel.mockResolvedValue("stable");
		vi.restoreAllMocks();
	});

	it("checkForUpdateWithChannel reports devBuild without hitting the network", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		const result = await checkForUpdateWithChannel("stable");

		expect(result.devBuild).toBe(true);
		expect(result.updateAvailable).toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("downloadUpdateForChannel refuses to touch the built-in updater on dev", async () => {
		const result = await downloadUpdateForChannel("stable", vi.fn());

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/dev/i);
		// The crashing Electrobun calls must never run.
		expect(mockUpdater.checkForUpdate).not.toHaveBeenCalled();
		expect(mockUpdater.downloadUpdate).not.toHaveBeenCalled();
	});
});

describe("updater single-flight lock", () => {
	it("applyUpdate waits for an in-flight download instead of racing it", async () => {
		vi.clearAllMocks();
		let ready = false;
		mockUpdater.updateInfo.mockImplementation(() => ({ ...remoteState, updateReady: ready }));
		mockUpdater.checkForUpdate.mockImplementation(async () => {
			ready = false;
			return { ...remoteState };
		});

		let releaseDownload!: () => void;
		const firstDownload = new Promise<void>((resolve) => {
			releaseDownload = () => {
				ready = true;
				resolve();
			};
		});
		mockUpdater.downloadUpdate.mockImplementationOnce(() => firstDownload);
		mockUpdater.downloadUpdate.mockImplementation(async () => {
			ready = true;
		});

		const downloadPromise = downloadUpdateForChannel("stable", vi.fn());
		// Let the download reach the blocked downloadUpdate() call
		await new Promise((r) => setTimeout(r, 10));

		const applyPromise = applyUpdate();
		await new Promise((r) => setTimeout(r, 10));

		// While the download is blocked, apply must not have restarted the app
		expect(mockUpdater.applyUpdate).not.toHaveBeenCalled();

		releaseDownload();
		await downloadPromise;
		await applyPromise;

		expect(mockUpdater.applyUpdate).toHaveBeenCalledOnce();
	});
});
