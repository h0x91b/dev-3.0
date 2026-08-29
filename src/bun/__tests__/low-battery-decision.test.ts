import { describe, expect, it } from "vitest";
import {
	applyLowBatteryOutputStyle,
	isLowBatteryStyle,
	LOW_BATTERY_STYLE_NAME,
} from "../../shared/low-battery";

describe("isLowBatteryStyle", () => {
	it.each([
		["Low Battery", true],
		["low battery", true],
		["low-battery", true],
		// The Claude Code plugin registers the same rules namespaced.
		["low-battery:Low Battery", true],
		["  low-battery:low battery  ", true],
		["default", false],
		["Explanatory", false],
		["My Own Style", false],
		["", false],
		[undefined, false],
		[42, false],
	])("%s → %s", (value, expected) => {
		expect(isLowBatteryStyle(value)).toBe(expected);
	});
});

describe("applyLowBatteryOutputStyle — enabling", () => {
	it("selects the style when the key is absent", () => {
		const settings: Record<string, unknown> = {};
		const { changed, outcome } = applyLowBatteryOutputStyle(settings, true);
		expect(changed).toBe(true);
		expect(outcome).toEqual({ kind: "selected" });
		expect(settings.outputStyle).toBe(LOW_BATTERY_STYLE_NAME);
	});

	it("selects the style over the built-in default", () => {
		const settings: Record<string, unknown> = { outputStyle: "default" };
		const { changed, outcome } = applyLowBatteryOutputStyle(settings, true);
		expect(changed).toBe(true);
		expect(outcome).toEqual({ kind: "selected" });
		expect(settings.outputStyle).toBe(LOW_BATTERY_STYLE_NAME);
	});

	it("treats the plugin-namespaced form as already on and installs no duplicate", () => {
		const settings: Record<string, unknown> = { outputStyle: "low-battery:Low Battery" };
		const { changed, outcome } = applyLowBatteryOutputStyle(settings, true);
		expect(changed).toBe(false);
		expect(outcome).toEqual({ kind: "already-on", style: "low-battery:Low Battery" });
		expect(settings.outputStyle).toBe("low-battery:Low Battery");
	});

	it("leaves the user's own style selected and names it", () => {
		const settings: Record<string, unknown> = { outputStyle: "Lazy Dzen" };
		const { changed, outcome } = applyLowBatteryOutputStyle(settings, true);
		expect(changed).toBe(false);
		expect(outcome).toEqual({ kind: "user-style-kept", style: "Lazy Dzen" });
		expect(settings.outputStyle).toBe("Lazy Dzen");
	});

	it("never touches unrelated keys", () => {
		const settings: Record<string, unknown> = { permissions: { allow: ["Bash(dev3 *)"] } };
		applyLowBatteryOutputStyle(settings, true);
		expect(settings.permissions).toEqual({ allow: ["Bash(dev3 *)"] });
	});
});

describe("applyLowBatteryOutputStyle — disabling", () => {
	it("clears only dev3's own value", () => {
		const settings: Record<string, unknown> = { outputStyle: LOW_BATTERY_STYLE_NAME, theme: "dark" };
		const { changed, outcome } = applyLowBatteryOutputStyle(settings, false);
		expect(changed).toBe(true);
		expect(outcome).toEqual({ kind: "cleared" });
		expect("outputStyle" in settings).toBe(false);
		expect(settings.theme).toBe("dark");
	});

	it("leaves a plugin-installed value alone — the plugin owns it, not dev3", () => {
		const settings: Record<string, unknown> = { outputStyle: "low-battery:Low Battery" };
		const { changed, outcome } = applyLowBatteryOutputStyle(settings, false);
		expect(changed).toBe(false);
		expect(outcome).toEqual({ kind: "left-alone", style: "low-battery:Low Battery" });
		expect(settings.outputStyle).toBe("low-battery:Low Battery");
	});

	it("leaves the user's own style alone", () => {
		const settings: Record<string, unknown> = { outputStyle: "Lazy Dzen" };
		const { changed } = applyLowBatteryOutputStyle(settings, false);
		expect(changed).toBe(false);
		expect(settings.outputStyle).toBe("Lazy Dzen");
	});

	it("is a no-op when nothing is selected", () => {
		const settings: Record<string, unknown> = {};
		const { changed, outcome } = applyLowBatteryOutputStyle(settings, false);
		expect(changed).toBe(false);
		expect(outcome).toEqual({ kind: "left-alone", style: undefined });
	});
});
