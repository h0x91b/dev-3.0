import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TmuxSessionManager from "../TmuxSessionManager";
import { I18nProvider } from "../../i18n";
import type { TmuxSessionInfo } from "../../../shared/types";
import type { Route } from "../../state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			listTmuxSessions: vi.fn(() => Promise.resolve([])),
			killTmuxSession: vi.fn(() => Promise.resolve()),
			setResourceMonitorBoost: vi.fn(() => Promise.resolve()),
		},
	},
}));

import { api } from "../../rpc";

const mockedApi = vi.mocked(api, true);

function renderManager(navigate?: (route: Route) => void) {
	return render(
		<I18nProvider>
			<TmuxSessionManager navigate={navigate ?? vi.fn()} />
		</I18nProvider>,
	);
}

/** The row as it lives inside the header kebab — hover-openable, flyout to the side. */
function renderMenuRow(navigate?: (route: Route) => void) {
	return render(
		<I18nProvider>
			<div role="menu">
				<TmuxSessionManager navigate={navigate ?? vi.fn()} variant="menu" />
			</div>
		</I18nProvider>,
	);
}

const projectTerminalSession: TmuxSessionInfo = {
	name: "dev3-pt-a1c9fe4e",
	cwd: "/Users/test/projects/dev-3.0",
	createdAt: 1700000001,
	windowCount: 1,
	isCleanup: false,
	isProjectTerminal: true,
	projectName: "dev-3.0",
	projectId: "a1c9fe4e-full-uuid",
};

const taskSession: TmuxSessionInfo = {
	name: "dev3-abc12345",
	cwd: "/Users/test/worktrees/abc12345",
	createdAt: 1700000000,
	windowCount: 1,
	isCleanup: false,
	taskTitle: "Fix some bug",
	taskId: "abc12345-full-uuid",
	projectId: "a1c9fe4e-full-uuid",
};

