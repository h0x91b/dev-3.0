import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GlobalHeader from "../GlobalHeader";
import { I18nProvider } from "../../i18n";
import type { Project, Task } from "../../../shared/types";
import type { Route } from "../../state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getTasks: vi.fn(),
			applyUpdate: vi.fn(),
			saveUpdateRoute: vi.fn(),
			renameTask: vi.fn(),
		},
	},
}));

vi.mock("../../analytics", () => ({
	trackEvent: vi.fn(),
}));

import { api } from "../../rpc";

const mockedApi = vi.mocked(api, true);

const project1: Project = {
	id: "p1",
	name: "Project Alpha",
	path: "/home/user/alpha",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

const project2: Project = {
	id: "p2",
	name: "Project Beta",
	path: "/home/user/beta",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-02T00:00:00Z",
};

const project3Deleted: Project = {
	id: "p3",
	name: "Deleted Project",
	path: "/home/user/deleted",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-03T00:00:00Z",
	deleted: true,
};

function renderHeader(
	route: Route,
	projects: Project[] = [project1, project2],
	navigate?: (route: Route) => void,
	tasks: Task[] = [],
	extra?: { updateVersion?: string | null; updateDownloadStatus?: string | null },
) {
	return render(
		<I18nProvider>
			<GlobalHeader
				route={route}
				projects={projects}
				tasks={tasks}
				navigate={navigate ?? vi.fn()}
				updateVersion={extra?.updateVersion}
				updateDownloadStatus={extra?.updateDownloadStatus}
			/>
		</I18nProvider>,
	);
}

function getChevronButton() {
	return screen.getByLabelText("Switch project");
}

describe("GlobalHeader — project switcher dropdown", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getTasks.mockResolvedValue([]);
	});

	it("shows chevron button next to project name when inside a project", () => {
		renderHeader({ screen: "project", projectId: "p1" });
		const chevron = getChevronButton();
		expect(chevron).toBeInTheDocument();
		// Project name text is rendered separately from the chevron
		expect(screen.getByText("Project Alpha")).toBeInTheDocument();
	});

	it("does not show project dropdown on dashboard", () => {
		renderHeader({ screen: "dashboard" });
		expect(screen.queryByLabelText("Switch project")).not.toBeInTheDocument();
	});

	it("project name click navigates to project board (restores from split view)", async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();
		renderHeader(
			{ screen: "project", projectId: "p1", activeTaskId: "t1" },
			[project1, project2],
			navigate,
			[{ id: "t1", seq: 1, title: "Task 1", status: "in-progress" } as Task],
		);

		// Click the project name text (not the chevron)
		await user.click(screen.getByText("Project Alpha"));

		expect(navigate).toHaveBeenCalledWith({
			screen: "project",
			projectId: "p1",
		});
	});

	it("opens dropdown on chevron click and shows all non-deleted projects", async () => {
		const user = userEvent.setup();
		renderHeader(
			{ screen: "project", projectId: "p1" },
			[project1, project2, project3Deleted],
		);

		await user.click(getChevronButton());

		// Both non-deleted projects should appear in the dropdown
		// Project Alpha appears twice: once in breadcrumb, once in dropdown
		expect(screen.getAllByText("Project Alpha")).toHaveLength(2);
		expect(screen.getByText("Project Beta")).toBeInTheDocument();

		// Deleted project should not appear
		expect(screen.queryByText("Deleted Project")).not.toBeInTheDocument();
	});

	it("highlights the current project in the dropdown", async () => {
		const user = userEvent.setup();
		renderHeader({ screen: "project", projectId: "p1" });

		await user.click(getChevronButton());

		// Find the dropdown buttons — the current project should have accent styling
		const alphaBtn = screen.getAllByRole("button").find(
			(b) => b.textContent?.includes("Project Alpha") && b.className.includes("bg-accent"),
		);
		expect(alphaBtn).toBeDefined();
	});

	it("navigates to selected project and closes dropdown", async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();
		renderHeader({ screen: "project", projectId: "p1" }, [project1, project2], navigate);

		await user.click(getChevronButton());

		// Click on Project Beta in the dropdown
		const betaBtn = screen.getAllByRole("button").find(
			(b) => b.textContent?.includes("Project Beta"),
		);
		expect(betaBtn).toBeDefined();
		await user.click(betaBtn!);

		expect(navigate).toHaveBeenCalledWith({
			screen: "project",
			projectId: "p2",
		});
	});

	it("closes dropdown on outside click", async () => {
		const user = userEvent.setup();
		renderHeader({ screen: "project", projectId: "p1" });

		await user.click(getChevronButton());
		// Dropdown should be open — Project Beta is only visible in the dropdown
		expect(screen.getByText("Project Beta")).toBeInTheDocument();

		// Click outside
		await user.click(document.body);

		// Dropdown should close — Project Beta should no longer be visible
		expect(screen.queryByText("Project Beta")).not.toBeInTheDocument();
	});

	it("closes dropdown on Escape key", async () => {
		const user = userEvent.setup();
		renderHeader({ screen: "project", projectId: "p1" });

		await user.click(getChevronButton());
		expect(screen.getByText("Project Beta")).toBeInTheDocument();

		await user.keyboard("{Escape}");

		expect(screen.queryByText("Project Beta")).not.toBeInTheDocument();
	});

	it("fetches task counts when dropdown opens", async () => {
		const user = userEvent.setup();
		mockedApi.request.getTasks.mockImplementation(async ({ projectId }) => {
			if (projectId === "p1") {
				return [
					{ id: "t1", status: "in-progress" } as Task,
					{ id: "t2", status: "completed" } as Task,
				];
			}
			return [
				{ id: "t3", status: "in-progress" } as Task,
				{ id: "t4", status: "user-questions" } as Task,
				{ id: "t5", status: "review-by-user" } as Task,
			];
		});

		renderHeader({ screen: "project", projectId: "p1" });
		await user.click(getChevronButton());

		// Wait for counts to load
		expect(await screen.findByText("1 active")).toBeInTheDocument();
		expect(await screen.findByText("3 active")).toBeInTheDocument();
	});

	it("shows 'No active tasks' for projects with zero active tasks", async () => {
		const user = userEvent.setup();
		mockedApi.request.getTasks.mockResolvedValue([
			{ id: "t1", status: "completed" } as Task,
		]);

		renderHeader({ screen: "project", projectId: "p1" });
		await user.click(getChevronButton());

		expect(await screen.findAllByText("No active tasks")).toHaveLength(2);
	});

	it("shows downloading indicator when updateDownloadStatus is downloading", () => {
		renderHeader(
			{ screen: "dashboard" },
			[project1, project2],
			vi.fn(),
			[],
			{ updateDownloadStatus: "downloading" },
		);
		expect(screen.getByText("Downloading...")).toBeInTheDocument();
	});

	it("shows checking indicator when updateDownloadStatus is checking", () => {
		renderHeader(
			{ screen: "dashboard" },
			[project1, project2],
			vi.fn(),
			[],
			{ updateDownloadStatus: "checking" },
		);
		expect(screen.getByText("Checking...")).toBeInTheDocument();
	});

	it("does not show download indicator when updateVersion is set (ready state)", () => {
		renderHeader(
			{ screen: "dashboard" },
			[project1, project2],
			vi.fn(),
			[],
			{ updateVersion: "1.2.3", updateDownloadStatus: "downloading" },
		);
		expect(screen.queryByText("Downloading...")).not.toBeInTheDocument();
		// Should show the "Update" ready button instead
		expect(screen.getByText("Update")).toBeInTheDocument();
	});

	it("does not show download indicator when status is error", () => {
		renderHeader(
			{ screen: "dashboard" },
			[project1, project2],
			vi.fn(),
			[],
			{ updateDownloadStatus: "error" },
		);
		expect(screen.queryByText("Downloading...")).not.toBeInTheDocument();
		expect(screen.queryByText("Checking...")).not.toBeInTheDocument();
	});

	it("toggles dropdown open/close on repeated chevron clicks", async () => {
		const user = userEvent.setup();
		renderHeader({ screen: "project", projectId: "p1" });

		const chevron = getChevronButton();

		// Open
		await user.click(chevron);
		expect(screen.getByText("Project Beta")).toBeInTheDocument();

		// Close
		await user.click(chevron);
		expect(screen.queryByText("Project Beta")).not.toBeInTheDocument();
	});
});

