import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { I18nProvider } from "../i18n";

vi.mock("../rpc", () => ({
	api: {
		request: {
			checkSystemRequirements: vi.fn().mockResolvedValue([]),
			checkGhAvailable: vi.fn().mockResolvedValue({ available: true, notInstalled: false }),
			getProjects: vi.fn().mockResolvedValue([]),
			getUpdateRoute: vi.fn().mockResolvedValue({ route: null }),
			quitApp: vi.fn().mockResolvedValue(undefined),
			requestQuit: vi.fn().mockResolvedValue(undefined),
			consumePendingQuitDialog: vi.fn().mockResolvedValue(false),
			openNewWindow: vi.fn().mockResolvedValue(undefined),
			hideApp: vi.fn().mockResolvedValue(undefined),
			listTmuxSessions: vi.fn().mockResolvedValue([]),
			getProjectCurrentBranch: vi.fn().mockResolvedValue({ branch: "main", isBaseBranch: true, isDirty: false }),
			pullProjectMain: vi.fn(),
			getPreventSleepState: vi.fn().mockResolvedValue({ enabled: false, available: false, forcedByRemote: false }),
			setPreventSleep: vi.fn(),
			getAgents: vi.fn().mockResolvedValue([]),
			getGlobalSettings: vi.fn().mockResolvedValue({
				defaultAgentId: "builtin-claude",
				defaultConfigId: "claude-default",
				taskDropPosition: "top",
				updateChannel: "stable",
			}),
			moveTask: vi.fn().mockResolvedValue({}),
			dismissMergeCompletionPrompt: vi.fn().mockResolvedValue(undefined),
		},
	},
}));

vi.mock("../analytics", () => ({
	trackPageView: vi.fn(),
	trackEvent: vi.fn(),
}));

vi.mock("../zoom", () => ({
	adjustZoom: vi.fn(),
	applyZoom: vi.fn(),
	ZOOM_STEP: 0.1,
	DEFAULT_ZOOM: 1.0,
	getZoom: vi.fn().mockReturnValue(1.0),
	bootstrapZoom: vi.fn(),
	ZOOM_CHANGED_EVENT: "zoom-changed",
	MIN_ZOOM: 0.5,
	MAX_ZOOM: 2.0,
}));

vi.mock("../task-sounds", () => ({
	initTaskSoundPlayback: vi.fn(),
	playTaskSound: vi.fn().mockResolvedValue(undefined),
}));

// Mock child screens so they don't trigger their own API calls
vi.mock("../components/Dashboard", () => ({
	default: () => <div data-testid="dashboard-screen" />,
}));
vi.mock("../components/AddProjectModal", () => ({
	default: ({ onClose }: { onClose: () => void }) => (
		<div data-testid="add-project-modal">
			<button onClick={onClose}>Close Add Project</button>
		</div>
	),
}));
vi.mock("../components/GlobalSettings", () => ({
	default: () => <div data-testid="settings-screen" />,
}));
vi.mock("../components/Changelog", () => ({
	default: (_props: { navigate: unknown; goBack: unknown; canGoBack: unknown }) => <div data-testid="changelog-screen" />,
}));
vi.mock("../components/ProjectView", () => ({
	default: (props: { projectId: string; activeTaskId?: string; taskView?: boolean }) => (
		<div
			data-testid="project-screen"
			data-project-id={props.projectId}
			data-active-task-id={props.activeTaskId ?? ""}
			data-task-view={props.taskView ? "true" : "false"}
		/>
	),
}));
vi.mock("../components/TaskWorkspaceView", () => ({
	default: () => <div data-testid="task-screen" />,
}));
vi.mock("../components/TaskTerminal", () => ({
	default: () => <div data-testid="task-screen" />,
}));
vi.mock("../components/ProjectSettings", () => ({
	default: () => <div data-testid="project-settings-screen" />,
}));
vi.mock("../components/RequirementsCheck", () => ({
	default: () => <div data-testid="requirements-check" />,
}));
vi.mock("../components/gauges/GaugeDemo", () => ({
	default: () => <div data-testid="gauge-demo-screen" />,
}));
vi.mock("../components/ProjectTerminal", () => ({
	default: () => <div data-testid="project-terminal-screen" />,
}));

