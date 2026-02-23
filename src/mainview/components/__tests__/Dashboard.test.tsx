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
			removeProject: vi.fn(),
		},
	},
}));

import { api } from "../../rpc";

const mockedApi = vi.mocked(api);

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
			/>
		</I18nProvider>,
	);
}

const mockProject: Project = {
	id: "p1",
	name: "My Project",
	path: "/home/user/my-project",
	setupScript: "",
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
		it("renders project name and path", () => {
			renderDashboard([mockProject]);
			expect(screen.getByText("My Project")).toBeInTheDocument();
			expect(
				screen.getByText("/home/user/my-project"),
			).toBeInTheDocument();
		});

		it("shows project count", () => {
			renderDashboard([mockProject]);
			expect(screen.getByText("1 project")).toBeInTheDocument();
		});

		it("shows plural count for multiple projects", () => {
			const projects = [
				mockProject,
				{ ...mockProject, id: "p2", name: "Second" },
			];
			renderDashboard(projects);
			expect(screen.getByText("2 projects")).toBeInTheDocument();
		});
	});

	describe("add project flow", () => {
		it("calls pickFolder and addProject on click", async () => {
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

		it("does nothing when pickFolder returns null", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();

			mockedApi.request.pickFolder.mockResolvedValue(null);

			renderDashboard([], dispatch);
			await user.click(screen.getByText("Add Project"));

			expect(mockedApi.request.addProject).not.toHaveBeenCalled();
			expect(dispatch).not.toHaveBeenCalled();
		});
	});

	describe("remove project flow", () => {
		it("dispatches removeProject after confirm", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();

			window.confirm = vi.fn(() => true);
			mockedApi.request.removeProject.mockResolvedValue(undefined);

			renderDashboard([mockProject], dispatch);

			const removeBtn = screen.getByText("Remove");
			await user.click(removeBtn);

			expect(window.confirm).toHaveBeenCalled();
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

			window.confirm = vi.fn(() => false);

			renderDashboard([mockProject], dispatch);
			await user.click(screen.getByText("Remove"));

			expect(mockedApi.request.removeProject).not.toHaveBeenCalled();
			expect(dispatch).not.toHaveBeenCalled();
		});
	});

	describe("navigation", () => {
		it("navigates to project on card click", async () => {
			const user = userEvent.setup();
			const navigate = vi.fn();

			renderDashboard([mockProject], vi.fn(), navigate);

			await user.click(screen.getByText("My Project"));

			expect(navigate).toHaveBeenCalledWith({
				screen: "project",
				projectId: "p1",
			});
		});
	});
});