describe("GlobalHeader — breadcrumb inline rename", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getTasks.mockResolvedValue([]);
	});

	const taskForRename: Task = {
		id: "t1",
		seq: 42,
		projectId: "p1",
		title: "My Task Title",
		description: "",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: "/tmp/wt",
		branchName: "feat/test",
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
	};

	it("shows pencil icon on hover for task segment in full-page view", () => {
		renderHeader(
			{ screen: "task", projectId: "p1", taskId: "t1" },
			[project1],
			vi.fn(),
			[taskForRename],
		);
		expect(screen.getByText("My Task Title")).toBeInTheDocument();
		expect(screen.getByTitle("Edit title")).toBeInTheDocument();
	});

	it("shows pencil icon for task segment in split view", () => {
		renderHeader(
			{ screen: "project", projectId: "p1", activeTaskId: "t1" },
			[project1],
			vi.fn(),
			[taskForRename],
		);
		expect(screen.getByText("My Task Title")).toBeInTheDocument();
		expect(screen.getByTitle("Edit title")).toBeInTheDocument();
	});

	it("opens inline input on pencil click", async () => {
		const user = userEvent.setup();
		renderHeader(
			{ screen: "task", projectId: "p1", taskId: "t1" },
			[project1],
			vi.fn(),
			[taskForRename],
		);
		await user.click(screen.getByTitle("Edit title"));
		expect(screen.getByDisplayValue("My Task Title")).toBeInTheDocument();
	});

	it("saves new title on Enter", async () => {
		const user = userEvent.setup();
		const updatedTask = { ...taskForRename, customTitle: "New Name" };
		mockedApi.request.renameTask.mockResolvedValue(updatedTask);

		renderHeader(
			{ screen: "task", projectId: "p1", taskId: "t1" },
			[project1],
			vi.fn(),
			[taskForRename],
		);
		await user.click(screen.getByTitle("Edit title"));
		const input = screen.getByDisplayValue("My Task Title");
		await user.clear(input);
		await user.type(input, "New Name{Enter}");

		expect(mockedApi.request.renameTask).toHaveBeenCalledWith({
			taskId: "t1",
			projectId: "p1",
			customTitle: "New Name",
		});
	});

	it("cancels rename on cancel button click", async () => {
		const user = userEvent.setup();
		renderHeader(
			{ screen: "task", projectId: "p1", taskId: "t1" },
			[project1],
			vi.fn(),
			[taskForRename],
		);
		await user.click(screen.getByTitle("Edit title"));
		expect(screen.getByDisplayValue("My Task Title")).toBeInTheDocument();

		await user.click(screen.getByTestId("rename-cancel"));
		expect(screen.queryByDisplayValue("My Task Title")).not.toBeInTheDocument();
		expect(screen.getByText("My Task Title")).toBeInTheDocument();
	});

	it("does not save when title is unchanged", async () => {
		const user = userEvent.setup();
		renderHeader(
			{ screen: "task", projectId: "p1", taskId: "t1" },
			[project1],
			vi.fn(),
			[taskForRename],
		);
		await user.click(screen.getByTitle("Edit title"));
		await user.keyboard("{Enter}");
		expect(mockedApi.request.renameTask).not.toHaveBeenCalled();
	});
});

