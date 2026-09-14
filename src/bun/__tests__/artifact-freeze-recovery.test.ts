import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The recovery is allowed to change a user's setting exactly once per freeze, and
 * only for a freeze it actually has evidence of. These pin down both halves: what
 * makes it act, and the far longer list of things that must not.
 */

const { TEST_HOME } = vi.hoisted(() => ({
	TEST_HOME: require("node:fs").mkdtempSync(
		require("node:path").join(require("node:os").tmpdir(), "dev3-freeze-test-"),
	),
}));

vi.mock("../paths", () => ({ DEV3_HOME: TEST_HOME }));
vi.mock("../logger", () => ({
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
	applyArtifactFreezeRecovery,
	consumeArtifactFreezeNotice,
	EVIDENCE_STALE_MS,
	markArtifactFreezeRecovered,
	noteArtifactPopupPreference,
	recordArtifactFreezeEvidence,
	SELF_RECOVERY_MS,
} from "../artifact-freeze-recovery";
import {
	recordRendererHeartbeat,
	resetRendererWatchdog,
	startRendererWatchdog,
	type RendererBeat,
} from "../renderer-watchdog";
import type { GlobalSettings } from "../../shared/types";

const RECORD = join(TEST_HOME, "artifact-freeze-recovery.json");
const SETTINGS = join(TEST_HOME, "settings.json");
const NOW = 1_700_000_000_000;

function settingsOnDisk(): GlobalSettings {
	return JSON.parse(readFileSync(SETTINGS, "utf-8"));
}

function writeSettings(over: Partial<GlobalSettings> = {}) {
	writeFileSync(
		SETTINGS,
		JSON.stringify({ defaultAgentId: "builtin-claude", defaultConfigId: "claude-default", ...over }, null, 2),
		"utf-8",
	);
}

function record(): Record<string, unknown> {
	return JSON.parse(readFileSync(RECORD, "utf-8"));
}

function freeze(over: Partial<{ at: number; quietForMs: number; artifactOpen: boolean; artifactIdleMs: number | null }> = {}) {
	recordArtifactFreezeEvidence({
		at: NOW - 60_000,
		quietForMs: 25_000,
		artifactOpen: true,
		artifactIdleMs: 0,
		...over,
	});
}

beforeEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(TEST_HOME, { recursive: true });
	writeSettings();
	// The suite runs on node, where `Bun.write` is a no-op stub (src/bun/test-setup.ts)
	// — without this, `saveSettings` would silently write nothing and every
	// assertion about the settings file would pass for the wrong reason.
	vi.spyOn(Bun, "write").mockImplementation(async (target: unknown, content: unknown) => {
		writeFileSync(String(target), String(content), "utf-8");
		return 0;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("artifact freeze recovery", () => {
	it("enables the popup once for a recorded freeze, and leaves nothing to act on next launch", async () => {
		freeze();

		expect(await applyArtifactFreezeRecovery(NOW)).toEqual({ enabled: true, freezeAt: NOW - 60_000 });
		expect(settingsOnDisk().openArtifactsInPopup).toBe(true);
		expect(record().autoEnableCount).toBe(1);

		// Second launch: the evidence is spent, so nothing is written again.
		expect(await applyArtifactFreezeRecovery(NOW + 1_000)).toEqual({ enabled: false, reason: "no-evidence" });
		expect(record().autoEnableCount).toBe(1);
	});

	it("keeps every other setting the user had", async () => {
		writeSettings({ taskSortOrder: "newest-first", tipsDisabled: true, telemetryDisabled: true });
		freeze();

		await applyArtifactFreezeRecovery(NOW);
		expect(settingsOnDisk()).toMatchObject({
			taskSortOrder: "newest-first",
			tipsDisabled: true,
			telemetryDisabled: true,
			openArtifactsInPopup: true,
		});
	});

	it("does nothing on a healthy launch — no evidence, no write", async () => {
		expect(await applyArtifactFreezeRecovery(NOW)).toEqual({ enabled: false, reason: "no-evidence" });
		expect(settingsOnDisk().openArtifactsInPopup).toBeUndefined();
	});

	it("ignores a freeze the window recovered from on its own", async () => {
		freeze();
		markArtifactFreezeRecovered(SELF_RECOVERY_MS - 1);

		expect(await applyArtifactFreezeRecovery(NOW)).toEqual({ enabled: false, reason: "self-recovered" });
		expect(settingsOnDisk().openArtifactsInPopup).toBeUndefined();
	});

	it("still acts when the window came back only long after the freeze", async () => {
		freeze();
		markArtifactFreezeRecovered(SELF_RECOVERY_MS + 1);

		expect(await applyArtifactFreezeRecovery(NOW)).toMatchObject({ enabled: true });
	});

	it("ignores evidence older than two weeks", async () => {
		freeze({ at: NOW - EVIDENCE_STALE_MS - 1 });

		expect(await applyArtifactFreezeRecovery(NOW)).toEqual({ enabled: false, reason: "stale" });
		expect(settingsOnDisk().openArtifactsInPopup).toBeUndefined();
	});

	it("leaves an install that already opens artifacts in a popup untouched, and raises no notice", async () => {
		writeSettings({ openArtifactsInPopup: true });
		freeze();

		expect(await applyArtifactFreezeRecovery(NOW)).toEqual({ enabled: false, reason: "already-on" });
		expect(settingsOnDisk().openArtifactsInPopup).toBe(true);
		expect(consumeArtifactFreezeNotice()).toBeNull();
	});

	it("stands down for good once the user turns the popup back off", async () => {
		freeze();
		await applyArtifactFreezeRecovery(NOW);

		// The user opens Settings and chooses the panel again.
		noteArtifactPopupPreference(false);
		writeSettings({ openArtifactsInPopup: false });

		freeze({ at: NOW + 10_000 });
		expect(await applyArtifactFreezeRecovery(NOW + 20_000)).toEqual({ enabled: false, reason: "user-declined" });
		expect(settingsOnDisk().openArtifactsInPopup).toBe(false);
	});

	it("stands down even if the setting was turned off without passing through the settings handler", async () => {
		freeze();
		await applyArtifactFreezeRecovery(NOW);
		writeSettings({ openArtifactsInPopup: false });

		freeze({ at: NOW + 10_000 });
		expect(await applyArtifactFreezeRecovery(NOW + 20_000)).toEqual({ enabled: false, reason: "user-declined" });
	});

	it("starts recovering again if the user turns the popup on by hand after declining", async () => {
		freeze();
		await applyArtifactFreezeRecovery(NOW);
		noteArtifactPopupPreference(false);
		expect(record().declinedAt).toBeGreaterThan(0);

		noteArtifactPopupPreference(true);
		expect(record().declinedAt).toBeUndefined();
	});

	it("says nothing about a popup switch the user flipped with no recovery behind it", () => {
		noteArtifactPopupPreference(false);
		expect(() => record()).toThrow(); // no record file written at all
	});

	it("hands the notice over exactly once", async () => {
		freeze();
		await applyArtifactFreezeRecovery(NOW);

		expect(consumeArtifactFreezeNotice()).toEqual({ freezeAt: NOW - 60_000 });
		expect(consumeArtifactFreezeNotice()).toBeNull();
	});

	it("drops the pending notice when the user turns the popup off before seeing it", async () => {
		freeze();
		await applyArtifactFreezeRecovery(NOW);
		noteArtifactPopupPreference(false);

		expect(consumeArtifactFreezeNotice()).toBeNull();
	});

	it("survives a corrupt record instead of taking the launch down with it", async () => {
		writeFileSync(RECORD, "{ not json at all", "utf-8");

		expect(await applyArtifactFreezeRecovery(NOW)).toEqual({ enabled: false, reason: "no-evidence" });
		expect(settingsOnDisk().openArtifactsInPopup).toBeUndefined();
	});

	it("ignores a record whose evidence is the wrong shape", async () => {
		writeFileSync(RECORD, JSON.stringify({ version: 1, pending: { at: "yesterday" } }), "utf-8");

		expect(await applyArtifactFreezeRecovery(NOW)).toEqual({ enabled: false, reason: "no-evidence" });
	});

	/**
	 * The two halves wired together, the way the app wires them: a real watchdog
	 * watching a renderer that stops beating, then a restart reading what it left.
	 */
	describe("a stalled window through to the next launch", () => {
		let clock = NOW - 300_000;
		let tick: () => void = () => {};

		function stallAndRestart(over: Partial<RendererBeat> = {}): Promise<unknown> {
			resetRendererWatchdog();
			const stop = startRendererWatchdog({
				now: () => clock,
				checkIntervalMs: 2_000,
				setInterval: (fn) => { tick = fn; return 1; },
				clearInterval: () => {},
				onFreezeEvidence: recordArtifactFreezeEvidence,
				onFreezeRecovered: markArtifactFreezeRecovered,
			});
			// 20s of healthy beats from a visible desktop window with an artifact open.
			for (let n = 0; n < 10; n += 1) {
				recordRendererHeartbeat({
					clientId: "win-a",
					sinceLastBeatMs: 2_000,
					visible: true,
					hiddenSinceLastBeat: false,
					terminals: 2,
					frameErrorPanes: 0,
					desktop: true,
					artifactOpen: true,
					artifactIdleMs: 0,
					...over,
				});
				clock += 2_000;
				tick();
			}
			// Then it stops answering, and the host keeps checking for half a minute.
			for (let n = 0; n < 15; n += 1) {
				clock += 2_000;
				tick();
			}
			stop();
			return applyArtifactFreezeRecovery(clock);
		}

		it("switches to the popup, and only once", async () => {
			expect(await stallAndRestart()).toMatchObject({ enabled: true });
			expect(settingsOnDisk().openArtifactsInPopup).toBe(true);

			// Second launch of a machine that is now healthy: nothing left to act on.
			expect(await applyArtifactFreezeRecovery(clock + 1_000)).toEqual({ enabled: false, reason: "no-evidence" });
		});

		it("leaves an identical stall with no artifact in the window alone", async () => {
			expect(await stallAndRestart({ artifactOpen: false, artifactIdleMs: null })).toEqual({
				enabled: false,
				reason: "no-evidence",
			});
			expect(settingsOnDisk().openArtifactsInPopup).toBeUndefined();
		});
	});

	it("keeps only the most recent freeze when a session froze more than once", async () => {
		freeze({ at: NOW - 600_000 });
		freeze({ at: NOW - 30_000, quietForMs: 40_000 });

		expect(await applyArtifactFreezeRecovery(NOW)).toEqual({ enabled: true, freezeAt: NOW - 30_000 });
	});
});
