import { render, screen, waitFor } from "@testing-library/react";
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
			showConfirm: vi.fn(() => Promise.resolve(false)),
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
		await user.click(screen.getByTitle("tmux Sessions"));

		// Popover should show the project terminal entry
		expect(screen.getByText("dev-3.0")).toBeInTheDocument();
		expect(screen.getByText("Project Terminal")).toBeInTheDocument();
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
		await user.click(screen.getByTitle("tmux Sessions"));

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

		await user.click(screen.getByTitle("tmux Sessions"));
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

		await user.click(screen.getByTitle("tmux Sessions"));

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

		await user.click(screen.getByTitle("tmux Sessions"));

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

		await user.click(screen.getByTitle("tmux Sessions"));
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

		await user.click(screen.getByTitle("tmux Sessions"));

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

		await user.click(screen.getByTitle("tmux Sessions"));

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

		await user.click(screen.getByTitle("tmux Sessions"));

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

		await user.click(screen.getByTitle("tmux Sessions"));

		// Should show session name (not project name since it's undefined)
		const nameEl = screen.getByText("dev3-pt-a1c9fe4e");
		expect(nameEl.className).toContain("text-fg");
		expect(nameEl.className).not.toContain("text-accent");

		await user.click(nameEl);
		expect(navigate).not.toHaveBeenCalled();
	});
});
