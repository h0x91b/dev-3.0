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

const THREE_WINDOWS = { count: 3, activeIndex: 0, labels: ["claude", "shell", "logs"] };

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
		vi.mocked(api.request.tmuxWindowNavigate).mockResolvedValue({ count: 1, activeIndex: 0, labels: ["claude"] });
		renderCarousel();
		expect(screen.getByTestId("terminal-body")).toBeInTheDocument();
		await waitFor(() => expect(api.request.tmuxWindowNavigate).toHaveBeenCalled());
	});

	it("shows no switcher for a single-window session", async () => {
		vi.mocked(api.request.tmuxWindowNavigate).mockResolvedValue({ count: 1, activeIndex: 0, labels: ["claude"] });
		renderCarousel();
		await waitFor(() => expect(api.request.tmuxWindowNavigate).toHaveBeenCalled());
		expect(screen.queryByLabelText("Switch window")).toBeNull();
		expect(screen.queryByLabelText("Next window")).toBeNull();
	});

	it("polls read-only on mount (no step/index) and shows chevrons + named dropdown for multi-window", async () => {
		vi.mocked(api.request.tmuxWindowNavigate).mockResolvedValue(THREE_WINDOWS);
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Switch window")).toBeInTheDocument());
		expect(screen.getByLabelText("Previous window")).toBeInTheDocument();
		expect(screen.getByLabelText("Next window")).toBeInTheDocument();
		expect(screen.getByLabelText("Switch window")).toHaveTextContent("1. claude");
		// Mount poll is a pure read — no navigation args.
		expect(vi.mocked(api.request.tmuxWindowNavigate).mock.calls[0][0]).toEqual({ taskId: "task-1" });
	});

	it("the dropdown lists named windows and jumps to one by index (firing onSwitch)", async () => {
		vi.mocked(api.request.tmuxWindowNavigate).mockResolvedValue(THREE_WINDOWS);
		const onSwitch = vi.fn();
		renderCarousel(onSwitch);
		await waitFor(() => expect(screen.getByLabelText("Switch window")).toBeInTheDocument());

		await userEvent.click(screen.getByLabelText("Switch window"));
		const options = screen.getAllByRole("option");
		expect(options).toHaveLength(3);
		expect(options[1]).toHaveTextContent("shell");

		await userEvent.click(screen.getByRole("option", { name: /logs/ }));
		expect(api.request.tmuxWindowNavigate).toHaveBeenCalledWith({ taskId: "task-1", index: 2 });
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
		await waitFor(() => expect(screen.getByLabelText("Switch window")).toBeInTheDocument());
		expect(onSwitch).not.toHaveBeenCalled();
	});

	it("Arrow keys move between windows while the bar is focused", async () => {
		vi.mocked(api.request.tmuxWindowNavigate).mockResolvedValue(THREE_WINDOWS);
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Switch window")).toBeInTheDocument());
		const group = screen.getByRole("group");
		group.focus();
		await userEvent.keyboard("{ArrowRight}");
		expect(api.request.tmuxWindowNavigate).toHaveBeenCalledWith({ taskId: "task-1", step: "next" });
	});
});
