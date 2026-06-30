import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TmuxLayout } from "../../../shared/types";
import PaneMapSheet from "../PaneMapSheet";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";

vi.mock("../../rpc", () => ({
	api: { request: { tmuxLayout: vi.fn() } },
}));

// Two side-by-side panes in window 0; a second (background) window exists.
const LAYOUT: TmuxLayout = {
	sessionName: "dev3-task1",
	exists: true,
	windows: [
		{ index: 0, name: "main", active: true, panes: 2 },
		{ index: 1, name: "logs", active: false, panes: 1 },
	],
	panes: [
		{ windowIndex: 0, paneId: "%1", active: true, left: 0, top: 0, width: 99, height: 50, command: "claude", title: "Agent" },
		{ windowIndex: 0, paneId: "%2", active: false, left: 100, top: 0, width: 100, height: 50, command: "zsh", title: "Shell" },
		// A pane in the non-active window — must NOT appear on the map.
		{ windowIndex: 1, paneId: "%3", active: true, left: 0, top: 0, width: 200, height: 50, command: "tail", title: "Logs" },
	],
};

function renderSheet(props: Partial<React.ComponentProps<typeof PaneMapSheet>> = {}) {
	const onClose = props.onClose ?? vi.fn();
	const onJump = props.onJump ?? vi.fn();
	render(
		<I18nProvider>
			<PaneMapSheet taskId="task-1" open onClose={onClose} onJump={onJump} {...props} />
		</I18nProvider>,
	);
	return { onClose, onJump };
}

describe("PaneMapSheet", () => {
	beforeEach(() => {
		vi.mocked(api.request.tmuxLayout).mockReset();
	});

	it("fetches the layout when opened", async () => {
		vi.mocked(api.request.tmuxLayout).mockResolvedValue(LAYOUT);
		renderSheet();
		await waitFor(() => expect(api.request.tmuxLayout).toHaveBeenCalledWith({ taskId: "task-1" }));
	});

	it("does not fetch while closed", async () => {
		vi.mocked(api.request.tmuxLayout).mockResolvedValue(LAYOUT);
		renderSheet({ open: false });
		await Promise.resolve();
		expect(api.request.tmuxLayout).not.toHaveBeenCalled();
	});

	it("renders one box per pane of the active window, positioned by geometry", async () => {
		vi.mocked(api.request.tmuxLayout).mockResolvedValue(LAYOUT);
		renderSheet();

		const active = await screen.findByLabelText("Go to claude");
		const other = screen.getByLabelText("Go to zsh");
		// Only the active window's two panes — the %3 pane (window 1) is excluded.
		expect(screen.queryByLabelText("Go to tail")).toBeNull();

		// Geometry → CSS percentages (winW = 200, winH = 50).
		expect(active.style.left).toBe("0%");
		expect(active.style.width).toBe("49.5%");
		expect(other.style.left).toBe("50%");
		expect(other.style.width).toBe("50%");
		// The active pane is flagged for assistive tech.
		expect(active).toHaveAttribute("aria-current", "true");
		expect(other).not.toHaveAttribute("aria-current");
	});

	it("jumps to the tapped pane by id and closes", async () => {
		vi.mocked(api.request.tmuxLayout).mockResolvedValue(LAYOUT);
		const { onClose, onJump } = renderSheet();

		await userEvent.click(await screen.findByLabelText("Go to zsh"));
		expect(onJump).toHaveBeenCalledWith("%2");
		expect(onClose).toHaveBeenCalled();
	});

	it("lists windows when the session has more than one", async () => {
		vi.mocked(api.request.tmuxLayout).mockResolvedValue(LAYOUT);
		renderSheet();
		await screen.findByLabelText("Go to claude");
		expect(screen.getByText("Windows")).toBeInTheDocument();
		expect(screen.getByText("logs")).toBeInTheDocument();
		expect(screen.getByText("1 pane")).toBeInTheDocument();
		expect(screen.getByText("2 panes")).toBeInTheDocument();
	});

	it("hides the window list for a single-window session", async () => {
		vi.mocked(api.request.tmuxLayout).mockResolvedValue({
			...LAYOUT,
			windows: [LAYOUT.windows[0]],
			panes: LAYOUT.panes.filter((p) => p.windowIndex === 0),
		});
		renderSheet();
		await screen.findByLabelText("Go to claude");
		expect(screen.queryByText("Windows")).toBeNull();
	});

	it("shows an empty state when there are no panes", async () => {
		vi.mocked(api.request.tmuxLayout).mockResolvedValue({
			sessionName: "dev3-task1",
			exists: false,
			windows: [],
			panes: [],
		});
		renderSheet();
		expect(await screen.findByText("No panes to show.")).toBeInTheDocument();
	});
});
