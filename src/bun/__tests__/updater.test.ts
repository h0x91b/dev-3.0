import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
		getStatusHistory: vi.fn(() => [] as { status: string; message: string; details?: object }[]),
		onStatusChange: vi.fn(),
	},
	markQuitConfirmed: vi.fn(),
}));

vi.mock("../electrobun-platform", () => ({
	Updater: mockUpdater,
	Utils: {},
	PATHS: {},
}));
vi.mock("../quit-manager", () => ({ markQuitConfirmed }));

import {
	applyUpdate,
	attachUpdaterStatusLog,
	describeReturnedApply,
	macBundleReplaceBlocker,
	resetUpdaterStatusLogForTests,
	downloadUpdateForChannel,
	checkForUpdateWithChannel,
	startAutoCheck,
	markUpdateReady,
	clearReadyUpdate,
	isUpdateAlreadyReady,
	shouldRemindAboutReadyUpdate,
	READY_REMINDER_INTERVAL_MS,
} from "../updater";

/** Remote state as Electrobun's checkForUpdate() returns it: no updateReady. */
const remoteState = {
	version: "1.30.0",
	hash: "bbbb2222bbbb2222",
	updateAvailable: true,
	updateReady: undefined as boolean | undefined,
	error: "",
};

// downloadUpdateForChannel records the downloaded version in module state (the
// #1072 re-download guard) — reset it so tests stay independent.
// A successful Electrobun apply ends in quit(), which kills the process and never returns.
// The mock stands in for that with a rejection, so "reached quit" is observable.
const QUIT = new Error("process exited via quit()");

function setPlatform(platform: NodeJS.Platform, execPath = process.execPath) {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	Object.defineProperty(process, "execPath", { value: execPath, configurable: true });
}
const realPlatform = process.platform;
const realExecPath = process.execPath;

// The macOS apply pre-flight walks the bundle around process.execPath; tests opt into it.
beforeEach(() => {
	clearReadyUpdate();
	setPlatform("linux");
});
afterEach(() => setPlatform(realPlatform, realExecPath));

describe("applyUpdate", () => {
	let ready: boolean;

	beforeEach(() => {
		vi.clearAllMocks();
		mockUpdater.applyUpdate.mockRejectedValue(QUIT);
		mockUpdater.getStatusHistory.mockReturnValue([]);
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

		await expect(applyUpdate()).rejects.toBe(QUIT);

		expect(mockUpdater.downloadUpdate).toHaveBeenCalled();
		expect(mockUpdater.applyUpdate).toHaveBeenCalledOnce();
		expect(markQuitConfirmed).toHaveBeenCalledOnce();
	});

	it("re-validates the downloaded artifact even when updateReady is already true", async () => {
		// A newer release may have shipped since the download: the ready flag is
		// stale and Electrobun's applyUpdate would silently no-op on the missing
		// tar. The repair download must always run before applying.
		ready = true;

		await expect(applyUpdate()).rejects.toBe(QUIT);

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

	it("reports Electrobun's swallowed swap error instead of resolving into an endless Restarting…", async () => {
		// Electrobun's macOS applyUpdate catches a failed rmSync/renameSync, emits an
		// "error" status and RETURNS — the UI used to keep spinning forever.
		mockUpdater.applyUpdate.mockResolvedValue(undefined);
		mockUpdater.getStatusHistory.mockReturnValue([
			{ status: "applying", message: "Starting update installation..." },
			{ status: "replacing-app", message: "Removing old version..." },
			{
				status: "error",
				message: "Failed to replace app: EACCES: permission denied",
				details: { errorMessage: "EACCES: permission denied, rmdir '/Applications/dev-3.0.app'" },
			},
		]);

		await expect(applyUpdate()).rejects.toThrow("EACCES: permission denied, rmdir '/Applications/dev-3.0.app'");
	});

	it("refuses before downloading anything when macOS runs the app from App Translocation", async () => {
		setPlatform("darwin", "/private/var/folders/xy/T/AppTranslocation/0A1B/d/dev-3.0.app/Contents/MacOS/bun");

		await expect(applyUpdate()).rejects.toThrow("App Translocation");

		expect(mockUpdater.downloadUpdate).not.toHaveBeenCalled();
		expect(mockUpdater.applyUpdate).not.toHaveBeenCalled();
		expect(markQuitConfirmed).not.toHaveBeenCalled();
	});
});

describe("describeReturnedApply", () => {
	it("names the restart, not a failure, when the swap completed but quit was vetoed", () => {
		expect(describeReturnedApply([{ status: "complete", message: "Update complete" }])).toContain(
			"could not restart itself",
		);
	});

	it("names the step it stopped at when no error was emitted", () => {
		expect(describeReturnedApply([{ status: "extracting", message: "Extracting" }])).toContain('"extracting"');
	});

	it("still explains an empty history", () => {
		expect(describeReturnedApply([])).toContain("without reporting why");
	});
});

describe("macBundleReplaceBlocker", () => {
	let root: string;
	// Root ignores permission bits, so the not-writable case cannot be set up there.
	const isRoot = process.getuid?.() === 0;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-bundle-"));
		mkdirSync(join(root, "dev-3.0.app", "Contents", "Resources"), { recursive: true });
	});

	afterEach(() => {
		chmodSync(join(root, "dev-3.0.app", "Contents"), 0o755);
		rmSync(root, { recursive: true, force: true });
	});

	it("passes a bundle the user fully owns", () => {
		expect(macBundleReplaceBlocker(join(root, "dev-3.0.app"))).toBeNull();
	});

	it.skipIf(isRoot)("names the first directory rmSync would choke on", () => {
		chmodSync(join(root, "dev-3.0.app", "Contents"), 0o555);

		expect(macBundleReplaceBlocker(join(root, "dev-3.0.app"))).toContain(join(root, "dev-3.0.app", "Contents"));
	});

	it("flags App Translocation without touching the disk", () => {
		expect(macBundleReplaceBlocker("/private/var/folders/a/T/AppTranslocation/X/d/dev-3.0.app")).toContain(
			"/Applications",
		);
	});
});

