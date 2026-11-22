import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Context } from "cordis";
import type { Project, Task } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import { confirm } from "../../confirm";
import { setHiddenControlsForTests } from "../../hidden-controls";
import BoardHost, { resetPreviousBoardViewsForTests } from "../BoardHost";
import { getAppRoot, installIntoAppRoot, resetAppRootForTests } from "../../plugins/root";
import { installKanbanView } from "../kanban";
import { useBoard } from "../react";
import { resetBoardViewStateCacheForTests } from "../useBoardViewState";
import { resetTaskVisibilityForTests } from "../useTaskVisibility";
import {
	applyNamedViewChange,
	defaultBoardViewState,
	KANBAN_VIEW_ID,
	normalizeBoardViewState,
	withNamedViewsFrom,
	type BoardViewState,
} from "../../../shared/board-view-state";
import { toast } from "../../toast";
import { resetBoardViewCommandsForTests, runBoardViewCommand } from "../view-commands";
import { resetPluginsForTests } from "../../plugins/runtime";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAgents: vi.fn().mockResolvedValue([]),
			getProjectPRs: vi.fn().mockResolvedValue([]),
			getTaskLineage: vi.fn().mockResolvedValue({ nodes: [] }),
			getEpics: vi.fn().mockResolvedValue({ version: 1, epics: [] }),
			getEpicMembers: vi.fn().mockResolvedValue([]),
			getBoardViewState: vi.fn(),
			setBoardViewState: vi.fn(),
			changeNamedBoardView: vi.fn(),
			getBoardFilterState: vi.fn().mockResolvedValue({ visibility: "all" }),
			setBoardFilterState: vi.fn(async ({ state }) => state),
			getGlobalSettings: vi.fn().mockResolvedValue({ taskSortOrder: "oldest-first" }),
		},
	},
}));

