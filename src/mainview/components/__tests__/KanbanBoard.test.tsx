import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import KanbanBoard from "../KanbanBoard";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import type { CustomColumn, Project, TipState } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAgents: vi.fn().mockResolvedValue([]),
			getGlobalSettings: vi.fn().mockResolvedValue({
				defaultAgentId: "builtin-claude",
				defaultConfigId: "claude-default",
				taskDropPosition: "top",
				updateChannel: "stable",
			}),
			reorderColumns: vi.fn().mockResolvedValue(undefined),
			getTipState: vi.fn().mockResolvedValue({ snoozedUntil: 0, seen: {}, rotationIndex: 0 }),
			updateTipState: vi.fn().mockResolvedValue({ snoozedUntil: 0, seen: {}, rotationIndex: 0 }),
			resetTipState: vi.fn().mockResolvedValue({ snoozedUntil: 0, seen: {}, rotationIndex: 0 }),
			getProjectCurrentBranch: vi.fn().mockResolvedValue({ branch: "main", isBaseBranch: true, isDirty: false }),
			getProjectPRs: vi.fn().mockResolvedValue([]),
		},
	},
}));

vi.mock("../../analytics", () => ({ trackEvent: vi.fn() }));

const project: Project = {
	id: "p1",
	name: "Test Project",
	path: "/tmp/test",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

const customColA: CustomColumn = { id: "col-a", name: "Alpha", color: "#ff0000", llmInstruction: "" };
const customColB: CustomColumn = { id: "col-b", name: "Beta", color: "#00ff00", llmInstruction: "" };

function makeDt(data: Record<string, string> = {}): DataTransfer {
	return {
		types: Object.keys(data),
		getData: (key: string) => data[key] ?? "",
		setData: vi.fn((k: string, v: string) => { data[k] = v; }),
		effectAllowed: "move" as const,
		dropEffect: "move" as const,
	} as unknown as DataTransfer;
}

function dispatchDrag(el: Element, type: string, opts: { clientX?: number; dataTransfer?: DataTransfer } = {}): boolean {
	const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: opts.clientX ?? 0 });
	Object.defineProperty(event, "dataTransfer", { value: opts.dataTransfer ?? makeDt() });
	let prevented = false;
	act(() => { prevented = !el.dispatchEvent(event); });
	return prevented;
}

function getColumnEl(name: string) {
	return screen.getByText(name).closest("[class*='glass-column']") as HTMLElement;
}

function getHandle(name: string) {
	// The drag handle is inside the column with the given label text
	const col = getColumnEl(name);
	return col.querySelector("[title='Drag to reorder']") as Element;
}

function startColumnDrag(handle: Element) {
	const dt = makeDt();
	dispatchDrag(handle, "dragstart", { dataTransfer: dt });
}

async function renderBoardWith(props: Partial<React.ComponentProps<typeof KanbanBoard>> = {}) {
	let result: ReturnType<typeof render>;
	await act(async () => {
		result = render(
			<I18nProvider>
				<KanbanBoard
					project={props.project ?? project}
					tasks={props.tasks ?? []}
					dispatch={props.dispatch ?? vi.fn()}
					navigate={props.navigate ?? vi.fn()}
					bellCounts={props.bellCounts ?? new Map()}
					taskPorts={props.taskPorts ?? new Map()}
				/>
			</I18nProvider>,
		);
	});
	return result!;
}

function getColumnLabels() {
	const columns = document.querySelectorAll("[class*='glass-column']");
	return Array.from(columns).map((c) => {
		// Expanded column: normal header label
		const expanded = c.querySelector(".text-fg.text-sm.font-semibold");
		if (expanded) return expanded.textContent ?? "";
		// Collapsed column: vertical label
		const collapsed = c.querySelector(".kanban-col-vertical-label");
		if (collapsed) return collapsed.textContent ?? "";
		return "";
	});
}

