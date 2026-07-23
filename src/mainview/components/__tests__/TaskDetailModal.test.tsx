import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskDetailModal from "../TaskDetailModal";
import { I18nProvider } from "../../i18n";
import type { Project, Task, TaskStatus } from "../../../shared/types";
import type { AppAction } from "../../state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			editTask: vi.fn(),
			renameTask: vi.fn(),
			moveTask: vi.fn(),
			moveTaskToCustomColumn: vi.fn(),
			moveTaskToProject: vi.fn(),
			getProjects: vi.fn(),
			addTaskNote: vi.fn(),
			updateTaskNote: vi.fn(),
			deleteTaskNote: vi.fn(),
			deleteTask: vi.fn(),
			setTaskLabels: vi.fn(),
			uploadFileBase64: vi.fn(),
			pasteClipboardImage: vi.fn(),
			readImageBase64: vi.fn(),
		},
	},
}));

vi.mock("../../analytics", () => ({
	trackEvent: vi.fn(),
	agentNameFromId: vi.fn(() => "unknown"),
}));

vi.mock("../../confirm", () => ({
	confirm: vi.fn(() => Promise.resolve(true)),
}));

import { api } from "../../rpc";
import { confirm } from "../../confirm";

const mockedApi = vi.mocked(api, true);
const mockedConfirm = vi.mocked(confirm);

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

function makeFileList(files: File[]): FileList {
	return {
		length: files.length,
		item: (index: number) => files[index] ?? null,
		...Object.fromEntries(files.map((file, index) => [index, file])),
	} as unknown as FileList;
}

function dispatchDrop(target: Element, files: File[]) {
	const event = new MouseEvent("drop", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "dataTransfer", {
		value: {
			files: makeFileList(files),
			dropEffect: "copy" as const,
		},
	});
	act(() => {
		target.dispatchEvent(event);
	});
}

function renderModal(
	task: Task,
	props: {
		dispatch?: React.Dispatch<AppAction>;
		onClose?: () => void;
		onLaunchVariants?: (task: Task, targetStatus: TaskStatus) => void;
	} = {},
) {
	return render(
		<I18nProvider>
			<TaskDetailModal
				task={task}
				project={mockProject}
				dispatch={props.dispatch ?? vi.fn()}
				onClose={props.onClose ?? vi.fn()}
				onLaunchVariants={props.onLaunchVariants ?? vi.fn()}
			/>
		</I18nProvider>,
	);
}

