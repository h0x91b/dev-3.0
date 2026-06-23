import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskTerminal from "../TaskTerminal";
import { I18nProvider } from "../../i18n";
import type { Task, Project } from "../../../shared/types";
import type { AppAction, Route } from "../../state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getPtyUrl: vi.fn(),
			resumeTask: vi.fn(),
			restartTask: vi.fn(),
			moveTask: vi.fn(),
			cancelTaskPreparation: vi.fn(),
			checkWorktreeExists: vi.fn(),
			getResolvedProject: vi.fn().mockResolvedValue({}),
			getBranchStatus: vi.fn().mockResolvedValue({}),
			getPortAllocations: vi.fn().mockResolvedValue([]),
			getGlobalSettings: vi.fn().mockResolvedValue({}),
		},
	},
	isElectrobun: false,
}));

vi.mock("../../analytics", () => ({
	trackEvent: vi.fn(),
	agentNameFromId: vi.fn(() => "unknown"),
}));

vi.mock("../../TerminalView", () => ({
	default: ({ ptyUrl, onReady }: { ptyUrl: string; onReady?: (h: unknown) => void }) => {
		if (onReady) {
			setTimeout(() => onReady({ sendInput: vi.fn(), focus: vi.fn() }), 0);
		}
		return <div data-testid="terminal-view">{ptyUrl}</div>;
	},
}));

vi.mock("../TaskInfoPanel", () => ({
	default: () => <div data-testid="task-info-panel" />,
}));

vi.mock("../ExtraKeyBar", () => ({
	default: () => <div data-testid="extra-key-bar" />,
}));

// Mock navigator.maxTouchPoints for ExtraKeyBar visibility tests
const originalMaxTouchPoints = Object.getOwnPropertyDescriptor(Navigator.prototype, "maxTouchPoints");
function setTouchDevice(isTouch: boolean) {
	Object.defineProperty(navigator, "maxTouchPoints", { value: isTouch ? 5 : 0, configurable: true });
}

import { api } from "../../rpc";
import { trackEvent } from "../../analytics";

const mockedApi = vi.mocked(api, true);
const mockedTrackEvent = vi.mocked(trackEvent);

// ---- Fixtures ----

const project: Project = {
	id: "p1",
	name: "Test Project",
	path: "/tmp/test",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: "t1",
		seq: 1,
		projectId: "p1",
		title: "Test task",
		description: "",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: "/tmp/wt/t1",
		branchName: "dev3/task-t1",
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2025-06-15T10:30:00Z",
		updatedAt: "2025-06-15T12:00:00Z",
		...overrides,
	};
}

function renderTerminal(
	opts?: {
		tasks?: Task[];
		dispatch?: React.Dispatch<AppAction>;
		navigate?: (route: Route) => void;
	},
) {
	const tasks = opts?.tasks ?? [makeTask()];
	const dispatch = opts?.dispatch ?? vi.fn();
	const navigate = opts?.navigate ?? vi.fn();
	return render(
		<I18nProvider>
			<TaskTerminal
				projectId="p1"
				taskId="t1"
				tasks={tasks}
				projects={[project]}
				navigate={navigate}
				dispatch={dispatch}
			/>
		</I18nProvider>,
	);
}