describe("column ordering", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
	});

	it("review-by-colleague appears before completed in default order", async () => {
		await renderBoardWith();
		const labels = getColumnLabels();
		const colleagueIdx = labels.findIndex((l) => l === "PR Review");
		const completedIdx = labels.findIndex((l) => l === "Completed");
		expect(colleagueIdx).toBeGreaterThan(0);
		expect(colleagueIdx).toBeLessThan(completedIdx);
	});

	it("review-by-colleague is hidden when peerReviewEnabled is false", async () => {
		await renderBoardWith({ project: { ...project, peerReviewEnabled: false } });
		const labels = getColumnLabels();
		expect(labels).not.toContain("PR Review");
	});

	it("review-by-colleague is inserted before completed when missing from stored columnOrder", async () => {
		await renderBoardWith({
			project: {
				...project,
				columnOrder: ["todo", "in-progress", "user-questions", "review-by-user", "completed", "cancelled", "review-by-ai"],
			},
		});
		const labels = getColumnLabels();
		const colleagueIdx = labels.findIndex((l) => l === "PR Review");
		const completedIdx = labels.findIndex((l) => l === "Completed");
		expect(colleagueIdx).toBeGreaterThan(0);
		expect(colleagueIdx).toBeLessThan(completedIdx);
	});

	it("review-by-colleague stays in stored position when already in columnOrder", async () => {
		await renderBoardWith({
			project: {
				...project,
				columnOrder: ["review-by-colleague", "todo", "in-progress", "user-questions", "review-by-user", "completed", "cancelled", "review-by-ai"],
			},
		});
		const labels = getColumnLabels();
		expect(labels[0]).toBe("PR Review");
	});

	it("review-by-colleague is hidden when peerReviewEnabled is false and NOT in stored columnOrder", async () => {
		await renderBoardWith({
			project: {
				...project,
				peerReviewEnabled: false,
				columnOrder: ["todo", "in-progress", "user-questions", "review-by-user", "completed", "cancelled", "review-by-ai"],
			},
		});
		expect(getColumnLabels()).not.toContain("PR Review");
	});

	it("review-by-colleague is hidden when peerReviewEnabled is false, even if in stored columnOrder", async () => {
		await renderBoardWith({
			project: {
				...project,
				peerReviewEnabled: false,
				columnOrder: ["todo", "review-by-colleague", "in-progress", "completed", "cancelled", "review-by-ai", "review-by-user", "user-questions"],
			},
		});
		expect(getColumnLabels()).not.toContain("PR Review");
	});

	it("getOrderedColumns returns default order when columnOrder is absent", async () => {
		await renderBoardWith({ project: { ...project, customColumns: [customColA] } });
		// Default order: built-ins before custom, then completed/cancelled
		// The custom column "Alpha" should appear between review-by-user and completed
		const labels = getColumnLabels();
		// First column is To Do (collapsed, but label still present)
		expect(labels[0]).toMatch(/To Do/i);
		// Custom column appears after review-by-user and before completed
		const alphaIndex = labels.findIndex((l) => l === "Alpha");
		const completedIndex = labels.findIndex((l) => l === "Completed");
		const cancelledIndex = labels.findIndex((l) => l === "Cancelled");
		expect(alphaIndex).toBeGreaterThan(0);
		expect(alphaIndex).toBeLessThan(completedIndex);
		expect(alphaIndex).toBeLessThan(cancelledIndex);
	});

	it("getOrderedColumns respects stored columnOrder mixing built-ins and custom cols", async () => {
		await renderBoardWith({
			project: {
				...project,
				customColumns: [customColA, customColB],
				columnOrder: ["col-a", "todo", "in-progress", "col-b", "user-questions", "review-by-ai", "review-by-user", "completed", "cancelled"],
			},
		});
		const labels = getColumnLabels();
		const alphaIdx = labels.findIndex((l) => l === "Alpha");
		const todoIdx = labels.findIndex((l) => l === "To Do");
		const betaIdx = labels.findIndex((l) => l === "Beta");
		const inProgressIdx = labels.findIndex((l) => l === "Agent is Working");
		expect(alphaIdx).toBeLessThan(todoIdx);
		expect(betaIdx).toBeGreaterThan(inProgressIdx);
	});

	it("getOrderedColumns appends unknown/missing statuses at end", async () => {
		await renderBoardWith({
			project: {
				...project,
				customColumns: [customColA],
				columnOrder: ["todo", "in-progress", "col-a"],
			},
		});
		const labels = getColumnLabels();
		const todoIdx = labels.findIndex((l) => l === "To Do");
		const inProgressIdx = labels.findIndex((l) => l === "Agent is Working");
		const alphaIdx = labels.findIndex((l) => l === "Alpha");
		// Listed items appear in order
		expect(todoIdx).toBeLessThan(inProgressIdx);
		expect(inProgressIdx).toBeLessThan(alphaIdx);
		// Missing statuses are appended — they should all exist somewhere after alphaIdx
		const completedIdx = labels.findIndex((l) => l === "Completed");
		const cancelledIdx = labels.findIndex((l) => l === "Cancelled");
		expect(completedIdx).toBeGreaterThan(alphaIdx);
		expect(cancelledIdx).toBeGreaterThan(alphaIdx);
	});

	it("handleColumnDrop moves custom column before a built-in column", async () => {
		const dispatch = vi.fn();
		await renderBoardWith({
			project: { ...project, customColumns: [customColA] },
			dispatch,
		});
		// Drag "Alpha" (custom col) and drop it BEFORE "To Do" (built-in)
		const handle = getHandle("Alpha");
		startColumnDrag(handle);
		const todoCol = getColumnEl("To Do");
		// clientX < 0 → "before" (happy-dom rect center is 0)
		dispatchDrag(todoCol, "dragover", { clientX: -1 });
		dispatchDrag(todoCol, "drop");

		// dispatch should have been called with updateProject containing the new columnOrder
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const updateProjectCalls = dispatch.mock.calls.filter((call: any[]) => call[0]?.type === "updateProject");
		expect(updateProjectCalls.length).toBeGreaterThan(0);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const newOrder = (updateProjectCalls[updateProjectCalls.length - 1] as any[])[0].project.columnOrder as string[];
		const alphaIdx = newOrder.indexOf("col-a");
		const todoIdx = newOrder.indexOf("todo");
		expect(alphaIdx).toBeLessThan(todoIdx);
	});

	it("handleColumnDrop moves custom column after another custom column", async () => {
		const dispatch = vi.fn();
		await renderBoardWith({
			project: {
				...project,
				customColumns: [customColA, customColB],
				columnOrder: ["todo", "col-a", "col-b", "in-progress", "user-questions", "review-by-ai", "review-by-user", "completed", "cancelled"],
			},
			dispatch,
		});
		// Drag "Beta" and drop AFTER "Alpha"
		const betaHandle = getHandle("Beta");
		startColumnDrag(betaHandle);
		// Wait — "Beta" is already after "Alpha". Let's drag "Alpha" to AFTER "Beta" instead.
		// Reset: drag Alpha handle over Beta column (clientX > 0 → "after")
		const alphaHandle = getHandle("Alpha");
		startColumnDrag(alphaHandle);
		const betaCol = getColumnEl("Beta");
		dispatchDrag(betaCol, "dragover", { clientX: 1 });
		dispatchDrag(betaCol, "drop");

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const updateProjectCalls = dispatch.mock.calls.filter((call: any[]) => call[0]?.type === "updateProject");
		expect(updateProjectCalls.length).toBeGreaterThan(0);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const newOrder = (updateProjectCalls[updateProjectCalls.length - 1] as any[])[0].project.columnOrder as string[];
		const alphaIdx = newOrder.indexOf("col-a");
		const betaIdx = newOrder.indexOf("col-b");
		// Alpha moved after Beta
		expect(alphaIdx).toBeGreaterThan(betaIdx);
	});
});

