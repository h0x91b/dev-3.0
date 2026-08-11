import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { TEST_HOME } = vi.hoisted(() => ({
	TEST_HOME: require("node:fs").mkdtempSync(
		require("node:path").join(require("node:os").tmpdir(), "dev3-terminal-backend-pref-"),
	),
}));

vi.mock("../paths", () => ({ DEV3_HOME: TEST_HOME }));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_file: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

import {
	readNewTaskTerminalBackendPreference,
	TERMINAL_BACKEND_PREFERENCE_FILE,
	TERMINAL_BACKEND_PREFERENCE_VERSION,
	writeNewTaskTerminalBackendPreference,
} from "../terminal-backend-preference";
import { loadSettings, saveSettings } from "../settings";

const settingsPath = join(TEST_HOME, "settings.json");

function seed(content: string): void {
	mkdirSync(TEST_HOME, { recursive: true });
	writeFileSync(TERMINAL_BACKEND_PREFERENCE_FILE, content, "utf-8");
}

beforeEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(TEST_HOME, { recursive: true });
	// The bun test setup stubs Bun.write into a no-op; make it write for real so
	// the atomic temp-file + rename path is actually exercised.
	vi.spyOn(Bun, "write").mockImplementation(async (target, data) => {
		writeFileSync(String(target), String(data), "utf-8");
		return 0;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("the terminal backend preference sidecar", () => {
	it("lives outside settings.json, at its own documented path", () => {
		expect(TERMINAL_BACKEND_PREFERENCE_FILE).toBe(`${TEST_HOME}/terminal-backend.json`);
		expect(TERMINAL_BACKEND_PREFERENCE_FILE).not.toContain("settings.json");
	});

	it.each(["tmux", "native"] as const)("round-trips an explicit %s", async (backend) => {
		await writeNewTaskTerminalBackendPreference(backend);
		expect(readNewTaskTerminalBackendPreference()).toBe(backend);
		expect(JSON.parse(readFileSync(TERMINAL_BACKEND_PREFERENCE_FILE, "utf-8"))).toEqual({
			version: TERMINAL_BACKEND_PREFERENCE_VERSION,
			newTaskBackend: backend,
		});
	});

	it("reports no preference when the file does not exist", () => {
		expect(existsSync(TERMINAL_BACKEND_PREFERENCE_FILE)).toBe(false);
		expect(readNewTaskTerminalBackendPreference()).toBeNull();
	});

	// Every unreadable shape must mean "no preference" so the creation seam keeps
	// the platform default instead of guessing a backend nobody chose.
	it.each([
		["corrupt json", "{not json"],
		["not an object", '"native"'],
		["an array", '["native"]'],
		["a future schema version", JSON.stringify({ version: 99, newTaskBackend: "native" })],
		["a missing version", JSON.stringify({ newTaskBackend: "native" })],
		["an unknown identity", JSON.stringify({ version: 1, newTaskBackend: "screen" })],
		["a non-string identity", JSON.stringify({ version: 1, newTaskBackend: 7 })],
		["no identity at all", JSON.stringify({ version: 1 })],
	])("reports no preference for %s", (_label, content) => {
		seed(content);
		expect(readNewTaskTerminalBackendPreference()).toBeNull();
	});

	it("leaves an unreadable sidecar alone instead of repairing it", () => {
		const content = JSON.stringify({ version: 99, newTaskBackend: "native" });
		seed(content);
		readNewTaskTerminalBackendPreference();
		expect(readFileSync(TERMINAL_BACKEND_PREFERENCE_FILE, "utf-8")).toBe(content);
	});

	it("rejects an identity this build cannot decode instead of writing it", async () => {
		await expect(
			writeNewTaskTerminalBackendPreference("screen" as never),
		).rejects.toThrow(/Unsupported terminal backend identity/);
		expect(existsSync(TERMINAL_BACKEND_PREFERENCE_FILE)).toBe(false);
	});

	it("writes atomically and leaves no temp file behind", async () => {
		await writeNewTaskTerminalBackendPreference("native");
		expect(readdirSync(TEST_HOME).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("does not corrupt the previous value when the write crashes mid-save", async () => {
		await writeNewTaskTerminalBackendPreference("native");
		vi.mocked(Bun.write).mockImplementation(async (target) => {
			writeFileSync(String(target), '{"version":1,"newTaskBac', "utf-8");
			throw new Error("simulated crash");
		});

		await expect(writeNewTaskTerminalBackendPreference("tmux")).rejects.toThrow("simulated crash");
		expect(readNewTaskTerminalBackendPreference()).toBe("native");
	});
});

// ============================================================
// Side-by-side regression — the reason this file exists at all
// ============================================================

describe("an older side-by-side build saving settings.json", () => {
	/**
	 * Reproduces what actually happened on a real machine: settings.json is loaded
	 * through a FIELD WHITELIST, so a build that predates a key drops it on its
	 * next save. Here the "old" build is simulated by writing a settings.json that
	 * carries the preference as an unknown key, then doing the load→save round
	 * trip that every settings change performs.
	 */
	it("cannot delete the preference, because the preference is not in settings.json", async () => {
		await writeNewTaskTerminalBackendPreference("native");

		// An old build's settings.json, including a stray copy of the key it does
		// not know about — exactly the shape that used to get silently stripped.
		writeFileSync(
			settingsPath,
			JSON.stringify({
				defaultAgentId: "builtin-claude",
				defaultConfigId: "claude-auto-opus5-medium",
				taskSortOrder: "oldest-first",
				updateChannel: "stable",
				newTaskTerminalBackend: "native",
			}),
			"utf-8",
		);

		await saveSettings(await loadSettings());

		// The whitelist did drop the stray settings.json key…
		expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).not.toHaveProperty("newTaskTerminalBackend");
		// …and the real preference is untouched, because it never lived there.
		expect(readNewTaskTerminalBackendPreference()).toBe("native");
		expect(JSON.parse(readFileSync(TERMINAL_BACKEND_PREFERENCE_FILE, "utf-8"))).toEqual({
			version: TERMINAL_BACKEND_PREFERENCE_VERSION,
			newTaskBackend: "native",
		});
	});

	it("survives repeated old-build settings saves", async () => {
		await writeNewTaskTerminalBackendPreference("native");
		for (let i = 0; i < 3; i++) await saveSettings(await loadSettings());
		expect(readNewTaskTerminalBackendPreference()).toBe("native");
	});
});