describe("GlobalHeader — update countdown", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockedApi.request.getTasks.mockResolvedValue([]);
		mockedApi.request.applyUpdate.mockResolvedValue(undefined as any);
		mockedApi.request.saveUpdateRoute.mockResolvedValue(undefined as any);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows countdown on restart button when update is available", () => {
		renderHeader(
			{ screen: "dashboard" },
			[project1],
			vi.fn(),
			[],
			{ updateVersion: "1.2.3" },
		);
		expect(screen.getByText(/Restart to Update \(300s\)/)).toBeInTheDocument();
	});

	it("decrements countdown every second", () => {
		renderHeader(
			{ screen: "dashboard" },
			[project1],
			vi.fn(),
			[],
			{ updateVersion: "1.2.3" },
		);
		expect(screen.getByText(/\(300s\)/)).toBeInTheDocument();

		act(() => { vi.advanceTimersByTime(3000); });
		expect(screen.getByText(/\(297s\)/)).toBeInTheDocument();
	});

	it("shows Postpone button instead of Later", () => {
		renderHeader(
			{ screen: "dashboard" },
			[project1],
			vi.fn(),
			[],
			{ updateVersion: "1.2.3" },
		);
		expect(screen.getByText("Postpone")).toBeInTheDocument();
		expect(screen.queryByText("Later")).not.toBeInTheDocument();
	});

	it("dismisses toast and stops countdown on Postpone click", () => {
		renderHeader(
			{ screen: "dashboard" },
			[project1],
			vi.fn(),
			[],
			{ updateVersion: "1.2.3" },
		);
		expect(screen.getByText(/Restart to Update/)).toBeInTheDocument();

		act(() => { fireEvent.click(screen.getByText("Postpone")); });

		// Toast should be dismissed
		expect(screen.queryByText(/Restart to Update \(\d+s\)/)).not.toBeInTheDocument();
	});

	it("auto-restarts when countdown reaches 0", async () => {
		renderHeader(
			{ screen: "dashboard" },
			[project1],
			vi.fn(),
			[],
			{ updateVersion: "1.2.3" },
		);

		act(() => { vi.advanceTimersByTime(300_000); });
		// Flush the async handleRestart (saveUpdateRoute → applyUpdate)
		await act(async () => { await vi.advanceTimersByTimeAsync(0); });

		expect(mockedApi.request.applyUpdate).toHaveBeenCalled();
	});

	it("saves current route via RPC before applying update", () => {
		renderHeader(
			{ screen: "project", projectId: "p1" },
			[project1],
			vi.fn(),
			[],
			{ updateVersion: "1.2.3" },
		);

		act(() => { vi.advanceTimersByTime(300_000); });

		expect(mockedApi.request.saveUpdateRoute).toHaveBeenCalledWith({
			route: JSON.stringify({ screen: "project", projectId: "p1" }),
		});
	});
});

