/**
 * Board-host edge cases beyond SavedViews.test.tsx: form factors, board switching, the v chord,
 * a failed save, name dialog dismissal and duplicates, and session-memory ids.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Context } from "cordis";
import type { Project, Task } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import { setHiddenControlsForTests } from "../../hidden-controls";
import BoardHost, { resetPreviousBoardViewsForTests } from "../BoardHost";
import { getAppRoot, installIntoAppRoot, resetAppRootForTests } from "../../plugins/root";
import { installKanbanView } from "../kanban";
import { useBoard } from "../react";
import { resetBoardViewStateCacheForTests } from "../useBoardViewState";
import { resetTaskVisibilityForTests } from "../useTaskVisibility";
import { applyNamedViewChange, defaultBoardViewState, KANBAN_VIEW_ID, normalizeBoardViewState, withNamedViewsFrom, type BoardViewState } from "../../../shared/board-view-state";
import { toast } from "../../toast";
import { resetBoardViewCommandsForTests, runBoardViewCommand } from "../view-commands";
import { resetPluginsForTests } from "../../plugins/runtime";
import { resetRememberedFiltersForTests } from "../../hooks/useRememberedFilter";
import { CAROUSEL_MAX_WIDTH } from "../../components/MobileBoardCarousel";

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
			const layout = board.layout<{ collapsed?: boolean }>(KANBAN_VIEW_ID);
			return (
				<div data-testid="kanban" data-shown={board.tasks().map((t) => t.id).join(",")} data-collapsed={String(!!layout?.collapsed)}>
					<button type="button" onClick={() => board.setLayout(KANBAN_VIEW_ID, { collapsed: true })}>collapse</button>
				</div>
			);
		},
	};
});

// --- viewport control: useNarrowViewport reads matchMedia(`(max-width: 767px)`) ---
const NARROW_QUERY = `(max-width: ${CAROUSEL_MAX_WIDTH - 1}px)`;
let narrowNow = false;
const mqListeners = new Set<(e: { matches: boolean }) => void>();
const originalMatchMedia = window.matchMedia;

function installViewport() {
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		writable: true,
		value: (query: string) => ({
			matches: query === NARROW_QUERY ? narrowNow : query.includes("prefers-reduced-motion"),
			media: query,
			onchange: null,
			addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => { if (query === NARROW_QUERY) mqListeners.add(fn); },
			removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => { mqListeners.delete(fn); },
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => false,
		}),
	});
}

function setNarrow(narrow: boolean) {
	narrowNow = narrow;
	act(() => { for (const fn of [...mqListeners]) fn({ matches: narrow }); });
}

const projectA: Project = {
	id: "p1", name: "Project A", path: "/tmp/a", setupScript: "", devScript: "", cleanupScript: "",
	defaultBaseBranch: "main", createdAt: "2025-01-01T00:00:00Z",
};
const projectB: Project = { ...projectA, id: "p2", name: "Project B", path: "/tmp/b" };

function makeTask(id: string, title: string, projectId = "p1"): Task {
	return {
		id, seq: Number(id.replace(/\D/g, "")) || 1, projectId, title, description: title, status: "todo",
		baseBranch: "main", worktreePath: null, branchName: null, groupId: null, variantIndex: null,
		agentId: null, configId: null, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
		customColumnId: null, labelIds: [], notes: [], history: [],
	};
}

const tasksA = [makeTask("t1", "alpha"), makeTask("t2", "beta")];
const tasksB = [makeTask("t3", "gamma", "p2"), makeTask("t4", "delta", "p2")];

function host(project: Project, tasks: Task[]) {
	return (
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
		</I18nProvider>
	);
}

/** A narrow-capable list view and a wide-only table view. */
function registerViews() {
	getAppRoot().plugin({
		name: "ext:qa-views",
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
			ctx.boardViews.register({
				id: "ext:wide-table",
				label: "WideTable",
				component: () => <div data-testid="view-wide-table" />,
				supportsNarrow: false,
			});
		},
	});
}

