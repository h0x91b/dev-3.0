import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskDetailModal from "../TaskDetailModal";
import { I18nProvider } from "../../i18n";
import type { Project, Task } from "../../../shared/types";
import type { AppAction } from "../../state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			editTask: vi.fn(),
			renameTask: vi.fn(),
			moveTask: vi.fn(),
			moveTaskToCustomColumn: vi.fn(),
			addTaskNote: vi.fn(),
			updateTaskNote: vi.fn(),
			deleteTaskNote: vi.fn(),
		},
	},
}));

vi.mock("../../analytics", () => ({
	trackEvent: vi.fn(),
}));

import { api } from "../../rpc";

const mockedApi = vi.mocked(api, true);

const mockProject: Project = {
	id: "p1",
	name: "Test Project",
	path: "/home/user/test-project",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

function makeTodoTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "t1",
		seq: 42,
		projectId: "p1",
		title: "Auto-generated title",
		description: "Full task description that is longer than the title",
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

function renderModal(task: Task, props: { dispatch?: React.Dispatch<AppAction>; onClose?: () => void } = {}) {
	return render(
		<I18nProvider>
			<TaskDetailModal
				task={task}
				project={mockProject}
				dispatch={props.dispatch ?? vi.fn()}
				onClose={props.onClose ?? vi.fn()}
			/>
		</I18nProvider>,
	);
}

describe("TaskDetailModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("title rename", () => {
		it("shows a visible rename button for todo tasks without requiring hover", () => {
			const task = makeTodoTask();
			renderModal(task);

			const renameBtn = screen.getByTitle("Edit title");
			expect(renameBtn).toBeInTheDocument();
			// The button should NOT have opacity-0 class (should be always visible)
			expect(renameBtn.className).not.toContain("opacity-0");
		});

		it("clicking the title text starts rename", async () => {
			const task = makeTodoTask();
			renderModal(task);
			const user = userEvent.setup();

			// Click the title text itself
			const titleEl = screen.getByText("Auto-generated title");
			await user.click(titleEl);

			// Should enter rename mode — input should appear
			const renameInput = screen.getByRole("textbox");
			expect(renameInput).toBeInTheDocument();
			expect(renameInput).toHaveValue("Auto-generated title");
		});

		it("saves renamed title on Enter", async () => {
			const task = makeTodoTask();
			const dispatch = vi.fn();
			const updatedTask = { ...task, customTitle: "New title" };
			mockedApi.request.renameTask.mockResolvedValue(updatedTask);
			renderModal(task, { dispatch });
			const user = userEvent.setup();

			// Click rename button
			await user.click(screen.getByTitle("Edit title"));

			const input = screen.getByRole("textbox");
			await user.clear(input);
			await user.type(input, "New title");
			await user.keyboard("{Enter}");

			expect(mockedApi.request.renameTask).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				customTitle: "New title",
			});
		});

		it("cancels rename on Escape", async () => {
			const task = makeTodoTask();
			renderModal(task);
			const user = userEvent.setup();

			await user.click(screen.getByTitle("Edit title"));
			expect(screen.getByRole("textbox")).toBeInTheDocument();

			await user.keyboard("{Escape}");
			expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		});
	});

	describe("description edit", () => {
		it("shows edit button for todo tasks", () => {
			const task = makeTodoTask();
			renderModal(task);

			expect(screen.getByText("Edit")).toBeInTheDocument();
		});

		it("does not show edit button for active tasks", () => {
			const task = makeTodoTask({ status: "in-progress", worktreePath: "/tmp/wt" });
			renderModal(task);

			expect(screen.queryByText("Edit")).not.toBeInTheDocument();
		});
	});
});