describe("GlobalHeader — project terminal button", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getTasks.mockResolvedValue([]);
	});

	it("shows terminal button when inside a project", () => {
		renderHeader({ screen: "project", projectId: "p1" });
		expect(screen.getByText("Project Terminal")).toBeInTheDocument();
	});

	it("does not show terminal button on dashboard", () => {
		renderHeader({ screen: "dashboard" });
		expect(screen.queryByText("Project Terminal")).not.toBeInTheDocument();
	});

	it("terminal button has active style on project-terminal screen", () => {
		renderHeader({ screen: "project-terminal", projectId: "p1" });
		const btn = screen.getByTitle("Project Terminal (\u2318`)");
		expect(btn.className).toContain("text-accent");
	});

	it("clicking terminal button navigates to project-terminal", async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();
		renderHeader({ screen: "project", projectId: "p1" }, [project1, project2], navigate);
		await user.click(screen.getByTitle("Project Terminal (\u2318`)"));
		expect(navigate).toHaveBeenCalledWith({
			screen: "project-terminal",
			projectId: "p1",
		});
	});

	it("clicking terminal button when already on terminal navigates back to project", async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();
		renderHeader({ screen: "project-terminal", projectId: "p1" }, [project1, project2], navigate);
		await user.click(screen.getByTitle("Project Terminal (\u2318`)"));
		expect(navigate).toHaveBeenCalledWith({
			screen: "project",
			projectId: "p1",
		});
	});
});
