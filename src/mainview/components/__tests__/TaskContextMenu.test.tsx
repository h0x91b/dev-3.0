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
			resumeTask: vi.fn().mockResolvedValue("ws://localhost:9999?session=t1"),
			deleteTask: vi.fn().mockResolvedValue(undefined),
			moveTaskToProject: vi.fn().mockResolvedValue(undefined),
			moveTaskToCustomColumn: vi.fn(),
			moveTask: vi.fn(),
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
vi.mock("../LabelPicker", () => ({
	default: () => <div data-testid="label-picker" />,
	LabelPickerPanel: () => <input data-testid="label-picker-panel" />,
}));
vi.mock("../MoveToProjectPicker", () => ({
	default: () => <div data-testid="move-project-picker" />,
	MoveToProjectPanel: () => <div data-testid="move-project-panel" />,
}));

import { api } from "../../rpc";
import { confirm } from "../../confirm";
import { toast } from "../../toast";

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

	it("shows labels beside the row on hover and keeps the menu open", async () => {
		const { onClose } = renderMenu();
		await userEvent.hover(screen.getByTestId("task-menu-labels"));
		const flyout = await screen.findByTestId("task-menu-flyout-labels");
		expect(flyout).toContainElement(screen.getByTestId("label-picker-panel"));
		expect(screen.getByTestId("task-menu")).toContainElement(flyout);
		expect(onClose).not.toHaveBeenCalled();
	});

	it("keeps the flyout open when its row is clicked after the hover", async () => {
		renderMenu();
		await userEvent.click(screen.getByTestId("task-menu-status"));
		expect(await screen.findByTestId("task-menu-flyout-status")).toBeInTheDocument();
	});

	it("closes the flyout when the pointer moves to a plain row", async () => {
		renderMenu();
		await userEvent.hover(screen.getByTestId("task-menu-project"));
		expect(await screen.findByTestId("move-project-panel")).toBeInTheDocument();
		await userEvent.hover(screen.getByTestId("task-menu-rename"));
		await waitFor(() => expect(screen.queryByTestId("task-menu-flyout-project")).not.toBeInTheDocument());
	});

	it("keeps the open flyout when the pointer only crosses another row", async () => {
		renderMenu();
		await userEvent.hover(screen.getByTestId("task-menu-status"));
		await screen.findByTestId("task-menu-flyout-status");
		// On the way down into a tall flyout the pointer passes over the next row.
		await userEvent.hover(screen.getByTestId("task-menu-project"));
		await userEvent.hover(screen.getByTestId("task-menu-flyout-status"));
		await new Promise((r) => setTimeout(r, 300));
		expect(screen.getByTestId("task-menu-flyout-status")).toBeInTheDocument();
		expect(screen.queryByTestId("task-menu-flyout-project")).not.toBeInTheDocument();
	});

	it("does not close the menu on a click inside a flyout", async () => {
		const { onClose } = renderMenu();
		await userEvent.hover(screen.getByTestId("task-menu-labels"));
		fireEvent.mouseDown(await screen.findByTestId("label-picker-panel"));
		expect(onClose).not.toHaveBeenCalled();
	});

	it("opens a flyout from the keyboard and moves focus into it", async () => {
		renderMenu();
		const row = screen.getByTestId("task-menu-status");
		row.focus();
		fireEvent.keyDown(row, { key: "ArrowRight" });
		const flyout = await screen.findByTestId("task-menu-flyout-status");
		await waitFor(() => expect(flyout).toContainElement(document.activeElement as HTMLElement));
		fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
		expect(screen.queryByTestId("task-menu-flyout-status")).not.toBeInTheDocument();
		expect(document.activeElement).toBe(row);
	});

	it("sets priority in one click from the inline levels", async () => {
		const { onClose } = renderMenu(makeTask({ priority: "P3" }));
		expect(screen.getByTestId("task-menu-priority-P3")).toHaveAttribute("aria-checked", "true");
		await userEvent.click(screen.getByTestId("task-menu-priority-P0"));
		await waitFor(() => {
			expect(mockedApi.request.setTaskPriority).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1", priority: "P0" });
		});
		expect(onClose).toHaveBeenCalled();
	});

	it("sends nothing when the current priority is clicked again", async () => {
		const { onClose } = renderMenu(makeTask({ priority: "P2" }));
		await userEvent.click(screen.getByTestId("task-menu-priority-P2"));
		expect(mockedApi.request.setTaskPriority).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
	});

	it("walks the priority levels with left and right", async () => {
		renderMenu(makeTask({ priority: "P3" }));
		const currentLevel = screen.getByTestId("task-menu-priority-P3");
		currentLevel.focus();
		fireEvent.keyDown(currentLevel, { key: "ArrowRight" });
		expect(document.activeElement).toBe(screen.getByTestId("task-menu-priority-P4"));
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
		expect(screen.getByTestId("task-menu-restartSession")).toBeDisabled();
	});

	it("confirms the terminal replacement and restarts through managed resume", async () => {
		const { onClose } = renderMenu();
		await userEvent.click(screen.getByRole("menuitem", { name: "Restart agent session…" }));
		expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
			title: "Restart agent session?",
			message: expect.stringContaining("All terminal panes close"),
			confirmLabel: "Restart and resume",
		}));
		await waitFor(() => expect(mockedApi.request.resumeTask).toHaveBeenCalledWith({ taskId: "t1", restart: true }));
		expect(onClose).toHaveBeenCalled();
		expect(mockedApi.request.hibernateTask).not.toHaveBeenCalled();
	});

	it("leaves the session alone when restart is cancelled", async () => {
		vi.mocked(confirm).mockResolvedValueOnce(false);
		renderMenu();
		await userEvent.click(screen.getByTestId("task-menu-restartSession"));
		expect(mockedApi.request.resumeTask).not.toHaveBeenCalled();
	});

	it("shows the refusal instead of claiming restart succeeded", async () => {
		const errorToast = vi.spyOn(toast, "error").mockImplementation(() => {});
		vi.mocked(api.request.resumeTask).mockRejectedValueOnce(new Error("No saved conversation. Nothing was stopped."));
		try {
			renderMenu();
			await userEvent.click(screen.getByTestId("task-menu-restartSession"));
			await waitFor(() => expect(errorToast).toHaveBeenCalledWith("No saved conversation. Nothing was stopped.", { taskId: "t1" }));
		} finally {
			errorToast.mockRestore();
		}
	});

	it.each([{ status: "todo" }, { preparing: true }, { shuttingDown: true }, { draft: true }, { worktreePath: null }, { runtimeState: { runtime: "idle" } }])("disables restart for %j", (state) => {
		renderMenu(makeTask(state as Partial<Task>));
		expect(screen.getByTestId("task-menu-restartSession")).toBeDisabled();
	});
});

