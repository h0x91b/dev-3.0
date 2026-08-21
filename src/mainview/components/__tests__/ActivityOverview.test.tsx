import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ActivityOverview from "../ActivityOverview";
import { I18nProvider } from "../../i18n";
import type { Project, Task } from "../../../shared/types";
import { getTaskTitle } from "../../../shared/types";
import type { Route } from "../../state";
import { setStreamerMode } from "../../streamer-mode";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAllProjectTasks: vi.fn(),
			openFolder: vi.fn(),
			getSpaces: vi.fn(() => Promise.resolve({ version: 1, spaces: [], order: [] })),
			reorderSpaces: vi.fn(),
			reorderSpaceProjects: vi.fn(),
		},
	},
}));

vi.mock("../../utils/moveTaskToStatus", () => ({
	moveTaskToStatus: vi.fn(async () => true),
}));

import { api } from "../../rpc";
import { moveTaskToStatus } from "../../utils/moveTaskToStatus";

const mockedApi = vi.mocked(api, true);
const mockedMove = vi.mocked(moveTaskToStatus);

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
				dispatch={vi.fn()}
				bellCounts={new Map()}
				onRemoveProject={onRemoveProject}
				onOpenAddProject={onOpenAddProject}
			/>
		</I18nProvider>,
	);
}

function renderWithProjects(projects: Project[], navigate: (route: Route) => void = vi.fn()) {
	return render(
		<I18nProvider>
			<ActivityOverview
				projects={projects}
				navigate={navigate}
				dispatch={vi.fn()}
				bellCounts={new Map()}
				onRemoveProject={vi.fn()}
				onOpenAddProject={vi.fn()}
			/>
		</I18nProvider>,
	);
}

// A project flagged `sensitive` must read as present-but-off-limits while
// streamer mode is on: blurred name + task, lock glyph, and a non-actionable row
// (the refusal itself lives in App's navigate guard).
describe("ActivityOverview — sensitive project in streamer mode", () => {
	const sensitive: Project = { ...mockProject, sensitive: true };

	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getAllProjectTasks.mockResolvedValue([
			{ projectId: "p1", tasks: [mockTask], todoCount: 0 },
		]);
		localStorage.clear();
		delete document.documentElement.dataset.streamer;
		setStreamerMode(false);
	});

	it("leaves the row untouched while streamer mode is off", async () => {
		renderWithProjects([sensitive]);
		const name = await screen.findByText("My Project");
		expect(name.className).not.toContain("streamer-private");
	});

	it("blurs the project name and its task, and marks the row aria-disabled", async () => {
		setStreamerMode(true);
		renderWithProjects([sensitive]);

		const name = await screen.findByText("My Project");
		expect(name.className).toContain("streamer-private");
		expect(screen.getByText(getTaskTitle(mockTask)).className).toContain("streamer-private");
		expect(name.closest("button")).toHaveAttribute("aria-disabled", "true");
		expect(name.closest("button")).toHaveAttribute("title", expect.stringContaining("Sensitive project"));
	});

	it("hides the row's Complete action so a blurred task cannot be mutated", async () => {
		setStreamerMode(true);
		renderWithProjects([sensitive]);

		await screen.findByText("My Project");
		expect(screen.queryByTestId("activity-row-complete")).not.toBeInTheDocument();
	});

	it("does not blur a project without the flag", async () => {
		setStreamerMode(true);
		renderWithProjects([mockProject]);

		const name = await screen.findByText("My Project");
		expect(name.className).not.toContain("streamer-private");
		expect(name.closest("button")).not.toHaveAttribute("aria-disabled");
	});
});

