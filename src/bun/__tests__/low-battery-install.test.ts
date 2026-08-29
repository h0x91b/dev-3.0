import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Drives the installer against a throwaway home and asserts on what a user or
 * another process can observe: which files exist, what the patched settings JSON
 * holds, and what survives a toggle-off. Deliberately no assertions on the prose of
 * the rules — that content is upstream's and changes.
 */
describe("low-battery installer", () => {
	let home = "";

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "dev3-low-battery-"));
		vi.resetModules();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(home, { recursive: true, force: true });
	});

	async function loadModule() {
		vi.doMock("../logger", () => ({
			createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
		}));
		return import("../low-battery");
	}

	function claudeSettings(): Record<string, unknown> {
		return JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf-8"));
	}

	it("installs the skill into every agent config dir and the style for Claude Code", async () => {
		const { applyLowBattery, LOW_BATTERY_SKILL_DIRS, LOW_BATTERY_REVISION } = await loadModule();
		const outcome = applyLowBattery(home, true);

		for (const dir of LOW_BATTERY_SKILL_DIRS) {
			expect(existsSync(join(home, dir, "SKILL.md"))).toBe(true);
		}
		expect(existsSync(join(home, ".claude/output-styles/low-battery.md"))).toBe(true);
		expect(claudeSettings().outputStyle).toBe("Low Battery");
		expect(outcome).toEqual({ kind: "selected" });
		expect(LOW_BATTERY_REVISION).toMatch(/^[0-9a-f]{40}$/);
	});

	it("ships the templates and reference pages, not just SKILL.md", async () => {
		const { applyLowBattery } = await loadModule();
		applyLowBattery(home, true);

		const skillDir = join(home, ".agents/skills/low-battery");
		expect(existsSync(join(skillDir, "templates/T1.md"))).toBe(true);
		expect(existsSync(join(skillDir, "reference/numbers.md"))).toBe(true);
		// Only the shared `.agents` tree carries the OpenAI metadata sidecar.
		expect(existsSync(join(skillDir, "agents/openai.yaml"))).toBe(true);
		expect(existsSync(join(home, ".claude/skills/low-battery/agents/openai.yaml"))).toBe(false);
	});

	it("is idempotent across repeated installs", async () => {
		const { applyLowBattery } = await loadModule();
		applyLowBattery(home, true);
		const first = readFileSync(join(home, ".claude/output-styles/low-battery.md"), "utf-8");
		applyLowBattery(home, true);

		expect(readFileSync(join(home, ".claude/output-styles/low-battery.md"), "utf-8")).toBe(first);
		expect(claudeSettings().outputStyle).toBe("Low Battery");
	});

	it("uninstall removes only what dev3 wrote", async () => {
		const { applyLowBattery } = await loadModule();
		applyLowBattery(home, true);

		// The user's own belongings, written after the install.
		writeFileSync(join(home, ".claude/output-styles/lazy-dzen.md"), "---\nname: Lazy Dzen\n---\n", "utf-8");
		mkdirSync(join(home, ".claude/skills/my-own"), { recursive: true });
		writeFileSync(join(home, ".claude/skills/my-own/SKILL.md"), "mine", "utf-8");

		applyLowBattery(home, false);

		expect(existsSync(join(home, ".claude/output-styles/low-battery.md"))).toBe(false);
		expect(existsSync(join(home, ".agents/skills/low-battery"))).toBe(false);
		expect(existsSync(join(home, ".claude/skills/low-battery"))).toBe(false);
		expect("outputStyle" in claudeSettings()).toBe(false);
		expect(existsSync(join(home, ".claude/output-styles/lazy-dzen.md"))).toBe(true);
		expect(existsSync(join(home, ".claude/skills/my-own/SKILL.md"))).toBe(true);
	});

	it("never overwrites an output style the user picked", async () => {
		const { applyLowBattery, lowBatteryStatus } = await loadModule();
		mkdirSync(join(home, ".claude"), { recursive: true });
		writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ outputStyle: "Lazy Dzen" }), "utf-8");

		const outcome = applyLowBattery(home, true);

		expect(outcome).toEqual({ kind: "user-style-kept", style: "Lazy Dzen" });
		expect(claudeSettings().outputStyle).toBe("Lazy Dzen");
		// The skill still lands — the format reaches every harness that loads skills.
		expect(existsSync(join(home, ".agents/skills/low-battery/SKILL.md"))).toBe(true);

		const status = lowBatteryStatus(home, true);
		expect(status.outcome).toEqual({ kind: "user-style-kept", style: "Lazy Dzen" });
		expect(status.skillInstalled).toBe(true);
		expect(status.styleInstalled).toBe(true);
	});

	it("recognises the Claude Code plugin's copy instead of installing a duplicate name", async () => {
		const { applyLowBattery } = await loadModule();
		mkdirSync(join(home, ".claude"), { recursive: true });
		writeFileSync(
			join(home, ".claude/settings.json"),
			JSON.stringify({ outputStyle: "low-battery:Low Battery" }),
			"utf-8",
		);

		expect(applyLowBattery(home, true)).toEqual({ kind: "already-on", style: "low-battery:Low Battery" });
		expect(claudeSettings().outputStyle).toBe("low-battery:Low Battery");
	});

	it("switches the style on explicit request, and only then", async () => {
		const { applyLowBattery, forceSelectLowBatteryStyle } = await loadModule();
		mkdirSync(join(home, ".claude"), { recursive: true });
		writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ outputStyle: "Lazy Dzen" }), "utf-8");
		applyLowBattery(home, true);
		expect(claudeSettings().outputStyle).toBe("Lazy Dzen");

		forceSelectLowBatteryStyle(home);
		expect(claudeSettings().outputStyle).toBe("Low Battery");
	});

	it("warns and keeps going when a target directory cannot be written", async () => {
		const { applyLowBattery } = await loadModule();
		// Make ~/.claude unwritable so the style half fails while the skills succeed.
		mkdirSync(join(home, ".claude"), { recursive: true });
		chmodSync(join(home, ".claude"), 0o500);

		expect(() => applyLowBattery(home, true)).not.toThrow();
		expect(existsSync(join(home, ".agents/skills/low-battery/SKILL.md"))).toBe(true);

		chmodSync(join(home, ".claude"), 0o700);
	});

	/**
	 * The name in `outputStyle` must be the name Claude Code registers, or the
	 * setting looks correct and silently does nothing. dev3 already owns the
	 * resolver; this fails the moment the two disagree.
	 */
	it("writes the style name dev3's own resolver derives from the shipped file", async () => {
		const { LOW_BATTERY_STYLE_FILE, LOW_BATTERY_STYLE_NAME } = await import("../../shared/low-battery");
		const { LOW_BATTERY_OUTPUT_STYLE } = await import("../../shared/low-battery-content.generated");
		const { registeredOutputStyleName } = await import("../agent-accounts");

		expect(registeredOutputStyleName(LOW_BATTERY_STYLE_FILE, LOW_BATTERY_OUTPUT_STYLE)).toBe(
			LOW_BATTERY_STYLE_NAME,
		);
	});

	it("reports a clean status when the feature is off", async () => {
		const { lowBatteryStatus } = await loadModule();
		const status = lowBatteryStatus(home, false);
		expect(status.enabled).toBe(false);
		expect(status.styleInstalled).toBe(false);
		expect(status.skillInstalled).toBe(false);
	});
});
