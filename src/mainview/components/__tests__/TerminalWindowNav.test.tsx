import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import TerminalWindowNav from "../TerminalWindowNav";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import { notifyTmuxWindowsChanged } from "../../terminal-window-nav";
import type { TmuxWindowEntry } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: { request: { tmuxWindowNavigate: vi.fn(), tmuxCloseWindow: vi.fn(), tmuxNewWindow: vi.fn(), tmuxRenameWindow: vi.fn() } },
}));
vi.mock("../../confirm", () => ({ confirm: vi.fn() }));
import { confirm } from "../../confirm";

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
		vi.mocked(api.request.tmuxCloseWindow).mockReset().mockResolvedValue({ closed: true });
		vi.mocked(confirm).mockReset();
		vi.mocked(api.request.tmuxNewWindow).mockReset().mockResolvedValue(undefined as never);
		vi.mocked(api.request.tmuxRenameWindow).mockReset().mockResolvedValue({ renamed: true });
		mounts.count = 0;
		localStorage.clear();
	});

	it("stays visible with a single window, which offers no × and only Rename in its menu", async () => {
		respond([win(1, "Fix auth", { active: true, home: true })]);
		renderNav();
		const tab = await screen.findByRole("tab", { name: "Fix auth, agent" });
		expect(screen.getByTestId("terminal")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /^Close / })).toBeNull();
		await userEvent.pointer({ keys: "[MouseRight]", target: tab });
		expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Rename"]);
		await userEvent.keyboard("{Escape}");
		tab.focus();
		await userEvent.keyboard("{Delete}");
		expect(api.request.tmuxCloseWindow).not.toHaveBeenCalled();
	});

	it("shows a tab row above the terminal, the agent's home window first, the active one marked", async () => {
		respond([win(1, "zsh", { active: true }), win(2, "Fix auth", { home: true })]);
		renderNav();
		const list = await screen.findByRole("tablist");
		expect(list).toHaveAttribute("aria-orientation", "horizontal");
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

	it("the navigator appearing once windows load does not remount the terminal", async () => {
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
		await userEvent.keyboard("{ArrowRight}");
		expect(tabs[1]).toHaveFocus();
		await userEvent.keyboard("{End}");
		expect(tabs[2]).toHaveFocus();
		expect(navigate()).not.toHaveBeenCalledWith(expect.objectContaining({ windowId: expect.anything() }));
		await userEvent.keyboard("{Enter}");
		expect(navigate()).toHaveBeenCalledWith({ taskId: "task-1", windowId: "@3" });
	});

	it("the × on a tab closes exactly that window through the shared close path", async () => {
		respond([win(1, "Fix auth", { home: true, active: true }), win(2, "zsh"), win(3, "logs")]);
		renderNav();
		await userEvent.click(await screen.findByRole("button", { name: "Close logs" }));
		expect(api.request.tmuxCloseWindow).toHaveBeenCalledWith({ taskId: "task-1", windowId: "@3" });
	});

	it("closing the agent's window asks first, then retries that same window with force", async () => {
		vi.mocked(api.request.tmuxCloseWindow).mockResolvedValueOnce({ closed: false, reason: "agentWindow", windowId: "@1" });
		vi.mocked(confirm).mockResolvedValue(true);
		respond([win(1, "Fix auth", { home: true, active: true }), win(2, "zsh")]);
		renderNav();
		await userEvent.click(await screen.findByRole("button", { name: "Close Fix auth" }));
		await waitFor(() => expect(api.request.tmuxCloseWindow).toHaveBeenLastCalledWith({ taskId: "task-1", windowId: "@1", force: true }));
		expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
	});

	it("declining the confirmation leaves the agent's window alone", async () => {
		vi.mocked(api.request.tmuxCloseWindow).mockResolvedValueOnce({ closed: false, reason: "agentWindow", windowId: "@1" });
		vi.mocked(confirm).mockResolvedValue(false);
		respond([win(1, "Fix auth", { home: true, active: true }), win(2, "zsh")]);
		renderNav();
		await userEvent.click(await screen.findByRole("button", { name: "Close Fix auth" }));
		await waitFor(() => expect(confirm).toHaveBeenCalled());
		expect(api.request.tmuxCloseWindow).toHaveBeenCalledTimes(1);
	});

	it("Delete on a focused window and a middle click both close it", async () => {
		respond([win(1, "Fix auth", { home: true, active: true }), win(2, "zsh"), win(3, "logs")]);
		renderNav();
		const tabs = await screen.findAllByRole("tab");
		tabs[1].focus();
		await userEvent.keyboard("{Delete}");
		expect(api.request.tmuxCloseWindow).toHaveBeenCalledWith({ taskId: "task-1", windowId: "@2" });
		await userEvent.pointer({ keys: "[MouseMiddle]", target: tabs[2] });
		expect(api.request.tmuxCloseWindow).toHaveBeenCalledWith({ taskId: "task-1", windowId: "@3" });
	});

	it("a tab shows the window's number and its full name", async () => {
		respond([win(1, "Fix auth", { home: true, active: true }), win(4, "dev-server")]);
		renderNav();
		const tab = await screen.findByRole("tab", { name: "dev-server" });
		expect(tab).toHaveTextContent("4dev-server");
	});

	it("right-click opens a menu that closes that window", async () => {
		respond([win(1, "Fix auth", { home: true, active: true }), win(2, "zsh"), win(3, "logs")]);
		renderNav();
		await userEvent.pointer({ keys: "[MouseRight]", target: await screen.findByRole("tab", { name: "logs" }) });
		const menu = screen.getByRole("menu");
		expect(screen.getAllByRole("menuitem")[0]).toHaveFocus();
		await userEvent.click(screen.getByRole("menuitem", { name: "Close window" }));
		expect(api.request.tmuxCloseWindow).toHaveBeenCalledWith({ taskId: "task-1", windowId: "@3" });
		expect(menu).not.toBeInTheDocument();
	});

	it("the menu switches to a background window; the active one offers only Close", async () => {
		respond([win(1, "Fix auth", { home: true, active: true }), win(2, "zsh")]);
		renderNav();
		await userEvent.pointer({ keys: "[MouseRight]", target: await screen.findByRole("tab", { name: "zsh" }) });
		await userEvent.click(screen.getByRole("menuitem", { name: "Switch to this window" }));
		expect(navigate()).toHaveBeenCalledWith({ taskId: "task-1", windowId: "@2" });
		await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByRole("tab", { name: /Fix auth/ }) });
		expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Rename", "Close window"]);
	});

	it("Shift+F10 opens the menu from the keyboard and Escape returns focus to the window", async () => {
		respond([win(1, "Fix auth", { home: true, active: true }), win(2, "zsh")]);
		renderNav();
		const tab = await screen.findByRole("tab", { name: "zsh" });
		tab.focus();
		await userEvent.keyboard("{Shift>}{F10}{/Shift}");
		expect(screen.getByRole("menu")).toBeInTheDocument();
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("menu")).toBeNull();
		expect(tab).toHaveFocus();
		expect(api.request.tmuxCloseWindow).not.toHaveBeenCalled();
	});

	it("a window the user named shows that name over its automatic one and the task title", async () => {
		respond([win(1, "Claude Code", { home: true, active: true, customName: "Builder" }), win(2, "vite", { customName: "Vite" })]);
		renderNav(undefined, "Fix auth");
		expect(await screen.findByRole("tab", { name: "Builder, agent" })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "Vite" })).toBeInTheDocument();
	});

	it("double-clicking a tab renames it in place; Enter keeps the new name", async () => {
		respond([win(1, "Fix auth", { home: true, active: true }), win(2, "vite")]);
		renderNav();
		await userEvent.dblClick(await screen.findByRole("tab", { name: "vite" }));
		const field = screen.getByRole("textbox", { name: /Window name/ });
		expect(field).toHaveFocus();
		expect(field).toHaveValue("vite");
		expect(field).toHaveAttribute("placeholder", "vite");
		await userEvent.clear(field);
		await userEvent.type(field, "Dev server{Enter}");
		expect(api.request.tmuxRenameWindow).toHaveBeenCalledWith({ taskId: "task-1", windowId: "@2", name: "Dev server" });
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("Escape cancels a rename without saving anything", async () => {
		respond([win(1, "Fix auth", { home: true, active: true }), win(2, "vite")]);
		renderNav();
		await userEvent.dblClick(await screen.findByRole("tab", { name: "vite" }));
		await userEvent.type(screen.getByRole("textbox"), "nope{Escape}");
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(api.request.tmuxRenameWindow).not.toHaveBeenCalled();
		await waitFor(() => expect(screen.getByRole("tab", { name: "vite" })).toHaveFocus());
	});

	it("emptying the field hands a named window back to its automatic name", async () => {
		respond([win(1, "Fix auth", { home: true, active: true }), win(2, "vite", { customName: "Vite" })]);
		renderNav();
		await userEvent.click(await screen.findByRole("button", { name: "Rename Vite" }));
		const field = screen.getByRole("textbox");
		expect(field).toHaveValue("Vite");
		await userEvent.clear(field);
		await userEvent.keyboard("{Enter}");
		expect(api.request.tmuxRenameWindow).toHaveBeenCalledWith({ taskId: "task-1", windowId: "@2", name: "" });
	});

	it("confirming an untouched automatic name does not pin it", async () => {
		respond([win(1, "Fix auth", { home: true, active: true }), win(2, "vite")]);
		renderNav();
		const tab = await screen.findByRole("tab", { name: "vite" });
		tab.focus();
		await userEvent.keyboard("{F2}");
		await userEvent.keyboard("{Enter}");
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(api.request.tmuxRenameWindow).not.toHaveBeenCalled();
	});

	it("the menu's Rename opens the field; leaving the field keeps what was typed", async () => {
		respond([win(1, "Fix auth", { home: true, active: true }), win(2, "vite")]);
		renderNav();
		const tab = await screen.findByRole("tab", { name: "vite" });
		await userEvent.pointer({ keys: "[MouseRight]", target: tab });
		await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
		const field = screen.getByRole("textbox");
		await userEvent.clear(field);
		await userEvent.type(field, "Logs");
		await act(async () => field.blur());
		expect(api.request.tmuxRenameWindow).toHaveBeenCalledWith({ taskId: "task-1", windowId: "@2", name: "Logs" });
	});

	it("the + after the last tab opens a new window, even with one window", async () => {
		respond([win(1, "Fix auth", { home: true, active: true })]);
		renderNav();
		const plus = await screen.findByRole("button", { name: "New window" });
		expect(screen.getByRole("tablist")).not.toContainElement(plus);
		await userEvent.click(plus);
		expect(api.request.tmuxNewWindow).toHaveBeenCalledWith({ taskId: "task-1" });
		await waitFor(() => expect(navigate().mock.calls.length).toBeGreaterThan(1));
	});
});
