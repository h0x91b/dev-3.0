import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { TEST_ROOT } = vi.hoisted(() => ({
	TEST_ROOT: require("node:fs").mkdtempSync(
		require("node:path").join(require("node:os").tmpdir(), "dev3-low-battery-retire-"),
	),
}));
const HOME = join(TEST_ROOT, "home");
const DEV3_HOME = join(TEST_ROOT, "dev3");

vi.mock("../paths", () => ({ DEV3_HOME: require("node:path").join(TEST_ROOT, "dev3") }));
vi.mock("../logger", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { LOW_BATTERY_SKILL_DIRS, retireLowBattery } from "../low-battery";

const CLAUDE_SETTINGS = join(HOME, ".claude/settings.json");
const STYLE_FILE = join(HOME, ".claude/output-styles/low-battery.md");

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value), "utf-8");
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function plantLeftovers(): void {
	mkdirSync(join(STYLE_FILE, ".."), { recursive: true });
	writeFileSync(STYLE_FILE, "style", "utf-8");
	for (const dir of LOW_BATTERY_SKILL_DIRS) {
		mkdirSync(join(HOME, dir), { recursive: true });
		writeFileSync(join(HOME, dir, "SKILL.md"), "skill", "utf-8");
	}
}

describe("retireLowBattery", () => {
	beforeEach(() => {
		rmSync(TEST_ROOT, { recursive: true, force: true });
		mkdirSync(HOME, { recursive: true });
		mkdirSync(DEV3_HOME, { recursive: true });
		vi.spyOn(Bun, "write").mockImplementation(async (target, contents) => {
			writeFileSync(String(target), String(contents));
			return String(contents).length;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(TEST_ROOT, { recursive: true, force: true });
	});

	it("resets dev3's outputStyle to the default and keeps every other key", async () => {
		writeJson(CLAUDE_SETTINGS, { outputStyle: "Low Battery", model: "opus" });

		await retireLowBattery(HOME);

		expect(readJson(CLAUDE_SETTINGS)).toEqual({ model: "opus" });
	});

	it("leaves any other outputStyle alone, the plugin's namespaced copy included", async () => {
		for (const style of ["Lazy Dzen", "low-battery:Low Battery", "default"]) {
			writeJson(CLAUDE_SETTINGS, { outputStyle: style });
			await retireLowBattery(HOME);
			expect(readJson(CLAUDE_SETTINGS).outputStyle).toBe(style);
		}
	});

	it("removes dev3's files when settings prove dev3 installed them, then stores false", async () => {
		plantLeftovers();
		writeJson(join(DEV3_HOME, "settings.json"), { lowBatteryEnabled: true });

		await retireLowBattery(HOME);

		expect(existsSync(STYLE_FILE)).toBe(false);
		for (const dir of LOW_BATTERY_SKILL_DIRS) expect(existsSync(join(HOME, dir))).toBe(false);
		expect(readJson(join(DEV3_HOME, "settings.json")).lowBatteryEnabled).toBe(false);
	});

	// Without the proof, a `low-battery` dir may be the user's own copy from upstream.
	it("deletes no files when settings never recorded an install", async () => {
		plantLeftovers();
		for (const stored of [{}, { lowBatteryEnabled: false }]) {
			writeJson(join(DEV3_HOME, "settings.json"), stored);
			await retireLowBattery(HOME);
			expect(existsSync(STYLE_FILE)).toBe(true);
			for (const dir of LOW_BATTERY_SKILL_DIRS) expect(existsSync(join(HOME, dir, "SKILL.md"))).toBe(true);
		}
	});

	it("does not throw on an unparsable Claude settings file", async () => {
		mkdirSync(join(HOME, ".claude"), { recursive: true });
		writeFileSync(CLAUDE_SETTINGS, "{ not json", "utf-8");

		await expect(retireLowBattery(HOME)).resolves.toBeUndefined();
		expect(readFileSync(CLAUDE_SETTINGS, "utf-8")).toBe("{ not json");
	});
});
