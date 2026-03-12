import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskInfoPanel from "../TaskInfoPanel";
import { I18nProvider } from "../../i18n";
import type { Task, Project, BranchStatus, Label } from "../../../shared/types";
import type { AppAction, Route } from "../../state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			moveTask: vi.fn(),
			addTaskNote: vi.fn(),
			updateTaskNote: vi.fn(),
			deleteTaskNote: vi.fn(),
			runDevServer: vi.fn(),
			checkDevServer: vi.fn(),
			stopDevServer: vi.fn(),
			getBranchStatus: vi.fn(),
			rebaseTask: vi.fn(),
			mergeTask: vi.fn(),
			pushTask: vi.fn(),
			showDiff: vi.fn(),
			showUncommittedDiff: vi.fn(),
			showConfirm: vi.fn(),
			createPullRequest: vi.fn(),
			openPullRequest: vi.fn(),
			renameTask: vi.fn(),
		},
	},
}));

vi.mock("../../analytics", () => ({
	trackEvent: vi.fn(),
}));

vi.mock("../../utils/confirmTaskCompletion", () => ({
	confirmTaskCompletion: vi.fn().mockResolvedValue(true),
}));

import { api } from "../../rpc";
import { trackEvent } from "../../analytics";
import { confirmTaskCompletion } from "../../utils/confirmTaskCompletion";

const mockedApi = vi.mocked(api, true);
const mockedTrackEvent = vi.mocked(trackEvent);
const mockedConfirmTaskCompletion = vi.mocked(confirmTaskCompletion);

// ---- Fixtures ----

const label1: Label = { id: "lbl1", name: "Bug", color: "#ef4444" };
const label2: Label = { id: "lbl2", name: "Feature", color: "#3b82f6" };

const project: Project = {
	id: "p1",
	name: "Test Project",
	path: "/tmp/test",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
	labels: [label1, label2],
};

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: "t1",
		seq: 42,
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

const defaultBranchStatus: BranchStatus = {
	ahead: 3,
	behind: 0,
	canRebase: true,
	insertions: 0,
	deletions: 0,
	unpushed: 0,
	mergedByContent: false,
	diffFiles: 0,
	diffInsertions: 0,
	diffDeletions: 0,
	diffFileNames: [],
	prNumber: null,
	prUrl: null,
};

function renderPanel(
	task: Task,
	opts?: {
		dispatch?: React.Dispatch<AppAction>;
		navigate?: (route: Route) => void;
		project?: Project;
		isFullPage?: boolean;
	},
) {
	const dispatch = opts?.dispatch ?? vi.fn();
	const navigate = opts?.navigate ?? vi.fn();
	return render(
		<I18nProvider>
			<TaskInfoPanel
				task={task}
				project={opts?.project ?? project}
				dispatch={dispatch}
				navigate={navigate}
				isFullPage={opts?.isFullPage}
			/>
		</I18nProvider>,
	);
}

