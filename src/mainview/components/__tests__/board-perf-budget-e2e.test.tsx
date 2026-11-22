import { act, render } from "@testing-library/react";
import { Profiler, type ReactNode } from "react";
import type { Context } from "cordis";
import TaskCard from "../TaskCard";
import ActiveTasksSidebar from "../ActiveTasksSidebar";
import { I18nProvider } from "../../i18n";
import type { CodingAgent, Project, Task } from "../../../shared/types";
import { getAppRoot } from "../../plugins/root";
import { countSlotSubscriptions } from "../../plugins/__tests__/slot-subscriptions";
import type { SlotItem, SlotRegistry } from "../../plugins/slot-registry";
import { TaskMarkersProvider } from "../../task-markers/TaskMarkers";
import { installTaskMenuBuiltins } from "../../task-menu/__tests__/install-builtins";
import { installTaskMarkerBuiltins } from "../../task-markers/__tests__/install-builtins";

/**
 * Performance budgets for the 2400-task board (Phase 9). The guards are counts, not
 * timings: slot subscriptions must not grow with the number of cards, and a slot
 * change re-renders only the cards that read that slot. The wall-clock ceilings are
 * loose on purpose, to catch an order-of-magnitude regression without flaking on CI.
 */

vi.mock("../../rpc", () => ({
	api: {
		request: {
			moveTask: vi.fn(),
			cancelTaskPreparation: vi.fn(),
			moveTaskToCustomColumn: vi.fn(),
			deleteTask: vi.fn(),
			setTaskLabels: vi.fn(),
			toggleTaskWatch: vi.fn(),
			getTerminalPreview: vi.fn(),
			getAvailableApps: vi.fn().mockResolvedValue([
				{ id: "finder", name: "Finder", macAppName: "Finder" },
				{ id: "vscode", name: "VS Code", macAppName: "Visual Studio Code" },
			]),
			openInApp: vi.fn().mockResolvedValue(undefined),
			cancelScheduledMessage: vi.fn().mockResolvedValue({ id: "t1", scheduledMessages: [] }),
			sendScheduledMessageNow: vi.fn().mockResolvedValue({ id: "t1", scheduledMessages: [] }),
			stopDevServer: vi.fn().mockResolvedValue({}),
			cancelScheduledLaunch: vi.fn(),
			startScheduledLaunchNow: vi.fn(),
			startTaskLaunchAfterNow: vi.fn(),
			clearTaskLaunchAfter: vi.fn(),
			refreshTaskPrStatus: vi.fn().mockResolvedValue(undefined),
			getAgentRateLimits: vi.fn().mockResolvedValue({ snapshots: [], sessions: [], generatedAt: 0 }),
			getAllProjectTasks: vi.fn().mockResolvedValue([]),
			getTaskLineage: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
			getTipState: vi.fn().mockResolvedValue({ snoozedUntil: 0, seen: {}, rotationIndex: 0 }),
			updateTipState: vi.fn(async (state) => state),
			getSpaces: vi.fn().mockResolvedValue({ version: 1, spaces: [], order: [] }),
			getProjectPRs: vi.fn().mockResolvedValue([]),
			resolveReviewedPr: vi.fn().mockResolvedValue(null),
			getGlobalSettings: vi.fn().mockResolvedValue({ tipsDisabled: true }),
		},
	},
}));
vi.mock("../../analytics", () => ({ trackEvent: vi.fn(), agentNameFromId: vi.fn(() => "unknown") }));
vi.mock("../../confirm", () => ({ confirm: vi.fn(), ConfirmHost: () => null }));
vi.mock("../../toast", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }, ToastHost: () => null }));

const N = 2400;
/** Measured ~3.5 s in happy-dom on a dev laptop for both; 10x headroom. */
const MOUNT_CEILING_MS = 35_000;
/** Measured ~0.2 s for a marker registration across 2400 cards. */
const REGISTRATION_CEILING_MS = 5_000;

const project: Project = { id: "p1", name: "Test", path: "/tmp/test", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "2025-01-01T00:00:00Z" };
const agents: CodingAgent[] = [{ id: "builtin-claude", name: "Claude", baseCommand: "claude", isDefault: true, configurations: [{ id: "c", name: "Opus" }], defaultConfigId: "c" }];

