import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dashboard from "../Dashboard";
import { I18nProvider } from "../../i18n";
import type { Project } from "../../../shared/types";
import type { AppAction, Route } from "../../state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			removeProject: vi.fn(),
			reorderProjects: vi.fn(),
			getAllProjectTasks: vi.fn(() => Promise.resolve([])),
			getSpaces: vi.fn(() => Promise.resolve({ version: 1, spaces: [], order: [] })),
			reorderSpaces: vi.fn(),
			reorderSpaceProjects: vi.fn(),
			setProjectSpaces: vi.fn(),
			createSpace: vi.fn(),
			getGlobalSettings: vi.fn(() => Promise.resolve({ tipsDisabled: true })),
			getTipState: vi.fn(() => Promise.resolve({ snoozedUntil: 0, seen: {}, rotationIndex: 0 })),
			updateTipState: vi.fn((s) => Promise.resolve({ snoozedUntil: 0, seen: {}, rotationIndex: 0, ...s })),
			setTaskPriority: vi.fn(() => Promise.resolve([])),
			getTerminalPreview: vi.fn(),
		},
	},
}));

import { api } from "../../rpc";
import { confirm } from "../../confirm";

vi.mock("../../confirm", () => ({
	confirm: vi.fn(),
	ConfirmHost: () => null,
}));

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
		mockedApi.request.getAllProjectTasks.mockResolvedValue([]);
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
			await user.click(screen.getByText("Add project"));

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

		it("keeps the persisted project order instead of sorting by active task count", async () => {
			mockedApi.request.getAllProjectTasks.mockResolvedValue([
				{
					projectId: "p2",
					tasks: [{
						id: "t1",
						projectId: "p2",
						title: "Active",
						description: "Active",
						status: "in-progress",
						movedAt: "2026-04-29T00:00:00.000Z",
					}],
				},
			] as any);
			const projects = [
				mockProject,
				{ ...mockProject, id: "p2", name: "Second", path: "/home/user/second" },
			];

			renderDashboard(projects, vi.fn(), vi.fn(), vi.fn());
			const first = await screen.findByText("My Project");
			const second = await screen.findByText("Second");

			expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		});

		it("moves a project up and persists the new order", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();
			const projects = [
				mockProject,
				{ ...mockProject, id: "p2", name: "Second", path: "/home/user/second" },
				{ ...mockProject, id: "p3", name: "Third", path: "/home/user/third" },
			];
			mockedApi.request.reorderProjects.mockResolvedValue([projects[1], projects[0], projects[2]]);

			renderDashboard(projects, dispatch, vi.fn(), vi.fn());
			await screen.findByText("Second");
			await user.click(screen.getAllByTitle("Move project up")[1]);

			expect(dispatch).toHaveBeenCalledWith({
				type: "reorderProjects",
				projectIds: ["p2", "p1", "p3"],
			});
			expect(mockedApi.request.reorderProjects).toHaveBeenCalledWith({
				projectIds: ["p2", "p1", "p3"],
			});
			await waitFor(() => {
				expect(dispatch).toHaveBeenCalledWith({
					type: "setProjects",
					projects: [projects[1], projects[0], projects[2]],
				});
			});
		});
	});

	describe("remove project flow", () => {
		it("dispatches removeProject after confirm", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();

			vi.mocked(confirm).mockResolvedValue(true);
			mockedApi.request.removeProject.mockResolvedValue(undefined);

			renderDashboard([mockProject], dispatch, vi.fn(), vi.fn());
			await screen.findByText("My Project");
			await user.click(screen.getByTitle("Remove"));

			expect(vi.mocked(confirm)).toHaveBeenCalled();
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

			vi.mocked(confirm).mockResolvedValue(false);

			renderDashboard([mockProject], dispatch, vi.fn(), vi.fn());
			await screen.findByText("My Project");
			await user.click(screen.getByTitle("Remove"));

			expect(mockedApi.request.removeProject).not.toHaveBeenCalled();
			expect(dispatch).not.toHaveBeenCalled();
		});
	});

	describe("space selection vs the hidden rail", () => {
		const RAIL_QUERY = "(max-width: 1023px)";
		let originalMatchMedia: typeof window.matchMedia;
		let railQueryMatches: boolean;
		let railQueryListeners: Array<(e: { matches: boolean }) => void>;

		beforeEach(() => {
			originalMatchMedia = window.matchMedia;
			railQueryMatches = false;
			railQueryListeners = [];
			Object.defineProperty(window, "matchMedia", {
				configurable: true,
				value: (query: string) => ({
					get matches() {
						return query === RAIL_QUERY ? railQueryMatches : false;
					},
					media: query,
					onchange: null,
					addEventListener: (_: string, handler: (e: { matches: boolean }) => void) => {
						if (query === RAIL_QUERY) railQueryListeners.push(handler);
					},
					removeEventListener: vi.fn(),
					addListener: vi.fn(),
					removeListener: vi.fn(),
					dispatchEvent: vi.fn(),
				}),
			});
		});

		afterEach(() => {
			Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
		});

		it("clears the selected space when the viewport drops below the rail breakpoint", async () => {
			const user = userEvent.setup();
			const projects = [
				mockProject,
				{ ...mockProject, id: "p2", name: "Second", path: "/home/user/second" },
			];
			mockedApi.request.getSpaces.mockResolvedValue({
				version: 1,
				spaces: [
					{ id: "s1", name: "Client X", projectIds: ["p1"], createdAt: "2026-08-01T00:00:00Z" },
				],
				order: ["s1"],
			} as any);

			renderDashboard(projects, vi.fn(), vi.fn(), vi.fn());
			await user.click(await screen.findByTestId("rail-space-s1"));

			// The selection filters the overview down to the space's member.
			expect(screen.getByText("My Project")).toBeInTheDocument();
			expect(screen.queryByText("Second")).not.toBeInTheDocument();

			// The rail hides below `lg` via CSS; the filter must not survive it.
			railQueryMatches = true;
			act(() => {
				for (const notify of railQueryListeners) notify({ matches: true });
			});

			expect(await screen.findByText("Second")).toBeInTheDocument();
			expect(screen.getByText("My Project")).toBeInTheDocument();
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

	// The project rows already list every task waiting on the user, so a panel
	// beside them rendered the same rows twice. It stays in the project view,
	// where the centre is a board rather than a task list.
	describe("no cross-project task panel", () => {
		it("renders no Active tasks panel, even with spaces in play", async () => {
			mockedApi.request.getSpaces.mockResolvedValue({
				version: 1,
				spaces: [{ id: "sp_a", name: "Client X", parentId: null, projectIds: ["p1"], createdAt: 1 }],
				order: ["sp_a"],
			});
			renderDashboard([mockProject], vi.fn(), vi.fn(), vi.fn());
			await screen.findByText("My Project");
			expect(screen.queryByRole("navigation", { name: /active tasks/i })).not.toBeInTheDocument();
		});
	});

	// The rail owns `New space`; the header only carries a fallback while the
	// rail is off screen — which is where a first-time user with zero spaces is.
	describe("New space entry point", () => {
		it("keeps the header fallback when there is no rail yet", async () => {
			// Pinned explicitly: `clearAllMocks` keeps implementations, so a
			// sibling test's spaces would leak in and hide the rail-less case.
			mockedApi.request.getSpaces.mockResolvedValue({ version: 1, spaces: [], order: [] });
			renderDashboard([mockProject], vi.fn(), vi.fn(), vi.fn());
			await screen.findByText("My Project");
			expect(screen.getByTestId("dashboard-new-space")).toBeInTheDocument();
			expect(screen.queryByTestId("spaces-rail")).not.toBeInTheDocument();
		});

		it("drops the header fallback once the rail is on screen", async () => {
			mockedApi.request.getSpaces.mockResolvedValue({
				version: 1,
				spaces: [{ id: "sp_a", name: "Client X", parentId: null, projectIds: ["p1"], createdAt: 1 }],
				order: ["sp_a"],
			});
			renderDashboard([mockProject], vi.fn(), vi.fn(), vi.fn());
			await screen.findByTestId("spaces-rail");
			expect(screen.queryByTestId("dashboard-new-space")).not.toBeInTheDocument();
			expect(screen.getByTestId("rail-new-space")).toBeInTheDocument();
		});
	});
});
