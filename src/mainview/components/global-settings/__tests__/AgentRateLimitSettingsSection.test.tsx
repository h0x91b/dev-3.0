import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GlobalSettings } from "../../../../shared/types";
import { I18nProvider, type TFunction } from "../../../i18n";
import AgentRateLimitSettingsSection from "../AgentRateLimitSettingsSection";

const t = ((key: string) => key) as unknown as TFunction;

function renderSection(settings: Partial<GlobalSettings>) {
	const onShowAccountToggle = vi.fn();
	render(
		<I18nProvider>
			<AgentRateLimitSettingsSection
				t={t}
				globalSettings={settings as GlobalSettings}
				onToggle={vi.fn()}
				onShowAccountToggle={onShowAccountToggle}
			/>
		</I18nProvider>,
	);
	return { onShowAccountToggle, toggle: screen.getByRole("switch", { name: "settings.statusLineShowAccount" }) };
}

describe("AgentRateLimitSettingsSection — show account in statusline", () => {
	it("is off by default and turns on when clicked", async () => {
		const { onShowAccountToggle, toggle } = renderSection({});
		expect(toggle).toHaveAttribute("aria-checked", "false");
		await userEvent.click(toggle);
		expect(onShowAccountToggle).toHaveBeenCalledWith(true);
	});

	it("is disabled while rate-limit tracking is off, since tracking injects the wrapper", async () => {
		const { onShowAccountToggle, toggle } = renderSection({ agentRateLimitTracking: false, statusLineShowAccount: true });
		expect(toggle).toHaveAttribute("tabindex", "-1");
		await userEvent.click(toggle);
		expect(onShowAccountToggle).not.toHaveBeenCalled();
	});
});