describe("attachUpdaterStatusLog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetUpdaterStatusLogForTests();
	});

	it("subscribes once to Electrobun's status feed", () => {
		attachUpdaterStatusLog();
		attachUpdaterStatusLog();

		expect(mockUpdater.onStatusChange).toHaveBeenCalledOnce();
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
		mockUpdater.applyUpdate.mockRejectedValue(QUIT);
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
		await expect(applyPromise).rejects.toBe(QUIT);

		expect(mockUpdater.applyUpdate).toHaveBeenCalledOnce();
	});
});

describe("ready-update guard (issue #1072)", () => {
	let ready: boolean;

	beforeEach(() => {
		vi.clearAllMocks();
		ready = false;
		mockUpdater.localInfo.channel.mockResolvedValue("stable");
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
		vi.restoreAllMocks();
	});

	it("remembers the downloaded version so the same version is not fetched again", async () => {
		await downloadUpdateForChannel("stable", vi.fn());

		expect(isUpdateAlreadyReady("1.30.0")).toBe(true);
	});

	it("does not treat a newer release as already downloaded", async () => {
		await downloadUpdateForChannel("stable", vi.fn());

		expect(isUpdateAlreadyReady("1.31.0")).toBe(false);
	});

	it("forgets the version when the download fails, so the next check retries", async () => {
		mockUpdater.downloadUpdate.mockImplementation(async () => {
			// download failed — ready flag stays false
		});
		vi.useFakeTimers();

		const promise = downloadUpdateForChannel("stable", vi.fn());
		await vi.advanceTimersByTimeAsync(120_000);
		const result = await promise;

		expect(result.ok).toBe(false);
		expect(isUpdateAlreadyReady("1.30.0")).toBe(false);
	});

	it("reminds about a downloaded update only once per reminder interval", () => {
		markUpdateReady("1.30.0", 1_000);

		expect(shouldRemindAboutReadyUpdate(1_000)).toBe(false);
		expect(shouldRemindAboutReadyUpdate(1_000 + READY_REMINDER_INTERVAL_MS)).toBe(true);
		// The reminder just fired — the next check must stay silent.
		expect(shouldRemindAboutReadyUpdate(1_000 + READY_REMINDER_INTERVAL_MS + 1)).toBe(false);
		expect(shouldRemindAboutReadyUpdate(1_000 + 2 * READY_REMINDER_INTERVAL_MS + 1)).toBe(true);
	});

	it("never reminds when nothing is downloaded", () => {
		expect(shouldRemindAboutReadyUpdate(Date.now() + READY_REMINDER_INTERVAL_MS)).toBe(false);
	});
});

describe("startAutoCheck", () => {
	const STARTUP_DELAY_MS = 10_000;
	const CHECK_INTERVAL_MS = 30 * 60 * 1000;

	beforeEach(() => {
		vi.clearAllMocks();
		clearReadyUpdate();
		mockUpdater.localInfo.channel.mockResolvedValue("stable");
		mockUpdater.localInfo.version.mockResolvedValue("1.29.0");
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ version: "1.30.0", hash: "bbbb2222bbbb2222" }),
		} as unknown as Response);
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("asks for a download when nothing is downloaded yet", async () => {
		const onUpdate = vi.fn();
		const onRemind = vi.fn();

		startAutoCheck(async () => "stable", onUpdate, vi.fn(), onRemind);
		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);

		expect(onUpdate).toHaveBeenCalledWith("1.30.0", undefined);
		expect(onRemind).not.toHaveBeenCalled();
	});

	it("skips the download for a version already waiting for restart", async () => {
		const onUpdate = vi.fn();
		const onRemind = vi.fn();
		markUpdateReady("1.30.0");

		startAutoCheck(async () => "stable", onUpdate, vi.fn(), onRemind);
		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + CHECK_INTERVAL_MS);

		expect(onUpdate).not.toHaveBeenCalled();
	});

	it("re-prompts the postponed update once the reminder interval elapses", async () => {
		const onUpdate = vi.fn();
		const onRemind = vi.fn();
		markUpdateReady("1.30.0");

		startAutoCheck(async () => "stable", onUpdate, vi.fn(), onRemind);
		// First checks stay silent, then one crosses the reminder interval.
		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + READY_REMINDER_INTERVAL_MS + CHECK_INTERVAL_MS);

		expect(onUpdate).not.toHaveBeenCalled();
		expect(onRemind).toHaveBeenCalledWith("1.30.0", undefined);
	});

	it("downloads a newer release even while an older one is ready", async () => {
		const onUpdate = vi.fn();
		markUpdateReady("1.30.0");
		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ version: "1.31.0", hash: "cccc3333cccc3333" }),
		} as unknown as Response);

		startAutoCheck(async () => "stable", onUpdate, vi.fn(), vi.fn());
		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);

		expect(onUpdate).toHaveBeenCalledWith("1.31.0", undefined);
	});
});
