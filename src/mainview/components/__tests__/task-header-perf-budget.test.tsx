import { act, render } from "@testing-library/react";
import { Profiler } from "react";
import type { Context } from "cordis";
import TaskHeader from "../TaskHeader";
import { I18nProvider } from "../../i18n";
import type { BranchStatus, Project, Task } from "../../../shared/types";
import { applyBuiltinPlugins, resetPluginsForTests } from "../../plugins/runtime";
import { getAppRoot, observeAppSlots } from "../../plugins/root";
import type { SlotItem, SlotRegistry } from "../../plugins/slot-registry";
import { BUILTIN_TASK_HEADER_PLUGIN } from "../../task-header/builtins";

/**
 * Performance budgets for the task header (Phase 9): counts, not timings. Its slot subscriptions
 * stay a small constant, and a change in a slot the header does not read never re-renders it.
 * The wall-clock ceiling is loose on purpose: it catches an order-of-magnitude regression only.
 */

vi.mock("../../rpc", () => ({
	api: {
		request: {
			moveTask: vi.fn(),
			addTaskNote: vi.fn(),
			updateTaskNote: vi.fn(),
			deleteTaskNote: vi.fn(),
			getResolvedProject: vi.fn(),
			setTaskPriority: vi.fn(),
			runDevServer: vi.fn(),
			checkDevServer: vi.fn(),
			stopDevServer: vi.fn(),
			restartDevServer: vi.fn(),
			getDevServerStatus: vi.fn(),
			getBranchStatus: vi.fn(),
			refreshTaskPrStatus: vi.fn().mockResolvedValue({ outcome: "updated" }),
			prepareMergeCompletionPrompt: vi.fn(),
			dismissMergeCompletionPrompt: vi.fn(),
			setTaskManualCompletion: vi.fn(),
			setTaskCompletionOwner: vi.fn(),
			rebaseTask: vi.fn(),
			rebaseTaskViaAgent: vi.fn(),
			commitTaskViaAgent: vi.fn(),
			mergeTask: vi.fn(),
			pushTask: vi.fn(),
			createPullRequest: vi.fn(),
			openPullRequest: vi.fn(),
			setTaskAttachedRepo: vi.fn().mockResolvedValue({}),
			renameTask: vi.fn(),
			getPortAllocations: vi.fn().mockResolvedValue([]),
			getGlobalSettings: vi.fn().mockResolvedValue({ defaultAgentId: "builtin-claude", defaultConfigId: "claude-default", taskSortOrder: "oldest-first", updateChannel: "stable" }),
			getAvailableApps: vi.fn().mockResolvedValue([
				{ id: "finder", name: "Finder", macAppName: "Finder" },
				{ id: "text-mate", name: "TextMate", macAppName: "TextMate" },
			]),
			openInApp: vi.fn().mockResolvedValue(undefined),
			taskPaneState: vi.fn().mockResolvedValue({
				backend: "tmux",
				panes: [],
				activePaneId: null,
				zoomedPaneId: null,
				layout: null,
				layoutPreset: null,
				capabilities: ["split", "zoom", "newWindow"],
			}),
			hibernateTask: vi.fn(),
		},
	},
}));
vi.mock("../../analytics", () => ({ trackEvent: vi.fn(), agentNameFromId: vi.fn(() => "unknown") }));
vi.mock("../../confirm", () => ({ confirm: vi.fn(), ConfirmHost: () => null }));
vi.mock("../../toast", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }, ToastHost: () => null }));

import { api } from "../../rpc";

/** Measured ~50 ms in happy-dom on a dev laptop; generous headroom. */
const MOUNT_CEILING_MS = 10_000;
const HEADER_SUBSCRIPTION_BUDGET = 8;

