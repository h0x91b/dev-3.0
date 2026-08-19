import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import TerminalShortcutsButton from "../task-info-panel/TerminalShortcutsButton";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import { _resetPaneStateBus, fetchPaneState } from "../../pane-state-bus";
import type { TaskPaneState } from "../../../shared/task-panes";

vi.mock("../../rpc", () => ({
	api: { request: { taskPaneState: vi.fn(), taskPaneAction: vi.fn() } },
}));

function state(backend: "tmux" | "native"): TaskPaneState {
	return {
		backend,
		panes: [{ paneId: "%1", index: 0, label: "", active: true, zoomed: false, rect: { x: 0, y: 0, width: 1, height: 1 } }],
		activePaneId: "%1",
		zoomedPaneId: null,
		layout: null,
		layoutPreset: null,
		capabilities: ["split", "zoom", "close"],
	};
}

function renderButton() {
	return render(
		<I18nProvider>
			<TerminalShortcutsButton taskId="task-1" />
		</I18nProvider>,
	);
}

describe("TerminalShortcutsButton", () => {
	beforeEach(() => {
		_resetPaneStateBus();
		vi.mocked(api.request.taskPaneState).mockReset();
	});

	it("opens the ⌘/ overlay's Terminal tab", async () => {
		const user = userEvent.setup();
		const seen = vi.fn();
		window.addEventListener("menu:show-tmux-cheat-sheet", seen);
		vi.mocked(api.request.taskPaneState).mockResolvedValue(state("tmux"));

		renderButton();
		await user.click(screen.getByRole("button"));

		expect(seen).toHaveBeenCalledTimes(1);
		window.removeEventListener("menu:show-tmux-cheat-sheet", seen);
	});

	it("says tmux while the pane state is unknown and stays tmux for a tmux task", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(state("tmux"));
		renderButton();
		expect(screen.getByTitle("tmux Shortcuts")).toBeInTheDocument();

		await fetchPaneState("task-1");
		await waitFor(() => expect(screen.getByTitle("tmux Shortcuts")).toBeInTheDocument());
	});

	it("switches the wording for a native-backend task", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(state("native"));
		renderButton();

		// The bus is shared: the button only listens, TaskPaneControls does the polling.
		await fetchPaneState("task-1");

		await waitFor(() => expect(screen.getByTitle("Terminal Shortcuts")).toBeInTheDocument());
		expect(screen.queryByTitle("tmux Shortcuts")).not.toBeInTheDocument();
	});

	it("never polls the backend itself", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(state("tmux"));
		renderButton();
		await new Promise((r) => setTimeout(r, 30));
		expect(api.request.taskPaneState).not.toHaveBeenCalled();
	});
});