describe("TmuxSessionManager", () => {
	beforeEach(() => vi.clearAllMocks());

	it("renders session count badge after loading sessions", async () => {
		mockedApi.request.listTmuxSessions.mockResolvedValue([projectTerminalSession, taskSession]);
		renderManager();

		await waitFor(() => {
			expect(screen.getByText("2")).toBeInTheDocument();
		});
	});

	it("opens popover and shows sessions on button click", async () => {
		mockedApi.request.listTmuxSessions.mockResolvedValue([projectTerminalSession]);
		const user = userEvent.setup();
		renderManager();

		// Wait for sessions to load
		await waitFor(() => {
			expect(screen.getByText("1")).toBeInTheDocument();
		});

		// Click the tmux sessions button to open popover
		await user.click(screen.getByLabelText("tmux Sessions"));

		// Popover should show the project terminal entry
		expect(screen.getByText("dev-3.0")).toBeInTheDocument();
		expect(screen.getByText("Project Terminal")).toBeInTheDocument();
	});

	it("does not refetch immediately when opening the popover after a fresh load", async () => {
		mockedApi.request.listTmuxSessions.mockResolvedValue([projectTerminalSession]);
		const user = userEvent.setup();
		renderManager();

		await waitFor(() => {
			expect(screen.getByText("1")).toBeInTheDocument();
		});
		expect(mockedApi.request.listTmuxSessions).toHaveBeenCalledTimes(1);

		await user.click(screen.getByLabelText("tmux Sessions"));

		await waitFor(() => {
			expect(screen.getByText("Project Terminal")).toBeInTheDocument();
		});
		expect(mockedApi.request.listTmuxSessions).toHaveBeenCalledTimes(1);
	});

	it("navigates to project-terminal when clicking a project terminal session", async () => {
		mockedApi.request.listTmuxSessions.mockResolvedValue([projectTerminalSession]);
		const navigate = vi.fn();
		const user = userEvent.setup();
		renderManager(navigate);

		// Wait for sessions to load
		await waitFor(() => {
			expect(screen.getByText("1")).toBeInTheDocument();
		});

		// Open popover
		await user.click(screen.getByLabelText("tmux Sessions"));

		// Click on the project name to navigate
		await user.click(screen.getByText("dev-3.0"));

		expect(navigate).toHaveBeenCalledWith({
			screen: "project-terminal",
			projectId: "a1c9fe4e-full-uuid",
		});
	});

	it("navigates to project with activeTaskId when clicking a task session", async () => {
		mockedApi.request.listTmuxSessions.mockResolvedValue([taskSession]);
		const navigate = vi.fn();
		const user = userEvent.setup();
		renderManager(navigate);

		await waitFor(() => {
			expect(screen.getByText("1")).toBeInTheDocument();
		});

		await user.click(screen.getByLabelText("tmux Sessions"));
		await user.click(screen.getByText("Fix some bug"));

		expect(navigate).toHaveBeenCalledWith({
			screen: "project",
			projectId: "a1c9fe4e-full-uuid",
			activeTaskId: "abc12345-full-uuid",
		});
	});

	it("navigates on Enter key for navigable session", async () => {
		mockedApi.request.listTmuxSessions.mockResolvedValue([projectTerminalSession]);
		const navigate = vi.fn();
		const user = userEvent.setup();
		renderManager(navigate);

		await waitFor(() => {
			expect(screen.getByText("1")).toBeInTheDocument();
		});

		await user.click(screen.getByLabelText("tmux Sessions"));

		const row = screen.getByRole("button", { name: /dev-3\.0/i });
		row.focus();
		await user.keyboard("{Enter}");

		expect(navigate).toHaveBeenCalledWith({
			screen: "project-terminal",
			projectId: "a1c9fe4e-full-uuid",
		});
	});

	it("navigates on Space key for navigable session", async () => {
		mockedApi.request.listTmuxSessions.mockResolvedValue([projectTerminalSession]);
		const navigate = vi.fn();
		const user = userEvent.setup();
		renderManager(navigate);

		await waitFor(() => {
			expect(screen.getByText("1")).toBeInTheDocument();
		});

		await user.click(screen.getByLabelText("tmux Sessions"));

		const row = screen.getByRole("button", { name: /dev-3\.0/i });
		row.focus();
		await user.keyboard(" ");

		expect(navigate).toHaveBeenCalledWith({
			screen: "project-terminal",
			projectId: "a1c9fe4e-full-uuid",
		});
	});

	it("does not navigate when clicking the kill button", async () => {
		mockedApi.request.listTmuxSessions.mockResolvedValue([projectTerminalSession]);
		const navigate = vi.fn();
		const user = userEvent.setup();
		renderManager(navigate);

		await waitFor(() => {
			expect(screen.getByText("1")).toBeInTheDocument();
		});

		await user.click(screen.getByLabelText("tmux Sessions"));
		await user.click(screen.getByText("Kill"));

		expect(navigate).not.toHaveBeenCalled();
	});

	it("does not navigate when clicking the copy attach command button", async () => {
		mockedApi.request.listTmuxSessions.mockResolvedValue([projectTerminalSession]);
		const navigate = vi.fn();
		const user = userEvent.setup();

		// Mock clipboard
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", {
			...navigator,
			clipboard: { writeText },
		});

		renderManager(navigate);

		await waitFor(() => {
			expect(screen.getByText("1")).toBeInTheDocument();
		});

		await user.click(screen.getByLabelText("tmux Sessions"));

		// Click the copy button (shows tmux command text)
		const copyBtn = screen.getByText(/tmux -L dev3 attach/);
		await user.click(copyBtn);

		expect(navigate).not.toHaveBeenCalled();
	});

	it("shows project terminal session with cursor-pointer and role=button", async () => {
		mockedApi.request.listTmuxSessions.mockResolvedValue([projectTerminalSession]);
		const user = userEvent.setup();
		renderManager();

		await waitFor(() => {
			expect(screen.getByText("1")).toBeInTheDocument();
		});

		await user.click(screen.getByLabelText("tmux Sessions"));

		// The session name should be in accent color (indicating clickable)
		const nameSpan = screen.getByText("dev-3.0");
		expect(nameSpan.className).toContain("text-accent");

		// The row should have role="button" for accessibility/WKWebView
		const row = nameSpan.closest("[role='button']");
		expect(row).not.toBeNull();
		expect(row?.getAttribute("tabindex")).toBe("0");
	});

	it("copy button uses inline-flex to avoid capturing full row width", async () => {
		mockedApi.request.listTmuxSessions.mockResolvedValue([projectTerminalSession]);
		const user = userEvent.setup();
		renderManager();

		await waitFor(() => {
			expect(screen.getByText("1")).toBeInTheDocument();
		});

		await user.click(screen.getByLabelText("tmux Sessions"));

		const copyBtn = screen.getByText(/tmux -L dev3 attach/).closest("button");
		expect(copyBtn).not.toBeNull();
		expect(copyBtn!.className).toContain("inline-flex");
		expect(copyBtn!.className).not.toMatch(/(?<!\S)flex(?!\S)/);
	});

	it("does NOT navigate when projectId is missing from project terminal session", async () => {
		const sessionWithoutProjectId: TmuxSessionInfo = {
			...projectTerminalSession,
			projectId: undefined,
			projectName: undefined,
		};
		mockedApi.request.listTmuxSessions.mockResolvedValue([sessionWithoutProjectId]);
		const navigate = vi.fn();
		const user = userEvent.setup();
		renderManager(navigate);

		await waitFor(() => {
			expect(screen.getByText("1")).toBeInTheDocument();
		});

		await user.click(screen.getByLabelText("tmux Sessions"));

		// Should show session name (not project name since it's undefined)
		const nameEl = screen.getByText("dev3-pt-a1c9fe4e");
		expect(nameEl.className).toContain("text-fg");
		expect(nameEl.className).not.toContain("text-accent");

		await user.click(nameEl);
		expect(navigate).not.toHaveBeenCalled();
	});

	describe("as a row of the header kebab", () => {
		it("opens the session list on hover — click-only made the row read as a label", async () => {
			mockedApi.request.listTmuxSessions.mockResolvedValue([taskSession]);
			const user = userEvent.setup();
			renderMenuRow();
			await waitFor(() => expect(screen.getByText("1")).toBeInTheDocument());

			await user.hover(screen.getByLabelText("tmux Sessions"));
			// Real timers: the hover dwell is short enough to await for real.
			expect(await screen.findByText("Fix some bug")).toBeInTheDocument();
		});

		it("stays shut while the pointer is merely passing the row", async () => {
			mockedApi.request.listTmuxSessions.mockResolvedValue([taskSession]);
			const user = userEvent.setup();
			renderMenuRow();
			await waitFor(() => expect(screen.getByText("1")).toBeInTheDocument());

			const row = screen.getByLabelText("tmux Sessions");
			await user.hover(row);
			await user.unhover(row);
			await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
			expect(screen.queryByText("Fix some bug")).toBeNull();
		});

		it("marks its flyout so the menu around it stays open while it is used", async () => {
			mockedApi.request.listTmuxSessions.mockResolvedValue([taskSession]);
			const user = userEvent.setup();
			renderMenuRow();
			await waitFor(() => expect(screen.getByText("1")).toBeInTheDocument());

			await user.click(screen.getByLabelText("tmux Sessions"));
			await screen.findByText("Fix some bug");
			expect(document.querySelector("[data-header-flyout]")).not.toBeNull();
		});

		it("keeps a hover-opened list open after a click, so it can be worked in", async () => {
			mockedApi.request.listTmuxSessions.mockResolvedValue([taskSession]);
			const user = userEvent.setup();
			renderMenuRow();
			await waitFor(() => expect(screen.getByText("1")).toBeInTheDocument());

			const row = screen.getByLabelText("tmux Sessions");
			await user.hover(row);
			await screen.findByText("Fix some bug");
			await user.click(row);
			await user.unhover(row);
			await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
			expect(screen.getByText("Fix some bug")).toBeInTheDocument();
		});
	});

	describe("sorting and the live readout", () => {
		function heavy(over: Partial<TmuxSessionInfo> & { name: string }): TmuxSessionInfo {
			return {
				cwd: "/w",
				createdAt: 1700000000,
				windowCount: 1,
				isCleanup: false,
				projectId: "a1c9fe4e-full-uuid",
				...over,
			};
		}

		/** Session names in the order the popover renders them. */
		function renderedOrder(): string[] {
			return [...document.querySelectorAll("[data-session-name]")].map(
				(el) => el.getAttribute("data-session-name") ?? "",
			);
		}

		const bigRam: TmuxSessionInfo = heavy({
			name: "dev3-11111111",
			taskTitle: "Big RAM",
			taskId: "11111111-full-uuid",
			resourceUsage: { rss: 4 * 1024 * 1024 * 1024, cpu: 1 },
		});
		const bigCpu: TmuxSessionInfo = heavy({
			name: "dev3-22222222",
			taskTitle: "Big CPU",
			taskId: "22222222-full-uuid",
			resourceUsage: { rss: 512 * 1024 * 1024, cpu: 90 },
		});
		const unmeasured: TmuxSessionInfo = heavy({
			name: "dev3-pt-a1c9fe4e",
			isProjectTerminal: true,
			projectName: "dev-3.0",
			createdAt: 1700009999,
		});

		beforeEach(() => localStorage.clear());

		async function openWith(sessions: TmuxSessionInfo[]) {
			mockedApi.request.listTmuxSessions.mockResolvedValue(sessions);
			const user = userEvent.setup();
			renderManager();
			await waitFor(() => expect(screen.getByText(String(sessions.length))).toBeInTheDocument());
			await user.click(screen.getByLabelText("tmux Sessions"));
			await waitFor(() => expect(renderedOrder().length).toBe(sessions.length));
			return user;
		}

		it("sorts by memory by default, heaviest first", async () => {
			await openWith([bigCpu, bigRam]);
			expect(renderedOrder()).toEqual([bigRam.name, bigCpu.name]);
		});

		it("re-sorts by CPU when the CPU button is pressed", async () => {
			const user = await openWith([bigRam, bigCpu]);
			await user.click(screen.getByRole("button", { name: "CPU" }));
			expect(renderedOrder()).toEqual([bigCpu.name, bigRam.name]);
		});

		it("keeps the chosen sort across a remount", async () => {
			const user = await openWith([bigRam, bigCpu]);
			await user.click(screen.getByRole("button", { name: "CPU" }));
			expect(localStorage.getItem("dev3-tmux-session-sort")).toBe("cpu");

			cleanup();
			await openWith([bigRam, bigCpu]);
			expect(renderedOrder()).toEqual([bigCpu.name, bigRam.name]);
		});

		it("puts a session with no reading below every measured one", async () => {
			await openWith([unmeasured, bigCpu, bigRam]);
			expect(renderedOrder()).toEqual([bigRam.name, bigCpu.name, unmeasured.name]);
		});

		it("asks the backend for its fast tick while open and releases it on close", async () => {
			const user = await openWith([bigRam]);
			expect(mockedApi.request.setResourceMonitorBoost).toHaveBeenCalledWith({ active: true });

			await user.click(screen.getByLabelText("tmux Sessions"));
			await waitFor(() =>
				expect(mockedApi.request.setResourceMonitorBoost).toHaveBeenCalledWith({ active: false }),
			);
		});

		it("patches a pushed usage update in place and re-sorts on it", async () => {
			await openWith([bigRam, bigCpu]);
			expect(renderedOrder()).toEqual([bigRam.name, bigCpu.name]);

			// bigCpu's tree grows past bigRam's between two ticks.
			await act(async () => {
				window.dispatchEvent(
					new CustomEvent("rpc:resourceUsageUpdated", {
						detail: { taskId: "22222222", usage: { rss: 9 * 1024 * 1024 * 1024, cpu: 90 } },
					}),
				);
			});

			await waitFor(() => expect(renderedOrder()).toEqual([bigCpu.name, bigRam.name]));
			expect(screen.getByText("9.0 GB")).toBeInTheDocument();
		});
	});
});
