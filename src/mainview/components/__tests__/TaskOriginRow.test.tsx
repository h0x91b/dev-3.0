import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import type { Project, Task, TaskLineageIndex } from "../../../shared/types";
import TaskOriginRow from "../TaskOriginRow";
import type { Route } from "../../state";
import LineageFilterNotice from "../LineageFilterNotice";
import { EMPTY_LINEAGE } from "../../utils/taskLineage";

const lineageIndex = vi.hoisted(() => ({
	current: {
		nodes: [{ id: "parent", projectId: "p2", projectName: "Coordinators", seq: 1801, variantIndex: 2, status: "in-progress", title: "Coordinate" }],
		edges: [{ childId: "child", parentId: "parent" }],
	} as TaskLineageIndex,
}));
vi.mock("../../rpc", () => ({ api: { request: { getTaskLineage: vi.fn(async () => lineageIndex.current) } } }));

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "child", seq: 5, projectId: "p1", title: "Child", description: "", status: "todo", baseBranch: "main",
		worktreePath: null, branchName: null, groupId: null, variantIndex: null, agentId: null, configId: null,
		createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z", ...overrides,
	};
}

async function renderRow(task: Task, navigate?: (route: Route) => void) {
	await act(async () => {
		render(
			<I18nProvider>
				<div className="grid">
					<TaskOriginRow task={task} navigate={navigate} />
				</div>
			</I18nProvider>,
		);
	});
}

describe("TaskOriginRow", () => {
	it("links to the parent with its variant seq and project", async () => {
		const navigate = vi.fn();
		await renderRow(makeTask({ origin: { kind: "task", taskId: "parent", projectId: "p2" } }), navigate);
		const link = await screen.findByTestId("task-origin-row-link");
		expect(screen.getByText("Created by")).toBeTruthy();
		expect(link.textContent).toBe("#1801-2 · Coordinators");
		await userEvent.click(link);
		expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p2", taskDetailId: "parent" });
	});

	it("says the parent was deleted once the index no longer has it", async () => {
		await renderRow(makeTask({ origin: { kind: "task", taskId: "gone", projectId: "p2" } }));
		await waitFor(() => expect(screen.getByTestId("task-origin-row").textContent).toBe("a task (deleted)"));
	});

	it("names an automation and an import, and renders nothing for the user", async () => {
		await renderRow(makeTask({ origin: { kind: "automation" }, automationId: "a1" }));
		expect(screen.getByTestId("task-origin-row").textContent).toBe("an automation");
		document.body.innerHTML = "";
		await renderRow(makeTask());
		expect(screen.queryByText("Created by")).toBeNull();
	});
});

describe("LineageFilterNotice", () => {
	const twinA = { id: "aaaaaaaa-1", name: "twin" } as Project;
	const twinB = { id: "bbbbbbbb-2", name: "twin" } as Project;

	it("asks to pick a project when the name in the token is ambiguous", async () => {
		const onPickProject = vi.fn();
		render(
			<I18nProvider>
				<LineageFilterNotice
					searchQuery="children:twin/7"
					lineage={EMPTY_LINEAGE}
					allProjects={[twinA, twinB]}
					boardProjectIds={new Set(["aaaaaaaa-1"])}
					currentProjectId="aaaaaaaa-1"
					onOpenProject={vi.fn()}
					onPickProject={onPickProject}
				/>
			</I18nProvider>,
		);
		expect(screen.getByTestId("lineage-filter-notice").textContent).toContain("Several projects are named “twin”");
		await userEvent.click(screen.getByRole("button", { name: "children:bbbbbbbb/7" }));
		expect(onPickProject).toHaveBeenCalledWith({ projectId: "bbbbbbbb-2", seq: 7 });
	});
});