describe("ActivityOverview", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getAllProjectTasks.mockResolvedValue([
			{ projectId: "p1", tasks: [mockTask], todoCount: 0 },
		]);
		mockedApi.request.openFolder.mockResolvedValue(undefined);
	});

	it("shows project quick actions for active projects", async () => {
		renderActivityOverview(vi.fn(), vi.fn(), vi.fn());

		await screen.findByText("My Project");

		expect(screen.getByText("/home/user/my-project")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add project" })).toBeInTheDocument();
		expect(screen.getByTitle("Project settings")).toBeInTheDocument();
		expect(screen.getByTitle("Open in Finder")).toBeInTheDocument();
		expect(screen.getByTitle("Open a terminal in the project root")).toBeInTheDocument();
		expect(screen.getByTitle("Remove")).toBeInTheDocument();
	});

	it("keeps project quick actions visible at rest instead of revealing them on hover", async () => {
		renderActivityOverview(vi.fn(), vi.fn(), vi.fn());

		const cluster = (await screen.findByTitle("Project settings")).parentElement;

		expect(cluster?.className).not.toMatch(/opacity-0/);
		for (const title of ["Project settings", "Open in Finder", "Open a terminal in the project root", "Remove"]) {
			expect(screen.getByTitle(title).className).toContain("text-fg-3");
		}
	});

	it("renders project quick actions before the activity count", async () => {
		renderActivityOverview(vi.fn(), vi.fn(), vi.fn());

		const settingsButton = await screen.findByTitle("Project settings");
		const activeCount = screen.getByText("1 active task");

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

		await user.click(screen.getByTitle("Project settings"));
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
			{ projectId: "p1", tasks: [], todoCount: 0 },
		]);

		renderActivityOverview();

		expect(await screen.findByText("My Project")).toBeInTheDocument();
		expect(screen.getByText("/home/user/my-project")).toBeInTheDocument();
		expect(screen.getByText("No active tasks across any project")).toBeInTheDocument();
		expect(screen.getByText("No active tasks")).toBeInTheDocument();
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
		mockedApi.request.getAllProjectTasks.mockResolvedValue([{ projectId: "vp1", tasks: [], todoCount: 0 }]);

		render(
			<I18nProvider>
				<ActivityOverview projects={[virtual]} navigate={vi.fn()} dispatch={vi.fn()} bellCounts={new Map()} />
			</I18nProvider>,
		);

		// Special identity: bracketed name, SYSTEM badge, and the ⌘0 hint.
		expect(await screen.findByText("[ Operations ]")).toBeInTheDocument();
		expect(screen.getByText("System")).toBeInTheDocument();
		expect(screen.getByText("⌘0")).toBeInTheDocument();
		expect(screen.getByText("Code-driven tasks · no git")).toBeInTheDocument();
		// The synthetic on-disk path must never be shown to the user.
		expect(screen.queryByText("/home/user/.dev3.0/ops/operations")).not.toBeInTheDocument();
	});

	it("hides the reorder cluster on a board that cannot be reordered, without losing its column", async () => {
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
				<ActivityOverview
					projects={[gitProj, builtin]}
					navigate={vi.fn()}
					dispatch={vi.fn()}
					bellCounts={new Map()}
					onReorderProjects={vi.fn()}
				/>
			</I18nProvider>,
		);

		// A virtual board can never be reordered, so a grip and two disabled arrows
		// on its row were three controls promising something they cannot do.
		const opsRow = (await screen.findByText("[ Operations ]")).closest("[data-help-id='dashboard.project-row']")!;
		const opsCluster = opsRow.querySelector("[aria-hidden='true'].md\\:flex");
		expect(opsCluster).not.toBeNull();
		// `invisible`, not removed: the row is pinned above the rest and their
		// names have to start at the same x. It also drops out of the tab order.
		expect(opsCluster!.className).toContain("invisible");
		expect(opsRow.querySelector("[title='Move project up']")).not.toBeNull();

		const repoRow = screen.getByText("Alpha Repo").closest("[data-help-id='dashboard.project-row']")!;
		const repoCluster = repoRow.querySelector("[title='Move project up']")!.parentElement!;
		expect(repoCluster.className).not.toContain("invisible");
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
				<ActivityOverview projects={[gitProj, builtin]} navigate={vi.fn()} dispatch={vi.fn()} bellCounts={new Map()} />
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
				todoCount: 0,
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
				todoCount: 0,
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

	it("sinks a hibernated task below every live one and labels it", async () => {
		mockedApi.request.getAllProjectTasks.mockResolvedValue([
			{
				projectId: "p1",
				todoCount: 0,
				tasks: [
					{ ...mockTask, id: "parked", title: "Parked task", priority: "P0", hibernated: true },
					{ ...mockTask, id: "live", title: "Live task", priority: "P4" },
				],
			},
		]);

		renderActivityOverview();

		const live = await screen.findByText("Live task");
		const parked = screen.getByText("Parked task");
		expect(live.compareDocumentPosition(parked) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(screen.getByTestId("activity-hibernated-badge")).toBeInTheDocument();
	});

	it("sinks a task whose session died below every live one and labels it", async () => {
		mockedApi.request.getAllProjectTasks.mockResolvedValue([
			{
				projectId: "p1",
				todoCount: 0,
				tasks: [
					{
						...mockTask,
						id: "dead",
						title: "Dead session",
						priority: "P0",
						runtimeState: { runtime: "idle" as const, updatedAt: 1 },
					},
					{ ...mockTask, id: "live", title: "Live task", priority: "P4" },
				],
			},
		]);

		renderActivityOverview();

		const live = await screen.findByText("Live task");
		const dead = screen.getByText("Dead session");
		expect(live.compareDocumentPosition(dead) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(screen.getByTestId("activity-disconnected-badge")).toBeInTheDocument();
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
				todoCount: 0,
				tasks: [
					{ ...mockTask, id: "c1", title: "Parked work", status: "in-progress", customColumnId: "col1" },
				],
			},
		]);

		render(
			<I18nProvider>
				<ActivityOverview projects={[projWithColumn]} navigate={vi.fn()} dispatch={vi.fn()} bellCounts={new Map()} />
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
				todoCount: 0,
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
		await user.click(screen.getByRole("button", { name: "Add project" }));

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
			{ projectId: "p1", tasks: [mockTask], todoCount: 0 },
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
					dispatch={vi.fn()} bellCounts={new Map()}
					onRemoveProject={vi.fn()}
					onReorderProjects={vi.fn()}
				/>
			</I18nProvider>,
		);
		await screen.findByText("My Project");

		await user.click(screen.getByTitle("Project actions"));

		const sheet = screen.getByTestId("activity-project-action-sheet");
		expect(within(sheet).getByText("Open board")).toBeInTheDocument();
		expect(within(sheet).getByText("Project settings")).toBeInTheDocument();
		expect(within(sheet).getByText("Open in Finder")).toBeInTheDocument();
		expect(within(sheet).getByText("Open terminal")).toBeInTheDocument();
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
					dispatch={vi.fn()} bellCounts={new Map()}
					onRemoveProject={vi.fn()}
				/>
			</I18nProvider>,
		);
		await screen.findByText("My Project");

		await user.click(screen.getByTitle("Project actions"));
		const sheet = screen.getByTestId("activity-project-action-sheet");
		await user.click(within(sheet).getByText("Project settings"));

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
		mockedApi.request.getAllProjectTasks.mockResolvedValue([{ projectId: "p1", tasks: many, todoCount: 0 }]);

		render(
			<I18nProvider>
				<ActivityOverview projects={[mockProject]} navigate={vi.fn()} dispatch={vi.fn()} bellCounts={new Map()} />
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
		mockedApi.request.getAllProjectTasks.mockResolvedValue([{ projectId: "p1", tasks, todoCount: 0 }]);

		render(
			<I18nProvider>
				<ActivityOverview projects={[mockProject]} navigate={vi.fn()} dispatch={vi.fn()} bellCounts={new Map()} />
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
		mockedApi.request.getAllProjectTasks.mockResolvedValue([{ projectId: "p1", tasks, todoCount: 0 }]);

		render(
			<I18nProvider>
				<ActivityOverview projects={[mockProject]} navigate={vi.fn()} dispatch={vi.fn()} bellCounts={new Map()} />
			</I18nProvider>,
		);

		const colleague = await screen.findByText("Colleague PR");
		const mine = screen.getByText("My review");

		expect(colleague.compareDocumentPosition(mine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});
});

describe("ActivityOverview loading state", () => {
	it("renders a skeleton placeholder while tasks are still loading", async () => {
		vi.clearAllMocks();
		let release: (value: { projectId: string; tasks: Task[]; todoCount: number }[]) => void = () => {};
		mockedApi.request.getAllProjectTasks.mockReturnValue(
			new Promise((resolve) => {
				release = resolve;
			}),
		);

		const { container } = render(
			<I18nProvider>
				<ActivityOverview projects={[mockProject]} navigate={vi.fn()} dispatch={vi.fn()} bellCounts={new Map()} />
			</I18nProvider>,
		);

		expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(screen.queryByText(mockProject.name)).toBeNull();

		release([{ projectId: "p1", tasks: [mockTask], todoCount: 0 }]);
		await waitFor(() => expect(screen.getByText(mockProject.name)).toBeInTheDocument());
		expect(container.querySelector('[aria-busy="true"]')).toBeNull();
	});
});

describe("ActivityOverview accessibility and copy regressions", () => {
	it("pluralises the background-work summary instead of gluing a count onto a status label", async () => {
		vi.clearAllMocks();
		mockedApi.request.getAllProjectTasks.mockResolvedValue([
			{
				projectId: "p1",
				todoCount: 0,
				tasks: [
					{ ...mockTask, id: "t1", status: "in-progress" as const },
					{ ...mockTask, id: "t2", status: "in-progress" as const },
					{ ...mockTask, id: "t3", status: "review-by-ai" as const },
				],
			},
		]);

		render(
			<I18nProvider>
				<ActivityOverview projects={[mockProject]} navigate={vi.fn()} dispatch={vi.fn()} bellCounts={new Map()} />
			</I18nProvider>,
		);

		expect(await screen.findByText("2 agents working")).toBeInTheDocument();
		expect(screen.getByText("1 in AI review")).toBeInTheDocument();
		// The old implementation lowercased a status label and prefixed a count.
		expect(screen.queryByText(/agent is working/i)).toBeNull();
		expect(screen.queryByText(/\bai review\b/)).toBeNull();
	});

	it("keeps the drag affordance out of the tab order and off the accessibility tree", async () => {
		vi.clearAllMocks();
		mockedApi.request.getAllProjectTasks.mockResolvedValue([{ projectId: "p1", tasks: [mockTask], todoCount: 0 }]);

		const { container } = render(
			<I18nProvider>
				<ActivityOverview
					projects={[mockProject]}
					navigate={vi.fn()}
					dispatch={vi.fn()} bellCounts={new Map()}
					onReorderProjects={vi.fn()}
				/>
			</I18nProvider>,
		);

		await screen.findByText(mockProject.name);
		// It is a drag handle, not an action: a focusable button here would be a
		// dead tab stop, since Enter/Space do nothing and the step buttons own
		// the keyboard path.
		expect(screen.queryByRole("button", { name: /drag to reorder/i })).toBeNull();
		const handle = container.querySelector('[draggable="true"][role="presentation"]');
		expect(handle).not.toBeNull();
		expect(handle?.getAttribute("tabindex")).toBeNull();
	});

	it("gives every truncating identifier a reachable full value", async () => {
		vi.clearAllMocks();
		mockedApi.request.getAllProjectTasks.mockResolvedValue([{ projectId: "p1", tasks: [mockTask], todoCount: 0 }]);

		render(
			<I18nProvider>
				<ActivityOverview projects={[mockProject]} navigate={vi.fn()} dispatch={vi.fn()} bellCounts={new Map()} />
			</I18nProvider>,
		);

		expect(await screen.findByTitle(mockProject.name)).toBeInTheDocument();
		expect(screen.getByTitle(mockProject.path)).toBeInTheDocument();
		expect(screen.getByTitle(getTaskTitle(mockTask))).toBeInTheDocument();
	});
});

describe("ActivityOverview row complete action", () => {
	const user = userEvent.setup();

	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getAllProjectTasks.mockResolvedValue([
			{ projectId: "p1", tasks: [mockTask], todoCount: 0 },
		]);
	});

	it("gives every task row a complete button, and hibernated rows none", async () => {
		mockedApi.request.getAllProjectTasks.mockResolvedValue([
			{
				projectId: "p1",
				todoCount: 0,
				tasks: [mockTask, { ...mockTask, id: "t2", title: "Sleeping", hibernated: true }],
			},
		]);

		render(
			<I18nProvider>
				<ActivityOverview projects={[mockProject]} navigate={vi.fn()} dispatch={vi.fn()} bellCounts={new Map()} />
			</I18nProvider>,
		);
		await screen.findByText("Sleeping");

		expect(screen.getAllByTestId("activity-row-complete")).toHaveLength(1);
		expect(
			screen.getByLabelText(`Move to Completed — ${getTaskTitle(mockTask)}`),
		).toBeInTheDocument();
	});

	it("completes through the shared confirmed move and drops the row", async () => {
		mockedMove.mockImplementation(async ({ afterOptimistic }) => {
			afterOptimistic?.();
			return true;
		});

		render(
			<I18nProvider>
				<ActivityOverview projects={[mockProject]} navigate={vi.fn()} dispatch={vi.fn()} bellCounts={new Map()} />
			</I18nProvider>,
		);
		await screen.findByText(getTaskTitle(mockTask));

		await user.click(screen.getByTestId("activity-row-complete"));

		expect(mockedMove).toHaveBeenCalledWith(
			expect.objectContaining({ newStatus: "completed", alwaysConfirm: true }),
		);
		await waitFor(() => expect(screen.queryByTestId("activity-row-complete")).toBeNull());
	});

	it("brings the row back when the move fails", async () => {
		mockedMove.mockImplementation(async ({ afterOptimistic, onFailure }) => {
			afterOptimistic?.();
			onFailure?.(new Error("boom"));
			return true;
		});

		render(
			<I18nProvider>
				<ActivityOverview projects={[mockProject]} navigate={vi.fn()} dispatch={vi.fn()} bellCounts={new Map()} />
			</I18nProvider>,
		);
		await screen.findByText(getTaskTitle(mockTask));

		await user.click(screen.getByTestId("activity-row-complete"));

		await waitFor(() => expect(screen.getByTestId("activity-row-complete")).toBeInTheDocument());
		expect(screen.getByText(getTaskTitle(mockTask))).toBeInTheDocument();
	});

	it("does not navigate to the task when the complete button is clicked", async () => {
		const navigate = vi.fn();
		mockedMove.mockResolvedValue(true);

		render(
			<I18nProvider>
				<ActivityOverview projects={[mockProject]} navigate={navigate} dispatch={vi.fn()} bellCounts={new Map()} />
			</I18nProvider>,
		);
		await screen.findByText(getTaskTitle(mockTask));

		await user.click(screen.getByTestId("activity-row-complete"));

		expect(navigate).not.toHaveBeenCalled();
	});
});

