import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalSettings } from "../../../../shared/types";
import { I18nProvider, type TFunction } from "../../../i18n";
import { setHiddenControlsForTests } from "../../../hidden-controls";
import AdvancedExperienceSection from "../AdvancedExperienceSection";

// Stub translator: return the key so assertions are stable and locale-agnostic.
// Interpolating stub: a key with params renders as `key|value`, so a test can
// prove the directory actually reaches the copy.
const t = Object.assign(
	(key: string, params?: Record<string, string | number>) =>
		params ? `${key}|${Object.values(params).join(",")}` : key,
	{
		plural: (key: string, count: number) => `${key}|${count}`,
	},
) as unknown as TFunction;

function renderSection(
	globalSettings: Partial<GlobalSettings>,
	freezeDiagnostics: { supported: boolean; running: boolean; directory: string } | null = {
		supported: true,
		running: false,
		directory: "/home/logs/freeze",
	},
) {
	const onAgentTrafficToggle = vi.fn();
	const onTerminalBidiToggle = vi.fn();
	const onFreezeDiagnosticsToggle = vi.fn();
	const onSimplifyModeToggle = vi.fn();
	render(
		<I18nProvider>
			<AdvancedExperienceSection
				t={t}
				globalSettings={globalSettings as GlobalSettings}
				freezeDiagnostics={freezeDiagnostics}
				onTerminalBidiToggle={onTerminalBidiToggle}
				onAgentTrafficToggle={onAgentTrafficToggle}
				onFreezeDiagnosticsToggle={onFreezeDiagnosticsToggle}
			/>
		</I18nProvider>,
	);
	return {
		onAgentTrafficToggle,
		onTerminalBidiToggle,
		onFreezeDiagnosticsToggle,
		onSimplifyModeToggle,
		toggle: screen.getByLabelText("settings.agentTraffic"),
		bidiToggle: screen.getByLabelText("settings.terminalBidi"),
		freezeToggle: screen.getByLabelText("settings.freezeDiagnostics"),
	};
}

beforeEach(() => {
	setHiddenControlsForTests([]);
});

/**
 * Both entries ship on, so each toggle has to read three stored states apart:
 * no choice (on), an explicit off, an explicit on.
 */
describe("AdvancedExperienceSection — agent traffic", () => {
	it("shows on when nothing is stored", () => {
		expect(renderSection({}).toggle.getAttribute("aria-checked")).toBe("true");
	});

	it("shows off for a stored opt-out", () => {
		expect(renderSection({ experimentalAgentTraffic: false }).toggle.getAttribute("aria-checked")).toBe("false");
	});

	it("shows on for a stored opt-in", () => {
		expect(renderSection({ experimentalAgentTraffic: true }).toggle.getAttribute("aria-checked")).toBe("true");
	});

	it("asks to turn it off from the default state", async () => {
		const { onAgentTrafficToggle, toggle } = renderSection({});
		await userEvent.click(toggle);
		expect(onAgentTrafficToggle).toHaveBeenCalledWith(false);
	});

	it("asks to turn it back on from a stored opt-out", async () => {
		const { onAgentTrafficToggle, toggle } = renderSection({ experimentalAgentTraffic: false });
		await userEvent.click(toggle);
		expect(onAgentTrafficToggle).toHaveBeenCalledWith(true);
	});
});

describe("AdvancedExperienceSection — terminal bidi", () => {
	it("shows on when nothing is stored", () => {
		expect(renderSection({}).bidiToggle.getAttribute("aria-checked")).toBe("true");
	});

	it("shows off for a stored opt-out", () => {
		expect(
			renderSection({ experimentalTerminalBidi: false }).bidiToggle.getAttribute("aria-checked"),
		).toBe("false");
	});

	it("shows on for a stored opt-in", () => {
		expect(
			renderSection({ experimentalTerminalBidi: true }).bidiToggle.getAttribute("aria-checked"),
		).toBe("true");
	});

	it("asks to turn it off from the default state", async () => {
		const { onTerminalBidiToggle, bidiToggle } = renderSection({});
		await userEvent.click(bidiToggle);
		expect(onTerminalBidiToggle).toHaveBeenCalledWith(false);
	});

	it("asks to turn it back on from a stored opt-out", async () => {
		const { onTerminalBidiToggle, bidiToggle } = renderSection({ experimentalTerminalBidi: false });
		await userEvent.click(bidiToggle);
		expect(onTerminalBidiToggle).toHaveBeenCalledWith(true);
	});
});

/**
 * Freeze diagnostics ships OFF and only macOS can record, so the row has to keep
 * "nobody chose" and "this machine cannot" visibly apart.
 */
describe("AdvancedExperienceSection — freeze diagnostics", () => {
	it("shows off when nothing is stored", () => {
		expect(renderSection({}).freezeToggle.getAttribute("aria-checked")).toBe("false");
	});

	it("shows on for a stored opt-in", () => {
		expect(
			renderSection({ freezeDiagnosticsEnabled: true }).freezeToggle.getAttribute("aria-checked"),
		).toBe("true");
	});

	it("asks to turn it on, and names where the files land", async () => {
		const { onFreezeDiagnosticsToggle, freezeToggle } = renderSection({});
		await userEvent.click(freezeToggle);
		expect(onFreezeDiagnosticsToggle).toHaveBeenCalledWith(true);
		expect(screen.getByText("settings.freezeDiagnosticsPath|/home/logs/freeze")).toBeTruthy();
	});

	it("asks to turn it off from a stored opt-in", async () => {
		const { onFreezeDiagnosticsToggle, freezeToggle } = renderSection({ freezeDiagnosticsEnabled: true });
		await userEvent.click(freezeToggle);
		expect(onFreezeDiagnosticsToggle).toHaveBeenCalledWith(false);
	});

	it("says so and refuses the click where nothing can be recorded", async () => {
		const { onFreezeDiagnosticsToggle, freezeToggle } = renderSection(
			{ freezeDiagnosticsEnabled: true },
			{ supported: false, running: false, directory: "" },
		);
		expect(freezeToggle.getAttribute("aria-checked")).toBe("false");
		expect(screen.getByText("settings.freezeDiagnosticsUnsupported")).toBeTruthy();
		await userEvent.click(freezeToggle);
		expect(onFreezeDiagnosticsToggle).not.toHaveBeenCalled();
	});

	it("stays inert until the host has answered", async () => {
		const { onFreezeDiagnosticsToggle, freezeToggle } = renderSection({ freezeDiagnosticsEnabled: true }, null);
		expect(freezeToggle.getAttribute("aria-checked")).toBe("false");
		expect(screen.queryByText("settings.freezeDiagnosticsUnsupported")).toBeNull();
		await userEvent.click(freezeToggle);
		expect(onFreezeDiagnosticsToggle).not.toHaveBeenCalled();
	});
});
