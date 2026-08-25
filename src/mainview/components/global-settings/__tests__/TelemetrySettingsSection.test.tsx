/**
 * The three states this section has to tell apart: on, off by the toggle (still
 * movable, and turning it back on needs a relaunch), and locked off by the
 * environment. The middle one shipped inverted once — the toggle went off and the
 * UI kept showing the "you can also set an env var" hint, so the user was never
 * told the way back needs a restart.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { GlobalSettings } from "../../../../shared/types";
import TelemetrySettingsSection from "../TelemetrySettingsSection";
import { _resetTelemetryRuntimeStateForTests, setRuntimeTelemetryOptOut } from "../../../telemetry";

// The keys are what this section is asserted on; echo them back verbatim.
const t = ((key: string) => key) as never;

function renderSection(settings: Partial<GlobalSettings> = {}) {
	return render(
		<TelemetrySettingsSection
			t={t}
			globalSettings={settings as GlobalSettings}
			onToggle={vi.fn()}
		/>,
	);
}

beforeEach(() => {
	_resetTelemetryRuntimeStateForTests();
	delete window.__DEV3_TELEMETRY_OPT_OUT__;
});

afterEach(() => {
	delete window.__DEV3_TELEMETRY_OPT_OUT__;
	_resetTelemetryRuntimeStateForTests();
});

describe("TelemetrySettingsSection", () => {
	it("shows the toggle on, movable, and points at the env vars", () => {
		renderSection();
		const toggle = screen.getByRole("switch");
		expect(toggle).toHaveAttribute("aria-checked", "true");
		expect(toggle).toHaveAttribute("tabindex", "0");
		expect(screen.getByText("settings.telemetryEnvHint")).toBeInTheDocument();
	});

	it("says telemetry stopped on the spot once it is off by the toggle", () => {
		setRuntimeTelemetryOptOut(true);
		renderSection({ telemetryDisabled: true });
		expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
		expect(screen.getByText("settings.telemetryStoppedNow")).toBeInTheDocument();
		expect(screen.queryByText("settings.telemetryEnvHint")).not.toBeInTheDocument();
	});

	it("reads a stored opt-out as off even before the runtime gate is set", () => {
		renderSection({ telemetryDisabled: true });
		expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
	});

	// The toggle follows the stored CHOICE, not the live gate. It used to follow the
	// gate, so switching back on left the switch sitting in "off" — it read as a
	// dead control rather than as a change that needs a relaunch.
	it("moves back to on immediately and explains the lag instead of refusing", () => {
		window.__DEV3_TELEMETRY_OPT_OUT__ = "setting";
		renderSection({ telemetryDisabled: undefined });
		expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
		expect(screen.getByText("settings.telemetryResumesAfterRestart")).toBeInTheDocument();
	});

	it("locks the toggle and names DEV3_TELEMETRY when the environment decided", () => {
		window.__DEV3_TELEMETRY_OPT_OUT__ = "env";
		renderSection();
		const toggle = screen.getByRole("switch");
		expect(toggle).toHaveAttribute("aria-checked", "false");
		expect(toggle).toHaveAttribute("tabindex", "-1");
		expect(screen.getByText("settings.telemetryLockedEnv")).toBeInTheDocument();
	});

	it("names DO_NOT_TRACK specifically, not the generic env message", () => {
		window.__DEV3_TELEMETRY_OPT_OUT__ = "do-not-track";
		renderSection();
		expect(screen.getByText("settings.telemetryLockedDoNotTrack")).toBeInTheDocument();
		expect(screen.queryByText("settings.telemetryLockedEnv")).not.toBeInTheDocument();
	});
});
