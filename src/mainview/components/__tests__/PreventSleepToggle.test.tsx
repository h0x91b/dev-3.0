import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import PreventSleepToggle from "../PreventSleepToggle";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getPreventSleepState: vi.fn(),
			setPreventSleep: vi.fn(),
		},
	},
}));

import { api } from "../../rpc";

const mockedApi = vi.mocked(api, true);

function renderToggle() {
	return render(
		<I18nProvider>
			<PreventSleepToggle />
		</I18nProvider>,
	);
}

describe("PreventSleepToggle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders nothing when no sleep-inhibit tool is available", async () => {
		mockedApi.request.getPreventSleepState.mockResolvedValue({ enabled: true, available: false, forcedByRemote: false });
		const { container } = renderToggle();
		await waitFor(() => expect(mockedApi.request.getPreventSleepState).toHaveBeenCalled());
		expect(container.querySelector("button")).toBeNull();
	});

	it("shows the toggle as enabled and turns it off on click", async () => {
		mockedApi.request.getPreventSleepState.mockResolvedValue({ enabled: true, available: true, forcedByRemote: false });
		mockedApi.request.setPreventSleep.mockResolvedValue({ enabled: false });
		renderToggle();

		const button = await screen.findByRole("button");
		expect(button).toHaveAttribute("aria-pressed", "true");

		await userEvent.click(button);
		expect(mockedApi.request.setPreventSleep).toHaveBeenCalledWith({ enabled: false });
	});

	it("is locked and does not toggle while forced by remote access", async () => {
		mockedApi.request.getPreventSleepState.mockResolvedValue({ enabled: false, available: true, forcedByRemote: true });
		renderToggle();

		const button = await screen.findByRole("button");
		expect(button).toBeDisabled();
		expect(button).toHaveAttribute("aria-pressed", "true");

		await userEvent.click(button);
		expect(mockedApi.request.setPreventSleep).not.toHaveBeenCalled();
	});
});
