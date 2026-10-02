import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import TerminalWindowNav from "../TerminalWindowNav";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import { notifyTmuxWindowsChanged, setWindowNavStyle } from "../../terminal-window-nav";
import type { TmuxWindowEntry } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: { request: { tmuxWindowNavigate: vi.fn() } },
}));

function win(index: number, label: string, extra: Partial<TmuxWindowEntry> = {}): TmuxWindowEntry {
	return { windowId: `@${index}`, index, label, active: false, home: false, panes: 1, activity: 100, bell: false, ...extra };
}

const mounts = { count: 0 };
function Terminal() {
	useEffect(() => {
		mounts.count++;
	}, []);
	return <div data-testid="terminal">term</div>;
}

function renderNav(taskStatus?: "in-progress" | "user-questions", taskTitle?: string) {
	return render(
		<I18nProvider>
			<TerminalWindowNav taskId="task-1" taskStatus={taskStatus} taskTitle={taskTitle}>
				<Terminal />
			</TerminalWindowNav>
		</I18nProvider>,
	);
}

const navigate = () => vi.mocked(api.request.tmuxWindowNavigate);
const respond = (windows: TmuxWindowEntry[]) => navigate().mockResolvedValue({ windows });
const reread = async () => {
	await act(async () => {
		notifyTmuxWindowsChanged("task-1");
	});
};

