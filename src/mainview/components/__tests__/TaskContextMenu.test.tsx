import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskContextMenu from "../TaskContextMenu";
import { I18nProvider } from "../../i18n";
import type { Project, Task } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			setTaskLabels: vi.fn(),
			setTaskPriority: vi.fn().mockResolvedValue([]),
			setTaskHidden: vi.fn().mockResolvedValue([]),
			toggleTaskWatch: vi.fn().mockResolvedValue({ id: "t1" }),
			hibernateTask: vi.fn().mockResolvedValue({ task: { id: "t1" }, freedRssBytes: 0 }),
			deleteTask: vi.fn().mockResolvedValue(undefined),
			moveTaskToProject: vi.fn().mockResolvedValue(undefined),
			moveTaskToCustomColumn: vi.fn(),
			getAvailableApps: vi.fn().mockResolvedValue([{ id: "finder", name: "Finder", macAppName: "Finder" }]),
			openInApp: vi.fn().mockResolvedValue(undefined),
		},
	},
}));

vi.mock("../../confirm", () => ({ confirm: vi.fn().mockResolvedValue(true), ConfirmHost: () => null }));
vi.mock("../../analytics", () => ({ trackEvent: vi.fn(), agentNameFromId: vi.fn(() => "unknown") }));
vi.mock("../TaskDetailModal", () => ({
	default: ({ autoRename }: { autoRename?: boolean }) => (
		<div data-testid="task-detail-modal">{autoRename ? "renaming" : "details"}</div>
	),
}));
vi.mock("../LabelPicker", () => ({ default: () => <div data-testid="label-picker" /> }));
vi.mock("../PriorityPicker", () => ({ default: () => <div data-testid="priority-picker" /> }));
vi.mock("../MoveToProjectPicker", () => ({ default: () => <div data-testid="move-project-picker" /> }));

import { api } from "../../rpc";
import { confirm } from "../../confirm";

const mockedApi = vi.mocked(api);

const project: Project = {
	id: "p1",
	name: "Proj",
	path: "/tmp/p1",
	labels: [{ id: "l1", name: "Bug", color: "#ef4444" }],
} as unknown as Project;

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "t1",
		projectId: "p1",
		description: "My task",
		status: "in-progress",
		worktreePath: "/tmp/worktree",
		branchName: "dev3/test",
		createdAt: Date.now(),
		...overrides,
	} as Task;
}

function renderMenu(task: Task = makeTask(), onOpenTask = vi.fn()) {
	const onClose = vi.fn();
	render(
		<I18nProvider>
			<TaskContextMenu
				task={task}
				project={project}
				dispatch={vi.fn()}
				pos={{ x: 40, y: 60 }}
				onClose={onClose}
				onOpenTask={onOpenTask}
				testId="task-menu"
			/>
		</I18nProvider>,
	);
	return { onClose, onOpenTask };
}

describe("TaskContextMenu", () => {
	beforeEach(() => vi.clearAllMocks());

	it("renders nothing while closed", () => {
		render(
			<I18nProvider>
				<TaskContextMenu
					task={makeTask()}
					project={project}
					dispatch={vi.fn()}
					pos={null}
					onClose={vi.fn()}
					onOpenTask={vi.fn()}
					testId="task-menu"
				/>
			</I18nProvider>,
		);
		expect(screen.queryByTestId("task-menu")).not.toBeInTheDocument();
	});

	// The panel registers with the overlay-layer stack on MOUNT, so a panel that
	// merely appears inside an always-mounted host never reaches Escape at all.
	it("closes on Escape", async () => {
		const { onClose } = renderMenu();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalled();
	});

	it("closes on a click outside", async () => {
		const { onClose } = renderMenu();
		fireEvent.mouseDown(document.body);
		expect(onClose).toHaveBeenCalled();
	});

	it("focuses the first row and walks it with the arrow keys", async () => {
		renderMenu();
		const first = screen.getByTestId("task-menu-open");
		await waitFor(() => expect(document.activeElement).toBe(first));
		fireEvent.keyDown(first, { key: "ArrowDown" });
		expect(document.activeElement).toBe(screen.getByTestId("task-menu-details"));
	});

	it("opens the task from the first row", async () => {
		const { onOpenTask } = renderMenu();
		await userEvent.click(screen.getByTestId("task-menu-open"));
		expect(onOpenTask).toHaveBeenCalled();
	});

	it("hands labels to the label picker", async () => {
		renderMenu();
		await userEvent.click(screen.getByTestId("task-menu-labels"));
		expect(await screen.findByTestId("label-picker")).toBeInTheDocument();
	});

	it("opens the detail modal in rename mode", async () => {
		renderMenu();
		await userEvent.click(screen.getByTestId("task-menu-rename"));
		expect(await screen.findByTestId("task-detail-modal")).toHaveTextContent("renaming");
	});

	it("copies the branch name", async () => {
		const writeText = vi.fn();
		vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
		renderMenu();
		await userEvent.click(screen.getByTestId("task-menu-copyBranch"));
		expect(writeText).toHaveBeenCalledWith("dev3/test");
	});

	it("toggles Watch through the RPC", async () => {
		renderMenu(makeTask({ watched: false }));
		await userEvent.click(screen.getByTestId("task-menu-watch"));
		await waitFor(() => {
			expect(mockedApi.request.toggleTaskWatch).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				watched: true,
			});
		});
	});

	it("toggles sidebar visibility through the RPC", async () => {
		renderMenu(makeTask({ hidden: true }));
		await userEvent.click(screen.getByTestId("task-menu-hidden"));
		await waitFor(() => {
			expect(mockedApi.request.setTaskHidden).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				hidden: false,
			});
		});
	});

	it("confirms before deleting", async () => {
		renderMenu();
		await userEvent.click(screen.getByTestId("task-menu-delete"));
		await waitFor(() => expect(confirm).toHaveBeenCalled());
		await waitFor(() => expect(mockedApi.request.deleteTask).toHaveBeenCalled());
	});

	it("keeps session-only actions disabled on a hibernated task", () => {
		renderMenu(makeTask({ hibernated: true }));
		expect(screen.getByTestId("task-menu-hibernate")).toBeDisabled();
	});
});