describe("TaskDetailModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("focus trap", () => {
		it("traps focus inside the dialog on open", () => {
			renderModal(makeTodoTask());
			const dialog = screen.getByRole("dialog");
			expect(dialog.contains(document.activeElement)).toBe(true);
		});

		it("traps focus inside the archived dialog on open", () => {
			renderModal(makeTodoTask({ status: "completed" }));
			const dialog = screen.getByRole("dialog");
			expect(dialog.contains(document.activeElement)).toBe(true);
		});
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

		it("uploads an image dropped into the edit textarea and appends the saved path", async () => {
			mockedApi.request.uploadFileBase64.mockResolvedValue({ path: "/tmp/uploaded-drop.png" });
			mockedApi.request.readImageBase64.mockResolvedValue({ dataUrl: "data:image/png;base64,AAAA" });
			const task = makeTodoTask({ description: "original" });
			renderModal(task);
			const user = userEvent.setup();

			await user.click(screen.getByText("Edit"));
			const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
			// Caret at end so the inserted path is appended deterministically.
			textarea.selectionStart = textarea.value.length;
			textarea.selectionEnd = textarea.value.length;
			const file = new File(["abc"], "drop.jpg", { type: "image/jpeg", lastModified: 1711111111111 });

			// The textarea's parent is the drop-zone wrapper carrying the DnD handlers.
			dispatchDrop(textarea.parentElement!, [file]);

			await waitFor(() => {
				expect(mockedApi.request.uploadFileBase64).toHaveBeenCalledWith({
					projectId: "p1",
					base64: "YWJj",
					filename: "drop.jpg",
					mimeType: "image/jpeg",
				});
			});
			await waitFor(() => {
				expect(textarea.value).toBe("original\n/tmp/uploaded-drop.png\n");
			});
		});
	});

	describe("footer actions", () => {
		it("shows the Run button for todo tasks", () => {
			renderModal(makeTodoTask());
			expect(screen.getByRole("button", { name: "Run" })).toBeInTheDocument();
		});

		it("does not show the footer (Run/Delete) for active tasks", () => {
			renderModal(makeTodoTask({ status: "in-progress", worktreePath: "/tmp/wt" }));
			expect(screen.queryByRole("button", { name: "Run" })).not.toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
		});

		it("does not show the footer for archived tasks", () => {
			renderModal(makeTodoTask({ status: "completed" }));
			expect(screen.queryByRole("button", { name: "Run" })).not.toBeInTheDocument();
		});

		it("clicking Run closes the modal and launches the variants flow", async () => {
			const task = makeTodoTask();
			const onClose = vi.fn();
			const onLaunchVariants = vi.fn();
			renderModal(task, { onClose, onLaunchVariants });
			const user = userEvent.setup();

			await user.click(screen.getByRole("button", { name: "Run" }));

			expect(onClose).toHaveBeenCalledTimes(1);
			expect(onLaunchVariants).toHaveBeenCalledWith(task, "in-progress");
		});

		it("clicking Delete confirms, deletes the task and closes", async () => {
			const task = makeTodoTask();
			const dispatch = vi.fn();
			const onClose = vi.fn();
			mockedConfirm.mockResolvedValueOnce(true);
			mockedApi.request.deleteTask.mockResolvedValue(undefined as never);
			renderModal(task, { dispatch, onClose });
			const user = userEvent.setup();

			await user.click(screen.getByRole("button", { name: "Delete" }));

			expect(mockedConfirm).toHaveBeenCalledTimes(1);
			expect(mockedApi.request.deleteTask).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1" });
			expect(dispatch).toHaveBeenCalledWith({ type: "removeTask", taskId: "t1" });
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it("moving to a project calls the RPC, dispatches removal, and closes", async () => {
			const task = makeTodoTask();
			const dispatch = vi.fn();
			const onClose = vi.fn();
			const dest: Project = { ...mockProject, id: "p2", name: "Destination", path: "/home/user/dest" };
			mockedApi.request.getProjects.mockResolvedValue([mockProject, dest]);
			mockedApi.request.moveTaskToProject.mockResolvedValue({ ...task, projectId: "p2" });
			renderModal(task, { dispatch, onClose });
			const user = userEvent.setup();

			await user.click(screen.getByRole("button", { name: "Move to project…" }));
			await user.click(await screen.findByText("Destination"));

			expect(mockedApi.request.moveTaskToProject).toHaveBeenCalledWith({
				taskId: "t1",
				fromProjectId: "p1",
				toProjectId: "p2",
			});
			expect(dispatch).toHaveBeenCalledWith({ type: "removeTask", taskId: "t1" });
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it("does not delete when the confirmation is declined", async () => {
			const task = makeTodoTask();
			const onClose = vi.fn();
			mockedConfirm.mockResolvedValueOnce(false);
			renderModal(task, { onClose });
			const user = userEvent.setup();

			await user.click(screen.getByRole("button", { name: "Delete" }));

			expect(mockedApi.request.deleteTask).not.toHaveBeenCalled();
			expect(onClose).not.toHaveBeenCalled();
		});

		it("removes an assigned label via the chip remove button", async () => {
			const task = makeTodoTask({ labelIds: ["L1"] });
			const project: Project = {
				...mockProject,
				labels: [{ id: "L1", name: "Bug", color: "#ef4444" }],
			};
			const dispatch = vi.fn();
			mockedApi.request.setTaskLabels.mockResolvedValue({ ...task, labelIds: [] });
			const user = userEvent.setup();
			render(
				<I18nProvider>
					<TaskDetailModal
						task={task}
						project={project}
						dispatch={dispatch}
						onClose={vi.fn()}
						onLaunchVariants={vi.fn()}
					/>
				</I18nProvider>,
			);

			await user.click(screen.getByRole("button", { name: /remove/i }));

			expect(mockedApi.request.setTaskLabels).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				labelIds: [],
			});
		});
	});
});