describe("ActivityOverview — spaces grouping", () => {
	it("renders the flat, headerless dashboard when no spaces exist", async () => {
		mockedApi.request.getAllProjectTasks.mockResolvedValue([{ projectId: "p1", tasks: [], todoCount: 0 }]);
		renderActivityOverview();
		await waitFor(() => expect(screen.getByText("My Project")).toBeInTheDocument());
		expect(document.querySelector('[data-testid^="space-group-"]')).toBeNull();
	});

	it("groups projects under space headers when spaces exist, with the computed bottom block", async () => {
		mockedApi.request.getAllProjectTasks.mockResolvedValue([]);
		(mockedApi.request.getSpaces as ReturnType<typeof vi.fn>).mockResolvedValue({
			version: 1,
			spaces: [{ id: "sp_a", name: "Client X", parentId: null, projectIds: ["p1"], createdAt: 1 }],
			order: ["sp_a"],
		});
		const other: Project = { ...mockProject, id: "p2", name: "Loose Project", path: "/tmp/loose" };
		renderWithProjects([mockProject, other]);
		await waitFor(() => expect(screen.getByTestId("space-header-sp_a")).toHaveTextContent("Client X"));
		expect(within(screen.getByTestId("space-group-sp_a")).getByText("My Project")).toBeInTheDocument();
		expect(within(screen.getByTestId("space-group-rest")).getByText("Loose Project")).toBeInTheDocument();
	});
});

