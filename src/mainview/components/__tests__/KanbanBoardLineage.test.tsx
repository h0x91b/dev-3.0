import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import KanbanBoard from "../KanbanBoard";
import { I18nProvider } from "../../i18n";
import type { Project, Task, TaskLineageIndex } from "../../../shared/types";
import { resetRememberedFiltersForTests } from "../../hooks/useRememberedFilter";

const lineageIndex = vi.hoisted(() => ({ current: { nodes: [], edges: [] } as TaskLineageIndex }));

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAgents: vi.fn().mockResolvedValue([]),
			getGlobalSettings: vi.fn().mockResolvedValue({ defaultAgentId: "builtin-claude", defaultConfigId: "claude-default", taskSortOrder: "oldest-first", updateChannel: "stable" }),
			getTipState: vi.fn().mockResolvedValue({ snoozedUntil: 0, seen: {}, rotationIndex: 0 }),
			updateTipState: vi.fn().mockResolvedValue({ snoozedUntil: 0, seen: {}, rotationIndex: 0 }),
			getProjectCurrentBranch: vi.fn().mockResolvedValue({ branch: "main", isBaseBranch: true, isDirty: false }),
			getProjectPRs: vi.fn().mockResolvedValue([]),
			getTaskLineage: vi.fn(async () => lineageIndex.current),
		},
	},
}));
vi.mock("../../analytics", () => ({ trackEvent: vi.fn(), agentNameFromId: vi.fn(() => "unknown") }));
vi.mock("../../toast", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

function makeProject(id: string, name: string): Project {
	return { id, name, path: `/tmp/${id}`, setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "2025-01-01T00:00:00Z" };
}
const HOME = makeProject("p1", "dev-3.0");
const BREW = makeProject("p2", "homebrew");

function makeTask(id: string, seq: number, overrides: Partial<Task> = {}): Task {
	return {
		id, seq, projectId: "p1", title: `Task ${seq}`, description: `Task ${seq}`, status: "todo",
		baseBranch: "main", worktreePath: null, branchName: null, groupId: null, variantIndex: null,
		agentId: null, configId: null, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
		customColumnId: null, labelIds: [], notes: [], history: [], ...overrides,
	};
}
const node = (t: Task, projectName = "dev-3.0") => ({ id: t.id, projectId: t.projectId, projectName, seq: t.seq, variantIndex: null, status: t.status, title: t.title });

const coordinator = makeTask("coord", 1801, { title: "Coordinate the release" });
const child = makeTask("child", 1802, { title: "Fix the CLI", origin: { kind: "task", taskId: "coord", projectId: "p1" } });
const mine = makeTask("mine", 1700, { title: "My own task" });
const brewChild = makeTask("brew-child", 9, { projectId: "p2", origin: { kind: "task", taskId: "coord", projectId: "p1" } });

async function renderBoard(navigate = vi.fn()) {
	await act(async () => {
		render(
			<I18nProvider>
				<KanbanBoard
					project={HOME}
					allProjects={[HOME, BREW]}
					tasks={[coordinator, child, mine]}
					dispatch={vi.fn()}
					navigate={navigate}
					bellCounts={new Map()}
					taskPorts={new Map()}
					taskDevServers={new Map()}
				/>
			</I18nProvider>,
		);
	});
	await waitFor(() => expect(screen.getByTestId("task-card-lineage-children")).toBeTruthy());
}

const card = (title: string) => (screen.queryByText(title)?.closest("[data-task-id]") ?? null) as HTMLElement | null;

describe("KanbanBoard lineage", () => {
	beforeEach(() => {
		localStorage.clear();
		resetRememberedFiltersForTests();
		lineageIndex.current = {
			nodes: [node(coordinator), node(child), node(brewChild, "homebrew")],
			edges: [{ childId: "child", parentId: "coord" }, { childId: "brew-child", parentId: "coord" }],
		};
	});

	it("marks the child with its parent and the parent with its child count; a user task gets nothing", async () => {
		await renderBoard();
		expect(within(card("Fix the CLI")!).getByTestId("task-card-lineage-parent").textContent).toContain("#1801");
		expect(within(card("Coordinate the release")!).getByTestId("task-card-lineage-children").textContent).toContain("2");
		expect(within(card("My own task")!).queryByTestId("task-card-lineage")).toBeNull();
	});

	it("clicking the parent marker filters to the parent and its children, and footnotes the other project", async () => {
		const navigate = vi.fn();
		await renderBoard(navigate);
		await userEvent.click(within(card("Fix the CLI")!).getByTestId("task-card-lineage-parent"));

		expect((screen.getByPlaceholderText("Search tasks...") as HTMLInputElement).value).toBe("children:1801");
		expect(card("Coordinate the release")).not.toBeNull();
		expect(card("Fix the CLI")).not.toBeNull();
		expect(card("My own task")).toBeNull();
		// No detail modal opened by the click.
		expect(screen.queryByRole("dialog")).toBeNull();

		const notice = screen.getByTestId("lineage-filter-notice");
		expect(notice.textContent).toContain("+1 in another project:");
		await userEvent.click(within(notice).getByRole("button", { name: /homebrew/ }));
		expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p2" });
		cleanup();
		await act(async () => {
			render(
				<I18nProvider>
					<KanbanBoard project={BREW} allProjects={[HOME, BREW]} tasks={[brewChild]} dispatch={vi.fn()} navigate={vi.fn()} bellCounts={new Map()} taskPorts={new Map()} taskDevServers={new Map()} />
				</I18nProvider>,
			);
		});
		expect((screen.getByPlaceholderText("Search tasks...") as HTMLInputElement).value).toBe("children:dev-3.0/1801");
	});

	it("clicking the child counter applies the same filter", async () => {
		await renderBoard();
		await userEvent.click(within(card("Coordinate the release")!).getByTestId("task-card-lineage-children"));
		expect((screen.getByPlaceholderText("Search tasks...") as HTMLInputElement).value).toBe("children:1801");
		expect(card("My own task")).toBeNull();
	});

	it("the right-click menu filters a child to its parent's batch, and offers nothing for a user task", async () => {
		await renderBoard();
		fireEvent.contextMenu(card("My own task")!);
		await screen.findAllByRole("menuitem");
		expect(screen.queryByRole("menuitem", { name: "Show parent & children" })).toBeNull();
		await userEvent.keyboard("{Escape}");

		fireEvent.contextMenu(card("Fix the CLI")!);
		await userEvent.click(await screen.findByRole("menuitem", { name: "Show parent & children" }));
		expect((screen.getByPlaceholderText("Search tasks...") as HTMLInputElement).value).toBe("children:1801");

		fireEvent.contextMenu(card("Coordinate the release")!);
		await screen.findByRole("menuitem", { name: "Show parent & children" });
		await userEvent.keyboard("{Escape}");

	});

	it("puts the lineage line in the card body, not the identity row", async () => {
		await renderBoard();
		const childCard = card("Fix the CLI")!;
		expect(within(childCard).getByTestId("task-card-identity").querySelector("[data-testid=task-card-lineage]")).toBeNull();
		expect(within(childCard).getByTestId("task-card-lineage").textContent).toContain("from#1801");
	});
});