const project: Project = { id: "p1", name: "Test Project", path: "/tmp/test", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", defaultCompareRef: "origin/main", createdAt: "2025-01-01T00:00:00Z", labels: [] };
const task = {
	id: "t1", seq: 42, projectId: "p1", title: "Test task", description: "", status: "in-progress", baseBranch: "main", worktreePath: "/tmp/wt/t1",
	branchName: "dev3/task-t1", groupId: null, variantIndex: null, agentId: null, configId: null, createdAt: "2025-06-15T10:30:00Z", updatedAt: "2025-06-15T12:00:00Z",
} as Task;
const defaultBranchStatus: BranchStatus = {
	ahead: 3,
	behind: 0,
	baseUnreachable: false,
	canRebase: true,
	insertions: 0,
	deletions: 0,
	unpushed: 0,
	preservedOutsideBranch: false,
	mergedByContent: false,
	diffFiles: 0,
	diffInsertions: 0,
	diffDeletions: 0,
	diffFileStats: [],
	prNumber: null,
	prUrl: null,
	prState: null,
	mergeCompletionFingerprint: null,
	hasRemote: true,
	remoteIsGitHub: true,
	remoteAhead: 0,
};

async function settle(): Promise<void> {
	for (let tick = 0; tick < 50; tick++) await act(async () => {});
}

const LATE: Record<string, SlotItem & Record<string, unknown>> = {
	commands: { id: "ext:command", order: 0, labelKey: "command.boardView", labelVars: { name: "x" }, category: "nav", scope: "always", run: () => {} },
	taskMenu: { id: "ext:row", region: "open", label: () => "Row", run: () => {} },
	taskMarkers: { id: "ext:marker", when: () => true, label: () => "Marker", component: () => <span /> },
	taskPanels: { id: "ext:panel", title: () => "Panel", component: () => null },
	boardViews: { id: "ext:view", label: "View", component: () => null, supportsNarrow: true },
	taskHeader: { id: "ext:header", region: "status", order: 99, component: () => <span data-testid="late-header-item" /> },
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
	resetPluginsForTests();
	applyBuiltinPlugins([], [BUILTIN_TASK_HEADER_PLUGIN]);
	vi.mocked(api.request.getBranchStatus).mockResolvedValue(defaultBranchStatus);
	vi.mocked(api.request.getResolvedProject).mockResolvedValue(project);
	await settle();
});

describe("task header budgets", () => {
	it("keeps a constant number of slot subscriptions and ignores slots it does not read", async () => {
		const subscriptions = new Map<string, number>();
		observeAppSlots((slot: SlotRegistry<SlotItem>) => {
			const subscribe = slot.subscribe;
			vi.spyOn(slot, "subscribe").mockImplementation((listener) => {
				subscriptions.set(slot.name, (subscriptions.get(slot.name) ?? 0) + 1);
				return subscribe(listener);
			});
		});
		let commits = 0;
		const started = performance.now();
		render(
			<I18nProvider>
				<Profiler id="header" onRender={() => commits++}>
					<TaskHeader task={task} project={project} dispatch={vi.fn()} navigate={vi.fn()} />
				</Profiler>
			</I18nProvider>,
		);
		await settle();
		expect(performance.now() - started).toBeLessThan(MOUNT_CEILING_MS);
		// One subscription per drawn region (5 today: the bars and their sub-regions), none to any other
		// slot. A subscription per item or per control would blow past the budget.
		expect([...subscriptions.keys()]).toEqual(["taskHeader"]);
		expect(subscriptions.get("taskHeader")).toBeLessThanOrEqual(HEADER_SUBSCRIPTION_BUDGET);

		for (const slot of ["commands", "taskMenu", "taskMarkers", "taskPanels", "boardViews"]) {
			commits = 0;
			registerLate(slot);
			await settle();
			expect(commits, `${slot} registration re-rendered the header`).toBe(0);
		}
		commits = 0;
		registerLate("taskHeader");
		await settle();
		// Its own slot re-renders it, in one pass.
		expect(commits).toBeGreaterThan(0);
		expect(commits).toBeLessThanOrEqual(2);
	}, 60_000);
});