function stateWithNamed(named: Array<{ id: string; name: string; viewType?: string; query?: string; layouts?: Record<string, unknown> }>, base = defaultBoardViewState()): BoardViewState {
	return {
		...base,
		savedViews: [...base.savedViews, ...named.map((view) => ({ viewType: "ext:list", query: "", layouts: {}, ...view }))],
	};
}

const switcherButton = async () => (await screen.findByTestId("board-view-switcher")).querySelector("button")!;
const search = () => screen.getByRole("textbox", { name: /search/i }) as HTMLInputElement;

async function pick(name: string | RegExp) {
	fireEvent.click(await switcherButton());
	fireEvent.click(await screen.findByRole("option", { name }));
}

/** What the fake host has on disk for a board (both RPCs write it). */
function lastSaved(boardId = "p1"): BoardViewState {
	return disk.get(boardId) ?? defaultBoardViewState();
}
const writes = () => vi.mocked(api.request.setBoardViewState).mock.calls.length + vi.mocked(api.request.changeNamedBoardView).mock.calls.length;
const namedIn = (state: BoardViewState) => state.savedViews.filter((view) => view.name !== null);

/** A fake board-views.json per board: a save persists and a later read returns it, as on the host. */
const disk = new Map<string, BoardViewState>();
function seed(state: BoardViewState, boardId = "p1") {
	disk.set(boardId, JSON.parse(JSON.stringify(state)));
}

function boot() {
	installIntoAppRoot([installKanbanView]);
	registerViews();
}

beforeEach(() => {
	resetAppRootForTests();
	resetBoardViewStateCacheForTests();
	resetTaskVisibilityForTests();
	resetBoardViewCommandsForTests();
	resetPreviousBoardViewsForTests();
	resetPluginsForTests();
	resetRememberedFiltersForTests();
	setHiddenControlsForTests([]);
	narrowNow = false;
	mqListeners.clear();
	installViewport();
	disk.clear();
	vi.mocked(api.request.getBoardViewState).mockReset();
	vi.mocked(api.request.getBoardViewState).mockImplementation(async ({ board }) => JSON.parse(JSON.stringify(disk.get(board.id) ?? defaultBoardViewState())));
	vi.mocked(api.request.setBoardViewState).mockReset();
	// Emulates src/bun/board-view-state-data.ts: a plain save keeps the named views on disk;
	// a named change is applied to the file as it is now.
	vi.mocked(api.request.setBoardViewState).mockImplementation(async ({ board, state }) => {
		const next = withNamedViewsFrom(normalizeBoardViewState(JSON.parse(JSON.stringify(state))), disk.get(board.id) ?? defaultBoardViewState());
		disk.set(board.id, next);
		return JSON.parse(JSON.stringify(next));
	});
	vi.mocked(api.request.changeNamedBoardView).mockReset();
	vi.mocked(api.request.changeNamedBoardView).mockImplementation(async ({ board, change }) => {
		const next = normalizeBoardViewState(applyNamedViewChange(disk.get(board.id) ?? defaultBoardViewState(), JSON.parse(JSON.stringify(change))));
		disk.set(board.id, next);
		return JSON.parse(JSON.stringify(next));
	});
	localStorage.clear();
});

afterEach(() => {
	Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: originalMatchMedia });
});