import { api } from "../rpc";
import { confirm } from "../confirm";

vi.mock("../confirm", () => ({
	confirm: vi.fn().mockResolvedValue(false),
	ConfirmHost: () => null,
}));
import { initTaskSoundPlayback, playTaskSound } from "../task-sounds";
import { adjustZoom, applyZoom, ZOOM_STEP, DEFAULT_ZOOM } from "../zoom";

const mockedAdjustZoom = vi.mocked(adjustZoom);
const mockedApplyZoom = vi.mocked(applyZoom);

async function renderApp() {
	render(
		<I18nProvider>
			<App />
		</I18nProvider>,
	);
	await waitFor(() =>
		expect(
			screen.queryByTestId("dashboard-screen")
			|| screen.queryByTestId("project-screen")
			|| screen.queryByTestId("task-screen")
			|| screen.queryByTestId("settings-screen")
			|| screen.queryByTestId("project-settings-screen")
			|| screen.queryByTestId("project-terminal-screen"),
		).toBeInTheDocument(),
	);
}

describe("App keyboard shortcuts", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(api.request.checkSystemRequirements).mockResolvedValue([]);
		vi.mocked(api.request.getProjects).mockResolvedValue([]);
		vi.mocked(api.request.getUpdateRoute).mockResolvedValue({ route: null });
		vi.mocked(api.request.listTmuxSessions).mockResolvedValue([]);
	});

	// Quit is gated in the bun `before-quit` handler now (covers menu Quit, dock
	// Quit, and the renderer-initiated Cmd+Q). The bun side pushes
	// `rpc:showQuitDialog` to ask the renderer to confirm. Cmd+Q is caught in the
	// renderer (WKWebView swallows the native accelerator) and forwarded to bun
	// via `requestQuit`, which runs the same gate.
	describe("quit confirmation dialog", () => {
		function requestQuitDialog() {
			act(() => {
				window.dispatchEvent(new CustomEvent("rpc:showQuitDialog"));
			});
		}

		it("opens the quit dialog when bun requests it", async () => {
			await renderApp();
			requestQuitDialog();
			expect(screen.getByText("Sessions keep running")).toBeInTheDocument();
		});

		it("shows the dialog on mount when a quit is pending (reopened window)", async () => {
			vi.mocked(api.request.consumePendingQuitDialog).mockResolvedValueOnce(true);
			await renderApp();
			expect(await screen.findByText("Sessions keep running")).toBeInTheDocument();
		});

		it("does not show the dialog on mount when no quit is pending", async () => {
			vi.mocked(api.request.consumePendingQuitDialog).mockResolvedValueOnce(false);
			await renderApp();
			expect(screen.queryByText("Sessions keep running")).not.toBeInTheDocument();
		});

		it("Cmd+Q forwards to bun via requestQuit (no native accelerator reliance)", async () => {
			vi.mocked(api.request.requestQuit).mockResolvedValue(undefined);
			await renderApp();
			await userEvent.keyboard("{Meta>}q{/Meta}");
			expect(api.request.requestQuit).toHaveBeenCalled();
		});

		it("Ctrl+Q forwards to bun via requestQuit", async () => {
			vi.mocked(api.request.requestQuit).mockResolvedValue(undefined);
			await renderApp();
			await userEvent.keyboard("{Control>}q{/Control}");
			expect(api.request.requestQuit).toHaveBeenCalled();
		});

		it("Escape closes the quit dialog", async () => {
			await renderApp();
			requestQuitDialog();
			expect(screen.getByText("Sessions keep running")).toBeInTheDocument();
			await userEvent.keyboard("{Escape}");
			expect(screen.queryByText("Sessions keep running")).not.toBeInTheDocument();
		});

		it("Quit button confirms via quitApp (dontShowAgain=false by default)", async () => {
			vi.mocked(api.request.quitApp).mockResolvedValue(undefined);
			await renderApp();
			requestQuitDialog();
			await userEvent.click(screen.getByRole("button", { name: "Quit" }));
			expect(api.request.quitApp).toHaveBeenCalledWith({ dontShowAgain: false });
		});

		it("Quit with 'don't show again' checked passes dontShowAgain=true", async () => {
			vi.mocked(api.request.quitApp).mockResolvedValue(undefined);
			await renderApp();
			requestQuitDialog();
			await userEvent.click(screen.getByRole("checkbox"));
			await userEvent.click(screen.getByRole("button", { name: "Quit" }));
			expect(api.request.quitApp).toHaveBeenCalledWith({ dontShowAgain: true });
		});
	});

	describe("hide (Cmd+H / Ctrl+H)", () => {
		it("Cmd+H calls hideApp", async () => {
			await renderApp();
			await userEvent.keyboard("{Meta>}h{/Meta}");
			expect(api.request.hideApp).toHaveBeenCalled();
		});

		it("Ctrl+H calls hideApp", async () => {
			await renderApp();
			await userEvent.keyboard("{Control>}h{/Control}");
			expect(api.request.hideApp).toHaveBeenCalled();
		});
	});

	describe("settings (Cmd+, / Ctrl+,)", () => {
		it("Cmd+, navigates to the settings screen", async () => {
			await renderApp();
			await userEvent.keyboard("{Meta>},{/Meta}");
			expect(screen.getByTestId("settings-screen")).toBeInTheDocument();
		});

		it("Ctrl+, navigates to the settings screen", async () => {
			await renderApp();
			await userEvent.keyboard("{Control>},{/Control}");
			expect(screen.getByTestId("settings-screen")).toBeInTheDocument();
		});

		it("Escape from settings goes back to dashboard", async () => {
			await renderApp();
			await userEvent.keyboard("{Meta>},{/Meta}");
			expect(screen.getByTestId("settings-screen")).toBeInTheDocument();
			await userEvent.keyboard("{Escape}");
			expect(screen.getByTestId("dashboard-screen")).toBeInTheDocument();
		});
	});

	describe("switch project (Cmd+1..9)", () => {
		const twoProjects = [
			{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			{ id: "p2", name: "Beta", path: "/b", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
		];

		it("preserves task view: Cmd+2 from a task switches project and keeps task-view layout with no task selected", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue(twoProjects);
			vi.mocked(api.request.getUpdateRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "project", projectId: "p1", activeTaskId: "t1" }),
			});

			await renderApp();
			const before = screen.getByTestId("project-screen");
			expect(before).toHaveAttribute("data-project-id", "p1");
			expect(before).toHaveAttribute("data-active-task-id", "t1");

			await userEvent.keyboard("{Meta>}2{/Meta}");

			const after = screen.getByTestId("project-screen");
			expect(after).toHaveAttribute("data-project-id", "p2");
			expect(after).toHaveAttribute("data-task-view", "true");
			expect(after).toHaveAttribute("data-active-task-id", "");
		});

		it("preserves task view from the full-page task screen too", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue(twoProjects);
			vi.mocked(api.request.getUpdateRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "task", projectId: "p1", taskId: "t1" }),
			});

			await renderApp();
			expect(screen.getByTestId("task-screen")).toBeInTheDocument();

			await userEvent.keyboard("{Meta>}2{/Meta}");

			const after = screen.getByTestId("project-screen");
			expect(after).toHaveAttribute("data-project-id", "p2");
			expect(after).toHaveAttribute("data-task-view", "true");
		});

		it("keeps board view: Cmd+2 from the Kanban board switches project without task view", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue(twoProjects);
			vi.mocked(api.request.getUpdateRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "project", projectId: "p1" }),
			});

			await renderApp();
			const before = screen.getByTestId("project-screen");
			expect(before).toHaveAttribute("data-project-id", "p1");
			expect(before).toHaveAttribute("data-task-view", "false");

			await userEvent.keyboard("{Meta>}2{/Meta}");

			const after = screen.getByTestId("project-screen");
			expect(after).toHaveAttribute("data-project-id", "p2");
			expect(after).toHaveAttribute("data-task-view", "false");
			expect(after).toHaveAttribute("data-active-task-id", "");
		});
	});

	describe("Add Project modal", () => {
		it("initializes task sound playback on mount", async () => {
			await renderApp();
			expect(initTaskSoundPlayback).toHaveBeenCalled();
		});

		it("opens when rpc:openAddProjectModal fires", async () => {
			await renderApp();
			await act(async () => {
				window.dispatchEvent(new CustomEvent("rpc:openAddProjectModal"));
			});
			expect(screen.getByTestId("dashboard-screen")).toBeInTheDocument();
			expect(await screen.findByTestId("add-project-modal")).toBeInTheDocument();
		});

		it("Cmd+P returns to dashboard and opens Add Project from the full task screen", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			vi.mocked(api.request.getUpdateRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "task", projectId: "p1", taskId: "t1" }),
			});

			await renderApp();
			expect(screen.getByTestId("task-screen")).toBeInTheDocument();

			await userEvent.keyboard("{Meta>}p{/Meta}");

			expect(await screen.findByTestId("dashboard-screen")).toBeInTheDocument();
			expect(await screen.findByTestId("add-project-modal")).toBeInTheDocument();
		});

		it("rpc:openAddProjectModal returns to dashboard and opens Add Project from the full task screen", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			vi.mocked(api.request.getUpdateRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "task", projectId: "p1", taskId: "t1" }),
			});

			await renderApp();
			expect(screen.getByTestId("task-screen")).toBeInTheDocument();

			await act(async () => {
				window.dispatchEvent(new CustomEvent("rpc:openAddProjectModal"));
			});

			expect(await screen.findByTestId("dashboard-screen")).toBeInTheDocument();
			expect(await screen.findByTestId("add-project-modal")).toBeInTheDocument();
		});

		it("closes when the modal requests close", async () => {
			await renderApp();
			await act(async () => {
				window.dispatchEvent(new CustomEvent("rpc:openAddProjectModal"));
			});
			await userEvent.click(await screen.findByText("Close Add Project"));
			expect(screen.queryByTestId("add-project-modal")).not.toBeInTheDocument();
		});

		it("plays task sounds when rpc:taskSound fires", async () => {
			await renderApp();
			await act(async () => {
				window.dispatchEvent(new CustomEvent("rpc:taskSound", { detail: { status: "completed" } }));
			});
			expect(playTaskSound).toHaveBeenCalledWith("completed");
		});
	});

	describe("New Window (Cmd+Shift+N)", () => {
		it("Cmd+Shift+N opens a new window via openNewWindow", async () => {
			vi.mocked(api.request.openNewWindow).mockResolvedValue(undefined);
			await renderApp();
			await userEvent.keyboard("{Meta>}{Shift>}n{/Shift}{/Meta}");
			expect(api.request.openNewWindow).toHaveBeenCalled();
		});

		it("Cmd+Shift+N does not open the New Task modal", async () => {
			vi.mocked(api.request.openNewWindow).mockResolvedValue(undefined);
			await renderApp();
			await userEvent.keyboard("{Meta>}{Shift>}n{/Shift}{/Meta}");
			expect(screen.queryByText("New Task")).not.toBeInTheDocument();
		});

		it("Ctrl+Shift+N opens a new window", async () => {
			vi.mocked(api.request.openNewWindow).mockResolvedValue(undefined);
			await renderApp();
			await userEvent.keyboard("{Control>}{Shift>}n{/Shift}{/Control}");
			expect(api.request.openNewWindow).toHaveBeenCalled();
		});
	});

	describe("New Task modal", () => {
		it("opens from the full task screen with Cmd+N", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			vi.mocked(api.request.getUpdateRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "task", projectId: "p1", taskId: "t1" }),
			});

			await renderApp();
			expect(screen.getByTestId("task-screen")).toBeInTheDocument();

			await userEvent.keyboard("{Meta>}n{/Meta}");

			expect(await screen.findByText("New Task")).toBeInTheDocument();
		});

		it("Cmd+N from a task shows the Scratch button (same dialog as Kanban)", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			vi.mocked(api.request.getUpdateRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "task", projectId: "p1", taskId: "t1" }),
			});

			await renderApp();
			expect(screen.getByTestId("task-screen")).toBeInTheDocument();

			await userEvent.keyboard("{Meta>}n{/Meta}");

			expect(await screen.findByText("New Task")).toBeInTheDocument();
			// Scratch + Save & Start are the markers that onCreateAndRun was passed
			expect(await screen.findByText("Scratch Task")).toBeInTheDocument();
			expect(await screen.findByText("Save & Start")).toBeInTheDocument();
		});

		it("opens from the full task screen when rpc:openCreateTaskModal fires", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			vi.mocked(api.request.getUpdateRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "task", projectId: "p1", taskId: "t1" }),
			});

			await renderApp();
			expect(screen.getByTestId("task-screen")).toBeInTheDocument();

			await act(async () => {
				window.dispatchEvent(new CustomEvent("rpc:openCreateTaskModal"));
			});

			expect(await screen.findByText("New Task")).toBeInTheDocument();
		});
	});

	describe("Escape from project view", () => {
		it("Escape from project screen goes back to dashboard", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			await renderApp();
			await userEvent.keyboard("{Meta>}1{/Meta}");
			expect(screen.getByTestId("project-screen")).toBeInTheDocument();
			await userEvent.keyboard("{Escape}");
			expect(screen.getByTestId("dashboard-screen")).toBeInTheDocument();
		});
	});

	describe("project switching (Cmd+1..9)", () => {
		it("Cmd+1 navigates to the first project", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
				{ id: "p2", name: "Beta", path: "/b", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			await renderApp();
			await userEvent.keyboard("{Meta>}1{/Meta}");
			expect(screen.getByTestId("project-screen")).toBeInTheDocument();
		});

		it("Cmd+2 navigates to the second project", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
				{ id: "p2", name: "Beta", path: "/b", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			await renderApp();
			await userEvent.keyboard("{Meta>}2{/Meta}");
			expect(screen.getByTestId("project-screen")).toBeInTheDocument();
		});

		it("Cmd+9 does nothing when fewer than 9 projects", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			await renderApp();
			await userEvent.keyboard("{Meta>}9{/Meta}");
			// Should stay on dashboard
			expect(screen.getByTestId("dashboard-screen")).toBeInTheDocument();
		});

		it("skips deleted projects in the index", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Deleted", path: "/d", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "", deleted: true },
				{ id: "p2", name: "Active", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			await renderApp();
			// Cmd+1 should navigate to Active (the only non-deleted project)
			await userEvent.keyboard("{Meta>}1{/Meta}");
			expect(screen.getByTestId("project-screen")).toBeInTheDocument();
		});
	});

	describe("project terminal toggle (Cmd+`)", () => {
		it("Cmd+` from project screen opens project terminal", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			await renderApp();
			// Navigate to project first
			await userEvent.keyboard("{Meta>}1{/Meta}");
			expect(screen.getByTestId("project-screen")).toBeInTheDocument();
			// Toggle terminal
			await userEvent.keyboard("{Meta>}`{/Meta}");
			expect(screen.getByTestId("project-terminal-screen")).toBeInTheDocument();
		});

		it("Cmd+` from project terminal goes back to project", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			await renderApp();
			await userEvent.keyboard("{Meta>}1{/Meta}");
			await userEvent.keyboard("{Meta>}`{/Meta}");
			expect(screen.getByTestId("project-terminal-screen")).toBeInTheDocument();
			// Toggle back
			await userEvent.keyboard("{Meta>}`{/Meta}");
			expect(screen.getByTestId("project-screen")).toBeInTheDocument();
		});

		it("Cmd+` on dashboard does nothing", async () => {
			await renderApp();
			await userEvent.keyboard("{Meta>}`{/Meta}");
			expect(screen.getByTestId("dashboard-screen")).toBeInTheDocument();
		});
	});

	describe("zoom (Cmd/Ctrl + = - 0)", () => {
		it("Cmd+= calls adjustZoom with +ZOOM_STEP", async () => {
			await renderApp();
			await userEvent.keyboard("{Meta>}={/Meta}");
			expect(mockedAdjustZoom).toHaveBeenCalledWith(ZOOM_STEP);
		});

		it("Ctrl+= calls adjustZoom with +ZOOM_STEP", async () => {
			await renderApp();
			await userEvent.keyboard("{Control>}={/Control}");
			expect(mockedAdjustZoom).toHaveBeenCalledWith(ZOOM_STEP);
		});

		it("Cmd+- calls adjustZoom with -ZOOM_STEP", async () => {
			await renderApp();
			await userEvent.keyboard("{Meta>}-{/Meta}");
			expect(mockedAdjustZoom).toHaveBeenCalledWith(-ZOOM_STEP);
		});

		it("Ctrl+- calls adjustZoom with -ZOOM_STEP", async () => {
			await renderApp();
			await userEvent.keyboard("{Control>}-{/Control}");
			expect(mockedAdjustZoom).toHaveBeenCalledWith(-ZOOM_STEP);
		});

		it("Cmd+0 calls applyZoom with DEFAULT_ZOOM", async () => {
			await renderApp();
			await userEvent.keyboard("{Meta>}0{/Meta}");
			expect(mockedApplyZoom).toHaveBeenCalledWith(DEFAULT_ZOOM);
		});

		it("Ctrl+0 calls applyZoom with DEFAULT_ZOOM", async () => {
			await renderApp();
			await userEvent.keyboard("{Control>}0{/Control}");
			expect(mockedApplyZoom).toHaveBeenCalledWith(DEFAULT_ZOOM);
		});
	});

	describe("QR modal consumed state", () => {
		it("shows 'Connected' overlay and disables Copy when qrTokenConsumed fires", async () => {
			await renderApp();

			// Open QR modal via push event
			const qrData = {
				qrDataUrl: "data:image/png;base64,test",
				accessUrl: "http://192.168.0.1:1234/?token=test",
				tunnelState: "idle",
				cloudflaredInstalled: false,
			};
			window.dispatchEvent(new CustomEvent("rpc:showRemoteAccessQR", { detail: qrData }));

			// QR modal should be open with active Copy button
			await waitFor(() => {
				expect(screen.getByText("Copy URL")).toBeInTheDocument();
			});
			expect(screen.getByText("Copy URL")).not.toBeDisabled();

			// Simulate a client connecting
			window.dispatchEvent(new CustomEvent("rpc:qrTokenConsumed"));

			// Copy URL should be disabled, "Connected" label should appear
			await waitFor(() => {
				expect(screen.getByText("Copy URL")).toBeDisabled();
			});
			expect(screen.getByText("Connected")).toBeInTheDocument();
		});

		it("resets consumed state when modal is reopened", async () => {
			await renderApp();

			const qrData = {
				qrDataUrl: "data:image/png;base64,test",
				accessUrl: "http://192.168.0.1:1234/?token=test",
				tunnelState: "idle",
				cloudflaredInstalled: false,
			};

			// Open → consume → should be disabled
			window.dispatchEvent(new CustomEvent("rpc:showRemoteAccessQR", { detail: qrData }));
			await waitFor(() => { expect(screen.getByText("Copy URL")).toBeInTheDocument(); });
			window.dispatchEvent(new CustomEvent("rpc:qrTokenConsumed"));
			await waitFor(() => { expect(screen.getByText("Copy URL")).toBeDisabled(); });

			// Close modal
			await userEvent.click(screen.getByText("Close"));
			await waitFor(() => { expect(screen.queryByText("Copy URL")).not.toBeInTheDocument(); });

			// Reopen — should be fresh (not consumed)
			window.dispatchEvent(new CustomEvent("rpc:showRemoteAccessQR", { detail: qrData }));
			await waitFor(() => {
				expect(screen.getByText("Copy URL")).toBeInTheDocument();
				expect(screen.getByText("Copy URL")).not.toBeDisabled();
			});
			expect(screen.queryByText("Connected")).not.toBeInTheDocument();
		});

		it("shows auth failed screen when rpc:authFailed fires", async () => {
			await renderApp();
			window.dispatchEvent(new CustomEvent("rpc:authFailed", { detail: { status: 401 } }));
			await waitFor(() => {
				expect(screen.getByText("Session Expired")).toBeInTheDocument();
			});
		});
	});

	describe("branch-merged completion popup", () => {
		const fireBranchMerged = (taskId: string, projectId: string, fingerprint: string) =>
			act(async () => {
				window.dispatchEvent(
					new CustomEvent("rpc:branchMerged", {
						detail: {
							taskId,
							projectId,
							taskTitle: "Some task",
							branchName: "feat/whatever",
							fingerprint,
						},
					}),
				);
			});

		it("navigates from full task screen back to project view when user confirms completion", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			vi.mocked(api.request.getUpdateRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "task", projectId: "p1", taskId: "t1" }),
			});
			vi.mocked(confirm).mockResolvedValue(true);
			vi.mocked(api.request.moveTask).mockResolvedValue({} as never);

			await renderApp();
			expect(screen.getByTestId("task-screen")).toBeInTheDocument();

			await fireBranchMerged("t1", "p1", "fp-confirm-1");

			await waitFor(() => {
				expect(screen.getByTestId("project-screen")).toBeInTheDocument();
			});
			expect(screen.queryByTestId("task-screen")).not.toBeInTheDocument();
			expect(api.request.moveTask).toHaveBeenCalledWith(
				expect.objectContaining({ taskId: "t1", projectId: "p1", newStatus: "completed" }),
			);
		});

		it("stays on task screen when user declines the popup", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			vi.mocked(api.request.getUpdateRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "task", projectId: "p1", taskId: "t1" }),
			});
			vi.mocked(confirm).mockResolvedValue(false);

			await renderApp();
			expect(screen.getByTestId("task-screen")).toBeInTheDocument();

			await fireBranchMerged("t1", "p1", "fp-decline-1");

			// Give event handlers a tick to resolve
			await waitFor(() => {
				expect(api.request.dismissMergeCompletionPrompt).toHaveBeenCalled();
			});
			expect(screen.getByTestId("task-screen")).toBeInTheDocument();
			expect(screen.queryByTestId("project-screen")).not.toBeInTheDocument();
			expect(api.request.moveTask).not.toHaveBeenCalled();
		});

		it("does not navigate when user is on a different task's screen", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			vi.mocked(api.request.getUpdateRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "task", projectId: "p1", taskId: "t2" }),
			});
			vi.mocked(confirm).mockResolvedValue(true);
			vi.mocked(api.request.moveTask).mockResolvedValue({} as never);

			await renderApp();
			expect(screen.getByTestId("task-screen")).toBeInTheDocument();

			// Event is for t1, but user is viewing t2
			await fireBranchMerged("t1", "p1", "fp-other-task-1");

			await waitFor(() => {
				expect(api.request.moveTask).toHaveBeenCalled();
			});
			// Still on task screen (for t2)
			expect(screen.getByTestId("task-screen")).toBeInTheDocument();
			expect(screen.queryByTestId("project-screen")).not.toBeInTheDocument();
		});
	});
});