describe("tip rotation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
	});

	async function renderForRotation() {
		await act(async () => {
			render(
				<I18nProvider>
					<KanbanBoard
						project={project}
						tasks={[]}
						dispatch={vi.fn()}
						navigate={vi.fn()}
						bellCounts={new Map()}
						taskPorts={new Map()}
					/>
				</I18nProvider>,
			);
		});
		// The progress bar drives rotation; return it so tests can fire its animationend.
		return await screen.findByTestId("tip-progress");
	}

	it("rotates the tip when the progress-bar animation ends, advancing rotationIndex", async () => {
		const getTipState = vi.mocked(api.request.getTipState);
		const updateTipState = vi.mocked(api.request.updateTipState);
		getTipState.mockResolvedValue({ snoozedUntil: 0, seen: {}, rotationIndex: 0 });
		// Echo params back so the applied TipState advances the persisted rotationIndex.
		updateTipState.mockImplementation((params: Partial<TipState>) =>
			Promise.resolve({ snoozedUntil: 0, seen: {}, rotationIndex: 0, ...params } as TipState),
		);

		const bar = await renderForRotation();

		// First rotation: the progress animation completes.
		await act(async () => { fireEvent.animationEnd(bar, { animationName: "tip-progress" }); });
		await waitFor(() => expect(updateTipState).toHaveBeenCalledTimes(1));
		expect(updateTipState.mock.calls[0][0].rotationIndex).toBe(1);

		// Second rotation: the bar remounts (new key) and its animation ends again.
		const bar2 = await screen.findByTestId("tip-progress");
		await act(async () => { fireEvent.animationEnd(bar2, { animationName: "tip-progress" }); });
		await waitFor(() => expect(updateTipState).toHaveBeenCalledTimes(2));
		expect(updateTipState.mock.calls[1][0].rotationIndex).toBe(2);
	});

	it("persists TipState with the unchanged shape (seen[tipId]=timestamp, advancing rotationIndex)", async () => {
		const getTipState = vi.mocked(api.request.getTipState);
		const updateTipState = vi.mocked(api.request.updateTipState);
		getTipState.mockResolvedValue({ snoozedUntil: 0, seen: {}, rotationIndex: 0 });
		updateTipState.mockImplementation((params: Partial<TipState>) =>
			Promise.resolve({ snoozedUntil: 0, seen: {}, rotationIndex: 0, ...params } as TipState),
		);

		const bar = await renderForRotation();
		await act(async () => { fireEvent.animationEnd(bar, { animationName: "tip-progress" }); });
		await waitFor(() => expect(updateTipState).toHaveBeenCalledTimes(1));

		const payload = updateTipState.mock.calls[0][0];
		// Only the two writable keys are sent — no new/renamed fields that an older version can't read.
		expect(Object.keys(payload).sort()).toEqual(["rotationIndex", "seen"]);
		expect(payload.rotationIndex).toBe(1);
		// seen maps a tip id → a numeric timestamp.
		const seenEntries = Object.entries(payload.seen ?? {});
		expect(seenEntries.length).toBe(1);
		const [tipId, ts] = seenEntries[0];
		expect(typeof tipId).toBe("string");
		expect(typeof ts).toBe("number");
	});
});

describe("collapsible columns", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
	});

	it("renders completed, cancelled as collapsed by default", async () => {
		await renderBoardWith();
		const collapsedCols = document.querySelectorAll("[data-collapsed-column]");
		expect(collapsedCols.length).toBe(2);
	});

	it("active columns are always expanded", async () => {
		await renderBoardWith();
		// "Agent is Working" (in-progress) should not be collapsed
		const labels = getColumnLabels();
		expect(labels).toContain("Agent is Working");
	});

	it("collapsed columns are excluded from tip placement", async () => {
		// Tip should not be placed in collapsed todo column
		await renderBoardWith();
		const collapsedCols = document.querySelectorAll("[data-collapsed-column]");
		for (const col of collapsedCols) {
			// Collapsed columns should not contain TipCard content
			expect(col.querySelector("[class*='tip']")).toBeNull();
		}
	});
});