describe("TaskInfoPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers({ shouldAdvanceTime: true });
		localStorage.clear();
		// Default: getBranchStatus resolves immediately
		mockedApi.request.getBranchStatus.mockResolvedValue(defaultBranchStatus);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("collapsed view (default)", () => {
		it("renders status button with correct label", async () => {
			await act(async () => {
				renderPanel(makeTask({ status: "in-progress" }));
			});
			expect(screen.getByText("Agent is Working")).toBeInTheDocument();
		});

		it("renders labels when present", async () => {
			await act(async () => {
				renderPanel(makeTask({ labelIds: ["lbl1", "lbl2"] }));
			});
			expect(screen.getByText("Bug")).toBeInTheDocument();
			expect(screen.getByText("Feature")).toBeInTheDocument();
		});

		it("skips unknown label IDs", async () => {
			await act(async () => {
				renderPanel(makeTask({ labelIds: ["nonexistent"] }));
			});
			expect(screen.queryByText("nonexistent")).not.toBeInTheDocument();
		});

		it("renders branch name", async () => {
			await act(async () => {
				renderPanel(makeTask({ branchName: "dev3/my-branch" }));
			});
			// Branch appears in both collapsed and expanded, but collapsed is default
			expect(screen.getAllByText("dev3/my-branch").length).toBeGreaterThanOrEqual(1);
		});

		it("does not render metadata grid in collapsed state", async () => {
			await act(async () => {
				renderPanel(makeTask({ description: "Some desc" }));
			});
			// Description only shows in expanded metadata grid
			expect(screen.queryByText("Some desc")).not.toBeInTheDocument();
		});

		it("renders expand button", async () => {
			await act(async () => {
				renderPanel(makeTask());
			});
			expect(screen.getByTitle("Expand panel")).toBeInTheDocument();
		});

		it("renders full screen button", async () => {
			await act(async () => {
				renderPanel(makeTask());
			});
			expect(screen.getByTitle("Full screen")).toBeInTheDocument();
		});
	});

	describe("expanded view", () => {
		beforeEach(() => {
			localStorage.setItem("dev3-panel-collapsed", "false");
		});

		it("renders task seq number", async () => {
			await act(async () => {
				renderPanel(makeTask({ seq: 42 }));
			});
			expect(screen.getByText("#42")).toBeInTheDocument();
		});

		it("renders branch name in metadata", async () => {
			await act(async () => {
				renderPanel(makeTask({ branchName: "dev3/task-abc" }));
			});
			const branchTexts = screen.getAllByText("dev3/task-abc");
			expect(branchTexts.length).toBeGreaterThanOrEqual(2); // header row + metadata
		});

		it("renders description when present", async () => {
			await act(async () => {
				renderPanel(makeTask({ description: "Fix the login bug" }));
			});
			expect(screen.getByText("Fix the login bug")).toBeInTheDocument();
		});

		it("does not render description row when empty", async () => {
			await act(async () => {
				renderPanel(makeTask({ description: "" }));
			});
			expect(screen.queryByText("Description")).not.toBeInTheDocument();
		});

		it("renders worktree path when present", async () => {
			await act(async () => {
				renderPanel(makeTask({ worktreePath: "/tmp/wt/abc" }));
			});
			expect(screen.getByText("/tmp/wt/abc")).toBeInTheDocument();
		});

		it("renders notes section with empty state", async () => {
			await act(async () => {
				renderPanel(makeTask({ notes: [] }));
			});
			expect(screen.getByText("Notes")).toBeInTheDocument();
			expect(screen.getByText("No notes yet")).toBeInTheDocument();
		});

		it("renders existing notes", async () => {
			await act(async () => {
				renderPanel(makeTask({
					notes: [
						{ id: "n1", content: "AI note content", source: "ai", createdAt: "2025-06-15T10:00:00Z", updatedAt: "2025-06-15T10:00:00Z" },
						{ id: "n2", content: "User note content", source: "user", createdAt: "2025-06-15T11:00:00Z", updatedAt: "2025-06-15T11:00:00Z" },
					],
				}));
			});
			expect(screen.getByText("AI note content")).toBeInTheDocument();
			// User note is in a textarea
			expect(screen.getByDisplayValue("User note content")).toBeInTheDocument();
		});

		it("renders AI notes as read-only text", async () => {
			await act(async () => {
				renderPanel(makeTask({
					notes: [
						{ id: "n1", content: "AI generated", source: "ai", createdAt: "2025-06-15T10:00:00Z", updatedAt: "2025-06-15T10:00:00Z" },
					],
				}));
			});
			expect(screen.getByText("AI")).toBeInTheDocument();
			expect(screen.getByText("AI generated")).toBeInTheDocument();
			// Should not be a textarea
			expect(screen.queryByDisplayValue("AI generated")).not.toBeInTheDocument();
		});

		it("renders user notes as editable textareas", async () => {
			await act(async () => {
				renderPanel(makeTask({
					notes: [
						{ id: "n1", content: "Editable", source: "user", createdAt: "2025-06-15T10:00:00Z", updatedAt: "2025-06-15T10:00:00Z" },
					],
				}));
			});
			expect(screen.getByText("User")).toBeInTheDocument();
			const textarea = screen.getByDisplayValue("Editable");
			expect(textarea.tagName).toBe("TEXTAREA");
		});

		it("renders collapse button", async () => {
			await act(async () => {
				renderPanel(makeTask());
			});
			expect(screen.getByTitle("Collapse panel")).toBeInTheDocument();
		});
	});

	describe("collapse/expand toggle", () => {
		it("expands panel when clicking expand button", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			await act(async () => {
				renderPanel(makeTask({ seq: 99, description: "Some desc" }));
			});

			// Collapsed initially — no description
			expect(screen.queryByText("Some desc")).not.toBeInTheDocument();

			await user.click(screen.getByTitle("Expand panel"));

			// Now expanded — description visible
			expect(screen.getByText("Some desc")).toBeInTheDocument();
			expect(screen.getByText("#99")).toBeInTheDocument();
		});

		it("collapses panel when clicking collapse button", async () => {
			localStorage.setItem("dev3-panel-collapsed", "false");
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			await act(async () => {
				renderPanel(makeTask({ description: "Visible desc" }));
			});

			// Expanded — description visible
			expect(screen.getByText("Visible desc")).toBeInTheDocument();

			await user.click(screen.getByTitle("Collapse panel"));

			// Now collapsed — no description
			expect(screen.queryByText("Visible desc")).not.toBeInTheDocument();
		});

		it("persists collapsed state to localStorage", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			await act(async () => {
				renderPanel(makeTask());
			});

			// Default is collapsed=true
			expect(localStorage.getItem("dev3-panel-collapsed")).toBe("true");

			await user.click(screen.getByTitle("Expand panel"));
			expect(localStorage.getItem("dev3-panel-collapsed")).toBe("false");
		});
	});

	describe("status dropdown", () => {
		it("opens dropdown with allowed transitions on click", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			await act(async () => {
				renderPanel(makeTask({ status: "in-progress" }));
			});

			await user.click(screen.getByText("Agent is Working"));

			// in-progress can go to all other statuses
			expect(screen.getByText("To Do")).toBeInTheDocument();
			expect(screen.getByText("Completed")).toBeInTheDocument();
			expect(screen.getByText("Cancelled")).toBeInTheDocument();
			expect(screen.getByText("Has Questions")).toBeInTheDocument();
		});

		it("moves task to new status on selection", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const dispatch = vi.fn();
			const task = makeTask({ status: "in-progress" });
			const updatedTask = { ...task, status: "user-questions" as const };
			mockedApi.request.moveTask.mockResolvedValue(updatedTask);

			await act(async () => {
				renderPanel(task, { dispatch });
			});

			await user.click(screen.getByText("Agent is Working"));
			await user.click(screen.getByText("Has Questions"));

			expect(mockedApi.request.moveTask).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				newStatus: "user-questions",
			});
			expect(dispatch).toHaveBeenCalledWith({
				type: "updateTask",
				task: updatedTask,
			});
			expect(mockedTrackEvent).toHaveBeenCalledWith("task_moved", {
				from_status: "in-progress",
				to_status: "user-questions",
			});
		});

		it("retries with force on move failure", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const dispatch = vi.fn();
			const task = makeTask({ status: "in-progress" });
			const updatedTask = { ...task, status: "review-by-user" as const };

			mockedApi.request.moveTask
				.mockRejectedValueOnce(new Error("env broken"))
				.mockResolvedValueOnce(updatedTask);

			await act(async () => {
				renderPanel(task, { dispatch });
			});

			await user.click(screen.getByText("Agent is Working"));
			await user.click(screen.getByText("Your Review"));

			expect(mockedApi.request.moveTask).toHaveBeenCalledTimes(2);
			expect(mockedApi.request.moveTask).toHaveBeenLastCalledWith({
				taskId: "t1",
				projectId: "p1",
				newStatus: "review-by-user",
				force: true,
			});
			expect(dispatch).toHaveBeenCalledWith({
				type: "updateTask",
				task: updatedTask,
			});
		});

		it("shows alert when both move attempts fail", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const task = makeTask({ status: "in-progress" });
			const alertSpy = vi.fn(); window.alert = alertSpy;

			mockedApi.request.moveTask
				.mockRejectedValueOnce(new Error("fail1"))
				.mockRejectedValueOnce(new Error("fail2"));

			await act(async () => {
				renderPanel(task);
			});

			await user.click(screen.getByText("Agent is Working"));
			await user.click(screen.getByText("Your Review"));

			await waitFor(() => expect(alertSpy).toHaveBeenCalled());
			// alertSpy cleanup handled by clearAllMocks
		});

		it("navigates away on completed/cancelled", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const dispatch = vi.fn();
			const navigate = vi.fn();
			const task = makeTask({ status: "in-progress" });
			mockedApi.request.moveTask.mockResolvedValue({ ...task, status: "completed" });

			await act(async () => {
				renderPanel(task, { dispatch, navigate });
			});

			await user.click(screen.getByText("Agent is Working"));
			await user.click(screen.getByText("Completed"));

			expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p1" });
			expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
				type: "updateTask",
				task: expect.objectContaining({ status: "completed", worktreePath: null, branchName: null }),
			}));
		});

		it("sets movedAt when moving to completed via fast-path", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const dispatch = vi.fn();
			const navigate = vi.fn();
			const task = makeTask({ status: "in-progress" });
			mockedApi.request.moveTask.mockResolvedValue({ ...task, status: "completed" });

			await act(async () => {
				renderPanel(task, { dispatch, navigate });
			});

			await user.click(screen.getByText("Agent is Working"));
			await user.click(screen.getByText("Completed"));

			const dispatchedTask = dispatch.mock.calls.find(
				(c: unknown[]) => (c[0] as AppAction).type === "updateTask",
			)?.[0] as { type: string; task: Task } | undefined;
			expect(dispatchedTask).toBeDefined();
			expect(dispatchedTask!.task.movedAt).toBeDefined();
			expect(typeof dispatchedTask!.task.movedAt).toBe("string");
			// movedAt should be a recent ISO timestamp
			const movedAtMs = new Date(dispatchedTask!.task.movedAt!).getTime();
			expect(movedAtMs).toBeGreaterThan(Date.now() - 5000);
		});

		it("sets movedAt when moving to cancelled via fast-path", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const dispatch = vi.fn();
			const navigate = vi.fn();
			const task = makeTask({ status: "in-progress" });
			mockedApi.request.moveTask.mockResolvedValue({ ...task, status: "cancelled" });

			await act(async () => {
				renderPanel(task, { dispatch, navigate });
			});

			await user.click(screen.getByText("Agent is Working"));
			await user.click(screen.getByText("Cancelled"));

			const dispatchedTask = dispatch.mock.calls.find(
				(c: unknown[]) => (c[0] as AppAction).type === "updateTask",
			)?.[0] as { type: string; task: Task } | undefined;
			expect(dispatchedTask).toBeDefined();
			expect(dispatchedTask!.task.movedAt).toBeDefined();
			expect(dispatchedTask!.task.status).toBe("cancelled");
		});

		it("asks for confirmation before completing active task", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedConfirmTaskCompletion.mockResolvedValue(false);
			const task = makeTask({ status: "in-progress" });

			await act(async () => {
				renderPanel(task);
			});

			await user.click(screen.getByText("Agent is Working"));
			await user.click(screen.getByText("Completed"));

			expect(mockedConfirmTaskCompletion).toHaveBeenCalledWith(
				task,
				project,
				"completed",
				expect.any(Function),
			);
			// Move was blocked
			expect(mockedApi.request.moveTask).not.toHaveBeenCalled();
		});
	});

	describe("notes", () => {
		it("adds a note when clicking Add button", async () => {
			localStorage.setItem("dev3-panel-collapsed", "false");
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const dispatch = vi.fn();
			const task = makeTask({ notes: [] });
			const updatedTask = {
				...task,
				notes: [{ id: "n-new", content: "", source: "user" as const, createdAt: "2025-06-15T12:00:00Z", updatedAt: "2025-06-15T12:00:00Z" }],
			};
			mockedApi.request.addTaskNote.mockResolvedValue(updatedTask);

			await act(async () => {
				renderPanel(task, { dispatch });
			});

			await user.click(screen.getByText("+ Add Note"));

			expect(mockedApi.request.addTaskNote).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				content: "",
				source: "user",
			});
			expect(dispatch).toHaveBeenCalledWith({
				type: "updateTask",
				task: updatedTask,
			});
		});

		it("deletes a note when clicking delete button", async () => {
			localStorage.setItem("dev3-panel-collapsed", "false");
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const dispatch = vi.fn();
			const task = makeTask({
				notes: [
					{ id: "n1", content: "Delete me", source: "user", createdAt: "2025-06-15T10:00:00Z", updatedAt: "2025-06-15T10:00:00Z" },
				],
			});
			const updatedTask = { ...task, notes: [] };
			mockedApi.request.deleteTaskNote.mockResolvedValue(updatedTask);

			await act(async () => {
				renderPanel(task, { dispatch });
			});

			// Find delete button by title
			await user.click(screen.getByTitle("Delete note"));

			expect(mockedApi.request.deleteTaskNote).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				noteId: "n1",
			});
			expect(dispatch).toHaveBeenCalledWith({
				type: "updateTask",
				task: updatedTask,
			});
		});

		it("shows alert when add note fails", async () => {
			localStorage.setItem("dev3-panel-collapsed", "false");
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const alertSpy = vi.fn(); window.alert = alertSpy;
			mockedApi.request.addTaskNote.mockRejectedValue(new Error("network error"));

			await act(async () => {
				renderPanel(makeTask({ notes: [] }));
			});

			await user.click(screen.getByText("+ Add Note"));

			await waitFor(() => expect(alertSpy).toHaveBeenCalled());
			// alertSpy cleanup handled by clearAllMocks
		});

		it("shows alert when delete note fails", async () => {
			localStorage.setItem("dev3-panel-collapsed", "false");
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const alertSpy = vi.fn(); window.alert = alertSpy;
			mockedApi.request.deleteTaskNote.mockRejectedValue(new Error("oops"));

			await act(async () => {
				renderPanel(makeTask({
					notes: [
						{ id: "n1", content: "foo", source: "user", createdAt: "2025-06-15T10:00:00Z", updatedAt: "2025-06-15T10:00:00Z" },
					],
				}));
			});

			await user.click(screen.getByTitle("Delete note"));

			await waitFor(() => expect(alertSpy).toHaveBeenCalled());
			// alertSpy cleanup handled by clearAllMocks
		});
	});

	describe("dev server button", () => {
		it("is disabled when project has no devScript", async () => {
			await act(async () => {
				renderPanel(makeTask(), { project: { ...project, devScript: "" } });
			});
			const buttons = screen.getAllByText("Dev Server");
			const btn = buttons[0].closest("button")!;
			expect(btn).toBeDisabled();
		});

		it("is disabled when task is not active", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue(defaultBranchStatus);
			await act(async () => {
				renderPanel(
					makeTask({ status: "todo", worktreePath: null, branchName: null }),
					{ project: { ...project, devScript: "bun run dev" } },
				);
			});
			const buttons = screen.getAllByText("Dev Server");
			const btn = buttons[0].closest("button")!;
			expect(btn).toBeDisabled();
		});

		it("calls runDevServer when clicked and no server is running", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.checkDevServer.mockResolvedValue({ running: false });
			mockedApi.request.runDevServer.mockResolvedValue(undefined);

			await act(async () => {
				renderPanel(makeTask(), { project: { ...project, devScript: "bun run dev" } });
			});

			const buttons = screen.getAllByText("Dev Server");
			const btn = buttons[0].closest("button")!;
			expect(btn).not.toBeDisabled();

			await user.click(btn);

			expect(mockedApi.request.checkDevServer).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
			});
			expect(mockedApi.request.runDevServer).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
			});
		});

		it("shows running menu when dev server is already running", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.checkDevServer.mockResolvedValue({ running: true });

			await act(async () => {
				renderPanel(makeTask(), { project: { ...project, devScript: "bun run dev" } });
			});

			const buttons = screen.getAllByText("Dev Server");
			await user.click(buttons[0].closest("button")!);

			await waitFor(() => expect(screen.getByText("Dev server is already running")).toBeInTheDocument());
			expect(screen.getByText("Restart")).toBeInTheDocument();
			expect(screen.getByText("Stop")).toBeInTheDocument();
			expect(mockedApi.request.runDevServer).not.toHaveBeenCalled();
		});

		it("restarts dev server from running menu", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.checkDevServer.mockResolvedValue({ running: true });
			mockedApi.request.runDevServer.mockResolvedValue(undefined);

			await act(async () => {
				renderPanel(makeTask(), { project: { ...project, devScript: "bun run dev" } });
			});

			const buttons = screen.getAllByText("Dev Server");
			await user.click(buttons[0].closest("button")!);
			await waitFor(() => expect(screen.getByText("Restart")).toBeInTheDocument());

			await user.click(screen.getByText("Restart"));

			await waitFor(() => expect(mockedApi.request.runDevServer).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
			}));
		});

		it("stops dev server from running menu", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.checkDevServer.mockResolvedValue({ running: true });
			mockedApi.request.stopDevServer.mockResolvedValue(undefined);

			await act(async () => {
				renderPanel(makeTask(), { project: { ...project, devScript: "bun run dev" } });
			});

			const buttons = screen.getAllByText("Dev Server");
			await user.click(buttons[0].closest("button")!);
			await waitFor(() => expect(screen.getByText("Stop")).toBeInTheDocument());

			await user.click(screen.getByText("Stop"));

			await waitFor(() => expect(mockedApi.request.stopDevServer).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
			}));
		});

		it("shows alert when dev server fails", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const alertSpy = vi.fn(); window.alert = alertSpy;
			mockedApi.request.checkDevServer.mockResolvedValue({ running: false });
			mockedApi.request.runDevServer.mockRejectedValue(new Error("port busy"));

			await act(async () => {
				renderPanel(makeTask(), { project: { ...project, devScript: "bun run dev" } });
			});

			const buttons = screen.getAllByText("Dev Server");
			await user.click(buttons[0].closest("button")!);

			await waitFor(() => expect(alertSpy).toHaveBeenCalled());
			// alertSpy cleanup handled by clearAllMocks
		});
	});

	describe("branch status display", () => {
		it("shows ahead badge when ahead > 0", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 5,
				behind: 0,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			expect(screen.getAllByText(/5 commits ahead/).length).toBeGreaterThanOrEqual(1);
		});

		it("shows behind badge when behind > 0", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 0,
				behind: 2,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			expect(screen.getAllByText(/2 commits behind/).length).toBeGreaterThanOrEqual(1);
		});

		it("shows both ahead and behind when both > 0", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 3,
				behind: 1,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			expect(screen.getAllByText(/3 ahead/).length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText(/1 behind/).length).toBeGreaterThanOrEqual(1);
		});

		it("shows uncommitted changes badge", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				insertions: 10,
				deletions: 3,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			expect(screen.getAllByText("+10").length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText("−3").length).toBeGreaterThanOrEqual(1);
		});

		it("does not show badges when ahead=0, behind=0", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 0,
				behind: 0,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			expect(screen.queryByText(/commits? ahead/)).not.toBeInTheDocument();
			expect(screen.queryByText(/commits? behind/)).not.toBeInTheDocument();
		});

		it("uses task baseBranch as comparison branch", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 1,
			});

			await act(async () => {
				renderPanel(makeTask({ baseBranch: "develop" }));
			});

			expect(screen.getAllByText(/vs origin\/develop/).length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("git action buttons", () => {
		it("shows git buttons for active task with worktree", async () => {
			await act(async () => {
				renderPanel(makeTask());
			});

			expect(screen.getAllByText("Show Diff").length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText("Uncommitted").length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText("Rebase").length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText("Push").length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText("Merge").length).toBeGreaterThanOrEqual(1);
		});

		it("does not show git buttons for inactive task", async () => {
			await act(async () => {
				renderPanel(makeTask({ status: "todo", worktreePath: null, branchName: null }));
			});

			expect(screen.queryByText("Rebase")).not.toBeInTheDocument();
			expect(screen.queryByText("Push")).not.toBeInTheDocument();
			expect(screen.queryByText("Merge")).not.toBeInTheDocument();
		});

		it("rebase is disabled when not behind", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				behind: 0,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			// Find all Rebase buttons (collapsed + expanded might render different copies)
			const rebaseButtons = screen.getAllByText("Rebase");
			for (const btn of rebaseButtons) {
				expect(btn.closest("button")).toBeDisabled();
			}
		});

		it("push is disabled when not ahead", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 0,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			const pushButtons = screen.getAllByText("Push");
			for (const btn of pushButtons) {
				expect(btn.closest("button")).toBeDisabled();
			}
		});

		it("merge is disabled when behind > 0", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 2,
				behind: 1,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			const mergeButtons = screen.getAllByText("Merge");
			for (const btn of mergeButtons) {
				expect(btn.closest("button")).toBeDisabled();
			}
		});

		it("merge is disabled when ahead = 0", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 0,
				behind: 0,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			const mergeButtons = screen.getAllByText("Merge");
			for (const btn of mergeButtons) {
				expect(btn.closest("button")).toBeDisabled();
			}
		});

		it("calls rebaseTask on rebase click", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				behind: 2,
				canRebase: true,
			});
			mockedApi.request.rebaseTask.mockResolvedValue(undefined);

			await act(async () => {
				renderPanel(makeTask());
			});

			const rebaseButtons = screen.getAllByText("Rebase");
			const enabledBtn = rebaseButtons.find(b => !b.closest("button")!.disabled);
			expect(enabledBtn).toBeTruthy();
			await user.click(enabledBtn!.closest("button")!);

			expect(mockedApi.request.rebaseTask).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
			});
		});

		it("calls pushTask on push click", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 3,
			});
			mockedApi.request.pushTask.mockResolvedValue(undefined);

			await act(async () => {
				renderPanel(makeTask());
			});

			const pushButtons = screen.getAllByText("Push");
			const enabledBtn = pushButtons.find(b => !b.closest("button")!.disabled);
			expect(enabledBtn).toBeTruthy();
			await user.click(enabledBtn!.closest("button")!);

			expect(mockedApi.request.pushTask).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
			});
		});

		it("calls mergeTask on merge click", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 2,
				behind: 0,
			});
			mockedApi.request.mergeTask.mockResolvedValue(undefined);

			await act(async () => {
				renderPanel(makeTask());
			});

			const mergeButtons = screen.getAllByText("Merge");
			const enabledBtn = mergeButtons.find(b => !b.closest("button")!.disabled);
			expect(enabledBtn).toBeTruthy();
			await user.click(enabledBtn!.closest("button")!);

			expect(mockedApi.request.mergeTask).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
			});
		});

		it("calls showDiff on Show Diff click", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.showDiff.mockResolvedValue(undefined);

			await act(async () => {
				renderPanel(makeTask());
			});

			const diffButtons = screen.getAllByText("Show Diff");
			const enabledBtn = diffButtons.find(b => !b.closest("button")!.disabled);
			expect(enabledBtn).toBeTruthy();
			await user.click(enabledBtn!.closest("button")!);

			expect(mockedApi.request.showDiff).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
			});
		});

		it("calls showUncommittedDiff on Uncommitted click", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				insertions: 5,
				deletions: 2,
			});
			mockedApi.request.showUncommittedDiff.mockResolvedValue(undefined);

			await act(async () => {
				renderPanel(makeTask());
			});

			const uncommittedButtons = screen.getAllByText("Uncommitted");
			const enabledBtn = uncommittedButtons.find(b => !b.closest("button")!.disabled);
			expect(enabledBtn).toBeTruthy();
			await user.click(enabledBtn!.closest("button")!);

			expect(mockedApi.request.showUncommittedDiff).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
			});
		});

		it("uncommitted diff disabled when no uncommitted changes", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				insertions: 0,
				deletions: 0,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			const uncommittedButtons = screen.getAllByText("Uncommitted");
			for (const btn of uncommittedButtons) {
				expect(btn.closest("button")).toBeDisabled();
			}
		});

		it("shows alert on rebase failure", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const alertSpy = vi.fn(); window.alert = alertSpy;
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				behind: 2,
				canRebase: true,
			});
			mockedApi.request.rebaseTask.mockRejectedValue(new Error("conflict"));

			await act(async () => {
				renderPanel(makeTask());
			});

			const rebaseButtons = screen.getAllByText("Rebase");
			const enabledBtn = rebaseButtons.find(b => !b.closest("button")!.disabled);
			await user.click(enabledBtn!.closest("button")!);

			await waitFor(() => expect(alertSpy).toHaveBeenCalled());
			// alertSpy cleanup handled by clearAllMocks
		});

		it("shows alert on push failure", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const alertSpy = vi.fn(); window.alert = alertSpy;
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 1,
			});
			mockedApi.request.pushTask.mockRejectedValue(new Error("no remote"));

			await act(async () => {
				renderPanel(makeTask());
			});

			const pushButtons = screen.getAllByText("Push");
			const enabledBtn = pushButtons.find(b => !b.closest("button")!.disabled);
			await user.click(enabledBtn!.closest("button")!);

			await waitFor(() => expect(alertSpy).toHaveBeenCalled());
			// alertSpy cleanup handled by clearAllMocks
		});

		it("shows alert on merge failure", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const alertSpy = vi.fn(); window.alert = alertSpy;
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 1,
				behind: 0,
			});
			mockedApi.request.mergeTask.mockRejectedValue(new Error("merge error"));

			await act(async () => {
				renderPanel(makeTask());
			});

			const mergeButtons = screen.getAllByText("Merge");
			const enabledBtn = mergeButtons.find(b => !b.closest("button")!.disabled);
			await user.click(enabledBtn!.closest("button")!);

			await waitFor(() => expect(alertSpy).toHaveBeenCalled());
			// alertSpy cleanup handled by clearAllMocks
		});

		it("rebase is disabled when canRebase is false", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				behind: 2,
				canRebase: false,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			const rebaseButtons = screen.getAllByText("Rebase");
			for (const btn of rebaseButtons) {
				expect(btn.closest("button")).toBeDisabled();
			}
		});

		it("shows 'Create PR' when no open PR exists", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 3,
				unpushed: 0,
				prNumber: null,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			const createPRButtons = screen.getAllByText("Create PR");
			expect(createPRButtons.length).toBeGreaterThanOrEqual(1);
			expect(screen.queryByText("Open PR")).not.toBeInTheDocument();
		});

		it("shows PR badge when an open PR exists and hides Create PR button", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 3,
				unpushed: 0,
				prNumber: 42,
				prUrl: "https://github.com/org/repo/pull/42",
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			const badges = screen.getAllByText(/PR #42/);
			expect(badges.length).toBeGreaterThanOrEqual(1);
			expect(screen.queryByText("Create PR")).not.toBeInTheDocument();
		});

		it("shows PR badge even when ahead=0", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 0,
				unpushed: 0,
				prNumber: 99,
				prUrl: "https://github.com/org/repo/pull/99",
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			const badges = screen.getAllByText(/PR #99/);
			expect(badges.length).toBeGreaterThanOrEqual(1);
		});

		it("opens PR URL in new tab when PR badge is clicked", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const openSpy = vi.fn();
			window.open = openSpy;
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 3,
				unpushed: 0,
				prNumber: 42,
				prUrl: "https://github.com/org/repo/pull/42",
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			const badges = screen.getAllByText(/PR #42/);
			const btn = badges[0].closest("button")!;
			await user.click(btn);

			expect(openSpy).toHaveBeenCalledWith("https://github.com/org/repo/pull/42", "_blank");
		});

		it("calls createPullRequest when Create PR is clicked (no existing PR)", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 3,
				unpushed: 0,
				prNumber: null,
			});
			mockedApi.request.createPullRequest.mockResolvedValue(undefined);

			await act(async () => {
				renderPanel(makeTask());
			});

			const createPRButtons = screen.getAllByText("Create PR");
			const enabledBtn = createPRButtons.find(b => !b.closest("button")!.disabled);
			expect(enabledBtn).toBeTruthy();
			await user.click(enabledBtn!.closest("button")!);

			expect(mockedApi.request.createPullRequest).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
			});
		});

		it("shows PR badge tooltip with PR number", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 3,
				unpushed: 0,
				prNumber: 42,
				prUrl: "https://github.com/org/repo/pull/42",
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			const badges = screen.getAllByText(/PR #42/);
			const btn = badges[0].closest("button")!;
			expect(btn.title).toContain("42");
		});

		it("does not open window when prUrl is null", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const openSpy = vi.fn();
			window.open = openSpy;
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 3,
				unpushed: 0,
				prNumber: 42,
				prUrl: null,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			const badges = screen.getAllByText(/PR #42/);
			const btn = badges[0].closest("button")!;
			await user.click(btn);

			expect(openSpy).not.toHaveBeenCalled();
		});
	});

	describe("full screen navigation", () => {
		it("navigates to task screen on click", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const navigate = vi.fn();
			await act(async () => {
				renderPanel(makeTask(), { navigate });
			});

			await user.click(screen.getByTitle("Full screen"));

			expect(navigate).toHaveBeenCalledWith({
				screen: "task",
				projectId: "p1",
				taskId: "t1",
			});
		});

		it("navigates back to project when in full page mode", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const navigate = vi.fn();
			await act(async () => {
				renderPanel(makeTask(), { navigate, isFullPage: true });
			});

			await user.click(screen.getByTitle("Exit full screen"));

			expect(navigate).toHaveBeenCalledWith({
				screen: "project",
				projectId: "p1",
				activeTaskId: "t1",
			});
		});
	});

	describe("branch status polling", () => {
		it("fetches branch status on mount for active tasks", async () => {
			await act(async () => {
				renderPanel(makeTask());
			});

			expect(mockedApi.request.getBranchStatus).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
			});
		});

		it("does not fetch branch status for inactive tasks", async () => {
			await act(async () => {
				renderPanel(makeTask({ status: "todo", worktreePath: null }));
			});

			expect(mockedApi.request.getBranchStatus).not.toHaveBeenCalled();
		});

		it("does not fetch branch status when no worktree path", async () => {
			await act(async () => {
				renderPanel(makeTask({ status: "in-progress", worktreePath: null }));
			});

			expect(mockedApi.request.getBranchStatus).not.toHaveBeenCalled();
		});
	});

	describe("post-merge auto-complete", () => {
		it("sets movedAt when auto-completing after merge", async () => {
			const dispatch = vi.fn();
			const navigate = vi.fn();
			const task = makeTask({ status: "in-progress" });
			mockedApi.request.showConfirm.mockResolvedValue(true);
			mockedApi.request.moveTask.mockResolvedValue({ ...task, status: "completed" });

			await act(async () => {
				renderPanel(task, { dispatch, navigate });
			});

			// Simulate the gitOpCompleted event for a successful merge
			await act(async () => {
				window.dispatchEvent(
					new CustomEvent("rpc:gitOpCompleted", {
						detail: { taskId: "t1", operation: "merge", ok: true },
					}),
				);
			});

			// Wait for the confirm dialog to resolve
			await waitFor(() => {
				expect(mockedApi.request.showConfirm).toHaveBeenCalled();
			});

			await waitFor(() => {
				const updateCall = dispatch.mock.calls.find(
					(c: unknown[]) => (c[0] as AppAction).type === "updateTask"
						&& ((c[0] as { task: Task }).task).status === "completed",
				);
				expect(updateCall).toBeDefined();
				const dispatchedTask = (updateCall![0] as { task: Task }).task;
				expect(dispatchedTask.movedAt).toBeDefined();
				expect(typeof dispatchedTask.movedAt).toBe("string");
				expect(dispatchedTask.worktreePath).toBeNull();
				expect(dispatchedTask.branchName).toBeNull();
			});

			expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p1" });
		});
	});

	describe("inline rename", () => {
		beforeEach(() => {
			localStorage.setItem("dev3-panel-collapsed", "false");
		});

		it("shows task title with edit button in expanded view", async () => {
			await act(async () => {
				renderPanel(makeTask({ title: "My task title" }));
			});
			expect(screen.getByText("My task title")).toBeInTheDocument();
			expect(screen.getByTitle("Edit title")).toBeInTheDocument();
		});

		it("shows customTitle when set", async () => {
			await act(async () => {
				renderPanel(makeTask({ title: "Auto title", customTitle: "Custom name" }));
			});
			expect(screen.getByText("Custom name")).toBeInTheDocument();
		});

		it("opens rename input on pencil click", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			await act(async () => {
				renderPanel(makeTask({ title: "My task" }));
			});
			await user.click(screen.getByTitle("Edit title"));
			const input = screen.getByDisplayValue("My task");
			expect(input).toBeInTheDocument();
		});

		it("saves new title on Enter", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const dispatch = vi.fn();
			const updatedTask = makeTask({ title: "My task", customTitle: "New name" });
			mockedApi.request.renameTask.mockResolvedValue(updatedTask);

			await act(async () => {
				renderPanel(makeTask({ title: "My task" }), { dispatch });
			});
			await user.click(screen.getByTitle("Edit title"));
			const input = screen.getByDisplayValue("My task");
			await user.clear(input);
			await user.type(input, "New name{Enter}");

			await waitFor(() => {
				expect(mockedApi.request.renameTask).toHaveBeenCalledWith({
					taskId: "t1",
					projectId: "p1",
					customTitle: "New name",
				});
			});
			expect(dispatch).toHaveBeenCalledWith({ type: "updateTask", task: updatedTask });
			expect(mockedTrackEvent).toHaveBeenCalledWith("task_renamed", { project_id: "p1" });
		});

		it("cancels rename on cancel button click", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			await act(async () => {
				renderPanel(makeTask({ title: "My task" }));
			});
			await user.click(screen.getByTitle("Edit title"));
			expect(screen.getByDisplayValue("My task")).toBeInTheDocument();

			await user.click(screen.getByTestId("rename-cancel"));
			expect(screen.queryByDisplayValue("My task")).not.toBeInTheDocument();
			expect(screen.getByText("My task")).toBeInTheDocument();
		});

		it("shows reset button when customTitle is set", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			await act(async () => {
				renderPanel(makeTask({ title: "Auto title", customTitle: "Custom name" }));
			});
			await user.click(screen.getByTitle("Edit title"));
			expect(screen.getByText("Reset to auto")).toBeInTheDocument();
		});

		it("does not show reset button when no customTitle", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			await act(async () => {
				renderPanel(makeTask({ title: "Auto title" }));
			});
			await user.click(screen.getByTitle("Edit title"));
			expect(screen.queryByText("Reset to auto")).not.toBeInTheDocument();
		});

		it("resets title to auto-generated", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const dispatch = vi.fn();
			const updatedTask = makeTask({ title: "Auto title", customTitle: null });
			mockedApi.request.renameTask.mockResolvedValue(updatedTask);

			await act(async () => {
				renderPanel(makeTask({ title: "Auto title", customTitle: "Custom name" }), { dispatch });
			});
			await user.click(screen.getByTitle("Edit title"));
			await user.click(screen.getByText("Reset to auto"));

			await waitFor(() => {
				expect(mockedApi.request.renameTask).toHaveBeenCalledWith({
					taskId: "t1",
					projectId: "p1",
					customTitle: null,
				});
			});
			expect(dispatch).toHaveBeenCalledWith({ type: "updateTask", task: updatedTask });
		});

		it("does not save when title is unchanged", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			await act(async () => {
				renderPanel(makeTask({ title: "My task" }));
			});
			await user.click(screen.getByTitle("Edit title"));
			// Press Enter without changing value
			await user.keyboard("{Enter}");
			expect(mockedApi.request.renameTask).not.toHaveBeenCalled();
		});
	});
});
