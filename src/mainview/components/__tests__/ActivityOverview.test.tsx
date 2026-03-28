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
) {
	return render(
		<I18nProvider>
			<ActivityOverview
				projects={[mockProject]}
				navigate={navigate}
				bellCounts={new Map()}
				onRemoveProject={onRemoveProject}
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
		renderActivityOverview(vi.fn(), vi.fn());

		await screen.findByText("My Project");

		expect(screen.getByTitle("Project Settings")).toBeInTheDocument();
		expect(screen.getByTitle("Open in Finder")).toBeInTheDocument();
		expect(screen.getByTitle("Open a terminal in the project root")).toBeInTheDocument();
		expect(screen.getByTitle("Remove")).toBeInTheDocument();
	});

	it("renders project quick actions before the activity count", async () => {
		renderActivityOverview(vi.fn(), vi.fn());

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

		renderActivityOverview(navigate, onRemoveProject);
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
});