describe("form factors", () => {
	it("an applied view on wide is not marked applied on narrow, and wide keeps it after a round trip", async () => {
		seed(stateWithNamed([{ id: "sv-named-1", name: "Betas", query: "beta" }]));
		boot();
		render(host(projectA, tasksA));
		await screen.findByTestId("kanban");
		await pick("Betas");
		await screen.findByTestId("view-list");
		setNarrow(true);
		// The applied id is per form factor: narrow shows its own working view (Kanban).
		await waitFor(async () => expect((await switcherButton()).textContent).toBe("Kanban"));
		setNarrow(false);
		await waitFor(async () => expect((await switcherButton()).textContent).toBe("Betas"));
		expect(screen.getByTestId("view-list")).toBeInTheDocument();
	});

	it("a wide-only named view on narrow is a disabled row: a click toasts and changes nothing", async () => {
		seed(stateWithNamed([{ id: "sv-named-1", name: "WideOnly", viewType: "ext:wide-table", query: "wide" }]));
		const info = vi.spyOn(toast, "info").mockImplementation(() => "");
		boot();
		narrowNow = true;
		render(host(projectA, tasksA));
		await screen.findByTestId("kanban");
		fireEvent.click(await switcherButton());
		const row = await screen.findByRole("option", { name: "WideOnly" });
		expect(row).toHaveAttribute("aria-disabled", "true");
		fireEvent.click(row);
		await waitFor(() => expect(info).toHaveBeenCalledTimes(1));
		expect(search().value).toBe("");
		expect(writes()).toBe(0);
		info.mockRestore();
	});

});

describe("switching boards", () => {
	it("A -> B -> A keeps A's applied view and query, and B starts clean", async () => {
		seed(stateWithNamed([{ id: "sv-named-1", name: "Betas", query: "beta" }]));
		boot();
		const { rerender } = render(host(projectA, tasksA));
		await screen.findByTestId("kanban");
		await pick("Betas");
		expect(await screen.findByTestId("view-list")).toHaveAttribute("data-shown", "t2");

		rerender(host(projectB, tasksB));
		await waitFor(() => expect(search().value).toBe(""));
		expect(await screen.findByTestId("kanban")).toHaveAttribute("data-shown", "t3,t4");
		fireEvent.click(await switcherButton());
		expect(screen.queryByRole("option", { name: "Betas" })).not.toBeInTheDocument();
		fireEvent.keyDown(document, { key: "Escape" });

		rerender(host(projectA, tasksA));
		await waitFor(() => expect(search().value).toBe("beta"));
		expect(await screen.findByTestId("view-list")).toHaveAttribute("data-shown", "t2");
		expect((await switcherButton()).textContent).toBe("Betas");
	});

});


describe("the v chord leaves the applied view", () => {
	it("v-pick of the view type the applied view already shows also leaves it, like the switcher does", async () => {
		// The switcher's "Kanban" option leaves the applied view even when Kanban already shows.
		// The v chord skips pick() when the target equals the current view type.
		seed(stateWithNamed([{ id: "sv-named-1", name: "KanbanPreset", viewType: KANBAN_VIEW_ID, query: "alpha" }]));
		boot();
		render(host(projectA, tasksA));
		await screen.findByTestId("kanban");
		await pick("KanbanPreset");
		await waitFor(async () => expect((await switcherButton()).textContent).toBe("KanbanPreset"));
		act(() => runBoardViewCommand({ kind: "pick", viewId: KANBAN_VIEW_ID }));
		await waitFor(async () => expect((await switcherButton()).textContent).toBe("Kanban"));
	});
});

