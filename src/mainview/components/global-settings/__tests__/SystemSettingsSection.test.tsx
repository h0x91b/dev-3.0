import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GlobalSettings } from "../../../../shared/types";
import { I18nProvider, type TFunction } from "../../../i18n";
import SystemSettingsSection from "../SystemSettingsSection";

const t = Object.assign((key: string) => key, {
	plural: (key: string, count: number) => `${key}|${count}`,
}) as unknown as TFunction;

function renderSection(settings: Partial<GlobalSettings> = {}) {
	const onRemoteTunnelChange = vi.fn();
	const onStaticAccessCodeChange = vi.fn();
	render(
		<I18nProvider>
			<SystemSettingsSection
				t={t}
				globalSettings={{ updateChannel: "stable", ...settings } as GlobalSettings}
				caffeinateAvailable
				canaryAvailable
				onUpdateChannelChange={vi.fn()}
				onRemoteTunnelChange={onRemoteTunnelChange}
				onRemoteSilentUpdateToggle={vi.fn()}
				onStaticAccessCodeChange={onStaticAccessCodeChange}
				onPreventSleepToggle={vi.fn()}
				onConfirmBeforeQuitToggle={vi.fn()}
			/>
		</I18nProvider>,
	);
	return { onRemoteTunnelChange, onStaticAccessCodeChange };
}

describe("SystemSettingsSection — tunnel provider", () => {
	it("defaults to the built-in provider and hides the custom fields", () => {
		renderSection();
		const select = screen.getByTestId("remote-tunnel-provider") as HTMLSelectElement;
		expect(select.value).toBe("cloudflare");
		expect(screen.queryByTestId("remote-tunnel-command")).not.toBeInTheDocument();
	});

	it("switching to Custom persists the provider and reveals the fields", async () => {
		const { onRemoteTunnelChange } = renderSection();
		await userEvent.selectOptions(screen.getByTestId("remote-tunnel-provider"), "custom");
		expect(onRemoteTunnelChange).toHaveBeenCalledWith({ provider: "custom", command: "" });
	});

	it("switching back to the built-in provider clears the setting", async () => {
		const { onRemoteTunnelChange } = renderSection({
			remoteTunnel: { provider: "custom", command: "tunnel {port}" },
		});
		await userEvent.selectOptions(screen.getByTestId("remote-tunnel-provider"), "cloudflare");
		expect(onRemoteTunnelChange).toHaveBeenCalledWith(undefined);
	});

	it("persists BOTH fields together on blur, so neither can wipe the other", async () => {
		const { onRemoteTunnelChange } = renderSection({
			remoteTunnel: { provider: "custom", command: "tunnel {port}" },
		});
		const pattern = screen.getByTestId("remote-tunnel-url-pattern") as HTMLInputElement;
		await userEvent.type(pattern, "url=(https://\\S+)");
		await userEvent.tab();
		expect(onRemoteTunnelChange).toHaveBeenLastCalledWith({
			provider: "custom",
			command: "tunnel {port}",
			urlPattern: "url=(https://\\S+)",
		});
	});

	it("warns inline while the command is blank — it fails closed, not back to Cloudflare", async () => {
		renderSection({ remoteTunnel: { provider: "custom", command: "" } });
		expect(screen.getByTestId("remote-tunnel-command-required")).toBeInTheDocument();

		await userEvent.type(screen.getByTestId("remote-tunnel-command"), "ngrok http {port}");
		expect(screen.queryByTestId("remote-tunnel-command-required")).not.toBeInTheDocument();
	});
});

describe("static access code", () => {
	it("persists the trimmed code on blur, not on every keystroke", async () => {
		const { onStaticAccessCodeChange } = renderSection();
		const field = screen.getByTestId("static-access-code") as HTMLInputElement;

		await userEvent.type(field, "  correct-horse-battery-staple  ");
		expect(onStaticAccessCodeChange).not.toHaveBeenCalled();

		await userEvent.tab();
		expect(onStaticAccessCodeChange).toHaveBeenCalledWith("correct-horse-battery-staple");
	});

	it("clearing the field clears the code", async () => {
		const { onStaticAccessCodeChange } = renderSection({ staticAccessCode: "sesame" });
		await userEvent.clear(screen.getByTestId("static-access-code"));
		await userEvent.tab();
		expect(onStaticAccessCodeChange).toHaveBeenCalledWith("");
	});

	it("masks the code by default and reveals it on request", async () => {
		renderSection({ staticAccessCode: "sesame" });
		const field = screen.getByTestId("static-access-code");
		expect(field).toHaveAttribute("type", "password");

		await userEvent.click(screen.getByTestId("static-access-code-reveal"));
		expect(field).toHaveAttribute("type", "text");
	});

	it("warns about public reach only while a code is set", async () => {
		renderSection();
		expect(screen.queryByTestId("static-access-code-warning")).not.toBeInTheDocument();

		await userEvent.type(screen.getByTestId("static-access-code"), "sesame");
		expect(screen.getByTestId("static-access-code-warning")).toBeInTheDocument();
	});
});
