import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MobileWindowCarousel from "../MobileWindowCarousel";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			tmuxWindowNavigate: vi.fn(),
		},
	},
}));

import type { TmuxWindowEntry } from "../../../shared/types";

function win(index: number, label: string, extra: Partial<TmuxWindowEntry> = {}): TmuxWindowEntry {
	return { windowId: `@${index}`, index, label, active: false, home: false, panes: 1, activity: 0, bell: false, ...extra };
}
const ONE_WINDOW = { windows: [win(1, "claude", { active: true, home: true })] };
const THREE_WINDOWS = { windows: [win(1, "claude", { active: true, home: true }), win(2, "shell"), win(3, "logs")] };

function renderCarousel(onSwitch?: () => void, taskId = "task-1") {
	return render(
		<I18nProvider>
			<MobileWindowCarousel taskId={taskId} onSwitch={onSwitch}>
				<div data-testid="terminal-body">term</div>
			</MobileWindowCarousel>
		</I18nProvider>,
	);
}

describe("MobileWindowCarousel", () => {
	beforeEach(() => {
		vi.mocked(api.request.tmuxWindowNavigate).mockReset();
	});

	it("always renders the children", async () => {
		vi.mocked(api.request.tmuxWindowNavigate).mockResolvedValue(ONE_WINDOW);
		renderCarousel();
		expect(screen.getByTestId("terminal-body")).toBeInTheDocument();
		await waitFor(() => expect(api.request.tmuxWindowNavigate).toHaveBeenCalled());
	});

	it("shows no switcher for a single-window session", async () => {
		vi.mocked(api.request.tmuxWindowNavigate).mockResolvedValue(ONE_WINDOW);
		renderCarousel();
		await waitFor(() => expect(api.request.tmuxWindowNavigate).toHaveBeenCalled());
		expect(screen.queryByLabelText(/Switch window/)).toBeNull();
		expect(screen.queryByLabelText("Next window")).toBeNull();
	});

	it("polls read-only on mount (no step/index) and shows chevrons + named dropdown for multi-window", async () => {
		vi.mocked(api.request.tmuxWindowNavigate).mockResolvedValue(THREE_WINDOWS);
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText(/Switch window/)).toBeInTheDocument());
		expect(screen.getByLabelText("Previous window")).toBeInTheDocument();
		expect(screen.getByLabelText("Next window")).toBeInTheDocument();
		expect(screen.getByLabelText(/Switch window/)).toHaveTextContent("1. claude");
		// Mount poll is a pure read — no navigation args.
		expect(vi.mocked(api.request.tmuxWindowNavigate).mock.calls[0][0]).toEqual({ taskId: "task-1" });
	});

	it("the dropdown lists named windows and jumps to one by its id (firing onSwitch)", async () => {
		vi.mocked(api.request.tmuxWindowNavigate).mockResolvedValue(THREE_WINDOWS);
		const onSwitch = vi.fn();
		renderCarousel(onSwitch);
		await waitFor(() => expect(screen.getByLabelText(/Switch window/)).toBeInTheDocument());

		await userEvent.click(screen.getByLabelText(/Switch window/));
		const options = screen.getAllByRole("option");
		expect(options).toHaveLength(3);
		expect(options[1]).toHaveTextContent("shell");

		await userEvent.click(screen.getByRole("option", { name: /logs/ }));
		expect(api.request.tmuxWindowNavigate).toHaveBeenCalledWith({ taskId: "task-1", windowId: "@3" });
		expect(onSwitch).toHaveBeenCalled();
	});

	it("chevron buttons move between windows and fire onSwitch", async () => {
		vi.mocked(api.request.tmuxWindowNavigate).mockResolvedValue(THREE_WINDOWS);
		const onSwitch = vi.fn();
		renderCarousel(onSwitch);
		await waitFor(() => expect(screen.getByLabelText("Next window")).toBeInTheDocument());
		await userEvent.click(screen.getByLabelText("Next window"));
		expect(api.request.tmuxWindowNavigate).toHaveBeenCalledWith({ taskId: "task-1", step: "next" });
		await userEvent.click(screen.getByLabelText("Previous window"));
		expect(api.request.tmuxWindowNavigate).toHaveBeenCalledWith({ taskId: "task-1", step: "prev" });
		expect(onSwitch).toHaveBeenCalledTimes(2);
	});

	it("a mount/poll read does not fire onSwitch", async () => {
		vi.mocked(api.request.tmuxWindowNavigate).mockResolvedValue(THREE_WINDOWS);
		const onSwitch = vi.fn();
		renderCarousel(onSwitch);
		await waitFor(() => expect(screen.getByLabelText(/Switch window/)).toBeInTheDocument());
		expect(onSwitch).not.toHaveBeenCalled();
	});

	it("offers 'Back to the agent' only while you are outside the agent's window", async () => {
		vi.mocked(api.request.tmuxWindowNavigate).mockResolvedValue(THREE_WINDOWS);
		const { unmount } = renderCarousel();
		await waitFor(() => expect(screen.getByLabelText(/Switch window/)).toBeInTheDocument());
		expect(screen.queryByLabelText("Back to the agent")).toBeNull();
		unmount();

		vi.mocked(api.request.tmuxWindowNavigate).mockResolvedValue({
			windows: [win(1, "claude", { home: true }), win(2, "shell", { active: true }), win(3, "logs")],
		});
		renderCarousel();
		await userEvent.click(await screen.findByLabelText("Back to the agent"));
		expect(api.request.tmuxWindowNavigate).toHaveBeenCalledWith({ taskId: "task-1", windowId: "@1" });
	});

	it("the switch button's accessible name carries the visible window name", async () => {
		vi.mocked(api.request.tmuxWindowNavigate).mockResolvedValue(THREE_WINDOWS);
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Switch window: 1. claude")).toBeInTheDocument());
	});

	it("Arrow keys move between windows while the bar is focused", async () => {
		vi.mocked(api.request.tmuxWindowNavigate).mockResolvedValue(THREE_WINDOWS);
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText(/Switch window/)).toBeInTheDocument());
		const group = screen.getByRole("group");
		group.focus();
		await userEvent.keyboard("{ArrowRight}");
		expect(api.request.tmuxWindowNavigate).toHaveBeenCalledWith({ taskId: "task-1", step: "next" });
	});
});