describe("a failed save", () => {
	it("a view whose save failed raises an error toast and drops out of the switcher without a remount", async () => {
		// Decided after the spec probe: a named view is the user's content, so a failed save is told, not just logged.
		vi.mocked(api.request.changeNamedBoardView).mockRejectedValue(new Error("disk full"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(toast, "error").mockImplementation(() => "");
		boot();
		const user = userEvent.setup();
		render(host(projectA, tasksA));
		await screen.findByTestId("kanban");
		await pick("Save current view…");
		await user.type(await screen.findByTestId("saved-view-name-input"), "Doomed{Enter}");
		await waitFor(() => expect(error).toHaveBeenCalledWith("Couldn't save the change to your saved view. Try again."));
		await waitFor(async () => {
			fireEvent.click(await switcherButton());
			expect(screen.queryByRole("option", { name: "Doomed" })).not.toBeInTheDocument();
			fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
		});
		warn.mockRestore();
		error.mockRestore();
	});
});

describe("the name dialog", () => {
	async function openSave(query?: string) {
		const user = userEvent.setup();
		render(host(projectA, tasksA));
		await screen.findByTestId("kanban");
		if (query) fireEvent.change(search(), { target: { value: query } });
		await pick("Save current view…");
		const dialog = await screen.findByTestId("saved-view-name-dialog");
		return { user, dialog, input: within(dialog).getByTestId("saved-view-name-input") as HTMLInputElement };
	}

	it("a backdrop click closes it without saving", async () => {
		boot();
		const { user, dialog, input } = await openSave();
		await user.type(input, "Draft");
		const backdrop = dialog.parentElement!;
		await user.pointer({ keys: "[MouseLeft]", target: backdrop });
		await waitFor(() => expect(screen.queryByTestId("saved-view-name-dialog")).not.toBeInTheDocument());
		expect(writes()).toBe(0);
	});

	it("refuses a new name that differs only in case or spacing from an existing one, on Enter too", async () => {
		seed(stateWithNamed([{ id: "sv-named-1", name: "Betas" }]));
		boot();
		const { user, dialog, input } = await openSave();
		await user.type(input, "  bETAS  {Enter}");
		expect(within(dialog).getByRole("alert")).toBeInTheDocument();
		expect(within(dialog).getByTestId("saved-view-name-submit")).toBeDisabled();
		expect(screen.getByTestId("saved-view-name-dialog")).toBeInTheDocument();
		expect(writes()).toBe(0);
	});

});

describe("apply and Revert on a preset saved with the default layout", () => {
	it("applying such a preset over a working view with its own layout is not modified at once", async () => {
		const base = stateWithNamed([{ id: "sv-named-1", name: "Plain", viewType: KANBAN_VIEW_ID, query: "", layouts: {} }]);
		base.savedViews[0] = { ...base.savedViews[0], layouts: { [KANBAN_VIEW_ID]: { collapsed: true } } };
		seed(base);
		boot();
		render(host(projectA, tasksA));
		await screen.findByTestId("kanban");
		await pick("Plain");
		await waitFor(async () => expect((await switcherButton()).textContent).not.toBe("Kanban"));
		expect((await switcherButton()).textContent).toBe("Plain");
	});
});

describe("session-memory ids", () => {
	it("a view saved after a delete on narrow does not show as applied on wide", async () => {
		// wide applies sv-named-2; narrow applies and deletes it; narrow saves "Fresh",
		// which takes the lowest free id sv-named-2. Wide's session memory still holds it.
		const { confirm } = await import("../../confirm");
		vi.mocked(confirm).mockResolvedValue(true);
		seed(stateWithNamed([
			{ id: "sv-named-1", name: "One" },
			{ id: "sv-named-2", name: "Two" },
		]));
		boot();
		const user = userEvent.setup();
		render(host(projectA, tasksA));
		await screen.findByTestId("kanban");
		await pick("Two");
		await screen.findByTestId("view-list");
		setNarrow(true);
		await waitFor(async () => expect((await switcherButton()).textContent).toBe("Kanban"));
		await pick("Two");
		await waitFor(async () => expect((await switcherButton()).textContent).toBe("Two"));
		await pick('Delete "Two"');
		await waitFor(() => expect(namedIn(lastSaved()).map((v) => v.id)).toEqual(["sv-named-1"]));
		await pick("Save current view…");
		await user.type(await screen.findByTestId("saved-view-name-input"), "Fresh{Enter}");
		await waitFor(() => expect(namedIn(lastSaved()).map((v) => v.name)).toEqual(["One", "Fresh"]));
		setNarrow(false);
		await waitFor(() => expect(screen.getByTestId("view-list")).toBeInTheDocument());
		expect((await switcherButton()).textContent).not.toMatch(/^Fresh/);
	});
});