describe("TaskTerminal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Suppress expected console noise from the component's error handling
		// (tests intentionally trigger getPtyUrl failures to test error UI)
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		// Restore navigator.maxTouchPoints
		if (originalMaxTouchPoints) {
			Object.defineProperty(Navigator.prototype, "maxTouchPoints", originalMaxTouchPoints);
		} else {
			Object.defineProperty(navigator, "maxTouchPoints", { value: 0, configurable: true });
		}
	});

	describe("handleMove sets movedAt", () => {
		it("sets movedAt when completing task from error screen", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();
			const navigate = vi.fn();

			// getPtyUrl fails → triggers error classification
			mockedApi.request.getPtyUrl.mockRejectedValue(new Error("no pty"));
			mockedApi.request.checkWorktreeExists.mockResolvedValue(true);
			mockedApi.request.moveTask.mockResolvedValue({ ...makeTask(), status: "completed" });

			await act(async () => {
				renderTerminal({ dispatch, navigate });
			});

			// Wait for error screen to appear (session-ended because worktree exists)
			await waitFor(() => {
				expect(screen.getByText(/Complete/i)).toBeInTheDocument();
			});

			await user.click(screen.getByText(/Complete/i));

			expect(dispatch).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "updateTask",
					task: expect.objectContaining({
						status: "completed",
						worktreePath: null,
						branchName: null,
					}),
				}),
			);

			// Verify movedAt is set
			const updateCall = dispatch.mock.calls.find(
				(c: unknown[]) => (c[0] as AppAction).type === "updateTask",
			);
			expect(updateCall).toBeDefined();
			const dispatchedTask = (updateCall![0] as { task: Task }).task;
			expect(dispatchedTask.movedAt).toBeDefined();
			expect(typeof dispatchedTask.movedAt).toBe("string");
			const movedAtMs = new Date(dispatchedTask.movedAt!).getTime();
			expect(movedAtMs).toBeGreaterThan(Date.now() - 5000);

			expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p1", taskView: true });
			expect(mockedTrackEvent).toHaveBeenCalledWith("task_moved", {
				from_status: "in-progress",
				to_status: "completed",
				agent_name: "unknown",
			});
		});

		it("sets movedAt when cancelling task from error screen", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();
			const navigate = vi.fn();

			mockedApi.request.getPtyUrl.mockRejectedValue(new Error("no pty"));
			mockedApi.request.checkWorktreeExists.mockResolvedValue(false);
			mockedApi.request.moveTask.mockResolvedValue({ ...makeTask(), status: "cancelled" });

			await act(async () => {
				renderTerminal({ dispatch, navigate });
			});

			// Wait for error screen (worktree-gone variant)
			await waitFor(() => {
				expect(screen.getByText(/Cancel/i)).toBeInTheDocument();
			});

			await user.click(screen.getByText(/Cancel/i));

			const updateCall = dispatch.mock.calls.find(
				(c: unknown[]) => (c[0] as AppAction).type === "updateTask",
			);
			expect(updateCall).toBeDefined();
			const dispatchedTask = (updateCall![0] as { task: Task }).task;
			expect(dispatchedTask.movedAt).toBeDefined();
			expect(dispatchedTask.status).toBe("cancelled");
			expect(dispatchedTask.worktreePath).toBeNull();
			expect(dispatchedTask.branchName).toBeNull();

			expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p1", taskView: true });
		});

		it("fires moveTask API call in background", async () => {
			const user = userEvent.setup();

			mockedApi.request.getPtyUrl.mockRejectedValue(new Error("no pty"));
			mockedApi.request.checkWorktreeExists.mockResolvedValue(true);
			mockedApi.request.moveTask.mockResolvedValue({ ...makeTask(), status: "completed" });

			await act(async () => {
				renderTerminal();
			});

			await waitFor(() => {
				expect(screen.getByText(/Complete/i)).toBeInTheDocument();
			});

			await user.click(screen.getByText(/Complete/i));

			// The shared move helper tries a normal move first (force is only the
			// fallback when that fails), so the background call carries no force flag.
			expect(mockedApi.request.moveTask).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				newStatus: "completed",
			});
		});
	});

	describe("Session recovery prompt", () => {
		it("shows recovery prompt when getPtyUrl returns recoverable", async () => {
			mockedApi.request.getPtyUrl.mockResolvedValue({
				recoverable: true,
				sessionState: { panes: [{ agentCmd: "claude", sessionId: "sid-1", agentId: "builtin-claude", configId: "cfg-1" }] },
			});

			await act(async () => {
				renderTerminal();
			});

			await waitFor(() => {
				expect(screen.getByText("Previous agent session found")).toBeInTheDocument();
				expect(screen.getByText("Resume Session")).toBeInTheDocument();
				expect(screen.getByText("Start Fresh")).toBeInTheDocument();
			});
		});

		it("calls resumeTask when clicking Resume Session", async () => {
			const user = userEvent.setup();
			mockedApi.request.getPtyUrl.mockResolvedValue({
				recoverable: true,
				sessionState: { panes: [{ agentCmd: "claude", sessionId: "sid-1", agentId: "builtin-claude", configId: "cfg-1" }] },
			});
			mockedApi.request.resumeTask.mockResolvedValue("ws://localhost:9999?session=t1");

			await act(async () => {
				renderTerminal();
			});

			await waitFor(() => {
				expect(screen.getByText("Resume Session")).toBeInTheDocument();
			});

			await act(async () => {
				await user.click(screen.getByText("Resume Session"));
			});

			expect(mockedApi.request.resumeTask).toHaveBeenCalledWith({ taskId: "t1" });
		});

		it("calls restartTask when clicking Start Fresh", async () => {
			const user = userEvent.setup();
			mockedApi.request.getPtyUrl.mockResolvedValue({
				recoverable: true,
				sessionState: { panes: [{ agentCmd: "claude", sessionId: "sid-1", agentId: "builtin-claude", configId: "cfg-1" }] },
			});
			mockedApi.request.restartTask.mockResolvedValue("ws://localhost:9999?session=t1");

			await act(async () => {
				renderTerminal();
			});

			await waitFor(() => {
				expect(screen.getByText("Start Fresh")).toBeInTheDocument();
			});

			await act(async () => {
				await user.click(screen.getByText("Start Fresh"));
			});

			expect(mockedApi.request.restartTask).toHaveBeenCalledWith({ taskId: "t1" });
		});

		it("renders terminal after successful resume", async () => {
			const user = userEvent.setup();
			mockedApi.request.getPtyUrl.mockResolvedValue({
				recoverable: true,
				sessionState: { panes: [{ agentCmd: "claude", sessionId: "sid-1", agentId: "builtin-claude", configId: "cfg-1" }] },
			});
			mockedApi.request.resumeTask.mockResolvedValue("ws://localhost:9999?session=t1");

			await act(async () => {
				renderTerminal();
			});

			await waitFor(() => {
				expect(screen.getByText("Resume Session")).toBeInTheDocument();
			});

			await act(async () => {
				await user.click(screen.getByText("Resume Session"));
			});

			await waitFor(() => {
				expect(screen.getByTestId("terminal-view")).toBeInTheDocument();
			});
		});
	});

	describe("Resume Session button", () => {
		it("shows Resume Session button on session-ended error", async () => {
			mockedApi.request.getPtyUrl.mockRejectedValue(new Error("no pty"));
			mockedApi.request.checkWorktreeExists.mockResolvedValue(true);

			await act(async () => {
				renderTerminal();
			});

			await waitFor(() => {
				expect(screen.getByText("Resume Session")).toBeInTheDocument();
			});
		});

		it("calls getPtyUrl with resume: true when clicking Resume Session", async () => {
			const user = userEvent.setup();
			// Both calls fail — we only care that the second call has resume: true
			mockedApi.request.getPtyUrl.mockRejectedValue(new Error("no pty"));
			mockedApi.request.checkWorktreeExists.mockResolvedValue(true);

			await act(async () => {
				renderTerminal();
			});

			await waitFor(() => {
				expect(screen.getByText("Resume Session")).toBeInTheDocument();
			});

			await act(async () => {
				await user.click(screen.getByText("Resume Session"));
			});

			expect(mockedApi.request.getPtyUrl).toHaveBeenLastCalledWith({
				taskId: "t1",
				resume: true,
			});
		});

		it("does not show Resume Session button when worktree is gone", async () => {
			mockedApi.request.getPtyUrl.mockRejectedValue(new Error("no pty"));
			mockedApi.request.checkWorktreeExists.mockResolvedValue(false);

			await act(async () => {
				renderTerminal();
			});

			await waitFor(() => {
				expect(screen.getByText(/Cancel Task/i)).toBeInTheDocument();
			});

			expect(screen.queryByText("Resume Session")).not.toBeInTheDocument();
		});
	});

	describe("Preparing state", () => {
		it("shows preparing loading view and skips getPtyUrl while task is preparing", async () => {
			const preparingTask = makeTask({
				preparing: true,
				preparingStage: "fetching-origin",
				preparingProgress: 24,
			});

			await act(async () => {
				renderTerminal({ tasks: [preparingTask] });
			});

			await waitFor(() => {
				expect(screen.getByText("Preparing…")).toBeInTheDocument();
			});
			expect(screen.getByText("Fetching origin")).toBeInTheDocument();
			expect(screen.queryByTestId("terminal-view")).not.toBeInTheDocument();
			expect(mockedApi.request.getPtyUrl).not.toHaveBeenCalled();
		});

		it("cancels preparation, dispatches the reverted task, and navigates back", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();
			const navigate = vi.fn();
			const preparingTask = makeTask({ preparing: true, preparingStage: "creating-worktree" });
			const revertedTask = makeTask({ status: "todo", preparing: false, worktreePath: null });
			mockedApi.request.cancelTaskPreparation.mockResolvedValue(revertedTask);

			await act(async () => {
				renderTerminal({ tasks: [preparingTask], dispatch, navigate });
			});

			await waitFor(() => {
				expect(screen.getByText("Preparing…")).toBeInTheDocument();
			});

			await act(async () => {
				await user.click(screen.getByText("Cancel"));
			});

			expect(mockedApi.request.cancelTaskPreparation).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1" });
			expect(dispatch).toHaveBeenCalledWith({ type: "updateTask", task: revertedTask });
			expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p1", taskView: true });
		});

		it("connects to the PTY once preparing flips to false", async () => {
			mockedApi.request.getPtyUrl.mockResolvedValue({ url: "ws://localhost:1234?session=t1" });
			const navigate = vi.fn();
			const dispatch = vi.fn();

			const { rerender } = render(
				<I18nProvider>
					<TaskTerminal
						projectId="p1"
						taskId="t1"
						tasks={[makeTask({ preparing: true })]}
						projects={[project]}
						navigate={navigate}
						dispatch={dispatch}
					/>
				</I18nProvider>,
			);

			await waitFor(() => {
				expect(screen.getByText("Preparing…")).toBeInTheDocument();
			});
			expect(mockedApi.request.getPtyUrl).not.toHaveBeenCalled();

			await act(async () => {
				rerender(
					<I18nProvider>
						<TaskTerminal
							projectId="p1"
							taskId="t1"
							tasks={[makeTask({ preparing: false })]}
							projects={[project]}
							navigate={navigate}
							dispatch={dispatch}
						/>
					</I18nProvider>,
				);
			});

			await waitFor(() => {
				expect(mockedApi.request.getPtyUrl).toHaveBeenCalledWith({ taskId: "t1" });
				expect(screen.getByTestId("terminal-view")).toBeInTheDocument();
			});
		});
	});

	describe("ExtraKeyBar visibility", () => {
		it("does not show ExtraKeyBar on non-touch desktop browser", async () => {
			setTouchDevice(false);
			mockedApi.request.getPtyUrl.mockResolvedValue({ url: "ws://localhost:1234" });

			await act(async () => {
				renderTerminal();
			});

			await waitFor(() => {
				expect(screen.getByTestId("terminal-view")).toBeInTheDocument();
			});

			await act(async () => {
				await new Promise((r) => setTimeout(r, 10));
			});

			expect(screen.queryByTestId("extra-key-bar")).not.toBeInTheDocument();
		});

		it("shows ExtraKeyBar on touch device (mobile)", async () => {
			setTouchDevice(true);
			mockedApi.request.getPtyUrl.mockResolvedValue({ url: "ws://localhost:1234" });

			await act(async () => {
				renderTerminal();
			});

			await waitFor(() => {
				expect(screen.getByTestId("terminal-view")).toBeInTheDocument();
			});

			await act(async () => {
				await new Promise((r) => setTimeout(r, 10));
			});

			await waitFor(() => {
				expect(screen.getByTestId("extra-key-bar")).toBeInTheDocument();
			});
		});
	});
});
