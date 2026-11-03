import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import KanbanBoard from "../KanbanBoard";
import { I18nProvider } from "../../i18n";
import type { Epic, EpicMember, Project, Task } from "../../../shared/types";
import { resetRememberedFiltersForTests } from "../../hooks/useRememberedFilter";
import { _resetEpicStoresForTest } from "../../hooks/useEpics";

const registry = vi.hoisted(() => ({ epics: [] as Epic[], members: [] as EpicMember[] }));

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAgents: vi.fn().mockResolvedValue([]),
			getGlobalSettings: vi.fn().mockResolvedValue({ defaultAgentId: "builtin-claude", defaultConfigId: "claude-default", taskSortOrder: "oldest-first", updateChannel: "stable" }),
			getTipState: vi.fn().mockResolvedValue({ snoozedUntil: 0, seen: {}, rotationIndex: 0 }),
			updateTipState: vi.fn().mockResolvedValue({ snoozedUntil: 0, seen: {}, rotationIndex: 0 }),
			getProjectCurrentBranch: vi.fn().mockResolvedValue({ branch: "main", isBaseBranch: true, isDirty: false }),
			getProjectPRs: vi.fn().mockResolvedValue([]),
			getTaskLineage: vi.fn(async () => ({ nodes: [], edges: [] })),
			getEpics: vi.fn(async () => ({ version: 1, epics: registry.epics })),
			getEpicMembers: vi.fn(async () => registry.members),
		},
	},
}));
vi.mock("../../analytics", () => ({ trackEvent: vi.fn(), agentNameFromId: vi.fn(() => "unknown") }));
vi.mock("../../toast", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

function makeProject(id: string, name: string): Project {
	return { id, name, path: `/tmp/${id}`, setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "2025-01-01T00:00:00Z" };
}
const HOME = makeProject("p1", "dev-3.0");
const BACKEND = makeProject("p2", "backend");

function makeTask(id: string, seq: number, overrides: Partial<Task> = {}): Task {
	return {
		id, seq, projectId: "p1", title: `Task ${seq}`, description: `Task ${seq}`, status: "todo",
		baseBranch: "main", worktreePath: null, branchName: null, groupId: null, variantIndex: null,
		agentId: null, configId: null, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
		customColumnId: null, labelIds: [], notes: [], history: [], ...overrides,
	};
}

const PAYMENTS: Epic = { id: "epicpay1-0000-1111-2222", name: "Payments v2", color: "#3b82f6", archived: false, createdAt: 0 };
const inEpic = makeTask("t1", 10, { title: "Add the checkout page", epicId: PAYMENTS.id });
const loose = makeTask("t2", 11, { title: "Unrelated chore" });
const member = (t: Task, projectName: string): EpicMember => ({ id: t.id, projectId: t.projectId, projectName, seq: t.seq, variantIndex: null, status: t.status, title: t.title, epicId: PAYMENTS.id });

async function renderBoard(navigate = vi.fn(), project = HOME, tasks = [inEpic, loose]) {
	await act(async () => {
		render(
			<I18nProvider>
				<KanbanBoard project={project} allProjects={[HOME, BACKEND]} tasks={tasks} dispatch={vi.fn()} navigate={navigate} bellCounts={new Map()} taskPorts={new Map()} taskDevServers={new Map()} />
			</I18nProvider>,
		);
	});
}

const card = (title: string) => (screen.queryByText(title)?.closest("[data-task-id]") ?? null) as HTMLElement | null;
const search = () => screen.getByPlaceholderText("Search tasks...") as HTMLInputElement;

describe("KanbanBoard epics", () => {
	beforeEach(() => {
		localStorage.clear();
		resetRememberedFiltersForTests();
		_resetEpicStoresForTest();
		registry.epics = [PAYMENTS];
		registry.members = [member(inEpic, "dev-3.0"), member(makeTask("api", 4, { projectId: "p2" }), "backend")];
	});

	it("shows the epic chip only on a task in an epic", async () => {
		await renderBoard();
		const chip = await within(card("Add the checkout page")!).findByTestId("task-card-epic");
		expect(chip.textContent).toBe("Payments v2");
		expect(within(card("Unrelated chore")!).queryByTestId("task-card-epic")).toBeNull();
	});

	it("a chip click filters the board to the epic and footnotes its tasks elsewhere", async () => {
		const navigate = vi.fn();
		await renderBoard(navigate);
		await userEvent.click(await within(card("Add the checkout page")!).findByTestId("task-card-epic"));

		expect(search().value).toBe('epic:"Payments v2"');
		expect(card("Unrelated chore")).toBeNull();
		expect(screen.queryByRole("dialog")).toBeNull();

		const notice = await screen.findByTestId("epic-filter-notice");
		expect(notice.textContent).toContain("+1 in another project:");
		await userEvent.click(within(notice).getByRole("button", { name: /backend/ }));
		expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p2" });

		cleanup();
		await renderBoard(vi.fn(), BACKEND, [makeTask("api", 4, { projectId: "p2", title: "Payments API", epicId: PAYMENTS.id })]);
		expect(search().value).toBe('epic:"Payments v2"');
	});

	it("an epic: value that names no epic matches nothing and shows no footnote", async () => {
		await renderBoard();
		await userEvent.type(search(), "epic:Paymnts");
		await waitFor(() => expect(card("Add the checkout page")).toBeNull());
		expect(card("Unrelated chore")).toBeNull();
		expect(screen.queryByTestId("epic-filter-notice")).toBeNull();
	});
});
