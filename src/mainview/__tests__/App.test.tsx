import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { I18nProvider } from "../i18n";

vi.mock("../rpc", () => ({
	// These App tests assert the desktop layout; keep the browser menu bar unmounted.
	isElectrobun: true,
	getRpcConnectionState: vi.fn(() => "connected"),
	reconnectRpc: vi.fn(),
	api: {
		request: {
			checkSystemRequirements: vi.fn().mockResolvedValue([]),
			getRosettaWarning: vi.fn().mockResolvedValue(null),
			checkGhAvailable: vi.fn().mockResolvedValue({ available: true, notInstalled: false }),
			getProjects: vi.fn().mockResolvedValue([]),
			getLastRoute: vi.fn().mockResolvedValue({ route: null }),
			saveLastRoute: vi.fn().mockResolvedValue(undefined),
			quitApp: vi.fn().mockResolvedValue(undefined),
			requestQuit: vi.fn().mockResolvedValue(undefined),
			consumePendingQuitDialog: vi.fn().mockResolvedValue(false),
			consumePendingNotificationNav: vi.fn().mockResolvedValue(null),
			openNewWindow: vi.fn().mockResolvedValue(undefined),
			hideApp: vi.fn().mockResolvedValue(undefined),
			listTmuxSessions: vi.fn().mockResolvedValue([]),
			getProjectCurrentBranch: vi.fn().mockResolvedValue({ branch: "main", isBaseBranch: true, isDirty: false }),
			pullProjectMain: vi.fn(),
			getPreventSleepState: vi.fn().mockResolvedValue({ enabled: false, available: false, forcedByRemote: false }),
			setPreventSleep: vi.fn(),
			getAgentRateLimits: vi.fn().mockResolvedValue({ generatedAt: 0, snapshots: [] }),
			listAgentAccounts: vi.fn().mockResolvedValue({
				claude: { accounts: [], activeId: null, systemIdentity: null },
				codex: { accounts: [], activeId: null, currentIdentity: null },
			}),
			getAgents: vi.fn().mockResolvedValue([]),
			getGlobalSettings: vi.fn().mockResolvedValue({
				defaultAgentId: "builtin-claude",
				defaultConfigId: "claude-default",
				taskDropPosition: "top",
				updateChannel: "stable",
			}),
			moveTask: vi.fn().mockResolvedValue({}),
			openQuickShell: vi.fn().mockResolvedValue({ id: "op-task-1", projectId: "ops-proj" }),
			dismissMergeCompletionPrompt: vi.fn().mockResolvedValue(undefined),
			setTaskManualCompletion: vi.fn().mockResolvedValue(undefined),
			listAgentSkills: vi.fn().mockResolvedValue([]),
			respondToAgentCompletionRequest: vi.fn().mockResolvedValue(undefined),
			getRemoteAccessQR: vi.fn().mockResolvedValue({
				qrDataUrl: "data:image/png;base64,test",
				accessUrl: "http://127.0.0.1:1234/?token=test",
				tunnelState: "idle",
				cloudflaredInstalled: false,
				interfaces: [],
				selectedHost: "127.0.0.1",
			}),
			stopTunnel: vi.fn().mockResolvedValue(undefined),
		},
	},
}));

vi.mock("../analytics", () => ({
	trackPageView: vi.fn(),
	trackEvent: vi.fn(),
	registerAgents: vi.fn(),
	agentNameFromId: vi.fn(() => "unknown"),
}));

vi.mock("../zoom", () => ({
	adjustZoom: vi.fn(),
	applyZoom: vi.fn(),
	ZOOM_STEP: 0.1,
	DEFAULT_ZOOM: 1.0,
	getZoom: vi.fn().mockReturnValue(1.0),
	bootstrapZoom: vi.fn(),
	retainDenseZoom: vi.fn(() => vi.fn()),
	ZOOM_CHANGED_EVENT: "zoom-changed",
	MIN_ZOOM: 0.5,
	MAX_ZOOM: 2.0,
}));

