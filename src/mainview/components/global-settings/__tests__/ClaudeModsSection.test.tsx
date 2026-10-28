import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeModStatus } from "../../../../shared/types";
import type { TFunction } from "../../../i18n";

const h = vi.hoisted(() => ({
	claudeModStatus: vi.fn(),
	claudeModSetEnabled: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("../../../rpc", () => ({
	api: { request: { claudeModStatus: h.claudeModStatus, claudeModSetEnabled: h.claudeModSetEnabled } },
}));
vi.mock("../../../toast", () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));

import ClaudeModsSection from "../ClaudeModsSection";

const t = Object.assign(
	(key: string, params?: Record<string, string | number>) =>
		params ? `${key}|${Object.values(params).join(",")}` : key,
	{ plural: (key: string, count: number) => `${key}|${count}` },
) as unknown as TFunction;

function status(overrides: Partial<ClaudeModStatus> = {}): ClaudeModStatus {
	return { modId: "prismantis", claudeAvailable: true, installed: false, enabled: false, version: null, ...overrides };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("ClaudeModsSection", () => {
	it("turns prismantis on and reports the installed version", async () => {
		h.claudeModStatus.mockResolvedValue(status());
		h.claudeModSetEnabled.mockResolvedValue(status({ installed: true, enabled: true, version: "0.36.0" }));
		render(<ClaudeModsSection t={t} />);

		const toggle = await screen.findByRole("switch", { name: "settings.claudeMod.prismantis.title" });
		await waitFor(() => expect(toggle).toHaveAttribute("tabindex", "0"));
		expect(toggle).toHaveAttribute("aria-checked", "false");

		await userEvent.click(toggle);

		expect(h.claudeModSetEnabled).toHaveBeenCalledWith({ modId: "prismantis", enabled: true });
		await screen.findByText("settings.claudeModVersion|0.36.0");
		expect(toggle).toHaveAttribute("aria-checked", "true");
		expect(h.toastSuccess).toHaveBeenCalledWith("settings.claudeModInstalled|settings.claudeMod.prismantis.title");
	});

	it("turns an installed mod off", async () => {
		h.claudeModStatus.mockResolvedValue(status({ installed: true, enabled: true, version: "0.36.0" }));
		h.claudeModSetEnabled.mockResolvedValue(status());
		render(<ClaudeModsSection t={t} />);

		const toggle = await screen.findByRole("switch");
		await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
		await userEvent.click(toggle);

		expect(h.claudeModSetEnabled).toHaveBeenCalledWith({ modId: "prismantis", enabled: false });
		await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
	});

	it("shows the CLI error in a toast and keeps the switch where it was", async () => {
		h.claudeModStatus.mockResolvedValue(status());
		h.claudeModSetEnabled.mockRejectedValue(new Error("network unreachable"));
		render(<ClaudeModsSection t={t} />);

		const toggle = await screen.findByRole("switch");
		await waitFor(() => expect(toggle).toHaveAttribute("tabindex", "0"));
		await userEvent.click(toggle);

		await waitFor(() =>
			expect(h.toastError).toHaveBeenCalledWith(
				"settings.claudeModFailed|settings.claudeMod.prismantis.title,network unreachable",
			),
		);
		expect(toggle).toHaveAttribute("aria-checked", "false");
	});

	it("disables the switch and explains why when Claude Code is missing", async () => {
		h.claudeModStatus.mockResolvedValue(status({ claudeAvailable: false }));
		render(<ClaudeModsSection t={t} />);

		await screen.findByText("settings.claudeModNoCli");
		expect(screen.getByRole("switch")).toHaveAttribute("tabindex", "-1");
	});
});
