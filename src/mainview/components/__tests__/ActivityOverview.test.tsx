import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ActivityOverview from "../ActivityOverview";
import { I18nProvider } from "../../i18n";
import type { Project, Task } from "../../../shared/types";
import type { Route } from "../../state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAllProjectTasks: vi.fn(),
			openFolder: vi.fn(),
		},
	},
}));

import { api } from "../../rpc";

const mockedApi = vi.mocked(api, true);

const mockProject: Project = {
	id: "p1",
	name: "My Project",
	path: "/home/user/my-project",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

const mockTask: Task = {
	id: "t1",
	seq: 1,
	projectId: "p1",
	title: "Need review",
	description: "Need review",
	status: "user-questions",
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
};

function renderActivityOverview(
	navigate: (route: Route) => void = vi.fn(),
	onRemoveProject?: (projectId: string) => void | Promise<void>,
	onOpenAddProject?: () => void,
) {
	return render(
		<I18nProvider>
			<ActivityOverview
				projects={[mockProject]}
				navigate={navigate}
				bellCounts={new Map()}
				onRemoveProject={onRemoveProject}
				onOpenAddProject={onOpenAddProject}
			/>
		</I18nProvider>,
	);
}

describe("ActivityOverview", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getAllProjectTasks.mockResolvedValue([
			{ projectId: "p1", tasks: [mockTask] },
		]);
		mockedApi.request.openFolder.mockResolvedValue(undefined);
	});

	it("shows project quick actions for active projects", async () => {
		renderActivityOverview(vi.fn(), vi.fn(), vi.fn());

		await screen.findByText("My Project");

		expect(screen.getByText("/home/user/my-project")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add Project" })).toBeInTheDocument();
		expect(screen.getByTitle("Project Settings")).toBeInTheDocument();
		expect(screen.getByTitle("Open in Finder")).toBeInTheDocument();
		expect(screen.getByTitle("Open a terminal in the project root")).toBeInTheDocument();
		expect(screen.getByTitle("Remove")).toBeInTheDocument();
	});

	it("renders project quick actions before the activity count", async () => {
		renderActivityOverview(vi.fn(), vi.fn(), vi.fn());

		const settingsButton = await screen.findByTitle("Project Settings");
		const activeCount = screen.getByText("1 active");

		expect(
			settingsButton.compareDocumentPosition(activeCount) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("opens the project folder without navigating to the project page", async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();

		renderActivityOverview(navigate);
		await screen.findByText("My Project");

		await user.click(screen.getByTitle("Open in Finder"));

		expect(mockedApi.request.openFolder).toHaveBeenCalledWith({
			path: "/home/user/my-project",
		});
		expect(navigate).not.toHaveBeenCalledWith({
			screen: "project",
			projectId: "p1",
		});
	});

	it("navigates to project settings and project terminal from activity actions", async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();
		const onRemoveProject = vi.fn();

		renderActivityOverview(navigate, onRemoveProject, vi.fn());
		await screen.findByText("My Project");

		await user.click(screen.getByTitle("Project Settings"));
		await user.click(screen.getByTitle("Open a terminal in the project root"));
		await user.click(screen.getByTitle("Remove"));

		expect(navigate).toHaveBeenCalledWith({
			screen: "project-settings",
			projectId: "p1",
		});
		expect(navigate).toHaveBeenCalledWith({
			screen: "project-terminal",
			projectId: "p1",
		});
		await waitFor(() => {
			expect(onRemoveProject).toHaveBeenCalledWith("p1");
		});
	});

	it("shows all projects even when there are no active tasks", async () => {
		mockedApi.request.getAllProjectTasks.mockResolvedValue([
			{ projectId: "p1", tasks: [] },
		]);

		renderActivityOverview();

		expect(await screen.findByText("My Project")).toBeInTheDocument();
		expect(screen.getByText("/home/user/my-project")).toBeInTheDocument();
		expect(screen.getByText("No active tasks across any project")).toBeInTheDocument();
		expect(screen.getByText("no active tasks")).toBeInTheDocument();
	});

	it("shows the special bracketed name + SYSTEM badge for the built-in board and hides the synthetic path", async () => {
		const virtual: Project = {
			...mockProject,
			id: "vp1",
			name: "Operations",
			kind: "virtual",
			builtin: true,
			path: "/home/user/.dev3.0/ops/operations",
		};
		mockedApi.request.getAllProjectTasks.mockResolvedValue([{ projectId: "vp1", tasks: [] }]);

		render(
			<I18nProvider>
				<ActivityOverview projects={[virtual]} navigate={vi.fn()} bellCounts={new Map()} />
			</I18nProvider>,
		);

		// Special identity: bracketed name, SYSTEM badge, and the ⌘0 hint.
		expect(await screen.findByText("[ Operations ]")).toBeInTheDocument();
		expect(screen.getByText("SYSTEM")).toBeInTheDocument();
		expect(screen.getByText("⌘0")).toBeInTheDocument();
		expect(screen.getByText("Code-driven tasks · no git")).toBeInTheDocument();
		// The synthetic on-disk path must never be shown to the user.
		expect(screen.queryByText("/home/user/.dev3.0/ops/operations")).not.toBeInTheDocument();
	});

	it("pins the built-in Operations board first, above ordinary projects", async () => {
		const gitProj: Project = { ...mockProject, id: "g1", name: "Alpha Repo", path: "/home/user/alpha" };
		const builtin: Project = {
			...mockProject,
			id: "vp1",
			name: "Operations",
			kind: "virtual",
			builtin: true,
			path: "/home/user/.dev3.0/ops/operations",
		};
		mockedApi.request.getAllProjectTasks.mockResolvedValue([]);

		render(
			<I18nProvider>
				{/* Built-in passed LAST but must render FIRST. */}
				<ActivityOverview projects={[gitProj, builtin]} navigate={vi.fn()} bellCounts={new Map()} />
			</I18nProvider>,
		);

		const ops = await screen.findByText("[ Operations ]");
		const repo = screen.getByText("Alpha Repo");
		// Document order: Operations tile appears before the git project tile.
		expect(ops.compareDocumentPosition(repo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("shows PR Review tasks as individual rows, not collapsed into the summary", async () => {
		mockedApi.request.getAllProjectTasks.mockResolvedValue([
			{
				projectId: "p1",
				tasks: [
					{ ...mockTask, id: "pr1", title: "Ship the parser", status: "review-by-colleague" },
				],
			},
		]);

		renderActivityOverview();

		// The task title is rendered as its own row...
		expect(await screen.findByText("Ship the parser")).toBeInTheDocument();
		// ...with the "PR Review" status pill, instead of being folded into the
		// background summary line.
		expect(screen.getByText("PR Review")).toBeInTheDocument();
	});

	it("shows priority badges and orders visible task rows from highest to lowest", async () => {
		mockedApi.request.getAllProjectTasks.mockResolvedValue([
			{
				projectId: "p1",
				tasks: [
					{ ...mockTask, id: "low", title: "Low priority", priority: "P3" },
					{ ...mockTask, id: "high", title: "High priority", priority: "P1" },
					{ ...mockTask, id: "normal", title: "Normal priority", priority: "P2" },
				],
			},
		]);

		renderActivityOverview();

		const high = await screen.findByText("High priority");
		const normal = screen.getByText("Normal priority");
		const low = screen.getByText("Low priority");
		const highRow = high.closest("button");
		if (!highRow) throw new Error("Expected high-priority task row");

		expect(screen.getByText("P1")).toBeInTheDocument();
		expect(screen.getByText("P2")).toBeInTheDocument();
		expect(screen.getByText("P3")).toBeInTheDocument();
		expect(highRow.firstElementChild).toHaveTextContent("P1");
		expect(within(highRow).getAllByText("P1")).toHaveLength(1);
		expect(high.compareDocumentPosition(normal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(normal.compareDocumentPosition(low) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("shows custom-column tasks as rows labeled with the column name", async () => {
		const projWithColumn: Project = {
			...mockProject,
			customColumns: [{ id: "col1", name: "Blocked", color: "#ff0000", llmInstruction: "" }],
		};
		// An in-progress task would normally be summarized; parking it in a custom
		// column promotes it to its own row carrying the column's identity.
		mockedApi.request.getAllProjectTasks.mockResolvedValue([
			{
				projectId: "p1",
				tasks: [
					{ ...mockTask, id: "c1", title: "Parked work", status: "in-progress", customColumnId: "col1" },
				],
			},
		]);

		render(
			<I18nProvider>
				<ActivityOverview projects={[projWithColumn]} navigate={vi.fn()} bellCounts={new Map()} />
			</I18nProvider>,
		);

		expect(await screen.findByText("Parked work")).toBeInTheDocument();
		// Labeled by the custom column, not its underlying "Agent is Working" status.
		expect(screen.getByText("Blocked")).toBeInTheDocument();
		expect(screen.queryByText("Agent is Working")).not.toBeInTheDocument();
	});

	it("ignores a dangling customColumnId and falls back to status bucketing", async () => {
		// Column "ghost" no longer exists on the project → the task must not be
		// treated as a custom-column row; an in-progress task stays in the summary.
		mockedApi.request.getAllProjectTasks.mockResolvedValue([
			{
				projectId: "p1",
				tasks: [
					{ ...mockTask, id: "g1", title: "Orphan task", status: "in-progress", customColumnId: "ghost" },
				],
			},
		]);

		renderActivityOverview();

		await screen.findByText("My Project");
		// Background in-progress task is summarized, never shown as a titled row.
		expect(screen.queryByText("Orphan task")).not.toBeInTheDocument();
	});

	it("opens the add project flow from the activity header", async () => {
		const user = userEvent.setup();
		const onOpenAddProject = vi.fn();

		renderActivityOverview(vi.fn(), vi.fn(), onOpenAddProject);

		await screen.findByText("My Project");
		await user.click(screen.getByRole("button", { name: "Add Project" }));

		expect(onOpenAddProject).toHaveBeenCalled();
	});

	it("does not render the per-project action kebab on a wide viewport", async () => {
		renderActivityOverview(vi.fn(), vi.fn(), vi.fn());
		await screen.findByText("My Project");

		// On desktop the inline hover cluster is used; the touch kebab + sheet
		// are narrow-only and must not be in the DOM.
		expect(screen.queryByTitle("Project actions")).toBeNull();
		expect(screen.queryByTestId("activity-project-action-sheet")).toBeNull();
	});
});

describe("ActivityOverview — narrow viewport", () => {
	const originalInnerWidth = window.innerWidth;
	const originalMatchMedia = window.matchMedia;

	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getAllProjectTasks.mockResolvedValue([
			{ projectId: "p1", tasks: [mockTask] },
		]);
		mockedApi.request.openFolder.mockResolvedValue(undefined);
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			value: (query: string) => ({
				matches: true,
				media: query,
				onchange: null,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
				dispatchEvent: vi.fn(),
			}),
		});
	});

	afterEach(() => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
		Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
	});

	it("collapses every per-project action + reorder into a kebab action sheet", async () => {
		const user = userEvent.setup();
		render(
			<I18nProvider>
				<ActivityOverview
					projects={[mockProject]}
					navigate={vi.fn()}
					bellCounts={new Map()}
					onRemoveProject={vi.fn()}
					onReorderProjects={vi.fn()}
				/>
			</I18nProvider>,
		);
		await screen.findByText("My Project");

		await user.click(screen.getByTitle("Project actions"));

		const sheet = screen.getByTestId("activity-project-action-sheet");
		expect(within(sheet).getByText("Open board")).toBeInTheDocument();
		expect(within(sheet).getByText("Project Settings")).toBeInTheDocument();
		expect(within(sheet).getByText("Open in Finder")).toBeInTheDocument();
		expect(within(sheet).getByText("Open a terminal in the project root")).toBeInTheDocument();
		// Reorder — touch-unreachable on the desktop layout (drag + hidden step
		// buttons) — is now reachable here.
		expect(within(sheet).getByText("Move project up")).toBeInTheDocument();
		expect(within(sheet).getByText("Move project down")).toBeInTheDocument();
		expect(within(sheet).getByText("Remove")).toBeInTheDocument();
	});

	it("navigates to project settings from the action sheet (touch path)", async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();
		render(
			<I18nProvider>
				<ActivityOverview
					projects={[mockProject]}
					navigate={navigate}
					bellCounts={new Map()}
					onRemoveProject={vi.fn()}
				/>
			</I18nProvider>,
		);
		await screen.findByText("My Project");

		await user.click(screen.getByTitle("Project actions"));
		const sheet = screen.getByTestId("activity-project-action-sheet");
		await user.click(within(sheet).getByText("Project Settings"));

		expect(navigate).toHaveBeenCalledWith({ screen: "project-settings", projectId: "p1" });
		// The sheet closes after a navigation action.
		expect(screen.queryByTestId("activity-project-action-sheet")).toBeNull();
	});

	it("caps the per-project list at 3 rows and reveals the rest behind a toggle", async () => {
		const user = userEvent.setup();
		const many = Array.from({ length: 5 }, (_, i) => ({
			...mockTask,
			id: `m${i}`,
			title: `Review item ${i + 1}`,
			status: "review-by-user" as const,
		}));
		mockedApi.request.getAllProjectTasks.mockResolvedValue([{ projectId: "p1", tasks: many }]);

		render(
			<I18nProvider>
				<ActivityOverview projects={[mockProject]} navigate={vi.fn()} bellCounts={new Map()} />
			</I18nProvider>,
		);
		await screen.findByText("Review item 1");

		// Only the first 3 of 5 attention rows render before the fold.
		expect(screen.getByText("Review item 3")).toBeInTheDocument();
		expect(screen.queryByText("Review item 4")).toBeNull();
		expect(screen.queryByText("Review item 5")).toBeNull();

		// The toggle announces how many are hidden and reveals them on tap.
		await user.click(screen.getByText("Show 2 more"));
		expect(screen.getByText("Review item 4")).toBeInTheDocument();
		expect(screen.getByText("Review item 5")).toBeInTheDocument();

		// …and collapses again.
		await user.click(screen.getByText("Show fewer"));
		expect(screen.queryByText("Review item 4")).toBeNull();
	});

	it("orders 'your turn' tasks above colleague reviews on narrow", async () => {
		// Passed colleague-first; the narrow sort must surface "your review" first.
		const tasks = [
			{ ...mockTask, id: "pr", title: "Colleague PR", status: "review-by-colleague" as const },
			{ ...mockTask, id: "mine", title: "My review", status: "review-by-user" as const },
		];
		mockedApi.request.getAllProjectTasks.mockResolvedValue([{ projectId: "p1", tasks }]);

		render(
			<I18nProvider>
				<ActivityOverview projects={[mockProject]} navigate={vi.fn()} bellCounts={new Map()} />
			</I18nProvider>,
		);
		const mine = await screen.findByText("My review");
		const colleague = screen.getByText("Colleague PR");

		expect(mine.compareDocumentPosition(colleague) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("orders by priority before status on narrow", async () => {
		const tasks = [
			{ ...mockTask, id: "mine", title: "My review", status: "review-by-user" as const, priority: "P3" as const },
			{ ...mockTask, id: "colleague", title: "Colleague PR", status: "review-by-colleague" as const, priority: "P1" as const },
		];
		mockedApi.request.getAllProjectTasks.mockResolvedValue([{ projectId: "p1", tasks }]);

		render(
			<I18nProvider>
				<ActivityOverview projects={[mockProject]} navigate={vi.fn()} bellCounts={new Map()} />
			</I18nProvider>,
		);

		const colleague = await screen.findByText("Colleague PR");
		const mine = screen.getByText("My review");

		expect(colleague.compareDocumentPosition(mine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});
});
