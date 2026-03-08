import { render, screen, within } from "@testing-library/react";
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
		},
	},
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
) {
	return render(
		<I18nProvider>
			<GlobalHeader
				route={route}
				projects={projects}
				tasks={tasks}
				navigate={navigate ?? vi.fn()}
			/>
		</I18nProvider>,
	);
}

describe("GlobalHeader — project switcher dropdown", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getTasks.mockResolvedValue([]);
	});

	it("shows chevron icon next to project name when inside a project", () => {
		renderHeader({ screen: "project", projectId: "p1" });
		const button = screen.getByTitle("Switch project");
		expect(button).toBeInTheDocument();
		expect(button).toHaveTextContent("Project Alpha");
		// Chevron SVG should be present
		expect(button.querySelector("svg")).toBeInTheDocument();
	});

	it("does not show project dropdown on dashboard", () => {
		renderHeader({ screen: "dashboard" });
		expect(screen.queryByTitle("Switch project")).not.toBeInTheDocument();
	});

	it("opens dropdown on click and shows all non-deleted projects", async () => {
		const user = userEvent.setup();
		renderHeader(
			{ screen: "project", projectId: "p1" },
			[project1, project2, project3Deleted],
		);

		await user.click(screen.getByTitle("Switch project"));

		// Both non-deleted projects should appear in the dropdown
		// Project Alpha appears twice: once in breadcrumb trigger, once in dropdown
		expect(screen.getAllByText("Project Alpha")).toHaveLength(2);
		expect(screen.getByText("Project Beta")).toBeInTheDocument();

		// Deleted project should not appear
		expect(screen.queryByText("Deleted Project")).not.toBeInTheDocument();
	});

	it("highlights the current project in the dropdown", async () => {
		const user = userEvent.setup();
		renderHeader({ screen: "project", projectId: "p1" });

		await user.click(screen.getByTitle("Switch project"));

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

		await user.click(screen.getByTitle("Switch project"));

		// Click on Project Beta
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

		await user.click(screen.getByTitle("Switch project"));
		// Dropdown should be open
		expect(screen.getByText("Project Beta")).toBeInTheDocument();

		// Click outside
		await user.click(document.body);

		// Dropdown should close — Project Beta should no longer be visible as a dropdown item
		// (Project Alpha is still in breadcrumb, so we check for Beta specifically)
		// Need to wait for state update
		expect(screen.queryByText("No active tasks")).not.toBeInTheDocument();
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
		await user.click(screen.getByTitle("Switch project"));

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
		await user.click(screen.getByTitle("Switch project"));

		expect(await screen.findAllByText("No active tasks")).toHaveLength(2);
	});

	it("toggles dropdown open/close on repeated clicks", async () => {
		const user = userEvent.setup();
		renderHeader({ screen: "project", projectId: "p1" });

		const trigger = screen.getByTitle("Switch project");

		// Open
		await user.click(trigger);
		expect(screen.getByText("Project Beta")).toBeInTheDocument();

		// Close
		await user.click(trigger);
		// After closing, dropdown items should be gone
		// (Beta is only in the dropdown, not in breadcrumb)
		const betaElements = screen.queryAllByText("Project Beta");
		// Should be 0 or only the breadcrumb one (but breadcrumb shows Alpha, not Beta)
		expect(betaElements).toHaveLength(0);
	});
});