function tasks(status: Task["status"]): Task[] {
	return Array.from({ length: N }, (_, i) => ({
		id: `t${i}`, seq: i + 1, projectId: "p1", title: `Task number ${i}`, description: "d", status,
		baseBranch: "main", worktreePath: "/tmp/wt", branchName: `b${i}`, groupId: null, variantIndex: null,
		agentId: "builtin-claude", configId: "c", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
		// 5% carry a built-in marker, as on a real board.
		...(i % 20 === 0 ? { terminalBackend: "native" } : {}),
	}) as Task);
}

async function settle(): Promise<void> {
	for (let tick = 0; tick < 50; tick++) await act(async () => {});
}

const LATE: Record<string, SlotItem & Record<string, unknown>> = {
	commands: { id: "ext:command", order: 0, labelKey: "command.boardView", labelVars: { name: "x" }, category: "nav", scope: "always", run: () => {} },
	taskMenu: { id: "ext:row", region: "open", label: () => "Row", run: () => {} },
	taskMarkers: { id: "ext:marker", when: () => true, label: () => "Marker", component: () => <span /> },
};

function registerLate(slot: string): void {
	getAppRoot().plugin({
		name: `late-${slot}`,
		inject: [slot],
		apply(ctx: Context) {
			(ctx as unknown as Record<string, SlotRegistry<SlotItem>>)[slot].register(LATE[slot]);
		},
	});
}

beforeEach(async () => {
	await installTaskMenuBuiltins();
	await installTaskMarkerBuiltins();
	// The sidebar's once-a-second status-age ticker re-renders every row. Where one such render
	// outlasts a second (a CI runner), real ticks never let the list settle, and they would add
	// commits to every count here. Only intervals are faked; promises and timeouts stay real.
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
	vi.useRealTimers();
});

const surfaces: [string, () => ReactNode][] = [
	["board", () => tasks("todo").map((task) => (
		<Profiler key={task.id} id="row" onRender={onRow}>
			<TaskCard task={task} project={project} dispatch={vi.fn()} navigate={vi.fn()} agents={agents} onLaunchVariants={vi.fn()} onAddAttempts={vi.fn()} onDragStart={vi.fn()} siblingMap={new Map()} />
		</Profiler>
	))],
	["sidebar", () => (
		<Profiler id="row" onRender={onRow}>
			<ActiveTasksSidebar project={project} tasks={tasks("in-progress")} dispatch={vi.fn()} navigate={vi.fn()} agents={agents} bellCounts={new Map()} taskPorts={new Map()} />
		</Profiler>
	)],
];

let rowRenders = 0;
function onRow(): void {
	rowRenders++;
}

describe(`${N}-task board budgets`, () => {
	it.each(surfaces)("%s: slot subscriptions do not grow with the number of tasks, and a slot change wakes only its readers", async (surface, view) => {
		const subscriptions = countSlotSubscriptions();
		const started = performance.now();
		render(<I18nProvider><TaskMarkersProvider>{view()}</TaskMarkersProvider></I18nProvider>);
		expect(performance.now() - started).toBeLessThan(MOUNT_CEILING_MS);
		// One provider-level subscription at most per slot, never one per row.
		for (const [slot, count] of subscriptions) expect(count, `${slot} subscriptions`).toBeLessThanOrEqual(1);
		await settle();

		for (const slot of ["commands", "taskMenu"]) {
			rowRenders = 0;
			registerLate(slot);
			await settle();
			expect(rowRenders, `${slot} registration re-rendered rows`).toBe(0);
		}

		// A marker may apply to any task, so every row reads it: each card once on the board (one
		// Profiler per card), the sidebar list (one Profiler) in one commit.
		rowRenders = 0;
		const registered = performance.now();
		registerLate("taskMarkers");
		await settle();
		expect(performance.now() - registered).toBeLessThan(REGISTRATION_CEILING_MS);
		expect(rowRenders).toBeLessThanOrEqual(surface === "board" ? N : 1);
	}, 120_000);
});
