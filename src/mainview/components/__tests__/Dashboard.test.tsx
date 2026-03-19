import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dashboard from "../Dashboard";
import { I18nProvider } from "../../i18n";
import type { Project } from "../../../shared/types";
import type { AppAction, Route } from "../../state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			pickFolder: vi.fn(),
			addProject: vi.fn(),
			cloneAndAddProject: vi.fn(),
			removeProject: vi.fn(),
			showConfirm: vi.fn(),
			getAllProjectTasks: vi.fn(() => Promise.resolve([])),
			getGlobalSettings: vi.fn(() => Promise.resolve({
				defaultAgentId: "builtin-claude",
				defaultConfigId: "claude-default",
				taskDropPosition: "top",
				updateChannel: "stable",
			})),
			saveGlobalSettings: vi.fn(),
		},
	},
}));

import { api } from "../../rpc";

const mockedApi = vi.mocked(api, true);

function renderDashboard(
	projects: Project[] = [],
	dispatch?: React.Dispatch<AppAction>,
	navigate?: (route: Route) => void,
) {
	return render(
		<I18nProvider>
			<Dashboard
				projects={projects}
				dispatch={dispatch ?? vi.fn()}
				navigate={navigate ?? vi.fn()}
				bellCounts={new Map()}
			/>
		</I18nProvider>,
	);
}

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

describe("Dashboard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		sessionStorage.removeItem("dev3-dashboard-tab");
	});

	describe("empty state", () => {
		it("shows empty state message", () => {
			renderDashboard();
			expect(screen.getByText("No projects yet")).toBeInTheDocument();
			expect(
				screen.getByText("Add a git repository to get started"),
			).toBeInTheDocument();
		});

		it("shows add project button", () => {
			renderDashboard();
			expect(
				screen.getByText("Add Project"),
			).toBeInTheDocument();
		});
	});

	describe("project list", () => {
		it("renders project name and path", async () => {
			const user = userEvent.setup();
			renderDashboard([mockProject]);
			await user.click(screen.getByText("Projects"));
			expect(screen.getByText("My Project")).toBeInTheDocument();
			expect(
				screen.getByText("/home/user/my-project"),
			).toBeInTheDocument();
		});

		it("shows project count", async () => {
			const user = userEvent.setup();
			renderDashboard([mockProject]);
			await user.click(screen.getByText("Projects"));
			expect(screen.getByText("1 project")).toBeInTheDocument();
		});

		it("shows plural count for multiple projects", async () => {
			const user = userEvent.setup();
			const projects = [
				mockProject,
				{ ...mockProject, id: "p2", name: "Second" },
			];
			renderDashboard(projects);
			await user.click(screen.getByText("Projects"));
			expect(screen.getByText("2 projects")).toBeInTheDocument();
		});
	});

	describe("add project flow", () => {
		it("opens AddProjectModal on Add Project click", async () => {
			const user = userEvent.setup();
			renderDashboard([], vi.fn());
			await user.click(screen.getByText("Add Project"));

			// Modal should appear with tabs
			expect(screen.getByText("Local Folder")).toBeInTheDocument();
			expect(screen.getByText("Clone from URL")).toBeInTheDocument();
		});

		it("browses local folder through modal", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();

			mockedApi.request.pickFolder.mockResolvedValue("/new/path");
			mockedApi.request.addProject.mockResolvedValue({
				ok: true as const,
				project: {
					...mockProject,
					id: "p-new",
					name: "path",
					path: "/new/path",
				},
			});

			renderDashboard([], dispatch);
			await user.click(screen.getByText("Add Project"));
			// Click Browse in the Local Folder tab
			await user.click(screen.getByText("Browse..."));

			expect(mockedApi.request.pickFolder).toHaveBeenCalled();
			expect(mockedApi.request.addProject).toHaveBeenCalledWith({
				path: "/new/path",
				name: "path",
			});
			expect(dispatch).toHaveBeenCalledWith({
				type: "addProject",
				project: expect.objectContaining({ id: "p-new" }),
			});
		});
	});

	describe("remove project flow", () => {
		it("dispatches removeProject after confirm", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();

			mockedApi.request.showConfirm.mockResolvedValue(true);
			mockedApi.request.removeProject.mockResolvedValue(undefined);

			renderDashboard([mockProject], dispatch);
			await user.click(screen.getByText("Projects"));

			const removeBtn = screen.getByTitle("Remove");
			await user.click(removeBtn);

			expect(mockedApi.request.showConfirm).toHaveBeenCalled();
			expect(mockedApi.request.removeProject).toHaveBeenCalledWith({
				projectId: "p1",
			});
			expect(dispatch).toHaveBeenCalledWith({
				type: "removeProject",
				projectId: "p1",
			});
		});

		it("does nothing when confirm is cancelled", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();

			mockedApi.request.showConfirm.mockResolvedValue(false);

			renderDashboard([mockProject], dispatch);
			await user.click(screen.getByText("Projects"));
			await user.click(screen.getByTitle("Remove"));

			expect(mockedApi.request.removeProject).not.toHaveBeenCalled();
			expect(dispatch).not.toHaveBeenCalled();
		});
	});

	describe("tab persistence", () => {
		it("defaults to activity tab when no saved preference", () => {
			renderDashboard([mockProject]);
			// Activity tab should be active (has bg-elevated class)
			const activityBtn = screen.getByText("Activity");
			expect(activityBtn.className).toContain("bg-elevated");
		});

		it("restores saved tab from sessionStorage", () => {
			sessionStorage.setItem("dev3-dashboard-tab", "projects");
			renderDashboard([mockProject]);
			const projectsBtn = screen.getByText("Projects");
			expect(projectsBtn.className).toContain("bg-elevated");
		});

		it("saves tab to sessionStorage when switched", async () => {
			const user = userEvent.setup();
			renderDashboard([mockProject]);
			await user.click(screen.getByText("Projects"));
			expect(sessionStorage.getItem("dev3-dashboard-tab")).toBe("projects");
		});

		it("ignores invalid saved tab values", () => {
			sessionStorage.setItem("dev3-dashboard-tab", "bogus");
			renderDashboard([mockProject]);
			const activityBtn = screen.getByText("Activity");
			expect(activityBtn.className).toContain("bg-elevated");
		});

		it("does not persist tab across app restarts (localStorage)", () => {
			localStorage.setItem("dev3-dashboard-tab", "projects");
			renderDashboard([mockProject]);
			// Should ignore localStorage and default to activity
			const activityBtn = screen.getByText("Activity");
			expect(activityBtn.className).toContain("bg-elevated");
		});
	});

	describe("navigation", () => {
		it("navigates to project on card click", async () => {
			const user = userEvent.setup();
			const navigate = vi.fn();

			renderDashboard([mockProject], vi.fn(), navigate);
			await user.click(screen.getByText("Projects"));

			await user.click(screen.getByText("My Project"));

			expect(navigate).toHaveBeenCalledWith({
				screen: "project",
				projectId: "p1",
			});
		});
	});
});
