import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AllTasksBoard from "../AllTasksBoard";
import { I18nProvider } from "../../i18n";
import type { Project, Task } from "../../../shared/types";
import type { Route } from "../../state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAllProjectTasks: vi.fn(),
			getAgents: vi.fn(),
		},
	},
}));

import { api } from "../../rpc";

const mockedApi = vi.mocked(api, true);

function makeProject(over: Partial<Project> = {}): Project {
	return {
		id: "p1",
		name: "My Project",
		path: "/home/user/my-project",
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2025-01-01T00:00:00Z",
		...over,
	};
}

function makeTask(over: Partial<Task> = {}): Task {
	return {
		id: "t1",
		seq: 1,
		projectId: "p1",
		title: "A task",
		description: "A task",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: "/tmp/worktree",
		branchName: "feat/test",
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
		movedAt: "2025-01-01T00:00:00Z",
		...over,
	};
}

const projects = [makeProject(), makeProject({ id: "p2", name: "Second Project", path: "/home/user/second" })];

function renderBoard(navigate: (route: Route) => void = vi.fn(), projectsList: Project[] = projects) {
	return render(
		<I18nProvider>
			<AllTasksBoard projects={projectsList} navigate={navigate} bellCounts={new Map()} />
		</I18nProvider>,
	);
}

describe("AllTasksBoard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getAgents.mockResolvedValue([]);
		mockedApi.request.getAllProjectTasks.mockResolvedValue([
			{ projectId: "p1", tasks: [makeTask({ id: "todo1", projectId: "p1", status: "todo", title: "Draft feature" })] },
			{ projectId: "p2", tasks: [makeTask({ id: "rev1", projectId: "p2", status: "review-by-user", title: "Review me" })] },
		]);
	});

	it("requests cross-project tasks including todo", async () => {
		renderBoard();
		await waitFor(() =>
			expect(mockedApi.request.getAllProjectTasks).toHaveBeenCalledWith({ includeTodo: true }),
		);
	});

	it("renders all six status columns", async () => {
		renderBoard();
		await screen.findByTestId("board-column-To Do");
		for (const label of ["To Do", "Agent is Working", "Has Questions", "AI Review", "Your Review", "PR Review"]) {
			expect(screen.getByTestId(`board-column-${label}`)).toBeInTheDocument();
		}
	});

	it("places each task in its status column with a project badge", async () => {
		renderBoard();
		const todoCol = await screen.findByTestId("board-column-To Do");
		expect(within(todoCol).getByText("Draft feature")).toBeInTheDocument();
		expect(within(todoCol).getByTestId("board-project-badge-todo1")).toHaveTextContent("My Project");

		const reviewCol = screen.getByTestId("board-column-Your Review");
		expect(within(reviewCol).getByText("Review me")).toBeInTheDocument();
		expect(within(reviewCol).getByTestId("board-project-badge-rev1")).toHaveTextContent("Second Project");
	});

	it("opens the task in its own project when clicked", async () => {
		const navigate = vi.fn();
		renderBoard(navigate);
		const card = await screen.findByTestId("board-card-rev1");
		await userEvent.click(card);
		expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p2", activeTaskId: "rev1" });
	});

	it("filters tasks by search query", async () => {
		renderBoard();
		await screen.findByText("Draft feature");
		const input = screen.getByPlaceholderText("Search all tasks…");
		await userEvent.type(input, "Review me");
		await waitFor(() => expect(screen.queryByText("Draft feature")).not.toBeInTheDocument());
		expect(screen.getByText("Review me")).toBeInTheDocument();
	});

	it("shows an empty state when there are no active tasks", async () => {
		mockedApi.request.getAllProjectTasks.mockResolvedValue([]);
		renderBoard();
		expect(await screen.findByText("No active tasks across any project")).toBeInTheDocument();
	});

	it("opens a project picker on New task and creates in the chosen project", async () => {
		const events: (string | undefined)[] = [];
		const handler = (e: Event) => events.push((e as CustomEvent).detail?.projectId);
		window.addEventListener("rpc:openCreateTaskModal", handler);
		try {
			renderBoard();
			await screen.findByTestId("board-new-task");
			await userEvent.click(screen.getByTestId("board-new-task"));

			// Project typeahead opens (multiple projects → must choose one).
			const input = await screen.findByPlaceholderText("Search projects…");
			await userEvent.type(input, "Second");
			await userEvent.keyboard("{Enter}");

			expect(events).toEqual(["p2"]);
		} finally {
			window.removeEventListener("rpc:openCreateTaskModal", handler);
		}
	});

	it("skips the picker and creates directly when there is only one project", async () => {
		const events: (string | undefined)[] = [];
		const handler = (e: Event) => events.push((e as CustomEvent).detail?.projectId);
		window.addEventListener("rpc:openCreateTaskModal", handler);
		try {
			renderBoard(vi.fn(), [projects[0]]);
			await screen.findByTestId("board-new-task");
			await userEvent.click(screen.getByTestId("board-new-task"));

			expect(screen.queryByPlaceholderText("Search projects…")).not.toBeInTheDocument();
			expect(events).toEqual(["p1"]);
		} finally {
			window.removeEventListener("rpc:openCreateTaskModal", handler);
		}
	});
});