describe("TerminalWindowNav", () => {
	beforeEach(() => {
		navigate().mockReset();
		mounts.count = 0;
		localStorage.clear();
	});

	it("shows nothing but the terminal while the session has one window", async () => {
		respond([win(1, "Fix auth", { active: true, home: true })]);
		renderNav();
		await waitFor(() => expect(navigate()).toHaveBeenCalled());
		expect(screen.getByTestId("terminal")).toBeInTheDocument();
		expect(screen.queryByRole("tablist")).toBeNull();
	});

	it("defaults to the rail, lists the agent's home window first and marks the active one", async () => {
		respond([win(1, "zsh", { active: true }), win(2, "Fix auth", { home: true })]);
		renderNav();
		const list = await screen.findByRole("tablist");
		expect(list).toHaveAttribute("aria-orientation", "vertical");
		const tabs = screen.getAllByRole("tab");
		expect(tabs[0]).toHaveAccessibleName("Fix auth, agent");
		expect(tabs[1]).toHaveAccessibleName("zsh");
		expect(tabs[1]).toHaveAttribute("aria-selected", "true");
	});

	it("the home window is named after the task, like the tmux bar", async () => {
		respond([win(1, "✳ agent pane title", { home: true, active: true }), win(2, "zsh")]);
		renderNav(undefined, "Make tmux windows discoverable");
		expect(await screen.findByRole("tab", { name: "Make tmux windows discoverable, agent" })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "zsh" })).toBeInTheDocument();
	});

	it("an unnamed window falls back to its tmux number", async () => {
		respond([win(1, "", { active: true }), win(4, "")]);
		renderNav();
		expect(await screen.findByRole("tab", { name: "Window 4" })).toBeInTheDocument();
	});

	it("names the agent's state on the home window", async () => {
		respond([win(1, "Fix auth", { home: true }), win(2, "zsh", { active: true })]);
		renderNav("user-questions");
		expect(await screen.findByRole("tab", { name: "Fix auth, agent, waiting for you" })).toBeInTheDocument();
	});

	it("clicking a window switches to it by id", async () => {
		respond([win(1, "Fix auth", { home: true }), win(2, "zsh", { active: true })]);
		renderNav();
		await userEvent.click(await screen.findByRole("tab", { name: /Fix auth/ }));
		expect(navigate()).toHaveBeenCalledWith({ taskId: "task-1", windowId: "@1" });
	});

	it("switching to tabs restyles live without remounting the terminal", async () => {
		respond([win(1, "Fix auth", { home: true, active: true }), win(2, "zsh")]);
		renderNav();
		await screen.findByRole("tablist");
		expect(mounts.count).toBe(1);
		act(() => setWindowNavStyle("tabs"));
		expect(screen.getByRole("tablist")).toHaveAttribute("aria-orientation", "horizontal");
		expect(screen.getByRole("tab", { name: /zsh/ })).toHaveTextContent("zsh");
		expect(mounts.count).toBe(1);
	});

	it("the navigator appearing for a second window does not remount the terminal", async () => {
		respond([win(1, "Fix auth", { home: true, active: true })]);
		renderNav();
		await waitFor(() => expect(navigate()).toHaveBeenCalled());
		respond([win(1, "Fix auth", { home: true, active: true }), win(2, "zsh")]);
		await reread();
		await screen.findByRole("tablist");
		expect(mounts.count).toBe(1);
	});

	it("marks a background window that printed since you last saw it — never on first sight", async () => {
		respond([win(1, "Fix auth", { home: true, active: true }), win(2, "dev-server", { activity: 100 })]);
		const { container } = renderNav();
		await screen.findByRole("tablist");
		expect(container.querySelector('[data-window-marker="output"]')).toBeNull();

		respond([win(1, "Fix auth", { home: true, active: true, activity: 500 }), win(2, "dev-server", { activity: 200 })]);
		await reread();
		await waitFor(() => expect(screen.getByRole("tab", { name: "dev-server, new output" })).toBeInTheDocument());
		expect(container.querySelectorAll('[data-window-marker="output"]')).toHaveLength(1);
	});

	it("never marks the agent's home window as new output — it repaints all the time", async () => {
		respond([win(1, "Fix auth", { home: true, active: true, activity: 100 }), win(2, "zsh", { active: false })]);
		const { container } = renderNav();
		await screen.findByRole("tablist");
		respond([win(1, "Fix auth", { home: true, activity: 900 }), win(2, "zsh", { active: true })]);
		await reread();
		await waitFor(() => expect(screen.getByRole("tab", { name: "zsh" })).toHaveAttribute("aria-selected", "true"));
		expect(screen.getByRole("tab", { name: /Fix auth/ })).toHaveAccessibleName("Fix auth, agent");
		expect(container.querySelector('[data-window-marker="output"]')).toBeNull();
	});

	it("a bell outranks new output", async () => {
		respond([win(1, "Fix auth", { home: true, active: true }), win(2, "tests", { bell: true })]);
		const { container } = renderNav();
		expect(await screen.findByRole("tab", { name: "tests, bell" })).toBeInTheDocument();
		expect(container.querySelector('[data-window-marker="bell"]')).not.toBeNull();
	});

	it("announces a window that appeared on its own", async () => {
		respond([win(1, "Fix auth", { home: true, active: true }), win(2, "zsh")]);
		renderNav();
		await screen.findByRole("tablist");
		expect(screen.getByRole("status")).toHaveTextContent("");
		respond([win(1, "Fix auth", { home: true, active: true }), win(2, "zsh"), win(3, "storybook")]);
		await reread();
		await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Window opened: storybook"));
	});

	it("arrow keys move focus between windows; Enter switches", async () => {
		respond([win(1, "Fix auth", { home: true, active: true }), win(2, "zsh"), win(3, "logs")]);
		renderNav();
		const tabs = await screen.findAllByRole("tab");
		expect(tabs[0]).toHaveAttribute("tabindex", "0");
		expect(tabs[1]).toHaveAttribute("tabindex", "-1");
		tabs[0].focus();
		await userEvent.keyboard("{ArrowDown}");
		expect(tabs[1]).toHaveFocus();
		await userEvent.keyboard("{End}");
		expect(tabs[2]).toHaveFocus();
		expect(navigate()).not.toHaveBeenCalledWith(expect.objectContaining({ windowId: expect.anything() }));
		await userEvent.keyboard("{Enter}");
		expect(navigate()).toHaveBeenCalledWith({ taskId: "task-1", windowId: "@3" });
	});
});