// A row carrying tasks and a footer is ~300px tall, so a handful of them never
// fit on one screen: the user had to scroll to the drop target with the pointer
// held down. While a drag is in flight every row that can take it is one line.
describe("ActivityOverview — dragging a project collapses the list", () => {
	const second: Project = { ...mockProject, id: "p2", name: "Second Project", path: "/tmp/second" };

	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getAllProjectTasks.mockResolvedValue([
			{ projectId: "p1", tasks: [mockTask], todoCount: 4 },
			{ projectId: "p2", tasks: [], todoCount: 0 },
		]);
		(mockedApi.request.getSpaces as ReturnType<typeof vi.fn>).mockResolvedValue({
			version: 1,
			spaces: [{ id: "sp_a", name: "Client X", parentId: null, projectIds: ["p1", "p2"], createdAt: 1 }],
			order: ["sp_a"],
		});
	});

	function startDragging(projectName: string) {
		const row = screen.getByText(projectName).closest('[data-help-id="dashboard.project-row"]')!;
		const grip = row.querySelector('[title="Drag to reorder project"]')!;
		fireEvent.dragStart(grip, { dataTransfer: { setData: vi.fn(), effectAllowed: "" } });
	}

	it("drops the task rows and the board footer for the duration of the drag", async () => {
		renderWithProjects([mockProject, second]);
		expect(await screen.findByText(getTaskTitle(mockTask))).toBeInTheDocument();
		startDragging("My Project");
		expect(screen.queryByText(getTaskTitle(mockTask))).not.toBeInTheDocument();
		expect(screen.queryByTestId("project-open-board-p1")).not.toBeInTheDocument();
		expect(screen.queryByTestId("project-open-board-p2")).not.toBeInTheDocument();
		// The one thing a row being reordered is for: which project it is.
		expect(screen.getByText("My Project")).toBeInTheDocument();
		expect(screen.getByText("Second Project")).toBeInTheDocument();
	});

	it("hides the path so the row is a single line", async () => {
		renderWithProjects([mockProject, second]);
		expect(await screen.findByTitle("/home/user/my-project")).toBeInTheDocument();
		startDragging("My Project");
		expect(screen.queryByTitle("/home/user/my-project")).not.toBeInTheDocument();
	});

	it("restores the full rows when the drag ends", async () => {
		renderWithProjects([mockProject, second]);
		expect(await screen.findByText(getTaskTitle(mockTask))).toBeInTheDocument();
		const row = screen.getByText("My Project").closest('[data-help-id="dashboard.project-row"]')!;
		const grip = row.querySelector('[title="Drag to reorder project"]')!;
		fireEvent.dragStart(grip, { dataTransfer: { setData: vi.fn(), effectAllowed: "" } });
		fireEvent.dragEnd(grip);
		expect(screen.getByText(getTaskTitle(mockTask))).toBeInTheDocument();
		expect(screen.getByTestId("project-open-board-p1")).toBeInTheDocument();
	});
});

