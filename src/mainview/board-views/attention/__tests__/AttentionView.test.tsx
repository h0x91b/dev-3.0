import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Context } from "cordis";
import type { Project, Task } from "../../../../shared/types";
import { ATTENTION_VIEW_ID, defaultBoardViewState, withLayout, withViewType } from "../../../../shared/board-view-state";
import { I18nProvider } from "../../../i18n";
import { api } from "../../../rpc";
import BoardHost from "../../BoardHost";
import { getBoardViewRegistry, resetBoardRootForTests, startBoardViews } from "../../root";
import { installKanbanView } from "../../kanban";
import { CordisContext } from "../../react";
import { resetBoardViewStateCacheForTests } from "../../useBoardViewState";
import type { BoardService } from "../../board-service";
import { ATTENTION_TICK_MS, AttentionView, installAttentionView } from "..";

vi.mock("../../../rpc", () => ({
	api: {
		request: {
			getAgents: vi.fn().mockResolvedValue([]),
			getGlobalSettings: vi.fn().mockResolvedValue({ taskSortOrder: "oldest-first" }),
			getProjectPRs: vi.fn().mockResolvedValue([]),
			getTaskLineage: vi.fn().mockResolvedValue({ nodes: [] }),
			getBoardViewState: vi.fn(),
			setBoardViewState: vi.fn(async ({ state }) => state),
		},
	},
}));

const project: Project = {
	id: "p1", name: "Test Project", path: "/tmp/test", setupScript: "", devScript: "", cleanupScript: "",
	defaultBaseBranch: "main", createdAt: "2025-01-01T00:00:00Z",
};

const NOW = Date.parse("2026-11-01T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function makeTask(seq: number, overrides: Partial<Task> = {}): Task {
	return {
		id: `t${seq}`, seq, projectId: "p1", title: `task ${seq}`, description: "", status: "todo",
		baseBranch: "main", worktreePath: null, branchName: null, groupId: null, variantIndex: null,
		agentId: null, configId: null, createdAt: hoursAgo(100), updatedAt: hoursAgo(100), statusEnteredAt: hoursAgo(1),
		customColumnId: null, labelIds: [], notes: [], history: [], ...overrides,
	};
}

const openPr = {
	prNumber: 7,
	prStatusCache: {
		number: 7, url: "https://example.invalid/pr/7", ciStatus: null, reviewState: null, unresolvedCount: null,
		mergeState: { mergeable: null, status: null, state: "OPEN" }, checks: [], prTitle: null, isDraft: null, cachedAt: hoursAgo(1),
	},
} satisfies Partial<Task>;

const tasks: Task[] = [
	makeTask(1, { status: "user-questions" }),
	makeTask(2, { status: "todo", priority: "P1" }),
	makeTask(3, { status: "in-progress", statusEnteredAt: hoursAgo(5) }),
	makeTask(4, { status: "in-progress", statusEnteredAt: hoursAgo(3.99) }),
	makeTask(5, { status: "review-by-ai", ...openPr }),
	// A finished task's cached PR state is frozen, so it stays out of Waiting on PR.
	makeTask(8, { status: "completed", ...openPr }),
	// Needs you AND an open PR: the first bucket wins.
	makeTask(6, { status: "review-by-user", ...openPr }),
	makeTask(7, { status: "cancelled" }),
];

function bucketSeqs(id: string): number[] {
	const section = screen.getAllByTestId("attention-bucket").find((el) => el.dataset.bucketId === id)!;
	return within(section).queryAllByTestId("attention-row").map((row) => Number(row.dataset.taskId!.slice(1)));
}

function renderAttentionBoard(navigate = vi.fn(), state = withViewType(defaultBoardViewState(), "wide", ATTENTION_VIEW_ID)) {
	vi.mocked(api.request.getBoardViewState).mockResolvedValue(state);
	startBoardViews([installKanbanView, installAttentionView]);
	render(
		<I18nProvider>
			<BoardHost project={project} tasks={tasks} dispatch={vi.fn()} navigate={navigate}
				bellCounts={new Map()} taskPorts={new Map()} taskDevServers={new Map()} />
		</I18nProvider>,
	);
	return navigate;
}

