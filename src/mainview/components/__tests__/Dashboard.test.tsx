import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dashboard from "../Dashboard";
import { I18nProvider } from "../../i18n";
import type { Project } from "../../../shared/types";
import type { AppAction, Route } from "../../state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			removeProject: vi.fn(),
			showConfirm: vi.fn(),
			getAllProjectTasks: vi.fn(() => Promise.resolve([])),
		},
	},
}));

import { api } from "../../rpc";

const mockedApi = vi.mocked(api, true);

function renderDashboard(
	projects: Project[] = [],
	dispatch?: React.Dispatch<AppAction>,
	navigate?: (route: Route) => void,
	onOpenAddProject?: () => void,
) {
	return render(
		<I18nProvider>
			<Dashboard
				projects={projects}
				dispatch={dispatch ?? vi.fn()}
				navigate={navigate ?? vi.fn()}
				bellCounts={new Map()}
				onOpenAddProject={onOpenAddProject ?? vi.fn()}
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
	});

	describe("empty state", () => {
		it("shows empty state message", () => {
			renderDashboard();
			expect(screen.getByText("No projects yet")).toBeInTheDocument();
			expect(screen.getByText("Add a git repository to get started")).toBeInTheDocument();
		});

		it("calls onOpenAddProject when Add Project is clicked", async () => {
			const user = userEvent.setup();
			const onOpenAddProject = vi.fn();

			renderDashboard([], vi.fn(), vi.fn(), onOpenAddProject);
			await user.click(screen.getByText("Add Project"));

			expect(onOpenAddProject).toHaveBeenCalled();
		});
	});

	describe("project list", () => {
		it("renders project name and path on the activity list", async () => {
			renderDashboard([mockProject], vi.fn(), vi.fn(), vi.fn());

			expect(await screen.findByText("My Project")).toBeInTheDocument();
			expect(screen.getByText("/home/user/my-project")).toBeInTheDocument();
		});

		it("shows project count", async () => {
			renderDashboard([mockProject], vi.fn(), vi.fn(), vi.fn());
			expect(await screen.findByText("1 project")).toBeInTheDocument();
		});

		it("shows plural count for multiple projects", async () => {
			const projects = [
				mockProject,
				{ ...mockProject, id: "p2", name: "Second" },
			];

			renderDashboard(projects, vi.fn(), vi.fn(), vi.fn());
			expect(await screen.findByText("2 projects")).toBeInTheDocument();
		});
	});

	describe("remove project flow", () => {
		it("dispatches removeProject after confirm", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();

			mockedApi.request.showConfirm.mockResolvedValue(true);
			mockedApi.request.removeProject.mockResolvedValue(undefined);

			renderDashboard([mockProject], dispatch, vi.fn(), vi.fn());
			await screen.findByText("My Project");
			await user.click(screen.getByTitle("Remove"));

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

			renderDashboard([mockProject], dispatch, vi.fn(), vi.fn());
			await screen.findByText("My Project");
			await user.click(screen.getByTitle("Remove"));

			expect(mockedApi.request.removeProject).not.toHaveBeenCalled();
			expect(dispatch).not.toHaveBeenCalled();
		});
	});

	describe("navigation", () => {
		it("navigates to project on card click", async () => {
			const user = userEvent.setup();
			const navigate = vi.fn();

			renderDashboard([mockProject], vi.fn(), navigate, vi.fn());
			await user.click(await screen.findByText("My Project"));

			expect(navigate).toHaveBeenCalledWith({
				screen: "project",
				projectId: "p1",
			});
		});
	});
});