// The row's whole left half already navigated into the board, but nothing said
// so and nothing said what the board holds that this screen does not.
describe("ActivityOverview — the board footer", () => {
	it("offers Open board even on a project with nothing active", async () => {
		mockedApi.request.getAllProjectTasks.mockResolvedValue([
			{ projectId: "p1", tasks: [], todoCount: 0 },
		]);
		renderWithProjects([mockProject]);
		expect(await screen.findByTestId("project-open-board-p1")).toHaveTextContent("Open board");
	});

	it("states the work parked on the board that this screen never lists", async () => {
		mockedApi.request.getAllProjectTasks.mockResolvedValue([
			{ projectId: "p1", tasks: [], todoCount: 42 },
		]);
		renderWithProjects([mockProject]);
		expect(await screen.findByTestId("project-todo-count-p1")).toHaveTextContent("42 in To Do");
	});

	it("says nothing rather than zero when the board is empty", async () => {
		mockedApi.request.getAllProjectTasks.mockResolvedValue([
			{ projectId: "p1", tasks: [], todoCount: 0 },
		]);
		renderWithProjects([mockProject]);
		await screen.findByTestId("project-open-board-p1");
		expect(screen.queryByTestId("project-todo-count-p1")).not.toBeInTheDocument();
	});

	it("opens that project's board", async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();
		mockedApi.request.getAllProjectTasks.mockResolvedValue([
			{ projectId: "p1", tasks: [], todoCount: 3 },
		]);
		renderWithProjects([mockProject], navigate);
		await user.click(await screen.findByTestId("project-open-board-p1"));
		expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p1" });
	});
});