beforeEach(() => {
	resetBoardRootForTests();
	resetBoardViewStateCacheForTests();
	vi.mocked(api.request.setBoardViewState).mockClear();
	localStorage.clear();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("Attention board view", () => {
	it("registers as its own built-in plugin next to Kanban", async () => {
		renderAttentionBoard();
		await waitFor(() => expect(getBoardViewRegistry().list().map((v) => v.def.id)).toEqual(["builtin:kanban", ATTENTION_VIEW_ID]));
	});

	it("sorts the board into the default buckets with the real search tokens", async () => {
		renderAttentionBoard();
		await screen.findByTestId("attention-view");
		expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual(["Needs you", "Ready to start", "Stalled", "Waiting on PR"]);
		expect(bucketSeqs("needs-you")).toEqual([1, 6]);
		expect(bucketSeqs("ready")).toEqual([2]);
		expect(bucketSeqs("stalled")).toEqual([3]);
		expect(bucketSeqs("waiting-pr")).toEqual([5]);
	});

	it("moves a quiet task into Stalled on the tick, with no board change", async () => {
		// The interval is faked only here: `waitFor` polls with a real one.
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		vi.setSystemTime(NOW);
		renderAttentionBoard();
		await screen.findByTestId("attention-view");
		expect(bucketSeqs("stalled")).toEqual([3]);
		act(() => {
			vi.setSystemTime(NOW + 2 * 60_000);
			vi.advanceTimersByTime(ATTENTION_TICK_MS);
		});
		expect(bucketSeqs("stalled")).toEqual([3, 4]);
	});

	it("buckets only what the shared board query lets through", async () => {
		renderAttentionBoard();
		await screen.findByTestId("attention-view");
		fireEvent.change(screen.getByRole("textbox", { name: /search/i }), { target: { value: "priority:P1" } });
		expect(bucketSeqs("needs-you")).toEqual([]);
		expect(bucketSeqs("ready")).toEqual([2]);
	});

	it("opens the task on click", async () => {
		const navigate = renderAttentionBoard();
		await screen.findByTestId("attention-view");
		fireEvent.click(screen.getAllByTestId("attention-row").find((row) => row.dataset.taskId === "t2")!);
		expect(navigate).toHaveBeenCalledTimes(1);
		expect(Object.values(navigate.mock.calls[0][0])).toContain("t2");
	});

	it("uses the saved buckets and their names", async () => {
		const state = withLayout(withViewType(defaultBoardViewState(), "wide", ATTENTION_VIEW_ID), "wide", ATTENTION_VIEW_ID, {
			buckets: [{ id: "x", name: "Done pile", query: "status:completed status:cancelled", sort: "recent" }],
		});
		renderAttentionBoard(vi.fn(), state);
		expect(await screen.findByRole("heading", { name: "Done pile" })).toBeInTheDocument();
		expect(bucketSeqs("x").sort()).toEqual([7, 8]);
	});

	it("edits buckets from View options and saves them in the view's layout", async () => {
		renderAttentionBoard();
		await screen.findByTestId("attention-view");
		fireEvent.click(screen.getByTestId("board-view-options"));
		const editor = await screen.findByTestId("attention-options");
		const rows = within(editor).getAllByTestId("attention-options-bucket");
		expect(rows).toHaveLength(4);

		const query = within(rows[1]).getByRole("textbox", { name: "Bucket query" });
		fireEvent.change(query, { target: { value: "status:todo priority:P0" } });
		expect(api.request.setBoardViewState).not.toHaveBeenCalled();
		fireEvent.focusOut(query);
		await waitFor(() => expect(api.request.setBoardViewState).toHaveBeenCalledTimes(1));
		const saved = vi.mocked(api.request.setBoardViewState).mock.calls[0][0].state;
		const view = saved.savedViews.find((v) => v.id === saved.slots.wide)!;
		expect((view.layouts[ATTENTION_VIEW_ID] as { buckets: { query: string }[] }).buckets[1].query).toBe("status:todo priority:P0");
		expect(bucketSeqs("ready")).toEqual([]);

		fireEvent.click(within(rows[0]).getByRole("button", { name: "Remove bucket" }));
		expect(within(editor).getAllByTestId("attention-options-bucket")).toHaveLength(3);
		expect(screen.queryByRole("heading", { name: "Needs you" })).not.toBeInTheDocument();

		fireEvent.click(within(editor).getByRole("button", { name: "Reset to defaults" }));
		expect(within(editor).getAllByTestId("attention-options-bucket")).toHaveLength(4);
		expect(bucketSeqs("ready")).toEqual([2]);
	});
});

describe("AttentionView on narrow", () => {
	it("stacks the buckets in one column", () => {
		const board = {
			formFactor: "narrow",
			scope: { kind: "project", id: "p1", projectIds: ["p1"] },
			tasks: () => [],
			matches: () => false,
			layout: () => undefined,
			setLayout: vi.fn(),
			columns: () => [],
			projects: () => [project],
		} as unknown as BoardService;
		const ctx = { board, on: () => () => {} } as unknown as Context;
		render(
			<I18nProvider>
				<CordisContext.Provider value={ctx}><AttentionView ctx={ctx} /></CordisContext.Provider>
			</I18nProvider>,
		);
		expect(screen.getByTestId("attention-view").className).toContain("flex-col");
		expect(screen.getAllByText("Nothing here")).toHaveLength(4);
	});
});