vi.mock("../../analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("../../confirm", () => ({ confirm: vi.fn() }));

vi.mock("../kanban/KanbanView", async () => {
	const { useBoard } = await import("../react");
	return {
		KanbanView: () => {
			const board = useBoard();
			return <div data-testid="kanban" data-shown={board.tasks().map((t) => t.id).join(",")} />;
		},
	};
});

const project: Project = {
	id: "p1", name: "Test Project", path: "/tmp/test", setupScript: "", devScript: "", cleanupScript: "",
	defaultBaseBranch: "main", createdAt: "2025-01-01T00:00:00Z",
};

function makeTask(id: string, title: string): Task {
	return {
		id, seq: Number(id.replace(/\D/g, "")) || 1, projectId: "p1", title, description: title, status: "todo",
		baseBranch: "main", worktreePath: null, branchName: null, groupId: null, variantIndex: null,
		agentId: null, configId: null, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
		customColumnId: null, labelIds: [], notes: [], history: [],
	};
}

const tasks = [makeTask("t1", "alpha"), makeTask("t2", "beta")];

function renderHost() {
	return render(
		<I18nProvider>
			<BoardHost
				project={project}
				tasks={tasks}
				dispatch={vi.fn()}
				navigate={vi.fn()}
				bellCounts={new Map()}
				taskPorts={new Map()}
				taskDevServers={new Map()}
			/>
		</I18nProvider>,
	);
}

/** A view that shows the query it gets and lets a test change its own layout. */
function registerListView() {
	getAppRoot().plugin({
		name: "ext:list",
		inject: ["board", "boardViews"],
		apply(ctx: Context) {
			ctx.boardViews.register({
				id: "ext:list",
				label: "List",
				component: () => {
					const board = useBoard();
					const layout = board.layout<{ sort?: string }>("ext:list");
					return (
						<div data-testid="view-list" data-shown={board.tasks().map((t) => t.id).join(",")} data-sort={layout?.sort ?? ""}>
							<button type="button" onClick={() => board.setLayout("ext:list", { sort: "seq" })}>sort-by-seq</button>
						</div>
					);
				},
				supportsNarrow: true,
			});
		},
	});
}

function stateWithNamed(named: Array<{ id: string; name: string; viewType?: string; query?: string; layouts?: Record<string, unknown> }>): BoardViewState {
	const base = defaultBoardViewState();
	return {
		...base,
		savedViews: [
			...base.savedViews,
			...named.map((view) => ({ viewType: "ext:list", query: "", layouts: {}, ...view })),
		],
	};
}

const switcherButton = async () => (await screen.findByTestId("board-view-switcher")).querySelector("button")!;
const search = () => screen.getByRole("textbox", { name: /search/i }) as HTMLInputElement;

async function pick(name: string | RegExp) {
	fireEvent.click(await switcherButton());
	fireEvent.click(await screen.findByRole("option", { name }));
}

// The host's file, as board-view-state-data.ts keeps it: plain saves keep its named views.
let disk: BoardViewState = defaultBoardViewState();
function lastSaved(): BoardViewState {
	return disk;
}
function serveFrom(initial: BoardViewState) {
	disk = initial;
	vi.mocked(api.request.getBoardViewState).mockImplementation(async () => disk);
}

const namedIn = (state: BoardViewState) => state.savedViews.filter((view) => view.name !== null);

beforeEach(() => {
	resetAppRootForTests();
	resetBoardViewStateCacheForTests();
	resetTaskVisibilityForTests();
	resetBoardViewCommandsForTests();
	resetPreviousBoardViewsForTests();
	resetPluginsForTests();
	setHiddenControlsForTests([]);
	serveFrom(defaultBoardViewState());
	vi.mocked(api.request.setBoardViewState).mockReset().mockImplementation(async ({ state }) => (disk = withNamedViewsFrom(normalizeBoardViewState(state), disk)));
	vi.mocked(api.request.changeNamedBoardView).mockReset().mockImplementation(async ({ change }) => (disk = applyNamedViewChange(disk, change)));
	vi.mocked(confirm).mockReset();
	localStorage.clear();
});

describe("named saved views", () => {
	it("saves the view type, its layout and the query under a name, and shows that name", async () => {
		installIntoAppRoot([installKanbanView]);
		registerListView();
		renderHost();
		await pick("List");
		fireEvent.click(await screen.findByRole("button", { name: "sort-by-seq" }));
		fireEvent.change(search(), { target: { value: "beta" } });
		await pick("Save current view…");
		const dialog = await screen.findByTestId("saved-view-name-dialog");
		fireEvent.change(within(dialog).getByTestId("saved-view-name-input"), { target: { value: "  Betas " } });
		fireEvent.click(within(dialog).getByTestId("saved-view-name-submit"));
		await waitFor(() => expect(namedIn(lastSaved())).toEqual([
			{ id: expect.any(String), name: "Betas", viewType: "ext:list", query: "beta", layouts: { "ext:list": { sort: "seq" } } },
		]));
		expect(screen.queryByTestId("saved-view-name-dialog")).not.toBeInTheDocument();
		expect((await switcherButton()).textContent).toContain("Betas");
		// The working view never stores the query: a fresh launch must not open filtered.
		expect(lastSaved().savedViews.filter((view) => view.name === null).every((view) => view.query === "")).toBe(true);
	});

	it("applies a saved view: view type, layout and query", async () => {
		serveFrom(stateWithNamed([{ id: "sv-named-1", name: "Betas", query: "beta", layouts: { "ext:list": { sort: "seq" } } }]));
		installIntoAppRoot([installKanbanView]);
		registerListView();
		renderHost();
		await screen.findByTestId("kanban");
		await pick("Betas");
		const view = await screen.findByTestId("view-list");
		expect(view).toHaveAttribute("data-shown", "t2");
		expect(view).toHaveAttribute("data-sort", "seq");
		expect(search().value).toBe("beta");
		expect((await switcherButton()).textContent).toBe("Betas");
	});

	it("marks the applied view modified on a query or layout change, and Update writes it back", async () => {
		serveFrom(stateWithNamed([{ id: "sv-named-1", name: "Betas", query: "beta" }]));
		installIntoAppRoot([installKanbanView]);
		registerListView();
		renderHost();
		await screen.findByTestId("kanban");
		await pick("Betas");
		fireEvent.change(search(), { target: { value: "alpha" } });
		expect((await switcherButton()).textContent).toBe("Betas • edited");
		await pick('Update "Betas"');
		await waitFor(() => expect(namedIn(lastSaved())[0]).toMatchObject({ query: "alpha", viewType: "ext:list" }));
		expect((await switcherButton()).textContent).toBe("Betas");

		fireEvent.click(screen.getByRole("button", { name: "sort-by-seq" }));
		expect((await switcherButton()).textContent).toBe("Betas • edited");
	});

	it("offers Update and Revert only while modified", async () => {
		serveFrom(stateWithNamed([{ id: "sv-named-1", name: "Betas", query: "beta" }]));
		installIntoAppRoot([installKanbanView]);
		registerListView();
		renderHost();
		await screen.findByTestId("kanban");
		await pick("Betas");
		fireEvent.click(await switcherButton());
		expect(screen.queryByRole("option", { name: 'Update "Betas"' })).not.toBeInTheDocument();
		expect(screen.queryByRole("option", { name: "Revert changes" })).not.toBeInTheDocument();
		expect(screen.getByRole("option", { name: 'Rename "Betas"…' })).toBeInTheDocument();
	});

	it("Revert restores the saved query and layout", async () => {
		serveFrom(stateWithNamed([{ id: "sv-named-1", name: "Betas", query: "beta", layouts: { "ext:list": { sort: "title" } } }]));
		installIntoAppRoot([installKanbanView]);
		registerListView();
		renderHost();
		await screen.findByTestId("kanban");
		await pick("Betas");
		fireEvent.click(await screen.findByRole("button", { name: "sort-by-seq" }));
		fireEvent.change(search(), { target: { value: "" } });
		await pick("Revert changes");
		expect(search().value).toBe("beta");
		expect(screen.getByTestId("view-list")).toHaveAttribute("data-sort", "title");
		expect((await switcherButton()).textContent).toBe("Betas");
	});

	it("leaves the saved view when a view type is picked, keeping the saved view itself", async () => {
		serveFrom(stateWithNamed([{ id: "sv-named-1", name: "Betas", query: "beta" }]));
		installIntoAppRoot([installKanbanView]);
		registerListView();
		renderHost();
		await screen.findByTestId("kanban");
		await pick("Betas");
		await pick("Kanban");
		await screen.findByTestId("kanban");
		expect((await switcherButton()).textContent).toBe("Kanban");
		fireEvent.click(await switcherButton());
		expect(screen.getByRole("option", { name: "Betas" })).toBeInTheDocument();
		expect(screen.queryByRole("option", { name: 'Rename "Betas"…' })).not.toBeInTheDocument();
	});

	it("deletes only after the confirm dialog says yes", async () => {
		serveFrom(stateWithNamed([{ id: "sv-named-1", name: "Betas", query: "beta" }]));
		installIntoAppRoot([installKanbanView]);
		registerListView();
		renderHost();
		await screen.findByTestId("kanban");
		await pick("Betas");

		vi.mocked(confirm).mockResolvedValueOnce(false);
		await pick('Delete "Betas"');
		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
		expect(vi.mocked(confirm).mock.calls[0][0]).toMatchObject({ danger: true, message: expect.stringContaining("Betas") });
		expect((await switcherButton()).textContent).toBe("Betas");

		vi.mocked(confirm).mockResolvedValueOnce(true);
		await pick('Delete "Betas"');
		await waitFor(() => expect(namedIn(lastSaved())).toEqual([]));
		// The board keeps showing what it showed; only the preset is gone.
		expect(screen.getByTestId("view-list")).toBeInTheDocument();
		expect((await switcherButton()).textContent).toBe("List");
	});

	it("renames, refusing a name another saved view has", async () => {
		serveFrom(stateWithNamed([
			{ id: "sv-named-1", name: "Betas" },
			{ id: "sv-named-2", name: "Alphas" },
		]));
		installIntoAppRoot([installKanbanView]);
		registerListView();
		renderHost();
		await screen.findByTestId("kanban");
		await pick("Betas");
		await pick('Rename "Betas"…');
		const dialog = await screen.findByTestId("saved-view-name-dialog");
		const input = within(dialog).getByTestId("saved-view-name-input") as HTMLInputElement;
		expect(input.value).toBe("Betas");
		fireEvent.change(input, { target: { value: "alphas" } });
		expect(within(dialog).getByRole("alert")).toHaveTextContent("already has a view with that name");
		expect(within(dialog).getByTestId("saved-view-name-submit")).toBeDisabled();
		fireEvent.change(input, { target: { value: "Bets" } });
		fireEvent.submit(input.closest("form")!);
		await waitFor(() => expect(namedIn(lastSaved()).map((view) => view.name)).toEqual(["Bets", "Alphas"]));
	});

	it("will not save a blank name", async () => {
		installIntoAppRoot([installKanbanView]);
		registerListView();
		renderHost();
		await pick("Save current view…");
		const dialog = await screen.findByTestId("saved-view-name-dialog");
		fireEvent.change(within(dialog).getByTestId("saved-view-name-input"), { target: { value: "   " } });
		expect(within(dialog).getByTestId("saved-view-name-submit")).toBeDisabled();
		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() => expect(screen.queryByTestId("saved-view-name-dialog")).not.toBeInTheDocument());
		expect(api.request.changeNamedBoardView).not.toHaveBeenCalled();
	});

	it("opens a board on its working view with no query, even when saved views exist", async () => {
		serveFrom(stateWithNamed([{ id: "sv-named-1", name: "Betas", query: "beta" }]));
		installIntoAppRoot([installKanbanView]);
		registerListView();
		renderHost();
		expect(await screen.findByTestId("kanban")).toHaveAttribute("data-shown", "t1,t2");
		expect(search().value).toBe("");
		expect((await switcherButton()).textContent).toBe("Kanban");
	});

	it("shows the switcher with only Kanban registered once a saved view exists", async () => {
		serveFrom(stateWithNamed([{ id: "sv-named-1", name: "Mine", viewType: KANBAN_VIEW_ID, query: "alpha" }]));
		installIntoAppRoot([installKanbanView]);
		renderHost();
		await pick("Mine");
		expect(search().value).toBe("alpha");
		expect(screen.getByTestId("kanban")).toHaveAttribute("data-shown", "t1");
	});

	it("keeps the old switcher look on a board without saved views", async () => {
		installIntoAppRoot([installKanbanView]);
		registerListView();
		renderHost();
		fireEvent.click(await switcherButton());
		expect(screen.queryByText("Saved views")).not.toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Save current view…" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Manage views…" })).toBeInTheDocument();
	});

	it("Revert clears a layout the saved view never had (saved before the layout was first written)", async () => {
		serveFrom(stateWithNamed([{ id: "sv-named-1", name: "Betas", query: "beta" }]));
		installIntoAppRoot([installKanbanView]);
		registerListView();
		renderHost();
		await screen.findByTestId("kanban");
		await pick("Betas");
		fireEvent.click(await screen.findByRole("button", { name: "sort-by-seq" }));
		expect((await switcherButton()).textContent).toBe("Betas • edited");
		await pick("Revert changes");
		expect(screen.getByTestId("view-list")).toHaveAttribute("data-sort", "");
		expect((await switcherButton()).textContent).toBe("Betas");
	});

	it("disables a saved view whose view type this board does not offer, and explains on click", async () => {
		const info = vi.spyOn(toast, "info").mockImplementation(() => "");
		serveFrom(stateWithNamed([{ id: "sv-named-1", name: "Gone", viewType: "ext:uninstalled", query: "beta" }]));
		installIntoAppRoot([installKanbanView]);
		registerListView();
		renderHost();
		await screen.findByTestId("kanban");
		fireEvent.click(await switcherButton());
		const row = await screen.findByRole("option", { name: /Gone/ });
		expect(row).toHaveAttribute("aria-disabled", "true");
		fireEvent.click(row);
		expect(info).toHaveBeenCalledWith("That board view is not available on this board.");
		expect(search().value).toBe("");
		expect(screen.getByTestId("kanban")).toBeInTheDocument();
		info.mockRestore();
	});

	it("the v chord leaves the applied saved view even when it names the view already shown", async () => {
		serveFrom(stateWithNamed([{ id: "sv-named-1", name: "Betas", query: "beta" }]));
		installIntoAppRoot([installKanbanView]);
		registerListView();
		renderHost();
		await screen.findByTestId("kanban");
		await pick("Betas");
		await screen.findByTestId("view-list");
		act(() => runBoardViewCommand({ kind: "pick", viewId: "ext:list" }));
		await waitFor(async () => expect((await switcherButton()).textContent).toBe("List"));
	});

	it("picking the applied, unedited saved view again writes nothing", async () => {
		serveFrom(stateWithNamed([{ id: "sv-named-1", name: "Betas", query: "beta" }]));
		installIntoAppRoot([installKanbanView]);
		registerListView();
		renderHost();
		await screen.findByTestId("kanban");
		await pick("Betas");
		await waitFor(() => expect(api.request.setBoardViewState).toHaveBeenCalledTimes(1));
		await pick("Betas");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(api.request.setBoardViewState).toHaveBeenCalledTimes(1);
	});

	it("picks up a saved view another window added once this window saves anything", async () => {
		installIntoAppRoot([installKanbanView]);
		registerListView();
		renderHost();
		await screen.findByTestId("kanban");
		disk = applyNamedViewChange(disk, { kind: "add", view: { id: "sv-named-other", name: "From elsewhere", viewType: KANBAN_VIEW_ID, query: "", layouts: {} } });
		await pick("List");
		fireEvent.click(await switcherButton());
		expect(await screen.findByRole("option", { name: "From elsewhere" })).toBeInTheDocument();
	});

	it("shows the edited mark as a dot to the eye and as a word to a screen reader", async () => {
		serveFrom(stateWithNamed([{ id: "sv-named-1", name: "Betas", query: "beta" }]));
		installIntoAppRoot([installKanbanView]);
		registerListView();
		renderHost();
		await screen.findByTestId("kanban");
		await pick("Betas");
		fireEvent.change(search(), { target: { value: "alpha" } });
		const trigger = await switcherButton();
		expect(within(trigger).getByText("•", { exact: false })).toHaveAttribute("aria-hidden");
		expect(within(trigger).getByText("edited", { exact: false })).toHaveClass("sr-only");
		fireEvent.click(trigger);
		expect(screen.getByRole("option", { name: /Betas.*edited/ })).toBeInTheDocument();
	});
});
