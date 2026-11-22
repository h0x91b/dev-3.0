import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Context } from "cordis";
import type { Project, Task } from "../../../shared/types";
import { defaultBoardViewState } from "../../../shared/board-view-state";
import BoardHost, { resetPreviousBoardViewsForTests } from "../../board-views/BoardHost";
import { installKanbanView } from "../../board-views/kanban";
import { resetBoardViewStateCacheForTests } from "../../board-views/useBoardViewState";
import TaskCard from "../../components/TaskCard";
import TaskContextMenu from "../../components/TaskContextMenu";
import { I18nProvider } from "../../i18n";
import { getAppRoot, installIntoAppRoot } from "../../plugins/root";
import { api } from "../../rpc";
import { installTaskMenuBuiltins } from "../../task-menu/__tests__/install-builtins";
import { installTaskDetailSectionBuiltins } from "./install-builtins";

vi.mock("../../rpc", () => ({
	isElectrobun: false,
	api: {
		request: {
			getAgents: vi.fn().mockResolvedValue([]),
			getProjectPRs: vi.fn().mockResolvedValue([]),
			getTaskLineage: vi.fn().mockResolvedValue({ nodes: [] }),
			getEpics: vi.fn().mockResolvedValue({ version: 1, epics: [] }),
			getEpicMembers: vi.fn().mockResolvedValue([]),
			getBoardViewState: vi.fn(),
			setBoardViewState: vi.fn(async ({ state }) => state),
			getBoardFilterState: vi.fn().mockResolvedValue({ visibility: "all" }),
			setBoardFilterState: vi.fn(async ({ state }) => state),
			getGlobalSettings: vi.fn().mockResolvedValue({ taskSortOrder: "oldest-first" }),
			getTaskTerminalBackend: vi.fn(() => new Promise(() => {})),
			getNativeTerminalAvailability: vi.fn(() => new Promise(() => {})),
		},
	},
}));
vi.mock("../../analytics", () => ({ trackEvent: vi.fn(), agentNameFromId: vi.fn(() => "unknown") }));
vi.mock("../../board-views/kanban/KanbanView", () => ({ KanbanView: () => <div data-testid="kanban" /> }));

const project = { id: "p1", name: "P", path: "/p", labels: [], setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "2025-01-01T00:00:00Z" } as unknown as Project;
const task = {
	id: "t1", seq: 7, projectId: "p1", title: "Finished", description: "Finished", status: "completed", baseBranch: "main",
	worktreePath: null, branchName: "feat/x", groupId: null, variantIndex: null, agentId: null, configId: null,
	createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-02T00:00:00Z", customColumnId: null, labelIds: [], notes: [], history: [],
} as unknown as Task;

async function settle(): Promise<void> {
	for (let tick = 0; tick < 50; tick++) await act(async () => {});
}

/** What every opener must show: the built-in body and a contributed section, through the same slot. */
async function expectSlotBody() {
	expect(await screen.findByRole("region", { name: "From probe" })).toHaveTextContent("Probe body");
	expect(screen.getByText("Notes")).toBeInTheDocument();
}

beforeEach(async () => {
	await installTaskMenuBuiltins();
	await installTaskDetailSectionBuiltins();
	resetBoardViewStateCacheForTests();
	resetPreviousBoardViewsForTests();
	vi.mocked(api.request.getBoardViewState).mockResolvedValue(defaultBoardViewState());
	getAppRoot().plugin({
		name: "probe",
		inject: ["taskDetailSections"],
		apply: (ctx: Context) => ctx.taskDetailSections.register({ id: "probe:section", region: "main", title: () => "From probe", component: () => <p>Probe body</p> }),
	});
	await settle();
});

describe("every opener of a finished task's detail draws the slot", () => {
	it("the card", async () => {
		render(
			<I18nProvider>
				<TaskCard task={task} project={project} dispatch={vi.fn()} navigate={vi.fn()} agents={[]} onLaunchVariants={vi.fn()} onAddAttempts={vi.fn()} onDragStart={vi.fn()} />
			</I18nProvider>,
		);
		await userEvent.click(screen.getByText("Finished").closest("[draggable]")!);
		await expectSlotBody();
	});

	it("the context menu", async () => {
		render(
			<I18nProvider>
				<TaskContextMenu task={task} project={project} dispatch={vi.fn()} pos={{ x: 40, y: 60 }} onClose={vi.fn()} onOpenTask={vi.fn()} testId="task-menu" />
			</I18nProvider>,
		);
		await userEvent.click(screen.getByTestId("task-menu-details"));
		await expectSlotBody();
	});

	it("BoardHost", async () => {
		installIntoAppRoot([installKanbanView]);
		render(
			<I18nProvider>
				<BoardHost project={project} tasks={[task]} detailTaskId="t1" dispatch={vi.fn()} navigate={vi.fn()} bellCounts={new Map()} taskPorts={new Map()} taskDevServers={new Map()} />
			</I18nProvider>,
		);
		await settle();
		await expectSlotBody();
	});
});