// R1 (Seq 2003 review 2003-010): "Move to → Agent is Working" on a To Do card must
// open the launch dialog; a bare moveTask is refused by the lifecycle.
describe("TaskContextMenu → start a To Do card", () => {
	it("hands the start to the launch dialog, sending no moveTask", async () => {
		const { LAUNCH_REQUESTED_EVENT } = await import("../../utils/moveTaskToStatus");
		const listener = vi.fn();
		window.addEventListener(LAUNCH_REQUESTED_EVENT, listener);
		try {
			renderMenu(makeTask({ status: "todo", worktreePath: null }));
			await userEvent.hover(screen.getByText("Move to"));
			await userEvent.click(await screen.findByText("Agent is Working"));
			await waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
			expect((listener.mock.calls[0]![0] as CustomEvent).detail.targetStatus).toBe("in-progress");
			expect(mockedApi.request.moveTask).not.toHaveBeenCalled();
		} finally {
			window.removeEventListener(LAUNCH_REQUESTED_EVENT, listener);
		}
	});
});

describe("TaskContextMenu on a phone", () => {
	const width = window.innerWidth;
	const matchMedia = window.matchMedia;
	beforeEach(() => {
		vi.clearAllMocks();
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
		window.matchMedia = ((query: string) => ({
			...matchMedia(query),
			matches: query.includes("max-width"),
		})) as typeof window.matchMedia;
	});
	afterEach(() => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
		window.matchMedia = matchMedia;
	});

	it("taps through to the label sheet instead of a hover flyout", async () => {
		renderMenu();
		await userEvent.click(screen.getByTestId("task-menu-labels"));
		expect(await screen.findByTestId("label-picker")).toBeInTheDocument();
		expect(screen.queryByTestId("task-menu-flyout-labels")).not.toBeInTheDocument();
	});

	it("keeps the inline priority levels", () => {
		renderMenu();
		expect(screen.getByTestId("task-menu-priority-P0")).toBeInTheDocument();
	});
});
