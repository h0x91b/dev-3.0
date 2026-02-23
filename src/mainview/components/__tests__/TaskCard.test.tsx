import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskCard from "../TaskCard";
import { I18nProvider } from "../../i18n";
import type { CodingAgent, Project, Task, TaskStatus } from "../../../shared/types";
import type { AppAction, Route } from "../../state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			moveTask: vi.fn(),
			deleteTask: vi.fn(),
		},
	},
}));

import { api } from "../../rpc";
const mockedApi = vi.mocked(api);

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

const project: Project = {
	id: "p1",
	name: "Test",
	path: "/tmp/test",
	setupScript: "",
	defaultTmuxCommand: "claude",
	defaultAgentId: "builtin-claude",
	defaultConfigId: "claude-default",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: "t1",
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
		onDragStart?: (taskId: string) => void;
	},
) {
	return render(
		<I18nProvider>
			<TaskCard
				task={task}
				project={project}
				dispatch={opts?.dispatch ?? vi.fn()}
				navigate={opts?.navigate ?? vi.fn()}
				agents={agents}
				onLaunchVariants={opts?.onLaunchVariants ?? vi.fn()}
				onDragStart={opts?.onDragStart ?? vi.fn()}
			/>
		</I18nProvider>,
	);
}

describe("TaskCard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("variant badge", () => {
		it("does not show badge for non-variant tasks", () => {
			renderCard(makeTask());
			expect(screen.queryByText(/#\d/)).not.toBeInTheDocument();
		});

		it("shows badge with agent name and config for variant task", () => {
			renderCard(makeTask({
				variantIndex: 1,
				agentId: "builtin-claude",
				configId: "claude-default",
				groupId: "g1",
			}));
			expect(screen.getByText("#1 · Claude (Default · sonnet)")).toBeInTheDocument();
		});

		it("shows badge with config name without model", () => {
			renderCard(makeTask({
				variantIndex: 2,
				agentId: "builtin-codex",
				configId: "codex-default",
				groupId: "g1",
			}));
			expect(screen.getByText("#2 · Codex (Default)")).toBeInTheDocument();
		});

		it("shows only variant number when agent not found", () => {
			renderCard(makeTask({
				variantIndex: 3,
				agentId: "nonexistent",
				configId: "whatever",
				groupId: "g1",
			}));
			expect(screen.getByText("#3")).toBeInTheDocument();
		});
	});

	describe("todo card action buttons", () => {
		it("shows Run and X buttons for todo tasks", () => {
			renderCard(makeTask({ status: "todo" }));

			expect(screen.getByTitle("Run")).toBeInTheDocument();
			expect(screen.getByTitle("Cancel")).toBeInTheDocument();
		});

		it("does not show status menu for todo tasks", () => {
			renderCard(makeTask({ status: "todo" }));

			// "To Do" text is present as a static badge, not a button
			const todoText = screen.getByText("To Do");
			expect(todoText.tagName).not.toBe("BUTTON");
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

		it("X button moves task to cancelled", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();
			const onLaunchVariants = vi.fn();
			const task = makeTask({ status: "todo" });

			mockedApi.request.moveTask.mockResolvedValue({
				...task,
				status: "cancelled",
			});

			renderCard(task, { dispatch, onLaunchVariants });

			await user.click(screen.getByTitle("Cancel"));

			expect(onLaunchVariants).not.toHaveBeenCalled();
			expect(mockedApi.request.moveTask).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				newStatus: "cancelled",
			});
		});
	});

	describe("non-todo status menu", () => {
		it("in-progress task has clickable status that opens menu", async () => {
			const user = userEvent.setup();
			renderCard(makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test" }));

			await user.click(screen.getByText("In Progress"));

			expect(screen.getByText("To Do")).toBeInTheDocument();
			expect(screen.getByText("Completed")).toBeInTheDocument();
			expect(screen.getByText("Cancelled")).toBeInTheDocument();
			expect(screen.getByText("User Questions")).toBeInTheDocument();
		});

		it("in-progress task does not show Run/Cancel buttons", () => {
			renderCard(makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/test" }));

			expect(screen.queryByTitle("Run")).not.toBeInTheDocument();
			expect(screen.queryByTitle("Cancel")).not.toBeInTheDocument();
		});
	});
});