vi.mock("../task-sounds", () => ({
	initTaskSoundPlayback: vi.fn(),
	playTaskSound: vi.fn().mockResolvedValue(undefined),
	playTaskSoundFromPush: vi.fn(),
	playTaskCompletionSound: vi.fn(),
	setTaskCompletionSoundEnabled: vi.fn(),
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
	default: (props: {
		projectId: string;
		activeTaskId?: string;
		taskView?: boolean;
		bellCounts?: Map<string, number>;
	}) => (
		<div
			data-testid="project-screen"
			data-project-id={props.projectId}
			data-active-task-id={props.activeTaskId ?? ""}
			data-task-view={props.taskView ? "true" : "false"}
			data-bell-count={String(props.bellCounts?.get("t-overflow") ?? 0)}
		/>
	),
}));
vi.mock("../components/TaskWorkspaceView", () => ({
	default: (props: { immersive?: boolean }) => <div data-testid="task-screen" data-immersive={props.immersive ? "true" : "false"} />,
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
vi.mock("../components/TaskImageViewer", () => ({
	default: () => <div data-testid="image-viewer" />,
}));

import { api } from "../rpc";
import { confirm } from "../confirm";

vi.mock("../confirm", () => ({
	confirm: vi.fn().mockResolvedValue(false),
	ConfirmHost: () => null,
}));
import { initTaskSoundPlayback, playTaskSoundFromPush } from "../task-sounds";
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
		// These assert the DESKTOP keymap (⌘Q, ⌘N, zoom, ⌘1–9). happy-dom looks like
		// a browser to `isRemote()`, where those combos are dropped/aliased, so fake
		// the Electrobun webview flag. Safe here because rpc is mocked (above).
		(window as Window & { __electrobunWebviewId?: number }).__electrobunWebviewId = 1;
		vi.clearAllMocks();
		vi.mocked(api.request.checkSystemRequirements).mockResolvedValue([]);
		vi.mocked(api.request.getProjects).mockResolvedValue([]);
		vi.mocked(api.request.getLastRoute).mockResolvedValue({ route: null });
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

	describe("history navigation aliases", () => {
		it("uses Ctrl+- for back and Ctrl+Shift+- for forward", async () => {
			await renderApp();
			await userEvent.keyboard("{Control>},{/Control}");
			expect(screen.getByTestId("settings-screen")).toBeInTheDocument();

			await userEvent.keyboard("{Control>}-{/Control}");
			expect(screen.getByTestId("dashboard-screen")).toBeInTheDocument();
			expect(mockedAdjustZoom).not.toHaveBeenCalled();

			await userEvent.keyboard("{Control>}{Shift>}-{/Shift}{/Control}");
			expect(screen.getByTestId("settings-screen")).toBeInTheDocument();
		});

		it("keeps the existing command-bracket aliases", async () => {
			await renderApp();
			await userEvent.keyboard("{Meta>},{/Meta}");
			expect(screen.getByTestId("settings-screen")).toBeInTheDocument();

			const back = new KeyboardEvent("keydown", {
				code: "BracketLeft",
				key: "[",
				metaKey: true,
				bubbles: true,
				cancelable: true,
			});
			act(() => window.dispatchEvent(back));
			expect(back.defaultPrevented).toBe(true);
			expect(screen.getByTestId("dashboard-screen")).toBeInTheDocument();

			const forward = new KeyboardEvent("keydown", {
				code: "BracketRight",
				key: "]",
				metaKey: true,
				bubbles: true,
				cancelable: true,
			});
			act(() => window.dispatchEvent(forward));
			expect(forward.defaultPrevented).toBe(true);
			expect(screen.getByTestId("settings-screen")).toBeInTheDocument();
		});
	});

	describe("live variant cycling", () => {
		const project = {
			id: "p1",
			name: "Alpha",
			path: "/a",
			setupScript: "",
			devScript: "",
			cleanupScript: "",
			defaultBaseBranch: "main",
			createdAt: "",
		};

		function task(id: string, variantIndex: number, status: "in-progress" | "completed" = "in-progress") {
			return {
				id,
				seq: variantIndex,
				projectId: "p1",
				title: `Variant ${variantIndex}`,
				description: "",
				status,
				baseBranch: "main",
				worktreePath: `/tmp/${id}`,
				branchName: `dev3/${id}`,
				groupId: "group-1",
				variantIndex,
				agentId: null,
				configId: null,
				createdAt: "",
				updatedAt: "",
			};
		}

		it("cycles live variants from the active task and wraps around", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([project]);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "project", projectId: "p1", activeTaskId: "v1" }),
			});

			await renderApp();
			act(() => {
				window.dispatchEvent(new CustomEvent("rpc:taskUpdated", { detail: { task: task("v1", 1) } }));
				window.dispatchEvent(new CustomEvent("rpc:taskUpdated", { detail: { task: task("v2", 2) } }));
				window.dispatchEvent(new CustomEvent("rpc:taskUpdated", { detail: { task: task("v3", 3, "completed") } }));
			});

			const next = new KeyboardEvent("keydown", {
				code: "BracketRight",
				key: "}",
				metaKey: true,
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			});
			act(() => window.dispatchEvent(next));
			expect(next.defaultPrevented).toBe(true);
			expect(screen.getByTestId("project-screen")).toHaveAttribute("data-active-task-id", "v2");

			const wrapped = new KeyboardEvent("keydown", {
				code: "BracketRight",
				key: "}",
				metaKey: true,
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			});
			act(() => window.dispatchEvent(wrapped));
			expect(screen.getByTestId("project-screen")).toHaveAttribute("data-active-task-id", "v1");
		});
	});

	describe("terminal immersive fullscreen", () => {
		const projects = [
			{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			{ id: "p2", name: "Beta", path: "/b", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
		];

		afterEach(() => {
			localStorage.removeItem("dev3-task-open-mode");
		});

		it("F11 toggles immersive mode for a split task and restores the exact route", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue(projects);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "project", projectId: "p1", activeTaskId: "t1" }),
			});

			await renderApp();
			expect(screen.queryByTestId("terminal-immersive-chrome")).not.toBeInTheDocument();

			await userEvent.keyboard("{F11}");
			expect(screen.getByTestId("terminal-immersive-chrome")).toBeInTheDocument();
			expect(screen.getByTestId("task-screen")).toHaveAttribute("data-immersive", "true");
			act(() => {
				window.dispatchEvent(new KeyboardEvent("keydown", { key: "F11", repeat: true, bubbles: true }));
			});
			expect(screen.getByTestId("terminal-immersive-chrome")).toBeInTheDocument();

			await userEvent.click(screen.getByRole("button", { name: "Exit full screen" }));
			expect(screen.queryByTestId("terminal-immersive-chrome")).not.toBeInTheDocument();
			expect(screen.getByTestId("project-screen")).toHaveAttribute("data-active-task-id", "t1");
		});

		it("Cmd/Ctrl+Shift+F toggles immersive mode on a task terminal", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "task", projectId: "p1", taskId: "t1" }),
			});

			await renderApp();
			await waitFor(() => expect(screen.getByTestId("task-screen")).toBeInTheDocument());
			await userEvent.keyboard("{Meta>}{Shift>}f{/Shift}{/Meta}");
			expect(screen.getByTestId("terminal-immersive-chrome")).toBeInTheDocument();
			expect(screen.getByTestId("task-screen")).toHaveAttribute("data-immersive", "true");

			await userEvent.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
			expect(screen.queryByTestId("terminal-immersive-chrome")).not.toBeInTheDocument();
		});

		it("is a no-op on Kanban routes", async () => {
			await renderApp();
			await userEvent.keyboard("{F11}");
			expect(screen.queryByTestId("terminal-immersive-chrome")).not.toBeInTheDocument();
		});

		it("is a no-op on Settings routes", async () => {
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "settings" }),
			});
			await renderApp();
			await userEvent.keyboard("{F11}");
			await userEvent.keyboard("{Meta>}{Shift>}f{/Shift}{/Meta}");
			expect(screen.getByTestId("settings-screen")).toBeInTheDocument();
			expect(screen.queryByTestId("terminal-immersive-chrome")).not.toBeInTheDocument();
		});

		it("exits before native notification navigation and preserves split open mode", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue(projects);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "project", projectId: "p1", activeTaskId: "t1" }),
			});

			await renderApp();
			await userEvent.keyboard("{F11}");
			expect(screen.getByTestId("terminal-immersive-chrome")).toBeInTheDocument();

			act(() => {
				window.dispatchEvent(new CustomEvent("rpc:openTaskFromNotification", {
					detail: { taskId: "t2", projectId: "p2" },
				}));
			});

			await waitFor(() => {
				expect(screen.getByTestId("project-screen")).toHaveAttribute("data-project-id", "p2");
				expect(screen.getByTestId("project-screen")).toHaveAttribute("data-active-task-id", "t2");
			});
			expect(screen.queryByTestId("terminal-immersive-chrome")).not.toBeInTheDocument();
		});

		it("exits but does not navigate when a notification target is malformed", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "project", projectId: "p1", activeTaskId: "t1" }),
			});

			await renderApp();
			await userEvent.keyboard("{F11}");
			act(() => {
				window.dispatchEvent(new CustomEvent("rpc:openTaskFromNotification", {
					detail: { taskId: "", projectId: "" },
				}));
			});

			expect(screen.queryByTestId("terminal-immersive-chrome")).not.toBeInTheDocument();
			expect(screen.getByTestId("project-screen")).toHaveAttribute("data-active-task-id", "t1");
		});

		it("exits before a clickable in-app task toast navigates", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue(projects);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "project", projectId: "p1", activeTaskId: "t1" }),
			});

			await renderApp();
			await userEvent.keyboard("{F11}");
			act(() => {
				window.dispatchEvent(new CustomEvent("rpc:cliToast", {
					detail: { taskId: "t2", projectId: "p2", message: "Task update", level: "info" },
				}));
			});

			expect(screen.queryByText("Task update")).not.toBeInTheDocument();
			await userEvent.keyboard("{F11}");
			await userEvent.click(await screen.findByRole("button", { name: "Task update" }));
			await waitFor(() => {
				expect(screen.getByTestId("project-screen")).toHaveAttribute("data-project-id", "p2");
				expect(screen.getByTestId("project-screen")).toHaveAttribute("data-active-task-id", "t2");
			});
			expect(screen.queryByTestId("terminal-immersive-chrome")).not.toBeInTheDocument();
		});

		it("exits before pending notification navigation and preserves fullscreen open mode", async () => {
			localStorage.setItem("dev3-task-open-mode", "fullscreen");
			vi.mocked(api.request.getProjects).mockResolvedValue(projects);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "project", projectId: "p1", activeTaskId: "t1" }),
			});
			let resolvePending!: (target: { taskId: string; projectId: string }) => void;
			vi.mocked(api.request.consumePendingNotificationNav).mockImplementationOnce(
				() => new Promise((resolve) => { resolvePending = resolve; }),
			);

			await renderApp();
			await userEvent.keyboard("{F11}");
			expect(screen.getByTestId("terminal-immersive-chrome")).toBeInTheDocument();
			resolvePending({ taskId: "t2", projectId: "p2" });

			await waitFor(() => expect(screen.getByTestId("task-screen")).toHaveAttribute("data-immersive", "false"));
			expect(screen.queryByTestId("terminal-immersive-chrome")).not.toBeInTheDocument();
		});
	});

	describe("switch project (Cmd+1..9)", () => {
		const twoProjects = [
			{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			{ id: "p2", name: "Beta", path: "/b", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
		];

		// Task-view preservation is gated on the `dev3-task-open-mode` setting.
		// Remove it between tests so the default ("split") applies unless a test opts in.
		afterEach(() => {
			localStorage.removeItem("dev3-task-open-mode");
		});

		it("preserves task view: Cmd+2 from a task switches project and keeps task-view layout with no task selected", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue(twoProjects);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
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
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
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
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
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

		it("fullscreen open-mode: Cmd+2 from a task jumps to the board, not an empty split", async () => {
			localStorage.setItem("dev3-task-open-mode", "fullscreen");
			vi.mocked(api.request.getProjects).mockResolvedValue(twoProjects);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "project", projectId: "p1", activeTaskId: "t1" }),
			});

			await renderApp();
			expect(screen.getByTestId("project-screen")).toHaveAttribute("data-active-task-id", "t1");

			await userEvent.keyboard("{Meta>}2{/Meta}");

			const after = screen.getByTestId("project-screen");
			expect(after).toHaveAttribute("data-project-id", "p2");
			expect(after).toHaveAttribute("data-task-view", "false");
			expect(after).toHaveAttribute("data-active-task-id", "");
		});

		it("fullscreen open-mode: Cmd+2 from the full-page task screen jumps to the board", async () => {
			localStorage.setItem("dev3-task-open-mode", "fullscreen");
			vi.mocked(api.request.getProjects).mockResolvedValue(twoProjects);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "task", projectId: "p1", taskId: "t1" }),
			});

			await renderApp();
			expect(screen.getByTestId("task-screen")).toBeInTheDocument();

			await userEvent.keyboard("{Meta>}2{/Meta}");

			const after = screen.getByTestId("project-screen");
			expect(after).toHaveAttribute("data-project-id", "p2");
			expect(after).toHaveAttribute("data-task-view", "false");
		});
	});

	// Quick shell (⇧⌘`) spawns a scratch op in the built-in Operations board and
	// jumps to it. Regression: it used to hardcode the full-page task route, which
	// (a) ignored the user's open-mode preference and (b) dropped them onto a
	// chrome-less terminal (the target project's tasks were never loaded). It must
	// honor `dev3-task-open-mode` like every other task-open path.
	describe("quick shell (⇧⌘`) navigation", () => {
		afterEach(() => {
			localStorage.removeItem("dev3-task-open-mode");
		});

		function triggerQuickShell() {
			act(() => {
				window.dispatchEvent(new CustomEvent("menu:open-quick-shell"));
			});
		}

		it("split open-mode: opens the scratch op beside its board (activeTaskId), not a bare fullscreen terminal", async () => {
			vi.mocked(api.request.openQuickShell).mockResolvedValue({ id: "op-task-1", projectId: "ops-proj" } as never);
			await renderApp();

			triggerQuickShell();

			const view = await screen.findByTestId("project-screen");
			expect(view).toHaveAttribute("data-project-id", "ops-proj");
			expect(view).toHaveAttribute("data-active-task-id", "op-task-1");
		});

		it("fullscreen open-mode: opens the scratch op in the full-page task view", async () => {
			localStorage.setItem("dev3-task-open-mode", "fullscreen");
			vi.mocked(api.request.openQuickShell).mockResolvedValue({ id: "op-task-1", projectId: "ops-proj" } as never);
			await renderApp();

			triggerQuickShell();

			expect(await screen.findByTestId("task-screen")).toBeInTheDocument();
		});
	});

	// `dev3 show-image` while the user is elsewhere raises a clickable toast.
	// Regression: clicking it opened the lightbox but stayed on the current
	// screen, so the user never knew which task produced the image. The toast
	// must navigate to the owning task (honoring open-mode) before opening it.
	describe("CLI shared-image toast navigation", () => {
		const oneProject = [
			{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
		];
		const sharedImage = {
			id: "img1",
			storedPath: "/a/shared-images/img1.png",
			originalPath: "/tmp/img1.png",
			name: "img1.png",
			mime: "image/png",
			bytes: 123,
			createdAt: 0,
		};

		function dispatchShowImage() {
			act(() => {
				window.dispatchEvent(
					new CustomEvent("rpc:cliShowImage", {
						detail: {
							taskId: "t-img",
							projectId: "p1",
							images: [sharedImage],
							newCount: 1,
							taskSeq: 42,
							taskTitle: "Some task",
							projectName: "Alpha",
						},
					}),
				);
			});
		}

		afterEach(() => {
			localStorage.removeItem("dev3-task-open-mode");
		});

		it("split open-mode: clicking the toast navigates to the owning task and opens the viewer", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue(oneProject);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "project", projectId: "p1" }),
			});

			await renderApp();
			// On the board, no task focused.
			expect(screen.getByTestId("project-screen")).toHaveAttribute("data-active-task-id", "");

			dispatchShowImage();
			await userEvent.click(await screen.findByText("Agent shared an image"));

			const view = screen.getByTestId("project-screen");
			expect(view).toHaveAttribute("data-project-id", "p1");
			expect(view).toHaveAttribute("data-active-task-id", "t-img");
			expect(screen.getByTestId("image-viewer")).toBeInTheDocument();
		});

		it("fullscreen open-mode: clicking the toast opens the full-page task view", async () => {
			localStorage.setItem("dev3-task-open-mode", "fullscreen");
			vi.mocked(api.request.getProjects).mockResolvedValue(oneProject);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "project", projectId: "p1" }),
			});

			await renderApp();
			dispatchShowImage();
			await userEvent.click(await screen.findByText("Agent shared an image"));

			expect(await screen.findByTestId("task-screen")).toBeInTheDocument();
			expect(screen.getByTestId("image-viewer")).toBeInTheDocument();
		});
	});

	describe("toast overflow attention routing", () => {
		const oneProject = [
			{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
		];

		function dispatchToast(message: string) {
			act(() => {
				window.dispatchEvent(new CustomEvent("rpc:cliToast", {
					detail: { taskId: "t-overflow", projectId: "p1", message, level: "info" },
				}));
			});
		}

		it("routes task identity from renderer to forced attention on eviction", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue(oneProject);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "project", projectId: "p1" }),
			});

			await renderApp();
			for (let index = 1; index <= 6; index += 1) dispatchToast(`Overflow ${index}`);

			await waitFor(() => expect(screen.getByTestId("project-screen")).toHaveAttribute("data-bell-count", "1"));
			expect(screen.queryByText("Overflow 1")).not.toBeInTheDocument();
			expect(screen.getByText("Overflow 6")).toBeInTheDocument();
		});

		it("applies a custom duration to a CLI toast", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue(oneProject);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "project", projectId: "p1" }),
			});

			await renderApp();
			vi.useFakeTimers();
			try {
				act(() => {
					window.dispatchEvent(new CustomEvent("rpc:cliToast", {
						detail: { taskId: null, projectId: null, message: "Brief toast", level: "info", durationMs: 2_000 },
					}));
				});

				expect(screen.getByText("Brief toast")).toBeInTheDocument();
				act(() => vi.advanceTimersByTime(1_999));
				expect(screen.getByText("Brief toast")).toBeInTheDocument();
				act(() => vi.advanceTimersByTime(1));
				expect(screen.queryByText("Brief toast")).not.toBeInTheDocument();
			} finally {
				vi.useRealTimers();
			}
		});

		it("does not double-count image or artifact attention when their toasts overflow", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue(oneProject);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "project", projectId: "p1" }),
			});

			await renderApp();
			act(() => {
				window.dispatchEvent(new CustomEvent("rpc:cliShowImage", {
					detail: {
						taskId: "t-overflow",
						projectId: "p1",
						images: [{ id: "img-1", storedPath: "/tmp/image.png", originalPath: "/tmp/image.png", name: "image.png", mime: "image/png", bytes: 1, createdAt: 0 }],
						newCount: 1,
					},
				}));
				window.dispatchEvent(new CustomEvent("rpc:cliShowArtifact", {
					detail: {
						taskId: "t-overflow",
						projectId: "p1",
						artifacts: [{ id: "artifact-1", storedPath: "/tmp/artifact.html", name: "artifact.html", mime: "text/html", bytes: 1, createdAt: 0 }],
						newCount: 1,
					},
				}));
			});
			for (let index = 1; index <= 5; index += 1) dispatchToast(`Overflow ${index}`);

			await waitFor(() => expect(screen.getByTestId("project-screen")).toHaveAttribute("data-bell-count", "2"));
		});
	});

	describe("route restore on launch", () => {
		const oneProject = [
			{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
		];

		it("restores the saved project route on launch", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue(oneProject);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "project", projectId: "p1" }),
			});

			await renderApp();

			expect(screen.getByTestId("project-screen")).toHaveAttribute("data-project-id", "p1");
			expect(screen.queryByTestId("dashboard-screen")).not.toBeInTheDocument();
		});

		it("falls back to the dashboard when the saved project no longer exists", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([]); // p1 was completed/removed
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "task", projectId: "p1", taskId: "t1" }),
			});

			await renderApp();

			expect(screen.getByTestId("dashboard-screen")).toBeInTheDocument();
			expect(screen.queryByTestId("task-screen")).not.toBeInTheDocument();
		});

		it("restores a non-project screen (settings)", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue(oneProject);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "settings" }),
			});

			await renderApp();

			expect(screen.getByTestId("settings-screen")).toBeInTheDocument();
		});

		it("persists the current route to disk on navigation", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue(oneProject);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({ route: null });

			await renderApp();
			await userEvent.keyboard("{Meta>},{/Meta}");
			expect(screen.getByTestId("settings-screen")).toBeInTheDocument();

			await waitFor(() =>
				expect(api.request.saveLastRoute).toHaveBeenCalledWith({
					route: JSON.stringify({ screen: "settings" }),
				}),
			);
		});
	});

	describe("switch project to opposite view (Cmd+Shift+1..9)", () => {
		const twoProjects = [
			{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			{ id: "p2", name: "Beta", path: "/b", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
		];

		afterEach(() => {
			localStorage.removeItem("dev3-task-open-mode");
		});

		it("from the board: Cmd+Shift+2 switches project and opens task view", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue(twoProjects);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "project", projectId: "p1" }),
			});

			await renderApp();
			const before = screen.getByTestId("project-screen");
			expect(before).toHaveAttribute("data-project-id", "p1");
			expect(before).toHaveAttribute("data-task-view", "false");

			await userEvent.keyboard("{Meta>}{Shift>}2{/Shift}{/Meta}");

			const after = screen.getByTestId("project-screen");
			expect(after).toHaveAttribute("data-project-id", "p2");
			expect(after).toHaveAttribute("data-task-view", "true");
			expect(after).toHaveAttribute("data-active-task-id", "");
		});

		it("from a task: Cmd+Shift+2 switches project and drops to the board", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue(twoProjects);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "project", projectId: "p1", activeTaskId: "t1" }),
			});

			await renderApp();
			expect(screen.getByTestId("project-screen")).toHaveAttribute("data-active-task-id", "t1");

			await userEvent.keyboard("{Meta>}{Shift>}2{/Shift}{/Meta}");

			const after = screen.getByTestId("project-screen");
			expect(after).toHaveAttribute("data-project-id", "p2");
			expect(after).toHaveAttribute("data-task-view", "false");
			expect(after).toHaveAttribute("data-active-task-id", "");
		});

		it("from the full-page task screen: Cmd+Shift+2 drops to the board", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue(twoProjects);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "task", projectId: "p1", taskId: "t1" }),
			});

			await renderApp();
			expect(screen.getByTestId("task-screen")).toBeInTheDocument();

			await userEvent.keyboard("{Meta>}{Shift>}2{/Shift}{/Meta}");

			const after = screen.getByTestId("project-screen");
			expect(after).toHaveAttribute("data-project-id", "p2");
			expect(after).toHaveAttribute("data-task-view", "false");
		});

		it("ignores open-mode: from the board in fullscreen mode it still opens task view", async () => {
			localStorage.setItem("dev3-task-open-mode", "fullscreen");
			vi.mocked(api.request.getProjects).mockResolvedValue(twoProjects);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "project", projectId: "p1" }),
			});

			await renderApp();
			expect(screen.getByTestId("project-screen")).toHaveAttribute("data-task-view", "false");

			await userEvent.keyboard("{Meta>}{Shift>}2{/Shift}{/Meta}");

			const after = screen.getByTestId("project-screen");
			expect(after).toHaveAttribute("data-project-id", "p2");
			expect(after).toHaveAttribute("data-task-view", "true");
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
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
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
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
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
				window.dispatchEvent(new CustomEvent("rpc:taskSound", { detail: { status: "completed", taskId: "task-9" } }));
			});
			expect(playTaskSoundFromPush).toHaveBeenCalledWith("completed");
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
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
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
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
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
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
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

		it("Escape with help mode active only exits help mode — no navigation", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			await renderApp();
			await userEvent.keyboard("{Meta>}1{/Meta}");
			expect(screen.getByTestId("project-screen")).toBeInTheDocument();

			// happy-dom has no layout, so real zones report zero-size rects and the
			// overlay would exit instantly. Inject one zone with a mocked rect.
			const zone = document.createElement("div");
			zone.setAttribute("data-help-id", "header.utilities");
			zone.getBoundingClientRect = () =>
				({ top: 10, left: 500, width: 200, height: 30, right: 700, bottom: 40, x: 500, y: 10, toJSON: () => ({}) }) as DOMRect;
			document.body.appendChild(zone);
			try {
				act(() => {
					window.dispatchEvent(new CustomEvent("menu:enter-help-mode"));
				});
				expect(screen.getByTestId("help-overlay")).toBeInTheDocument();

				await userEvent.keyboard("{Escape}");
				// Help mode closed…
				expect(screen.queryByTestId("help-overlay")).not.toBeInTheDocument();
				// …but the screen must NOT have navigated back to the dashboard.
				expect(screen.getByTestId("project-screen")).toBeInTheDocument();
			} finally {
				zone.remove();
			}
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

		it("Cmd+0 jumps to the built-in Operations board", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
				{ id: "ops", name: "Operations", path: "/home/u/.dev3.0/ops/operations", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "", kind: "virtual", builtin: true },
			]);
			await renderApp();
			await userEvent.keyboard("{Meta>}0{/Meta}");
			expect(screen.getByTestId("project-screen")).toBeInTheDocument();
		});

		it("Cmd+0 does nothing when there is no built-in Operations board", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			await renderApp();
			await userEvent.keyboard("{Meta>}0{/Meta}");
			// No built-in board → stays on the dashboard (zoom-reset relocated to ⇧⌘0).
			expect(screen.getByTestId("dashboard-screen")).toBeInTheDocument();
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

		it("Ctrl+Alt+- calls adjustZoom with -ZOOM_STEP", async () => {
			await renderApp();
			await userEvent.keyboard("{Control>}{Alt>}-{/Alt}{/Control}");
			expect(mockedAdjustZoom).toHaveBeenCalledWith(-ZOOM_STEP);
		});

		it("Cmd+Shift+0 calls applyZoom with DEFAULT_ZOOM", async () => {
			// Reset-zoom relocated from ⌘0 (now Jump to Operations) to ⇧⌘0.
			await renderApp();
			await userEvent.keyboard("{Meta>}{Shift>}0{/Shift}{/Meta}");
			expect(mockedApplyZoom).toHaveBeenCalledWith(DEFAULT_ZOOM);
		});

		it("Ctrl+Shift+0 calls applyZoom with DEFAULT_ZOOM", async () => {
			await renderApp();
			await userEvent.keyboard("{Control>}{Shift>}0{/Shift}{/Control}");
			expect(mockedApplyZoom).toHaveBeenCalledWith(DEFAULT_ZOOM);
		});

		it("Cmd+0 (no shift) does NOT reset zoom (it jumps to Operations instead)", async () => {
			await renderApp();
			await userEvent.keyboard("{Meta>}0{/Meta}");
			expect(mockedApplyZoom).not.toHaveBeenCalled();
		});
	});

	describe("QR modal consumed state", () => {
		it("shows a success state after copying the QR URL", async () => {
			await renderApp();
			let resolveWrite!: () => void;
			const writeText = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { resolveWrite = resolve; }));
			Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
			const qrData = {
				qrDataUrl: "data:image/png;base64,test",
				accessUrl: "http://192.168.0.1:1234/?token=test",
				tunnelState: "idle",
				cloudflaredInstalled: false,
			};

			window.dispatchEvent(new CustomEvent("rpc:showRemoteAccessQR", { detail: qrData }));
			await waitFor(() => expect(screen.getByRole("button", { name: "Copy URL" })).toBeInTheDocument());

			await userEvent.click(screen.getByRole("button", { name: "Copy URL" }));
			await waitFor(() => expect(screen.getByRole("button", { name: "Copying URL…" })).toBeInTheDocument());
			expect(screen.getByRole("button", { name: "Copying URL…" })).toBeDisabled();

			resolveWrite();
			await waitFor(() => expect(screen.getByRole("button", { name: "URL copied" })).toBeInTheDocument());
			expect(writeText).toHaveBeenCalledWith(qrData.accessUrl);
		});

		it("keeps the active tunnel indicator after the QR modal closes", async () => {
			await renderApp();
			const remoteButton = screen.getByLabelText("Open on your phone — scan QR code for remote access");
			const qrData = {
				qrDataUrl: "data:image/png;base64,test",
				accessUrl: "https://public.trycloudflare.com/?token=test",
				tunnelState: "connected",
				cloudflaredInstalled: true,
			};

			window.dispatchEvent(new CustomEvent("rpc:showRemoteAccessQR", { detail: qrData }));
			await waitFor(() => {
				expect(remoteButton.className).toContain("remote-access-active");
				expect(remoteButton.className).toContain("text-accent");
			});

			await userEvent.click(screen.getByText("Close"));
			await waitFor(() => expect(screen.queryByText("Copy URL")).not.toBeInTheDocument());
			expect(remoteButton.className).toContain("remote-access-active");
		});

		it("does not activate the indicator for a local-only QR session", async () => {
			await renderApp();
			const remoteButton = screen.getByLabelText("Open on your phone — scan QR code for remote access");

			window.dispatchEvent(new CustomEvent("rpc:showRemoteAccessQR", {
				detail: {
					qrDataUrl: "data:image/png;base64,test",
					accessUrl: "http://192.168.0.1:1234/?token=test",
					tunnelState: "idle",
					cloudflaredInstalled: true,
				},
			}));
			await waitFor(() => expect(screen.getByText("Copy URL")).toBeInTheDocument());
			expect(remoteButton.className).not.toContain("remote-access-active");
		});

		it("activates while the tunnel is starting and deactivates after a failed start", async () => {
			await renderApp();
			const remoteButton = screen.getByLabelText("Open on your phone — scan QR code for remote access");

			window.dispatchEvent(new CustomEvent("rpc:showRemoteAccessQR", {
				detail: {
					qrDataUrl: "data:image/png;base64,test",
					accessUrl: "https://public.trycloudflare.com/?token=test",
					tunnelState: "starting",
					cloudflaredInstalled: true,
				},
			}));
			await waitFor(() => expect(remoteButton.className).toContain("remote-access-active"));

			window.dispatchEvent(new CustomEvent("rpc:showRemoteAccessQR", {
				detail: {
					qrDataUrl: "data:image/png;base64,test",
					accessUrl: "https://public.trycloudflare.com/?token=test",
					tunnelState: "failed",
					cloudflaredInstalled: true,
				},
			}));
			await waitFor(() => expect(remoteButton.className).not.toContain("remote-access-active"));
		});

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

		it("reactivates a consumed QR when the tunnel recovers with a new hostname", async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			try {
				await renderApp();
				window.dispatchEvent(new CustomEvent("rpc:showRemoteAccessQR", {
					detail: {
						qrDataUrl: "data:image/png;base64,stale",
						accessUrl: "https://stale.trycloudflare.com/?token=old",
						tunnelState: "connected",
						cloudflaredInstalled: true,
					},
				}));
				window.dispatchEvent(new CustomEvent("rpc:qrTokenConsumed"));
				await waitFor(() => expect(screen.getByText("Copy URL")).toBeDisabled());

				vi.mocked(api.request.getRemoteAccessQR).mockResolvedValue({
					qrDataUrl: "data:image/png;base64,recovered",
					accessUrl: "https://recovered.trycloudflare.com/?token=new",
					tunnelState: "connected",
					cloudflaredInstalled: true,
					interfaces: [],
					selectedHost: "",
				});

				await act(async () => {
					await vi.advanceTimersByTimeAsync(25_000);
				});

				expect(api.request.getRemoteAccessQR).toHaveBeenCalledWith({ tunnel: true, host: undefined });
				expect(screen.getByText("https://recovered.trycloudflare.com/?token=new")).toBeInTheDocument();
				expect(screen.getByText("Copy URL")).not.toBeDisabled();
				expect(screen.queryByText("Connected")).not.toBeInTheDocument();
			} finally {
				vi.useRealTimers();
			}
		});

		it("auto-starts the tunnel in the background after a fast open (no extra click)", async () => {
			await renderApp();
			vi.mocked(api.request.getRemoteAccessQR).mockClear();
			vi.mocked(api.request.getRemoteAccessQR).mockResolvedValue({
				qrDataUrl: "data:image/png;base64,tunnel",
				accessUrl: "https://public.trycloudflare.com/?token=t",
				tunnelState: "connected",
				cloudflaredInstalled: true,
				interfaces: [],
				selectedHost: "",
			});

			// The button/menu open the modal immediately with the local QR and
			// flag the tunnel to start in the background.
			window.dispatchEvent(new CustomEvent("rpc:showRemoteAccessQR", {
				detail: {
					qrDataUrl: "data:image/png;base64,local",
					accessUrl: "http://192.168.0.1:1234/?token=l",
					tunnelState: "idle",
					cloudflaredInstalled: true,
					interfaces: [],
					selectedHost: "192.168.0.1",
					autoStartTunnel: true,
				},
			}));

			await waitFor(() => expect(screen.getByText("Copy URL")).toBeInTheDocument());
			await waitFor(() => expect(api.request.getRemoteAccessQR).toHaveBeenCalledWith({ tunnel: true }));
			expect(
				screen.getByLabelText("Open on your phone — scan QR code for remote access").className,
			).toContain("remote-access-active");
		});

		it("does not restart the tunnel when opened while already connected", async () => {
			await renderApp();
			vi.mocked(api.request.getRemoteAccessQR).mockClear();

			window.dispatchEvent(new CustomEvent("rpc:showRemoteAccessQR", {
				detail: {
					qrDataUrl: "data:image/png;base64,live",
					accessUrl: "https://public.trycloudflare.com/?token=c",
					tunnelState: "connected",
					cloudflaredInstalled: true,
					interfaces: [],
					selectedHost: "",
					autoStartTunnel: true,
				},
			}));

			await waitFor(() => expect(screen.getByText("Copy URL")).toBeInTheDocument());
			expect(api.request.getRemoteAccessQR).not.toHaveBeenCalled();
		});

		it("shows auth failed screen when rpc:authFailed fires", async () => {
			await renderApp();
			window.dispatchEvent(new CustomEvent("rpc:authFailed", { detail: { status: 401 } }));
			await waitFor(() => {
				expect(screen.getByText("Session Expired")).toBeInTheDocument();
			});
		});

		it("shows auth failed screen when the session expired BEFORE React mounted", async () => {
			// With a dead cookie the boot probe's 401 lands before App mounts, so
			// the rpc:authFailed event fires into the void — App must seed the
			// screen from the transport state instead of spinning forever.
			// No renderApp() helper here: it waits for a main screen, which never
			// appears in this state — render directly.
			const { getRpcConnectionState } = await import("../rpc");
			vi.mocked(getRpcConnectionState).mockReturnValue("auth-failed");
			try {
				render(
					<I18nProvider>
						<App />
					</I18nProvider>,
				);
				await waitFor(() => {
					expect(screen.getByText("Session Expired")).toBeInTheDocument();
				});
			} finally {
				vi.mocked(getRpcConnectionState).mockReturnValue("connected");
			}
		});

		it("shows the interface picker (tunnel off) and switches host on change", async () => {
			await renderApp();
			const interfaces = [
				{ name: "en0", address: "192.168.0.1", internal: false },
				{ name: "loopback", address: "127.0.0.1", internal: true },
			];
			vi.mocked(api.request.getRemoteAccessQR).mockResolvedValue({
				qrDataUrl: "data:image/png;base64,test2",
				accessUrl: "http://127.0.0.1:1234/?token=test",
				tunnelState: "idle",
				cloudflaredInstalled: false,
				interfaces,
				selectedHost: "127.0.0.1",
			});
			window.dispatchEvent(new CustomEvent("rpc:showRemoteAccessQR", {
				detail: {
					qrDataUrl: "data:image/png;base64,test",
					accessUrl: "http://192.168.0.1:1234/?token=test",
					tunnelState: "idle",
					cloudflaredInstalled: false,
					interfaces,
					selectedHost: "192.168.0.1",
				},
			}));

			await waitFor(() => expect(screen.getByText("Reachable at")).toBeInTheDocument());
			const select = screen.getByRole("combobox");
			expect(select).toHaveValue("192.168.0.1");
			expect(screen.getByRole("option", { name: "en0 · 192.168.0.1" })).toBeInTheDocument();
			expect(screen.getByRole("option", { name: "Localhost · 127.0.0.1" })).toBeInTheDocument();

			await userEvent.selectOptions(select, "127.0.0.1");
			expect(api.request.getRemoteAccessQR).toHaveBeenCalledWith({ tunnel: false, host: "127.0.0.1" });
		});

		it("shows a copyable install command when cloudflared is missing", async () => {
			const writeText = vi.fn().mockResolvedValue(undefined);
			Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
			await renderApp();
			window.dispatchEvent(new CustomEvent("rpc:showRemoteAccessQR", {
				detail: {
					qrDataUrl: "data:image/png;base64,test",
					accessUrl: "http://192.168.0.1:1234/?token=test",
					tunnelState: "idle",
					cloudflaredInstalled: false,
				},
			}));
			const toggle = await screen.findByLabelText("Accessible from anywhere (Cloudflare Tunnel)");

			// Enabling the Cloudflare Tunnel toggle reveals the "not installed" block.
			await userEvent.click(toggle);

			expect(screen.getByText("cloudflared is not installed")).toBeInTheDocument();
			expect(screen.getByText("brew install cloudflared")).toBeInTheDocument();

			await userEvent.click(screen.getByRole("button", { name: "Copy command" }));
			expect(writeText).toHaveBeenCalledWith("brew install cloudflared");
			expect(await screen.findByText("Copied!")).toBeInTheDocument();
		});

		it("hides the interface picker when the tunnel is connected", async () => {
			await renderApp();
			window.dispatchEvent(new CustomEvent("rpc:showRemoteAccessQR", {
				detail: {
					qrDataUrl: "data:image/png;base64,test",
					accessUrl: "https://abc.trycloudflare.com/?token=test",
					tunnelState: "connected",
					cloudflaredInstalled: true,
					interfaces: [
						{ name: "en0", address: "192.168.0.1", internal: false },
						{ name: "loopback", address: "127.0.0.1", internal: true },
					],
					selectedHost: "192.168.0.1",
				},
			}));
			await waitFor(() => expect(screen.getByText("Copy URL")).toBeInTheDocument());
			expect(screen.queryByText("Reachable at")).not.toBeInTheDocument();
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
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "task", projectId: "p1", taskId: "t1" }),
			});
			vi.mocked(confirm).mockResolvedValue(true);
			vi.mocked(api.request.moveTask).mockResolvedValue({} as never);

			await renderApp();
			expect(screen.getByTestId("task-screen")).toBeInTheDocument();

			await fireBranchMerged("t1", "p1", "fp-confirm-1");

			// Slow CI runners can exceed the default 1s waitFor timeout here
			await waitFor(
				() => {
					expect(screen.getByTestId("project-screen")).toBeInTheDocument();
				},
				{ timeout: 5000 },
			);
			expect(screen.queryByTestId("task-screen")).not.toBeInTheDocument();
			expect(api.request.moveTask).toHaveBeenCalledWith(
				expect.objectContaining({ taskId: "t1", projectId: "p1", newStatus: "completed" }),
			);
		});

		it("stays on task screen when user declines the popup", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
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

		it("offers manual completion and persists it without completing the task", async () => {
			vi.mocked(confirm).mockResolvedValue("manual" as never);
			await renderApp();

			await fireBranchMerged("t1", "p1", "fp-manual-1");

			await waitFor(() => {
				expect(api.request.setTaskManualCompletion).toHaveBeenCalledWith({
					taskId: "t1",
					projectId: "p1",
					manualCompletion: true,
				});
			});
			expect(api.request.moveTask).not.toHaveBeenCalled();
			expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
				title: "The branch is in the base branch",
				message: "The merge is complete. Is the task complete too?",
				confirmLabel: "Complete task",
				cancelLabel: "Not now",
				alternativeAction: { label: "I’ll complete it myself", value: "manual" },
				outcomeCards: {
					kicker: "Branch merged",
					statusLabel: "Merged",
					statusValue: "feat/whatever",
					confirmDescription: "Move the task to Completed now.",
					cancelDescription: "Keep it open and ask again after the next merge.",
					alternativeDescription: "Keep it open and stop asking after merges.",
				},
				dismissOnBackdrop: false,
			}));
		});

		it("passes the full task context to the merge popup", async () => {
			await renderApp();
			await act(async () => {
				window.dispatchEvent(new CustomEvent("rpc:branchMerged", {
					detail: {
						taskId: "t1",
						projectId: "p1",
						taskTitle: "Some task",
						branchName: "feat/whatever",
						fingerprint: "fp-rich-context-1",
						subject: {
							seqLabel: "1004",
							projectName: "Alpha",
							priority: "P2",
							labels: [],
							overview: "Branch merged; waiting for rollout verification.",
						},
					},
				}));
			});

			await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
				info: {
					title: "Some task",
					body: "Branch merged; waiting for rollout verification.",
					seqLabel: "1004",
					projectName: "Alpha",
					priority: "P2",
					labels: [],
				},
			})));
		});

		it("re-asks on the next merge after Not now", async () => {
			vi.mocked(confirm).mockResolvedValue(false);
			await renderApp();

			await fireBranchMerged("t1", "p1", "fp-not-now-1");
			await waitFor(() => expect(api.request.dismissMergeCompletionPrompt).toHaveBeenCalledTimes(1));

			await fireBranchMerged("t1", "p1", "fp-not-now-2");
			await waitFor(() => expect(api.request.dismissMergeCompletionPrompt).toHaveBeenCalledTimes(2));
			expect(confirm).toHaveBeenCalledTimes(2);
		});

		it("shows a notice instead of a popup when merge prompting is disabled", async () => {
			await renderApp();
			await act(async () => {
				window.dispatchEvent(new CustomEvent("rpc:branchMerged", {
					detail: {
						taskId: "t1",
						projectId: "p1",
						taskTitle: "Some task",
						branchName: "feat/whatever",
						fingerprint: "fp-notice-1",
						shouldPrompt: false,
						shouldNotify: true,
					},
				}));
			});

			expect(confirm).not.toHaveBeenCalled();
			expect(await screen.findByText('Branch of task "Some task" was merged.')).toBeInTheDocument();
		});

		it("shows when an agent changes the merge-prompt policy", async () => {
			await renderApp();
			await act(async () => {
				window.dispatchEvent(new CustomEvent("rpc:manualCompletionChanged", {
					detail: { taskId: "t1", projectId: "p1", manualCompletion: true },
				}));
			});

			expect(await screen.findByText("Agent turned off completion prompts for this task.")).toBeInTheDocument();
		});

		it("does not navigate when user is on a different task's screen", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
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

	describe("task preparation failure feedback", () => {
		it("shows the backend failure reason when a Git task is reverted to To Do", async () => {
			await renderApp();

			act(() => {
				window.dispatchEvent(new CustomEvent("rpc:taskPreparationFailed", {
					detail: {
						taskId: "t1",
						projectId: "p1",
						taskTitle: "Broken task",
						error: "tmux failed to spawn",
					},
				}));
			});

			expect(await screen.findByRole("alert")).toHaveTextContent(
				"Couldn't prepare \"Broken task\" — moved back to To Do: tmux failed to spawn",
			);
		});
	});

	describe("agent completion request dialog", () => {
		const fireAgentCompletionRequested = (requestId: string, taskId: string, projectId: string) =>
			act(async () => {
				window.dispatchEvent(
					new CustomEvent("rpc:agentCompletionRequested", {
						detail: { requestId, taskId, projectId, taskTitle: "Some task" },
					}),
				);
			});

		it("responds with approved:true and navigates away from the doomed task screen", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "task", projectId: "p1", taskId: "t1" }),
			});
			vi.mocked(confirm).mockResolvedValue(true);

			await renderApp();
			expect(screen.getByTestId("task-screen")).toBeInTheDocument();

			await fireAgentCompletionRequested("req-1", "t1", "p1");

			await waitFor(() => {
				expect(api.request.respondToAgentCompletionRequest).toHaveBeenCalledWith({
					requestId: "req-1",
					approved: true,
				});
			});
			expect(screen.getByTestId("project-screen")).toBeInTheDocument();
			expect(screen.queryByTestId("task-screen")).not.toBeInTheDocument();
			// The move itself happens in the bun process, not the renderer.
			expect(api.request.moveTask).not.toHaveBeenCalled();
			expect(vi.mocked(confirm).mock.calls[0][0]).toMatchObject({ agentInitiated: true, danger: true });
		});

		it("responds with approved:false and stays in place when declined", async () => {
			vi.mocked(api.request.getProjects).mockResolvedValue([
				{ id: "p1", name: "Alpha", path: "/a", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" },
			]);
			vi.mocked(api.request.getLastRoute).mockResolvedValue({
				route: JSON.stringify({ screen: "task", projectId: "p1", taskId: "t1" }),
			});
			vi.mocked(confirm).mockResolvedValue(false);

			await renderApp();
			expect(screen.getByTestId("task-screen")).toBeInTheDocument();

			await fireAgentCompletionRequested("req-2", "t1", "p1");

			await waitFor(() => {
				expect(api.request.respondToAgentCompletionRequest).toHaveBeenCalledWith({
					requestId: "req-2",
					approved: false,
				});
			});
			expect(screen.getByTestId("task-screen")).toBeInTheDocument();
			expect(api.request.moveTask).not.toHaveBeenCalled();
		});

		it("passes the task subject (project, seq, priority, labels, overview) into the confirm dialog", async () => {
			vi.mocked(confirm).mockResolvedValue(false);
			await renderApp();

			await act(async () => {
				window.dispatchEvent(
					new CustomEvent("rpc:agentCompletionRequested", {
						detail: {
							requestId: "req-3",
							taskId: "t1",
							projectId: "p1",
							taskTitle: "Ship the thing",
							subject: {
								seqLabel: "1159-1",
								projectName: "dev-3.0",
								priority: "P0",
								labels: [{ id: "l1", name: "Feature", color: "#84cc16" }],
								overview: "Almost done, wiring the dialog.",
							},
						},
					}),
				);
			});

			await waitFor(() => {
				expect(api.request.respondToAgentCompletionRequest).toHaveBeenCalled();
			});
			const calls = vi.mocked(confirm).mock.calls;
			const info = calls[calls.length - 1][0].info;
			expect(info).toEqual({
				title: "Ship the thing",
				body: "Almost done, wiring the dialog.",
				seqLabel: "1159-1",
				projectName: "dev-3.0",
				priority: "P0",
				labels: [{ id: "l1", name: "Feature", color: "#84cc16" }],
			});
		});
	});
});
