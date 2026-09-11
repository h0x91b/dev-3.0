import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GlobalSettings } from "../../../../shared/types";
import { I18nProvider, type TFunction } from "../../../i18n";
import AdvancedExperienceSection from "../AdvancedExperienceSection";

// Stub translator: return the key so assertions are stable and locale-agnostic.
const t = Object.assign((key: string) => key, {
	plural: (key: string, count: number) => `${key}|${count}`,
}) as unknown as TFunction;

function renderSection(globalSettings: Partial<GlobalSettings>) {
	const onAgentTrafficToggle = vi.fn();
	render(
		<I18nProvider>
			<AdvancedExperienceSection
				t={t}
				globalSettings={globalSettings as GlobalSettings}
				onTerminalBidiToggle={() => {}}
				onAgentTrafficToggle={onAgentTrafficToggle}
			/>
		</I18nProvider>,
	);
	return { onAgentTrafficToggle, toggle: screen.getByLabelText("settings.agentTraffic") };
}

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
