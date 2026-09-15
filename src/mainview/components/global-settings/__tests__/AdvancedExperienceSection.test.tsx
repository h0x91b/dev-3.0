import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalSettings } from "../../../../shared/types";
import { I18nProvider, type TFunction } from "../../../i18n";
import { SIMPLIFY_VIEW_PRESET_IDS } from "../../../hideable-controls";
import { setHiddenControlsForTests } from "../../../hidden-controls";
import AdvancedExperienceSection from "../AdvancedExperienceSection";

// Stub translator: return the key so assertions are stable and locale-agnostic.
const t = Object.assign((key: string) => key, {
	plural: (key: string, count: number) => `${key}|${count}`,
}) as unknown as TFunction;

function renderSection(globalSettings: Partial<GlobalSettings>) {
	const onAgentTrafficToggle = vi.fn();
	const onSimplifyModeToggle = vi.fn();
	render(
		<I18nProvider>
			<AdvancedExperienceSection
				t={t}
				globalSettings={globalSettings as GlobalSettings}
				onTerminalBidiToggle={() => {}}
				onAgentTrafficToggle={onAgentTrafficToggle}
				onSimplifyModeToggle={onSimplifyModeToggle}
			/>
		</I18nProvider>,
	);
	return {
		onAgentTrafficToggle,
		onSimplifyModeToggle,
		toggle: screen.getByLabelText("settings.agentTraffic"),
		simplifyToggle: screen.getByLabelText("settings.simplifyMode"),
	};
}

beforeEach(() => {
	setHiddenControlsForTests([]);
});

/**
 * Agent traffic is the one default-on entry of this section, so the toggle has to
 * read three stored states apart: no choice (on), an explicit off, an explicit on.
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

/**
 * Simplify View's checked state is DERIVED from the hidden-controls set (every
 * preset id currently hidden), not read off `globalSettings` — so these tests
 * drive the module directly rather than passing a prop.
 */
describe("AdvancedExperienceSection — simplify view", () => {
	it("shows off when nothing is hidden", () => {
		expect(renderSection({}).simplifyToggle.getAttribute("aria-checked")).toBe("false");
	});

	it("shows on when every preset id is hidden", () => {
		setHiddenControlsForTests(SIMPLIFY_VIEW_PRESET_IDS);
		expect(renderSection({}).simplifyToggle.getAttribute("aria-checked")).toBe("true");
	});

	it("shows off when only SOME preset ids are hidden (a manual restore broke the set)", () => {
		setHiddenControlsForTests(SIMPLIFY_VIEW_PRESET_IDS.slice(1));
		expect(renderSection({}).simplifyToggle.getAttribute("aria-checked")).toBe("false");
	});

	it("asks to turn it on from the default state", async () => {
		const { onSimplifyModeToggle, simplifyToggle } = renderSection({});
		await userEvent.click(simplifyToggle);
		expect(onSimplifyModeToggle).toHaveBeenCalledWith(true);
	});

	it("asks to turn it back off once every preset id is hidden", async () => {
		setHiddenControlsForTests(SIMPLIFY_VIEW_PRESET_IDS);
		const { onSimplifyModeToggle, simplifyToggle } = renderSection({});
		await userEvent.click(simplifyToggle);
		expect(onSimplifyModeToggle).toHaveBeenCalledWith(false);
	});
});
