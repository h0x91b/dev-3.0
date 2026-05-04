import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { I18nProvider } from "../i18n";
import type { Route } from "../state";
import { TASKS_QUICK_SWITCH_SHORTCUT_LS_KEY } from "../components/global-settings/utils";

vi.mock("../rpc", () => ({
	api: {
		request: {
			checkSystemRequirements: vi.fn().mockResolvedValue([]),
			checkGhAvailable: vi.fn().mockResolvedValue({ available: true, notInstalled: false }),
			getProjects: vi.fn().mockResolvedValue([]),
			getUpdateRoute: vi.fn().mockResolvedValue({ route: null }),
			getGlobalSettings: vi.fn().mockResolvedValue({
				defaultAgentId: "builtin-claude",
				defaultConfigId: "claude-default",
				taskDropPosition: "top",
				updateChannel: "stable",
				tasksQuickSwitchShortcut: {
					modifiers: ["alt"],
					key: "Tab",
				},
				tasksQuickSwitchFilters: [
					"in-progress",
					"review-by-ai",
					"review-by-user",
					"review-by-colleague",
				],
			}),
			getAllProjectTasks: vi.fn().mockResolvedValue([]),
			getTasksQuickSwitchTasks: vi.fn().mockResolvedValue([]),
			quitApp: vi.fn().mockResolvedValue(undefined),
			hideApp: vi.fn().mockResolvedValue(undefined),
			listTmuxSessions: vi.fn().mockResolvedValue([]),
			getProjectCurrentBranch: vi.fn().mockResolvedValue({ branch: "main", isBaseBranch: true, isDirty: false }),
			pullProjectMain: vi.fn(),
			getAgents: vi.fn().mockResolvedValue([]),
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
	default: (props: { projectId: string; activeTaskId?: string }) => (
		<div data-testid="project-screen">
			{props.projectId}:{props.activeTaskId ?? "none"}
		</div>
	),
}));
vi.mock("../components/TaskWorkspaceView", () => ({
	default: (props: { projectId: string; taskId: string }) => (
		<div data-testid="task-screen">
			{props.projectId}:{props.taskId}
		</div>
	),
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
	await waitFor(() => {
		const renderedScreen =
			screen.queryByTestId("dashboard-screen") ||
			screen.queryByTestId("project-screen") ||
			screen.queryByTestId("project-terminal-screen") ||
			screen.queryByTestId("task-screen") ||
			screen.queryByTestId("settings-screen") ||
			screen.queryByTestId("project-settings-screen");
		expect(renderedScreen).toBeInTheDocument();
	});
}

describe("App keyboard shortcuts", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(api.request.checkSystemRequirements).mockResolvedValue([]);
		vi.mocked(api.request.getProjects).mockResolvedValue([]);
		vi.mocked(api.request.getUpdateRoute).mockResolvedValue({ route: null } as any);
		vi.mocked(api.request.getGlobalSettings).mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskDropPosition: "top",
			updateChannel: "stable",
			tasksQuickSwitchShortcut: {
				modifiers: ["alt"],
				key: "Tab",
			},
			tasksQuickSwitchFilters: [
				"in-progress",
				"review-by-ai",
				"review-by-user",
				"review-by-colleague",
			],
		} as any);
		vi.mocked(api.request.getTasksQuickSwitchTasks).mockResolvedValue([]);
		vi.mocked(api.request.listTmuxSessions).mockResolvedValue([]);
	});

	describe("quit (Cmd+Q / Ctrl+Q)", () => {
		it("Cmd+Q opens the quit dialog", async () => {
			await renderApp();
			await userEvent.keyboard("{Meta>}q{/Meta}");
			expect(screen.getByText("Sessions keep running")).toBeInTheDocument();
		});

		it("Ctrl+Q opens the quit dialog", async () => {
			await renderApp();
			await userEvent.keyboard("{Control>}q{/Control}");
			expect(screen.getByText("Sessions keep running")).toBeInTheDocument();
		});

		it("Escape closes the quit dialog", async () => {
			await renderApp();
			await userEvent.keyboard("{Meta>}q{/Meta}");
			expect(screen.getByText("Sessions keep running")).toBeInTheDocument();
			await userEvent.keyboard("{Escape}");
			expect(screen.queryByText("Sessions keep running")).not.toBeInTheDocument();
		});

		it("Quit button in dialog calls quitApp", async () => {
			vi.mocked(api.request.quitApp).mockResolvedValue(undefined);
			await renderApp();
			await userEvent.keyboard("{Meta>}q{/Meta}");
			await userEvent.click(screen.getByRole("button", { name: "Quit" }));
			expect(api.request.quitApp).toHaveBeenCalled();
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

	describe("tasks quick switch (Option/Alt+Tab)", () => {
		const projects = [
			{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			{
				id: "p2",
				name: "Beta",
				path: "/b",
				setupScript: "",
				devScript: "",
				cleanupScript: "",
				defaultBaseBranch: "main",
				createdAt: "",
				customColumns: [
					{
						id: "col-waiting",
						name: "Waiting on API",
						color: "#22c55e",
						llmInstruction: "",
					},
				],
			},
		];

		const quickSwitchTasks = [
			{
				projectId: "p1",
				tasks: [
					{
						id: "t1",
						seq: 1,
						projectId: "p1",
						title: "Current Task",
						description: "Current Task",
						status: "in-progress",
						baseBranch: "main",
						worktreePath: "/a/.wt",
						branchName: "feat/current",
						groupId: null,
						variantIndex: null,
						agentId: null,
						configId: null,
						createdAt: "2026-04-15T10:00:00.000Z",
						updatedAt: "2026-04-15T10:00:00.000Z",
					},
				],
			},
			{
				projectId: "p2",
				tasks: [
					{
						id: "t2",
						seq: 2,
						projectId: "p2",
						title: "Next Task",
						description: "Next Task",
						status: "review-by-user",
						baseBranch: "main",
						worktreePath: "/b/.wt1",
						branchName: "feat/next",
						groupId: null,
						variantIndex: null,
						agentId: null,
						configId: null,
						createdAt: "2026-04-15T10:00:00.000Z",
						updatedAt: "2026-04-15T10:20:00.000Z",
					},
					{
						id: "t3",
						seq: 3,
						projectId: "p2",
						title: "Third Task",
						description: "Third Task",
						status: "review-by-ai",
						baseBranch: "main",
						worktreePath: "/b/.wt2",
						branchName: "feat/third",
						groupId: null,
						variantIndex: null,
						agentId: null,
						configId: null,
						createdAt: "2026-04-15T10:00:00.000Z",
						updatedAt: "2026-04-15T10:10:00.000Z",
					},
					{
						id: "t4",
						seq: 4,
						projectId: "p2",
						title: "Waiting Task",
						description: "Waiting Task",
						status: "in-progress",
						customColumnId: "col-waiting",
						baseBranch: "main",
						worktreePath: "/b/.wt3",
						branchName: "feat/waiting",
						groupId: null,
						variantIndex: null,
						agentId: null,
						configId: null,
						createdAt: "2026-04-15T10:00:00.000Z",
						updatedAt: "2026-04-15T10:25:00.000Z",
					},
				],
			},
		];

		async function renderAppOnTask(
			route: Route,
			settingsOverride: Record<string, unknown> = {},
		) {
			localStorage.setItem(
				TASKS_QUICK_SWITCH_SHORTCUT_LS_KEY,
				JSON.stringify(
					settingsOverride.tasksQuickSwitchShortcut ?? {
						modifiers: ["alt"],
						key: "Tab",
					},
				),
			);
			vi.mocked(api.request.getProjects).mockResolvedValue(projects as any);
			vi.mocked(api.request.getUpdateRoute).mockResolvedValue({
				route: JSON.stringify(route),
			} as any);
			vi.mocked(api.request.getGlobalSettings).mockResolvedValue({
				defaultAgentId: "builtin-claude",
				defaultConfigId: "claude-default",
				taskDropPosition: "top",
				updateChannel: "stable",
				tasksQuickSwitchShortcut: {
					modifiers: ["alt"],
					key: "Tab",
				},
				tasksQuickSwitchFilters: [
					"in-progress",
					"review-by-ai",
					"review-by-user",
					"review-by-colleague",
				],
				...settingsOverride,
			} as any);
			vi.mocked(api.request.getTasksQuickSwitchTasks).mockResolvedValue(
				quickSwitchTasks as any,
			);
			await renderApp();
			await waitFor(() =>
				expect(screen.getByTestId("project-screen")).toHaveTextContent(
					"p1:t1",
				),
			);
		}

		it("hydrates quick switch settings on mount but delays task loading until the shortcut is used", async () => {
			await renderAppOnTask({
				screen: "project",
				projectId: "p1",
				activeTaskId: "t1",
			});

			expect(api.request.getGlobalSettings).toHaveBeenCalledOnce();
			expect(api.request.getTasksQuickSwitchTasks).not.toHaveBeenCalled();

			await act(async () => {
				window.dispatchEvent(
					new KeyboardEvent("keydown", {
						key: "Tab",
						altKey: true,
						bubbles: true,
					}),
				);
			});

			await waitFor(() => {
				expect(api.request.getGlobalSettings).toHaveBeenCalledOnce();
				expect(api.request.getTasksQuickSwitchTasks).toHaveBeenCalledOnce();
			});
			expect(screen.getByText("Tasks Quick Switch")).toBeInTheDocument();
		});

		it("reverses direction when Shift is added to the shortcut chord", async () => {
			await renderAppOnTask({
				screen: "project",
				projectId: "p1",
				activeTaskId: "t1",
			});

			// Default-filter items sorted by updatedAt desc: [t2, t3, t1]; origin=t1 (index 2).
			// Forward (Alt+Tab) would wrap to t2 (index 0); backward (Shift+Alt+Tab) → t3 (index 1).
			await act(async () => {
				window.dispatchEvent(
					new KeyboardEvent("keydown", {
						key: "Tab",
						altKey: true,
						shiftKey: true,
						bubbles: true,
					}),
				);
			});

			expect(screen.getByText("Tasks Quick Switch")).toBeInTheDocument();

			await act(async () => {
				window.dispatchEvent(
					new KeyboardEvent("keyup", {
						key: "Alt",
						bubbles: true,
					}),
				);
			});

			await waitFor(() =>
				expect(screen.getByTestId("project-screen")).toHaveTextContent(
					"p2:t3",
				),
			);
		});

		it("opens the modal and switches to the next recent active task on Alt release", async () => {
			await renderAppOnTask({
				screen: "project",
				projectId: "p1",
				activeTaskId: "t1",
			});

			await act(async () => {
				window.dispatchEvent(
					new KeyboardEvent("keydown", {
						key: "Tab",
						altKey: true,
						bubbles: true,
					}),
				);
			});

			expect(screen.getByText("Tasks Quick Switch")).toBeInTheDocument();
			expect(screen.getByText("Next Task")).toBeInTheDocument();

			await act(async () => {
				window.dispatchEvent(
					new KeyboardEvent("keyup", { key: "Alt", bubbles: true }),
				);
			});

			await waitFor(() =>
				expect(screen.getByTestId("project-screen")).toHaveTextContent(
					"p2:t2",
				),
			);
		});

		it("moves selection with arrow keys before switching", async () => {
			await renderAppOnTask({
				screen: "project",
				projectId: "p1",
				activeTaskId: "t1",
			});

			await act(async () => {
				window.dispatchEvent(
					new KeyboardEvent("keydown", {
						key: "Tab",
						altKey: true,
						bubbles: true,
					}),
				);
			});

			await act(async () => {
				window.dispatchEvent(
					new KeyboardEvent("keydown", {
						key: "ArrowDown",
						bubbles: true,
					}),
				);
			});

			await act(async () => {
				window.dispatchEvent(
					new KeyboardEvent("keyup", { key: "Alt", bubbles: true }),
				);
			});

			await waitFor(() =>
				expect(screen.getByTestId("project-screen")).toHaveTextContent(
					"p2:t3",
				),
			);
		});

		it("prefers quick switch over app-level shortcuts when a custom binding overlaps", async () => {
			await renderAppOnTask(
				{
					screen: "project",
					projectId: "p1",
					activeTaskId: "t1",
				},
				{
					tasksQuickSwitchShortcut: {
						modifiers: ["ctrl"],
						key: ",",
					},
				},
			);

			await act(async () => {
				window.dispatchEvent(
					new KeyboardEvent("keydown", {
						key: ",",
						ctrlKey: true,
						bubbles: true,
					}),
				);
			});

			expect(screen.getByText("Tasks Quick Switch")).toBeInTheDocument();
			expect(screen.getByTestId("project-screen")).toHaveTextContent("p1:t1");
			expect(screen.queryByTestId("settings-screen")).not.toBeInTheDocument();
		});

		it("filters tasks in custom columns by the selected custom column type", async () => {
			await renderAppOnTask(
				{
					screen: "project",
					projectId: "p1",
					activeTaskId: "t1",
				},
				{
					tasksQuickSwitchFilters: ["custom:col-waiting"],
				},
			);

			await act(async () => {
				window.dispatchEvent(
					new KeyboardEvent("keydown", {
						key: "Tab",
						altKey: true,
						bubbles: true,
					}),
				);
			});

			expect(screen.getByText("Waiting Task")).toBeInTheDocument();
			expect(screen.queryByText("Next Task")).not.toBeInTheDocument();
			expect(screen.getByText("Waiting on API")).toBeInTheDocument();

			await act(async () => {
				window.dispatchEvent(
					new KeyboardEvent("keyup", { key: "Alt", bubbles: true }),
				);
			});

			await waitFor(() =>
				expect(screen.getByTestId("project-screen")).toHaveTextContent(
					"p2:t4",
				),
			);
		});

		it("matches recorded letter shortcuts by physical key code for Option characters", async () => {
			await renderAppOnTask(
				{
					screen: "project",
					projectId: "p1",
					activeTaskId: "t1",
				},
				{
					tasksQuickSwitchShortcut: {
						modifiers: ["alt", "shift"],
						key: "P",
					},
				},
			);

			await act(async () => {
				window.dispatchEvent(
					new KeyboardEvent("keydown", {
						key: "Π",
						code: "KeyP",
						altKey: true,
						shiftKey: true,
						bubbles: true,
					}),
				);
			});

			expect(screen.getByText("Tasks Quick Switch")).toBeInTheDocument();
			expect(screen.getByText("Next Task")).toBeInTheDocument();

			await act(async () => {
				window.dispatchEvent(
					new KeyboardEvent("keyup", {
						key: "Alt",
						shiftKey: true,
						bubbles: true,
					}),
				);
			});

			await waitFor(() =>
				expect(screen.getByTestId("project-screen")).toHaveTextContent(
					"p2:t2",
				),
			);
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
});
