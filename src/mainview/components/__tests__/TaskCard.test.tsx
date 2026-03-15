import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskCard from "../TaskCard";
import { I18nProvider } from "../../i18n";
import type { CodingAgent, Label, Project, Task, TaskStatus } from "../../../shared/types";
import type { AppAction, Route } from "../../state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			moveTask: vi.fn(),
			moveTaskToCustomColumn: vi.fn(),
			deleteTask: vi.fn(),
			showConfirm: vi.fn(),
			setTaskLabels: vi.fn(),
			getTerminalPreview: vi.fn(),
			getAvailableApps: vi.fn().mockResolvedValue([
				{ id: "finder", name: "Finder", macAppName: "Finder" },
				{ id: "vscode", name: "VS Code", macAppName: "Visual Studio Code" },
			]),
			openInApp: vi.fn().mockResolvedValue(undefined),
		},
	},
}));

vi.mock("../../analytics", () => ({
	trackEvent: vi.fn(),
}));

vi.mock("../../utils/confirmTaskCompletion", () => ({
	confirmTaskCompletion: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../utils/ansi-to-html", () => ({
	ansiToHtml: vi.fn((s: string) => s),
}));

vi.mock("../TaskDetailModal", () => ({
	default: ({ onClose }: { onClose: () => void }) => (
		<div data-testid="task-detail-modal">
			<button onClick={onClose}>Close modal</button>
		</div>
	),
}));

vi.mock("../LabelPicker", () => ({
	default: ({ onClose }: { onClose: () => void }) => (
		<div data-testid="label-picker">
			<button onClick={onClose}>Close picker</button>
		</div>
	),
}));

import { api } from "../../rpc";
import { trackEvent } from "../../analytics";
import { confirmTaskCompletion } from "../../utils/confirmTaskCompletion";
const mockedApi = vi.mocked(api, true);
const mockedTrackEvent = vi.mocked(trackEvent);
const mockedConfirmTaskCompletion = vi.mocked(confirmTaskCompletion);

// ---- Fixtures ----

const claudeAgent: CodingAgent = {
	id: "builtin-claude",
	name: "Claude",
	baseCommand: "claude",
	isDefault: true,
	configurations: [
		{ id: "claude-default", name: "Default", model: "sonnet" },
		{ id: "claude-plan", name: "Plan (Opus)", model: "opus" },
	],
	defaultConfigId: "claude-default",
};

const codexAgent: CodingAgent = {
	id: "builtin-codex",
	name: "Codex",
	baseCommand: "codex",
	isDefault: true,
	configurations: [{ id: "codex-default", name: "Default" }],
	defaultConfigId: "codex-default",
};

const agents = [claudeAgent, codexAgent];

const testLabel: Label = { id: "lbl-1", name: "Bug", color: "#ff0000" };
const testLabel2: Label = { id: "lbl-2", name: "Feature", color: "#00ff00" };

const project: Project = {
	id: "p1",
	name: "Test",
	path: "/tmp/test",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

const projectWithLabels: Project = {
	...project,
	labels: [testLabel, testLabel2],
};

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: "t1",
		seq: 1,
		projectId: "p1",
		title: "My task",
		description: "My task",
		status: "todo",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
		...overrides,
	};
}

function renderCard(
	task: Task,
	opts?: {
		dispatch?: React.Dispatch<AppAction>;
		navigate?: (route: Route) => void;
		onLaunchVariants?: (task: Task, targetStatus: TaskStatus) => void;
		onAddAttempts?: (task: Task) => void;
		onDragStart?: (taskId: string) => void;
		onTaskMoved?: (taskId: string) => void;
		bellCount?: number;
		isActiveInSplit?: boolean;
		isMoving?: boolean;
		projectOverride?: Project;
		prInfo?: { number: number; url: string };
	},
) {
	return render(
		<I18nProvider>
			<TaskCard
				task={task}
				project={opts?.projectOverride ?? project}
				dispatch={opts?.dispatch ?? vi.fn()}
				navigate={opts?.navigate ?? vi.fn()}
				agents={agents}
				onLaunchVariants={opts?.onLaunchVariants ?? vi.fn()}
				onAddAttempts={opts?.onAddAttempts ?? vi.fn()}
				onDragStart={opts?.onDragStart ?? vi.fn()}
				onTaskMoved={opts?.onTaskMoved ?? vi.fn()}
				bellCount={opts?.bellCount}
				isActiveInSplit={opts?.isActiveInSplit}
				isMoving={opts?.isMoving}
				prInfo={opts?.prInfo}
			/>
		</I18nProvider>,
	);
}

