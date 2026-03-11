import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import KanbanBoard from "../KanbanBoard";
import { I18nProvider } from "../../i18n";
import type { CustomColumn, Project } from "../../../shared/types";

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
			getProjectCurrentBranch: vi.fn().mockResolvedValue({ branch: "main", isBaseBranch: true }),
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

function renderBoard() {
	return render(
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
}

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

function getColumnLabels() {
	const columns = document.querySelectorAll("[class*='glass-column']");
	return Array.from(columns).map((c) => c.querySelector(".text-fg.text-sm.font-semibold")?.textContent ?? "");
}

describe("column ordering", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("review-by-colleague appears before completed in default order", () => {
		render(
			<I18nProvider>
				<KanbanBoard project={project} tasks={[]} dispatch={vi.fn()} navigate={vi.fn()} bellCounts={new Map()} taskPorts={new Map()} />
			</I18nProvider>,
		);
		const labels = getColumnLabels();
		const colleagueIdx = labels.findIndex((l) => l === "PR Review");
		const completedIdx = labels.findIndex((l) => l === "Completed");
		expect(colleagueIdx).toBeGreaterThan(0);
		expect(colleagueIdx).toBeLessThan(completedIdx);
	});

	it("review-by-colleague is hidden when peerReviewEnabled is false", () => {
		render(
			<I18nProvider>
				<KanbanBoard
					project={{ ...project, peerReviewEnabled: false }}
					tasks={[]}
					dispatch={vi.fn()}
					navigate={vi.fn()}
					bellCounts={new Map()}
						taskPorts={new Map()}
				/>
			</I18nProvider>,
		);
		const labels = getColumnLabels();
		expect(labels).not.toContain("PR Review");
	});

	it("review-by-colleague is inserted before completed when missing from stored columnOrder", () => {
		render(
			<I18nProvider>
				<KanbanBoard
					project={{
						...project,
						// Old stored order that predates review-by-colleague
						columnOrder: ["todo", "in-progress", "user-questions", "review-by-user", "completed", "cancelled", "review-by-ai"],
					}}
					tasks={[]}
					dispatch={vi.fn()}
					navigate={vi.fn()}
					bellCounts={new Map()}
						taskPorts={new Map()}
				/>
			</I18nProvider>,
		);
		const labels = getColumnLabels();
		const colleagueIdx = labels.findIndex((l) => l === "PR Review");
		const completedIdx = labels.findIndex((l) => l === "Completed");
		expect(colleagueIdx).toBeGreaterThan(0);
		expect(colleagueIdx).toBeLessThan(completedIdx);
	});

	it("review-by-colleague stays in stored position when already in columnOrder", () => {
		render(
			<I18nProvider>
				<KanbanBoard
					project={{
						...project,
						// User moved it to the very beginning
						columnOrder: ["review-by-colleague", "todo", "in-progress", "user-questions", "review-by-user", "completed", "cancelled", "review-by-ai"],
					}}
					tasks={[]}
					dispatch={vi.fn()}
					navigate={vi.fn()}
					bellCounts={new Map()}
						taskPorts={new Map()}
				/>
			</I18nProvider>,
		);
		const labels = getColumnLabels();
		expect(labels[0]).toBe("PR Review");
	});

	it("review-by-colleague is hidden when peerReviewEnabled is false and NOT in stored columnOrder", () => {
		// This is the common case: user has a saved columnOrder from before the feature existed
		render(
			<I18nProvider>
				<KanbanBoard
					project={{
						...project,
						peerReviewEnabled: false,
						columnOrder: ["todo", "in-progress", "user-questions", "review-by-user", "completed", "cancelled", "review-by-ai"],
					}}
					tasks={[]}
					dispatch={vi.fn()}
					navigate={vi.fn()}
					bellCounts={new Map()}
						taskPorts={new Map()}
				/>
			</I18nProvider>,
		);
		expect(getColumnLabels()).not.toContain("PR Review");
	});

	it("review-by-colleague is hidden when peerReviewEnabled is false, even if in stored columnOrder", () => {
		render(
			<I18nProvider>
				<KanbanBoard
					project={{
						...project,
						peerReviewEnabled: false,
						columnOrder: ["todo", "review-by-colleague", "in-progress", "completed", "cancelled", "review-by-ai", "review-by-user", "user-questions"],
					}}
					tasks={[]}
					dispatch={vi.fn()}
					navigate={vi.fn()}
					bellCounts={new Map()}
						taskPorts={new Map()}
				/>
			</I18nProvider>,
		);
		expect(getColumnLabels()).not.toContain("PR Review");
	});

	it("getOrderedColumns returns default order when columnOrder is absent", () => {
		render(
			<I18nProvider>
				<KanbanBoard
					project={{ ...project, customColumns: [customColA] }}
					tasks={[]}
					dispatch={vi.fn()}
					navigate={vi.fn()}
					bellCounts={new Map()}
						taskPorts={new Map()}
				/>
			</I18nProvider>,
		);
		// Default order: built-ins before custom, then completed/cancelled
		// The custom column "Alpha" should appear between review-by-user and completed
		const columns = document.querySelectorAll("[class*='glass-column']");
		const labels = Array.from(columns).map((c) => c.querySelector(".text-fg.text-sm.font-semibold")?.textContent);
		// Built-in columns before custom: To Do, In Progress, User Questions, Review by AI, Review by User
		expect(labels[0]).toMatch(/To Do/i);
		// Custom column appears after review-by-user and before completed
		const alphaIndex = labels.findIndex((l) => l === "Alpha");
		const completedIndex = labels.findIndex((l) => l === "Completed");
		const cancelledIndex = labels.findIndex((l) => l === "Cancelled");
		expect(alphaIndex).toBeGreaterThan(0);
		expect(alphaIndex).toBeLessThan(completedIndex);
		expect(alphaIndex).toBeLessThan(cancelledIndex);
	});

	it("getOrderedColumns respects stored columnOrder mixing built-ins and custom cols", () => {
		// columnOrder puts Alpha before "todo" and Beta after "in-progress"
		render(
			<I18nProvider>
				<KanbanBoard
					project={{
						...project,
						customColumns: [customColA, customColB],
						columnOrder: ["col-a", "todo", "in-progress", "col-b", "user-questions", "review-by-ai", "review-by-user", "completed", "cancelled"],
					}}
					tasks={[]}
					dispatch={vi.fn()}
					navigate={vi.fn()}
					bellCounts={new Map()}
						taskPorts={new Map()}
				/>
			</I18nProvider>,
		);
		const columns = document.querySelectorAll("[class*='glass-column']");
		const labels = Array.from(columns).map((c) => c.querySelector(".text-fg.text-sm.font-semibold")?.textContent);
		const alphaIdx = labels.findIndex((l) => l === "Alpha");
		const todoIdx = labels.findIndex((l) => l === "To Do");
		const betaIdx = labels.findIndex((l) => l === "Beta");
		const inProgressIdx = labels.findIndex((l) => l === "Agent is Working");
		expect(alphaIdx).toBeLessThan(todoIdx);
		expect(betaIdx).toBeGreaterThan(inProgressIdx);
	});

	it("getOrderedColumns appends unknown/missing statuses at end", () => {
		// columnOrder only lists a subset — missing statuses must be appended
		render(
			<I18nProvider>
				<KanbanBoard
					project={{
						...project,
						customColumns: [customColA],
						// Omit "cancelled" and "completed" from columnOrder
						columnOrder: ["todo", "in-progress", "col-a"],
					}}
					tasks={[]}
					dispatch={vi.fn()}
					navigate={vi.fn()}
					bellCounts={new Map()}
						taskPorts={new Map()}
				/>
			</I18nProvider>,
		);
		const columns = document.querySelectorAll("[class*='glass-column']");
		const labels = Array.from(columns).map((c) => c.querySelector(".text-fg.text-sm.font-semibold")?.textContent);
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

	it("handleColumnDrop moves custom column before a built-in column", () => {
		const dispatch = vi.fn();
		render(
			<I18nProvider>
				<KanbanBoard
					project={{
						...project,
						customColumns: [customColA],
						// Default order: todo, in-progress, ..., col-a, completed, cancelled
					}}
					tasks={[]}
					dispatch={dispatch}
					navigate={vi.fn()}
					bellCounts={new Map()}
						taskPorts={new Map()}
				/>
			</I18nProvider>,
		);
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

	it("handleColumnDrop moves custom column after another custom column", () => {
		const dispatch = vi.fn();
		render(
			<I18nProvider>
				<KanbanBoard
					project={{
						...project,
						customColumns: [customColA, customColB],
						columnOrder: ["todo", "col-a", "col-b", "in-progress", "user-questions", "review-by-ai", "review-by-user", "completed", "cancelled"],
					}}
					tasks={[]}
					dispatch={dispatch}
					navigate={vi.fn()}
					bellCounts={new Map()}
						taskPorts={new Map()}
				/>
			</I18nProvider>,
		);
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

describe("KanbanBoard keyboard shortcuts", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("Cmd+N opens the create task modal", async () => {
		renderBoard();
		expect(screen.queryByText("New Task")).not.toBeInTheDocument();
		await userEvent.keyboard("{Meta>}n{/Meta}");
		expect(screen.getByText("New Task")).toBeInTheDocument();
	});

	it("Ctrl+N opens the create task modal", async () => {
		renderBoard();
		expect(screen.queryByText("New Task")).not.toBeInTheDocument();
		await userEvent.keyboard("{Control>}n{/Control}");
		expect(screen.getByText("New Task")).toBeInTheDocument();
	});

	it("Cmd+N does nothing when the modal is already open", async () => {
		renderBoard();
		await userEvent.keyboard("{Meta>}n{/Meta}");
		expect(screen.getByText("New Task")).toBeInTheDocument();
		// Second press should not open a second modal
		await userEvent.keyboard("{Meta>}n{/Meta}");
		expect(screen.getAllByText("New Task")).toHaveLength(1);
	});

	it("Escape closes the create task modal after Cmd+N", async () => {
		renderBoard();
		await userEvent.keyboard("{Meta>}n{/Meta}");
		expect(screen.getByText("New Task")).toBeInTheDocument();
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByText("New Task")).not.toBeInTheDocument();
	});
});
