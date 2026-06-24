import { render, screen, waitFor } from "@testing-library/react";
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

	it("opens the add project flow from the activity header", async () => {
		const user = userEvent.setup();
		const onOpenAddProject = vi.fn();

		renderActivityOverview(vi.fn(), vi.fn(), onOpenAddProject);

		await screen.findByText("My Project");
		await user.click(screen.getByRole("button", { name: "Add Project" }));

		expect(onOpenAddProject).toHaveBeenCalled();
	});
});