describe("TaskCard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedConfirmTaskCompletion.mockResolvedValue(true);
		// happy-dom doesn't define window.alert
		window.alert = vi.fn();
	});

	describe("variant badge", () => {
		it("shows seq badge for non-variant tasks", () => {
			renderCard(makeTask({ seq: 7 }));
			expect(screen.getByText("#7")).toBeInTheDocument();
		});

		it("shows badge with seq, attempt, agent name and config for variant task", () => {
			renderCard(makeTask({
				seq: 5,
				status: "in-progress",
				worktreePath: "/tmp/wt",
				branchName: "dev3/test",
				variantIndex: 1,
				agentId: "builtin-claude",
				configId: "claude-default",
				groupId: "g1",
			}));
			expect(screen.getByText("#5 · Attempt 1 · Claude (Default · sonnet)")).toBeInTheDocument();
		});

		it("shows badge with config name without model", () => {
			renderCard(makeTask({
				seq: 5,
				status: "in-progress",
				worktreePath: "/tmp/wt",
				branchName: "dev3/test",
				variantIndex: 2,
				agentId: "builtin-codex",
				configId: "codex-default",
				groupId: "g1",
			}));
			expect(screen.getByText("#5 · Attempt 2 · Codex (Default)")).toBeInTheDocument();
		});

		it("shows seq and attempt when agent not found", () => {
			renderCard(makeTask({
				seq: 5,
				status: "in-progress",
				worktreePath: "/tmp/wt",
				branchName: "dev3/test",
				variantIndex: 3,
				agentId: "nonexistent",
				configId: "whatever",
				groupId: "g1",
			}));
			expect(screen.getByText("#5 · Attempt 3")).toBeInTheDocument();
		});

		it("shows agent name without config when configId does not match", () => {
			renderCard(makeTask({
				seq: 5,
				status: "in-progress",
				worktreePath: "/tmp/wt",
				branchName: "dev3/test",
				variantIndex: 1,
				agentId: "builtin-claude",
				configId: "nonexistent-config",
				groupId: "g1",
			}));
			// configId is truthy but doesn't match any config → config is undefined
			expect(screen.getByText("#5 · Attempt 1 · Claude")).toBeInTheDocument();
		});

		it("falls back to first config when no defaultConfigId and configId missing", () => {
			const agentNoDefault: CodingAgent = {
				id: "custom-agent",
				name: "Custom",
				baseCommand: "custom",
				isDefault: false,
				configurations: [{ id: "c1", name: "First", model: "fast" }],
				defaultConfigId: "",
			};
			render(
				<I18nProvider>
					<TaskCard
						task={makeTask({
							seq: 2,
							status: "in-progress",
							worktreePath: "/tmp/wt",
							branchName: "dev3/test",
							variantIndex: 1,
							agentId: "custom-agent",
							groupId: "g1",
						})}
						project={project}
						dispatch={vi.fn()}
						navigate={vi.fn()}
						agents={[agentNoDefault]}
						onLaunchVariants={vi.fn()}
						onAddAttempts={vi.fn()}
						onDragStart={vi.fn()}
						onTaskMoved={vi.fn()}
					/>
				</I18nProvider>,
			);
			expect(screen.getByText("#2 · Attempt 1 · Custom (First · fast)")).toBeInTheDocument();
		});
	});

	describe("todo card", () => {
		it("shows Run button and status dropdown", () => {
			renderCard(makeTask({ status: "todo" }));

			expect(screen.getByTitle("Run")).toBeInTheDocument();
			expect(screen.getByText("Run")).toBeInTheDocument();
			expect(screen.getByText("To Do")).toBeInTheDocument();
		});

		it("Run button triggers onLaunchVariants with in-progress", async () => {
			const user = userEvent.setup();
			const onLaunchVariants = vi.fn();
			const task = makeTask({ status: "todo" });
			renderCard(task, { onLaunchVariants });

			await user.click(screen.getByTitle("Run"));

			expect(onLaunchVariants).toHaveBeenCalledWith(task, "in-progress");
			expect(mockedApi.request.moveTask).not.toHaveBeenCalled();
		});

		it("+ Variant button triggers onAddAttempts for active tasks", async () => {
			const user = userEvent.setup();
			const onAddAttempts = vi.fn();
			const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "feat/test" });
			renderCard(task, { onAddAttempts });

			await user.click(screen.getByTitle("+ Variant"));

			expect(onAddAttempts).toHaveBeenCalledWith(task);
		});

		it("X button asks for confirmation before cancelling", async () => {
			const user = userEvent.setup();
			const task = makeTask({ status: "todo" });
			mockedApi.request.showConfirm.mockResolvedValue(false);

			renderCard(task);

			await user.click(screen.getByTitle("Cancel"));

			expect(mockedApi.request.showConfirm).toHaveBeenCalled();
			expect(mockedApi.request.moveTask).not.toHaveBeenCalled();
		});

		it("X button moves to cancelled when confirmed", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();
			const task = makeTask({ status: "todo" });
			mockedApi.request.showConfirm.mockResolvedValue(true);
			mockedApi.request.moveTask.mockResolvedValue({ ...task, status: "cancelled" });

			renderCard(task, { dispatch });

			await user.click(screen.getByTitle("Cancel"));

			expect(mockedApi.request.moveTask).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				newStatus: "cancelled",
			});
		});

		it("status dropdown opens with In Progress and Cancelled", async () => {
			const user = userEvent.setup();
			renderCard(makeTask({ status: "todo" }));

			await user.click(screen.getByText("To Do"));

			expect(screen.getByText("Agent is Working")).toBeInTheDocument();
			expect(screen.getByText("Cancelled")).toBeInTheDocument();
		});

		it("In Progress in dropdown triggers onLaunchVariants", async () => {
			const user = userEvent.setup();
			const onLaunchVariants = vi.fn();
			const task = makeTask({ status: "todo" });
			renderCard(task, { onLaunchVariants });

			await user.click(screen.getByText("To Do"));
			await user.click(screen.getByText("Agent is Working"));

			expect(onLaunchVariants).toHaveBeenCalledWith(task, "in-progress");
		});
	});

	describe("cancelled card", () => {
		it("X button asks for confirmation before deleting", async () => {
			const user = userEvent.setup();
			const task = makeTask({ status: "cancelled" });
			mockedApi.request.showConfirm.mockResolvedValue(false);

			renderCard(task);

			await user.click(screen.getByTitle("Delete"));

			expect(mockedApi.request.showConfirm).toHaveBeenCalled();
			expect(mockedApi.request.deleteTask).not.toHaveBeenCalled();
		});

		it("X button deletes task when confirmed", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();
			const task = makeTask({ status: "cancelled" });
			mockedApi.request.showConfirm.mockResolvedValue(true);
			mockedApi.request.deleteTask.mockResolvedValue(undefined);

			renderCard(task, { dispatch });

			await user.click(screen.getByTitle("Delete"));

			expect(mockedApi.request.deleteTask).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
			});
			await waitFor(() => {
				expect(dispatch).toHaveBeenCalledWith({ type: "removeTask", taskId: "t1" });
			});
		});

		it("shows delete option in status dropdown menu", async () => {
			const user = userEvent.setup();
			renderCard(makeTask({ status: "cancelled" }));

			await user.click(screen.getByText("Cancelled"));

			expect(screen.getByText("Delete")).toBeInTheDocument();
		});
	});

	describe("non-todo status menu", () => {
		it("in-progress task has clickable status that opens menu", async () => {
			const user = userEvent.setup();
			renderCard(makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test" }));

			await user.click(screen.getByText("Agent is Working"));

			expect(screen.getByText("To Do")).toBeInTheDocument();
			expect(screen.getByText("Completed")).toBeInTheDocument();
			expect(screen.getByText("Cancelled")).toBeInTheDocument();
			expect(screen.getByText("Has Questions")).toBeInTheDocument();
		});

		it("in-progress task does not show Run button", () => {
			renderCard(makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test" }));

			expect(screen.queryByTitle("Run")).not.toBeInTheDocument();
		});

		it("menu closes on second click of status trigger", async () => {
			const user = userEvent.setup();
			renderCard(makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test" }));

			// Click the status trigger button (first match — the card's status button)
			await user.click(screen.getAllByText("Agent is Working")[0]);
			expect(screen.getByText("Move to")).toBeInTheDocument();

			// Click the trigger again to close — it's still the first match
			await user.click(screen.getAllByText("Agent is Working")[0]);
			expect(screen.queryByText("Move to")).not.toBeInTheDocument();
		});
	});

	describe("click behavior", () => {
		it("clicking active task navigates to split view", async () => {
			const user = userEvent.setup();
			const navigate = vi.fn();
			const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test" });
			renderCard(task, { navigate });

			await user.click(screen.getByText("My task"));

			expect(navigate).toHaveBeenCalledWith({
				screen: "project",
				projectId: "p1",
				activeTaskId: "t1",
			});
		});

		it("clicking active task in split toggles it off", async () => {
			const user = userEvent.setup();
			const navigate = vi.fn();
			const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test" });
			renderCard(task, { navigate, isActiveInSplit: true });

			await user.click(screen.getByText("My task"));

			expect(navigate).toHaveBeenCalledWith({
				screen: "project",
				projectId: "p1",
			});
		});

		it("clicking todo task does not navigate", async () => {
			const user = userEvent.setup();
			const navigate = vi.fn();
			const task = makeTask({ status: "todo" });
			renderCard(task, { navigate });

			// Click the card background (not title or buttons)
			const card = screen.getByText("My task").closest("[draggable]")!;
			await user.click(card);

			expect(navigate).not.toHaveBeenCalled();
		});

		it("clicking completed task opens detail modal", async () => {
			const user = userEvent.setup();
			const navigate = vi.fn();
			const task = makeTask({ status: "completed" });
			renderCard(task, { navigate });

			const card = screen.getByText("My task").closest("[draggable]")!;
			await user.click(card);

			expect(navigate).not.toHaveBeenCalled();
			expect(screen.getByTestId("task-detail-modal")).toBeInTheDocument();
		});

		it("clicking cancelled task opens detail modal", async () => {
			const user = userEvent.setup();
			const navigate = vi.fn();
			const task = makeTask({ status: "cancelled" });
			renderCard(task, { navigate });

			const card = screen.getByText("My task").closest("[draggable]")!;
			await user.click(card);

			expect(navigate).not.toHaveBeenCalled();
			expect(screen.getByTestId("task-detail-modal")).toBeInTheDocument();
		});

		it("clicking active task while moving does not navigate", async () => {
			const user = userEvent.setup();
			const navigate = vi.fn();
			const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test" });
			renderCard(task, { navigate, isMoving: true });

			const card = screen.getByText("My task").closest("[draggable]")!;
			await user.click(card);

			expect(navigate).not.toHaveBeenCalled();
		});

		it("clicking completed task while moving does not open detail", async () => {
			const user = userEvent.setup();
			const navigate = vi.fn();
			const task = makeTask({ status: "completed" });
			renderCard(task, { navigate, isMoving: true });

			const card = screen.getByText("My task").closest("[draggable]")!;
			await user.click(card);

			expect(navigate).not.toHaveBeenCalled();
			expect(screen.queryByTestId("task-detail-modal")).not.toBeInTheDocument();
		});
	});

	describe("drag and drop", () => {
		it("calls onDragStart with task id and sets dataTransfer data", () => {
			const onDragStart = vi.fn();
			const task = makeTask({ status: "todo" });
			renderCard(task, { onDragStart });

			const card = screen.getByText("My task").closest("[draggable]")!;
			const mockDataTransfer = {
				setData: vi.fn(),
				effectAllowed: "",
			};
			fireEvent.dragStart(card, { dataTransfer: mockDataTransfer });

			expect(onDragStart).toHaveBeenCalledWith("t1");
			expect(mockDataTransfer.setData).toHaveBeenCalledWith("text/plain", "t1");
		});

		it("closes terminal preview when drag starts", async () => {
			vi.useFakeTimers();
			const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test" });
			mockedApi.request.getTerminalPreview.mockResolvedValue("$ hello");

			await act(async () => {
				renderCard(task);
			});

			const card = screen.getByText("My task").closest("[draggable]")!;

			// Trigger hover to open preview
			await act(async () => {
				fireEvent.mouseEnter(card);
				// Advance past the 400ms hover delay
				await vi.advanceTimersByTimeAsync(500);
			});

			// Preview should be open
			expect(mockedApi.request.getTerminalPreview).toHaveBeenCalled();

			// Start dragging — preview should close
			const mockDataTransfer = { setData: vi.fn(), effectAllowed: "" };
			await act(async () => {
				fireEvent.dragStart(card, { dataTransfer: mockDataTransfer });
			});

			// Preview portal should be gone
			expect(screen.queryByText("$ hello")).not.toBeInTheDocument();

			vi.useRealTimers();
		});
	});

	describe("title click and detail modal", () => {
		it("clicking title on todo task opens detail modal", async () => {
			const user = userEvent.setup();
			renderCard(makeTask({ status: "todo" }));

			await user.click(screen.getByText("My task"));

			expect(screen.getByTestId("task-detail-modal")).toBeInTheDocument();
		});

		it("closing detail modal removes it", async () => {
			const user = userEvent.setup();
			renderCard(makeTask({ status: "todo" }));

			await user.click(screen.getByText("My task"));
			expect(screen.getByTestId("task-detail-modal")).toBeInTheDocument();

			await user.click(screen.getByText("Close modal"));
			expect(screen.queryByTestId("task-detail-modal")).not.toBeInTheDocument();
		});
	});

	describe("show description button", () => {
		it("shows description button for non-todo task with long description", () => {
			renderCard(makeTask({
				status: "in-progress",
				worktreePath: "/tmp/wt",
				branchName: "dev3/test",
				title: "Short title",
				description: "This is a much longer description that differs from title",
			}));

			expect(screen.getByText("Show full description")).toBeInTheDocument();
		});

		it("does not show description button when title equals description", () => {
			renderCard(makeTask({
				status: "in-progress",
				worktreePath: "/tmp/wt",
				branchName: "dev3/test",
				title: "Same",
				description: "Same",
			}));

			expect(screen.queryByText("Show full description")).not.toBeInTheDocument();
		});

		it("does not show description button for todo tasks even with long description", () => {
			renderCard(makeTask({
				status: "todo",
				title: "Short title",
				description: "This is a much longer description that differs from title",
			}));

			expect(screen.queryByText("Show full description")).not.toBeInTheDocument();
		});

		it("clicking description button opens detail modal", async () => {
			const user = userEvent.setup();
			renderCard(makeTask({
				status: "in-progress",
				worktreePath: "/tmp/wt",
				branchName: "dev3/test",
				title: "Short title",
				description: "Long description different from title",
			}));

			await user.click(screen.getByText("Show full description"));

			expect(screen.getByTestId("task-detail-modal")).toBeInTheDocument();
		});
	});

	describe("bell badge", () => {
		it("shows bell badge when bellCount > 0", () => {
			renderCard(makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test" }), {
				bellCount: 3,
			});

			expect(screen.getByText("3")).toBeInTheDocument();
		});

		it("shows 9+ when bellCount > 9", () => {
			renderCard(makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test" }), {
				bellCount: 15,
			});

			expect(screen.getByText("9+")).toBeInTheDocument();
		});

		it("does not show bell badge when bellCount is 0", () => {
			renderCard(makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test" }), {
				bellCount: 0,
			});

			expect(screen.queryByText("9+")).not.toBeInTheDocument();
		});

		it("does not show bell badge when bellCount not provided", () => {
			renderCard(makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test" }));

			// No bell badge container should exist
			expect(screen.queryByTitle("Terminal bell")).not.toBeInTheDocument();
		});
	});

	describe("dismiss button visibility", () => {
		it("shows dismiss button for todo tasks", () => {
			renderCard(makeTask({ status: "todo" }));
			expect(screen.getByTitle("Cancel")).toBeInTheDocument();
		});

		it("shows dismiss button for cancelled tasks", () => {
			renderCard(makeTask({ status: "cancelled" }));
			expect(screen.getByTitle("Delete")).toBeInTheDocument();
		});

		it("does not show dismiss button for in-progress tasks", () => {
			renderCard(makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test" }));
			expect(screen.queryByTitle("Cancel")).not.toBeInTheDocument();
			expect(screen.queryByTitle("Delete")).not.toBeInTheDocument();
		});

		it("does not show dismiss button for completed tasks", () => {
			renderCard(makeTask({ status: "completed" }));
			expect(screen.queryByTitle("Cancel")).not.toBeInTheDocument();
			expect(screen.queryByTitle("Delete")).not.toBeInTheDocument();
		});
	});

	describe("handleMove — actual status transitions", () => {
		it("moves in-progress task to completed and dispatches updateTask", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();
			const onTaskMoved = vi.fn();
			const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test" });
			const updated = { ...task, status: "completed" as TaskStatus };
			mockedApi.request.moveTask.mockResolvedValue(updated);

			renderCard(task, { dispatch, onTaskMoved });

			await user.click(screen.getByText("Agent is Working"));
			await user.click(screen.getByText("Completed"));

			await waitFor(() => {
				expect(mockedConfirmTaskCompletion).toHaveBeenCalled();
			});

			await waitFor(() => {
				expect(mockedApi.request.moveTask).toHaveBeenCalledWith({
					taskId: "t1",
					projectId: "p1",
					newStatus: "completed",
				});
			});

			await waitFor(() => {
				expect(dispatch).toHaveBeenCalledWith({ type: "updateTask", task: updated });
				expect(onTaskMoved).toHaveBeenCalledWith("t1");
				expect(mockedTrackEvent).toHaveBeenCalledWith("task_moved", {
					from_status: "in-progress",
					to_status: "completed",
				});
			});
		});

		it("aborts move when confirmTaskCompletion returns false", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();
			const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test" });
			mockedConfirmTaskCompletion.mockResolvedValue(false);

			renderCard(task, { dispatch });

			await user.click(screen.getByText("Agent is Working"));
			await user.click(screen.getByText("Cancelled"));

			await waitFor(() => {
				expect(mockedConfirmTaskCompletion).toHaveBeenCalled();
			});

			expect(mockedApi.request.moveTask).not.toHaveBeenCalled();
			expect(dispatch).not.toHaveBeenCalled();
		});

		it("retries with force when first moveTask fails", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();
			const onTaskMoved = vi.fn();
			const task = makeTask({ status: "user-questions", worktreePath: "/tmp/wt", branchName: "dev3/test" });
			const updated = { ...task, status: "in-progress" as TaskStatus };

			mockedApi.request.moveTask
				.mockRejectedValueOnce(new Error("env broken"))
				.mockResolvedValueOnce(updated);

			renderCard(task, { dispatch, onTaskMoved });

			await user.click(screen.getByText("Has Questions"));
			await user.click(screen.getByText("Agent is Working"));

			await waitFor(() => {
				expect(mockedApi.request.moveTask).toHaveBeenCalledTimes(2);
			});

			expect(mockedApi.request.moveTask).toHaveBeenNthCalledWith(1, {
				taskId: "t1",
				projectId: "p1",
				newStatus: "in-progress",
			});
			expect(mockedApi.request.moveTask).toHaveBeenNthCalledWith(2, {
				taskId: "t1",
				projectId: "p1",
				newStatus: "in-progress",
				force: true,
			});
			expect(dispatch).toHaveBeenCalledWith({ type: "updateTask", task: updated });
			expect(onTaskMoved).toHaveBeenCalledWith("t1");
		});

		it("alerts when both normal and force retry fail", async () => {
			const user = userEvent.setup();
			const task = makeTask({ status: "user-questions", worktreePath: "/tmp/wt", branchName: "dev3/test" });

			mockedApi.request.moveTask
				.mockRejectedValueOnce(new Error("first"))
				.mockRejectedValueOnce(new Error("second"));

			renderCard(task);

			await user.click(screen.getByText("Has Questions"));
			await user.click(screen.getByText("Agent is Working"));

			await waitFor(() => {
				expect(window.alert).toHaveBeenCalledWith(expect.stringContaining("second"));
			});
		});

		it("tracks task_moved event after successful move", async () => {
			const user = userEvent.setup();
			const task = makeTask({ status: "todo" });
			const updated = { ...task, status: "cancelled" as TaskStatus };
			mockedApi.request.showConfirm.mockResolvedValue(true);
			mockedApi.request.moveTask.mockResolvedValue(updated);

			renderCard(task);

			await user.click(screen.getByTitle("Cancel"));

			await waitFor(() => {
				expect(mockedTrackEvent).toHaveBeenCalledWith("task_moved", {
					from_status: "todo",
					to_status: "cancelled",
				});
			});
		});
	});

	describe("handleDelete — dispatch", () => {
		it("dispatches removeTask and tracks event after successful delete", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();
			const task = makeTask({ status: "cancelled" });
			mockedApi.request.showConfirm.mockResolvedValue(true);
			mockedApi.request.deleteTask.mockResolvedValue(undefined);

			renderCard(task, { dispatch });

			await user.click(screen.getByTitle("Delete"));

			await waitFor(() => {
				expect(dispatch).toHaveBeenCalledWith({ type: "removeTask", taskId: "t1" });
				expect(mockedTrackEvent).toHaveBeenCalledWith("task_deleted", { project_id: "p1" });
			});
		});

		it("alerts when delete fails", async () => {
			const user = userEvent.setup();
			const task = makeTask({ status: "cancelled" });
			mockedApi.request.showConfirm.mockResolvedValue(true);
			mockedApi.request.deleteTask.mockRejectedValue(new Error("delete failed"));

			renderCard(task);

			await user.click(screen.getByTitle("Delete"));

			await waitFor(() => {
				expect(window.alert).toHaveBeenCalledWith(expect.stringContaining("delete failed"));
			});
		});
	});

	describe("label chips", () => {
		it("renders assigned labels", () => {
			const task = makeTask({ labelIds: ["lbl-1"] });
			renderCard(task, { projectOverride: projectWithLabels });

			expect(screen.getByText("Bug")).toBeInTheDocument();
		});

		it("renders multiple labels", () => {
			const task = makeTask({ labelIds: ["lbl-1", "lbl-2"] });
			renderCard(task, { projectOverride: projectWithLabels });

			expect(screen.getByText("Bug")).toBeInTheDocument();
			expect(screen.getByText("Feature")).toBeInTheDocument();
		});

		it("shows add label button", () => {
			renderCard(makeTask(), { projectOverride: projectWithLabels });

			expect(screen.getByText("Add label")).toBeInTheDocument();
		});

		it("clicking add label opens label picker", async () => {
			const user = userEvent.setup();
			renderCard(makeTask(), { projectOverride: projectWithLabels });

			await user.click(screen.getByText("Add label"));

			expect(screen.getByTestId("label-picker")).toBeInTheDocument();
		});

		it("removes label via API and dispatches update", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();
			const task = makeTask({ labelIds: ["lbl-1", "lbl-2"] });
			const updated = { ...task, labelIds: ["lbl-2"] };
			mockedApi.request.setTaskLabels.mockResolvedValue(updated);

			renderCard(task, { dispatch, projectOverride: projectWithLabels });

			await user.click(screen.getByTitle("Remove Bug"));

			await waitFor(() => {
				expect(mockedApi.request.setTaskLabels).toHaveBeenCalledWith({
					taskId: "t1",
					projectId: "p1",
					labelIds: ["lbl-2"],
				});
				expect(dispatch).toHaveBeenCalledWith({ type: "updateTask", task: updated });
			});
		});

		it("ignores unknown label IDs gracefully", () => {
			const task = makeTask({ labelIds: ["unknown-id"] });
			renderCard(task, { projectOverride: projectWithLabels });

			// Should not crash, no label chips rendered for unknown IDs
			expect(screen.queryByText("Bug")).not.toBeInTheDocument();
		});
	});

	describe("isActiveInSplit styling", () => {
		it("applies accent border/ring classes when isActiveInSplit is true", () => {
			const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test" });
			renderCard(task, { isActiveInSplit: true });

			const card = screen.getByText("My task").closest("[draggable]")!;
			expect(card.className).toContain("border-accent/50");
			expect(card.className).toContain("ring-2");
		});

		it("does not apply accent styling when isActiveInSplit is false", () => {
			const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test" });
			renderCard(task, { isActiveInSplit: false });

			const card = screen.getByText("My task").closest("[draggable]")!;
			expect(card.className).not.toContain("border-accent/50");
			expect(card.className).not.toContain("ring-2");
		});
	});

	describe("card draggability", () => {
		it("card is draggable by default", () => {
			renderCard(makeTask({ status: "todo" }));
			const card = screen.getByText("My task").closest("[draggable]")!;
			expect(card.getAttribute("draggable")).toBe("true");
		});
	});

	describe("menu close on outside click", () => {
		it("closes menu when clicking outside", async () => {
			const user = userEvent.setup();
			renderCard(makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test" }));

			await user.click(screen.getByText("Agent is Working"));
			expect(screen.getByText("Move to")).toBeInTheDocument();

			// Click outside the menu
			await user.click(document.body);

			await waitFor(() => {
				expect(screen.queryByText("Move to")).not.toBeInTheDocument();
			});
		});
	});

	describe("cancelled card — delete via dropdown", () => {
		it("delete button in dropdown menu triggers deletion", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();
			const task = makeTask({ status: "cancelled" });
			mockedApi.request.showConfirm.mockResolvedValue(true);
			mockedApi.request.deleteTask.mockResolvedValue(undefined);

			renderCard(task, { dispatch });

			// Open status dropdown
			await user.click(screen.getByText("Cancelled"));

			// Click "Delete" in the dropdown — it's the button with danger text styling
			const allDeleteBtns = screen.getAllByText("Delete");
			// The dropdown Delete button is the one inside the menu (not the dismiss X)
			const dropdownDelete = allDeleteBtns.find(
				(el) => el.closest("[class*='border-t']") !== null,
			)!;
			await user.click(dropdownDelete);

			await waitFor(() => {
				expect(mockedApi.request.showConfirm).toHaveBeenCalled();
			});

			await waitFor(() => {
				expect(mockedApi.request.deleteTask).toHaveBeenCalledWith({
					taskId: "t1",
					projectId: "p1",
				});
			});
		});
	});

	describe("context menu (Open in...)", () => {
		it("shows context menu on right-click for active task with worktree", async () => {
			renderCard(makeTask({
				status: "in-progress",
				worktreePath: "/tmp/worktree",
				branchName: "dev3/test",
			}));
			const card = screen.getByText("My task").closest("[draggable]")!;
			fireEvent.contextMenu(card, { clientX: 100, clientY: 200 });

			await waitFor(() => {
				expect(screen.getByText("Open in...")).toBeInTheDocument();
			});
		});

		it("does not show context menu for todo task without worktree", () => {
			renderCard(makeTask({ status: "todo", worktreePath: null }));
			const card = screen.getByText("My task").closest("[draggable]")!;
			fireEvent.contextMenu(card, { clientX: 100, clientY: 200 });
			expect(screen.queryByText("Open in...")).not.toBeInTheDocument();
		});

		it("calls openInApp when clicking an app in the context menu", async () => {
			renderCard(makeTask({
				status: "in-progress",
				worktreePath: "/tmp/worktree",
				branchName: "dev3/test",
			}));
			const card = screen.getByText("My task").closest("[draggable]")!;
			fireEvent.contextMenu(card, { clientX: 100, clientY: 200 });

			await waitFor(() => {
				expect(screen.getByText("Finder")).toBeInTheDocument();
			});

			await userEvent.click(screen.getByText("Finder"));

			await waitFor(() => {
				expect(mockedApi.request.openInApp).toHaveBeenCalledWith({
					appName: "Finder",
					path: "/tmp/worktree",
				});
			});
		});
	});

	describe("custom columns in status dropdown", () => {
		const projectWithCustomColumns: Project = {
			...project,
			customColumns: [
				{ id: "col-1", name: "On Hold", color: "#f59e0b", llmInstruction: "When waiting" },
				{ id: "col-2", name: "Blocked", color: "#ef4444", llmInstruction: "When blocked" },
			],
		};

		it("shows custom columns in the move-to dropdown", async () => {
			const user = userEvent.setup();
			renderCard(
				makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test" }),
				{ projectOverride: projectWithCustomColumns },
			);

			await user.click(screen.getByText("Agent is Working"));

			await waitFor(() => {
				expect(screen.getByText("On Hold")).toBeInTheDocument();
				expect(screen.getByText("Blocked")).toBeInTheDocument();
			});
		});

		it("calls moveTaskToCustomColumn when clicking a custom column", async () => {
			const user = userEvent.setup();
			const updatedTask = makeTask({ status: "in-progress", customColumnId: "col-1" });
			mockedApi.request.moveTaskToCustomColumn.mockResolvedValueOnce(updatedTask);
			const dispatch = vi.fn();

			renderCard(
				makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test" }),
				{ projectOverride: projectWithCustomColumns, dispatch },
			);

			await user.click(screen.getByText("Agent is Working"));

			await waitFor(() => {
				expect(screen.getByText("On Hold")).toBeInTheDocument();
			});

			await user.click(screen.getByText("On Hold"));

			await waitFor(() => {
				expect(mockedApi.request.moveTaskToCustomColumn).toHaveBeenCalledWith({
					taskId: "t1",
					projectId: "p1",
					customColumnId: "col-1",
				});
			});
		});

		it("shows the current custom column as disabled with current marker", async () => {
			const user = userEvent.setup();
			renderCard(
				makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test", customColumnId: "col-1" }),
				{ projectOverride: projectWithCustomColumns },
			);

			// Card status button now shows custom column name instead of built-in status
			await user.click(screen.getByText("On Hold"));

			await waitFor(() => {
				expect(screen.getByText("Blocked")).toBeInTheDocument();
			});
			// Current custom column is shown in dropdown but disabled
			const onHoldButtons = screen.getAllByText("On Hold");
			// One is the card button, others are in the dropdown
			const dropdownOnHold = onHoldButtons.find((el) => {
				const btn = el.closest("button");
				return btn?.disabled;
			});
			expect(dropdownOnHold).toBeTruthy();
		});
	});

	describe("PR badge", () => {
		it("keeps the footer wrap-safe when a PR badge is shown", () => {
			renderCard(makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "feat/test" }), {
				prInfo: { number: 42, url: "https://github.com/test/repo/pull/42" },
			});

			expect(screen.getByTestId("task-card-footer")).toHaveClass("flex-wrap");
			expect(screen.getByRole("button", { name: "Agent is Working" })).toHaveClass("min-w-0");
		});

		it("shows PR badge when prInfo is provided", () => {
			renderCard(makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "feat/test" }), {
				prInfo: { number: 42, url: "https://github.com/test/repo/pull/42" },
			});
			expect(screen.getByText("#42")).toBeInTheDocument();
		});

		it("does not show PR badge when prInfo is undefined", () => {
			renderCard(makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "feat/test" }));
			expect(screen.queryByText(/#\d+.*PR/)).not.toBeInTheDocument();
		});

		it("opens PR URL in new tab on click", async () => {
			const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
			const user = userEvent.setup();
			renderCard(makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "feat/test" }), {
				prInfo: { number: 99, url: "https://github.com/test/repo/pull/99" },
			});
			await user.click(screen.getByText("#99"));
			expect(openSpy).toHaveBeenCalledWith("https://github.com/test/repo/pull/99", "_blank");
			openSpy.mockRestore();
		});

		it("has correct tooltip with PR number", () => {
			renderCard(makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "feat/test" }), {
				prInfo: { number: 123, url: "https://github.com/test/repo/pull/123" },
			});
			const badge = screen.getByText("#123").closest("button");
			expect(badge).toHaveAttribute("title", "Open PR #123");
		});
	});
});
