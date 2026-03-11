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
			moveTask: vi.fn(),
			checkWorktreeExists: vi.fn(),
		},
	},
	isElectrobun: false,
}));

vi.mock("../../analytics", () => ({
	trackEvent: vi.fn(),
}));

vi.mock("../TerminalView", () => ({
	default: ({ ptyUrl }: { ptyUrl: string }) => (
		<div data-testid="terminal-view">{ptyUrl}</div>
	),
}));

vi.mock("./TaskInfoPanel", () => ({
	default: () => <div data-testid="task-info-panel" />,
}));

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

			expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p1" });
			expect(mockedTrackEvent).toHaveBeenCalledWith("task_moved", {
				from_status: "in-progress",
				to_status: "completed",
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

			expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p1" });
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

			expect(mockedApi.request.moveTask).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				newStatus: "completed",
				force: true,
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
});
