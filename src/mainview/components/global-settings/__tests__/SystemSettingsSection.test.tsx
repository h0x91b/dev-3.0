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
	const onRemotePortChange = vi.fn();
	const tree = (next: Partial<GlobalSettings>) => (
		<I18nProvider>
			<SystemSettingsSection
				t={t}
				globalSettings={{ updateChannel: "stable", ...next } as GlobalSettings}
				caffeinateAvailable
				canaryAvailable
				onUpdateChannelChange={vi.fn()}
				onRemoteTunnelChange={onRemoteTunnelChange}
				onRemotePortChange={onRemotePortChange}
				onRemoteSilentUpdateToggle={vi.fn()}
				onStaticAccessCodeChange={onStaticAccessCodeChange}
				onPreventSleepToggle={vi.fn()}
				onConfirmBeforeQuitToggle={vi.fn()}
			/>
		</I18nProvider>
	);
	const { rerender } = render(tree(settings));
	/** Settings arrive asynchronously; this is the second render carrying them. */
	const settingsArrive = (next: Partial<GlobalSettings>) => rerender(tree(next));
	return { onRemoteTunnelChange, onRemotePortChange, onStaticAccessCodeChange, settingsArrive };
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

	// The host DROPS a code below the floor and falls back to QR links, so saving
	// one would leave a field that looks set and a feature that is quietly off.
	it("refuses to save a code shorter than the shared minimum", async () => {
		const { onStaticAccessCodeChange } = renderSection();
		await userEvent.type(screen.getByTestId("static-access-code"), "short");
		expect(screen.getByTestId("static-access-code-error")).toBeInTheDocument();

		await userEvent.tab();
		expect(onStaticAccessCodeChange).not.toHaveBeenCalled();
	});

	it("saves once the code clears the minimum", async () => {
		const { onStaticAccessCodeChange } = renderSection();
		await userEvent.type(screen.getByTestId("static-access-code"), "long-enough-code");
		expect(screen.queryByTestId("static-access-code-error")).not.toBeInTheDocument();

		await userEvent.tab();
		expect(onStaticAccessCodeChange).toHaveBeenCalledWith("long-enough-code");
	});

	it("warns about public reach only while a code is set", async () => {
		renderSection();
		expect(screen.queryByTestId("static-access-code-warning")).not.toBeInTheDocument();

		await userEvent.type(screen.getByTestId("static-access-code"), "sesame-open-up");
		expect(screen.getByTestId("static-access-code-warning")).toBeInTheDocument();
	});
});

describe("SystemSettingsSection — remote access port", () => {
	it("shows the stored port and persists a new one on blur", async () => {
		const { onRemotePortChange } = renderSection({ remotePort: 41234 });
		const input = screen.getByTestId("remote-port") as HTMLInputElement;
		expect(input.value).toBe("41234");

		await userEvent.clear(input);
		await userEvent.type(input, "8443");
		await userEvent.tab();
		expect(onRemotePortChange).toHaveBeenCalledWith(8443);
	});

	it("clearing the field goes back to a free port each launch", async () => {
		const { onRemotePortChange } = renderSection({ remotePort: 41234 });
		await userEvent.clear(screen.getByTestId("remote-port"));
		await userEvent.tab();
		expect(onRemotePortChange).toHaveBeenCalledWith(undefined);
	});

	// Settings load in a useEffect AFTER this section mounts, so the field's first
	// render never carries the stored port. Freezing it at mount showed
	// "Automatic" over a pinned port, and touching the field then unpinned it.
	it("adopts the stored port when settings arrive after the first render", async () => {
		const { onRemotePortChange, settingsArrive } = renderSection({});
		expect((screen.getByTestId("remote-port") as HTMLInputElement).value).toBe("");

		settingsArrive({ remotePort: 41234 });
		expect((screen.getByTestId("remote-port") as HTMLInputElement).value).toBe("41234");

		// And blurring the untouched field must not unpin what just arrived.
		await userEvent.click(screen.getByTestId("remote-port"));
		await userEvent.tab();
		expect(onRemotePortChange).not.toHaveBeenCalledWith(undefined);
	});

	it("refuses an out-of-range port instead of persisting it", async () => {
		const { onRemotePortChange } = renderSection({ remotePort: 41234 });
		const input = screen.getByTestId("remote-port") as HTMLInputElement;
		await userEvent.clear(input);
		await userEvent.type(input, "70000");
		await userEvent.tab();
		expect(onRemotePortChange).not.toHaveBeenCalled();
		expect(input.value).toBe("41234");
	});
});
