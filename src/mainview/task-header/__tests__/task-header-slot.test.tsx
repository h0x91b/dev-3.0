import { act, render, screen } from "@testing-library/react";
import type { Context, Fiber } from "cordis";
import { I18nProvider } from "../../i18n";
import { applyBuiltinPlugins, resetPluginsForTests } from "../../plugins/runtime";
import { getAppRoot } from "../../plugins/root";
import type { Project, Task } from "../../../shared/types";
import type { TaskBranchStatusController } from "../../components/task-info-panel/useTaskBranchStatus";
import { BUILTIN_TASK_HEADER_PLUGIN } from "../builtins";
import { RUNTIME_ITEMS } from "../builtin-runtime";
import { SESSION_ITEMS } from "../builtin-session";
import { STATUS_DIFF_ITEMS, STATUS_ITEMS } from "../builtin-status";
import type { TaskSessionController } from "../useTaskSession";
import { BUILTIN_GIT_ITEMS } from "../builtin-git";
import { getTaskHeaderRegistry, TASK_HEADER_BUDGET_EXCEPTIONS, TASK_HEADER_REGIONS } from "../registry";
import { TaskHeaderProvider, TaskHeaderRegionItems, type TaskHeaderLayout } from "../scope";

vi.mock("../../rpc", () => ({ api: { request: {} } }));

const task = { id: "t1", projectId: "p1", title: "Task", status: "in-progress", branchName: "feat/x", worktreePath: "/tmp/wt" } as Task;
const project = { id: "p1", name: "Project" } as Project;

const branchStatus = {
	ahead: 2, behind: 0, insertions: 3, deletions: 1, canRebase: true, hasRemote: true, remoteIsGitHub: true, remoteAhead: 0,
	prNumber: null, prUrl: null, prState: null, diffFiles: 1, diffInsertions: 3, diffDeletions: 1, diffFileStats: [],
};

const git = {
	baseBranch: "main", branchStatus, prStatus: null, compareRef: "", displayRef: "origin/main", mergeRoute: "local",
	handleCommit: vi.fn(), handleCreatePR: vi.fn(), handleMerge: vi.fn(), handleOpenPR: vi.fn(), handlePush: vi.fn(),
	handleRebase: vi.fn(), handleRefreshStatus: vi.fn(), refreshStatusQuietly: vi.fn(), selectCompareRef: vi.fn(),
	committing: false, creatingPR: false, merging: false, pushing: false, rebasing: false, refreshingStatus: false,
	localMergeBlocked: false, statusError: null, statusLoading: false,
} as unknown as TaskBranchStatusController;

const DESKTOP: TaskHeaderLayout = { compact: false, tight: false, collapsed: true, narrow: false };

function renderRegions(surface: "bar" | "sheet" = "bar", layout: TaskHeaderLayout = DESKTOP) {
	return render(
		<I18nProvider>
			<TaskHeaderProvider
				value={{
					scope: { task, project, dispatch: vi.fn(), navigate: vi.fn() },
					layout,
					isTaskActive: true, resolvedProject: project,
					git,
					session: {} as TaskSessionController,
					closeSheet: vi.fn(),
					variants: [],
				}}
			>
				{/* The runtime and session items have their own suites (builtin-runtime/-session.test.tsx). */}
				{TASK_HEADER_REGIONS.filter((region) => region !== "runtime" && region !== "session").map((region) => (
					<div key={region} data-testid={`bar-${region}`}>
						<TaskHeaderRegionItems region={region} surface={surface} />
					</div>
				))}
			</TaskHeaderProvider>
		</I18nProvider>,
	);
}

beforeEach(() => {
	resetPluginsForTests();
	applyBuiltinPlugins([], [BUILTIN_TASK_HEADER_PLUGIN]);
});

describe("taskHeader slot", () => {
	it("gives the Context bar its own items, in bar order, with the diff badge's segment as a group", () => {
		const registry = getTaskHeaderRegistry();
		expect(registry.kind).toBe("contribute");
		expect(registry.listRegion("status").map((entry) => entry.def.id)).toEqual([
			"builtin:status.variant-switcher", "builtin:status.watch", "builtin:status.priority", "builtin:status.status",
			"builtin:status.narrow-outputs", "builtin:status.completion-owner", "builtin:status.diff",
		]);
		expect(registry.listRegion("status.diff").map((entry) => entry.def.id)).toEqual(["builtin:status.include-tests"]);
	});

	it("names only registered built-ins as budget exceptions", () => {
		const ids = new Set(getTaskHeaderRegistry().list().map((entry) => entry.def.id));
		for (const id of TASK_HEADER_BUDGET_EXCEPTIONS) expect(ids).toContain(id);
	});

	it("gives the Git bar its own items", () => {
		const registry = getTaskHeaderRegistry();
		expect(registry.listRegion("git").map((entry) => entry.def.id)).toEqual([
			"builtin:git.ops-repo", "builtin:git.workflow-off", "builtin:git.branch", "builtin:git.changes", "builtin:git.pr-status",
			"builtin:git.actions",
		]);
		expect(registry.listRegion("git.actions").map((entry) => entry.def.id)).toEqual([
			"builtin:git.commit", "builtin:git.rebase", "builtin:git.push", "builtin:git.pr", "builtin:git.auto-pr",
			"builtin:git.merge", "builtin:git.refresh",
		]);
		expect(registry.list()).toHaveLength(
			STATUS_ITEMS.length + STATUS_DIFF_ITEMS.length + BUILTIN_GIT_ITEMS.length + RUNTIME_ITEMS.length + SESSION_ITEMS.length,
		);
	});

	it("gives the Runtime bar its own items, in bar order", () => {
		expect(getTaskHeaderRegistry().listRegion("runtime").map((entry) => entry.def.id)).toEqual(RUNTIME_ITEMS.map((def) => def.id));
	});

	it("gives the Session bar its own items, in bar order", () => {
		expect(getTaskHeaderRegistry().listRegion("session").map((entry) => entry.def.id)).toEqual([
			"builtin:session.bug-hunters", "builtin:session.spawn-agent", "builtin:session.send-later",
			"builtin:session.hibernate", "builtin:session.scheduled-messages", "builtin:session.pane-controls",
		]);
	});

	it("draws the desktop Context bar in order: watch, priority, status with its ✓, completion owner, diff badge with its tests segment", () => {
		renderRegions();
		const bar = screen.getByTestId("bar-status");
		const labels = Array.from(bar.querySelectorAll("button")).map((el) => el.dataset.testid ?? el.getAttribute("aria-label") ?? el.textContent);
		expect(labels).toEqual([
			"Watch — notify on status changes", "Priority P3 (Low) — change", expect.stringContaining("Agent is Working"),
			"task-info-quick-complete", "task-completion-owner", "diff-summary-badge", "diff-include-tests-toggle",
		]);
	});

	it("draws the Context sheet rows from the same items: watch, then completion owner", () => {
		renderRegions("sheet");
		const sheet = screen.getByTestId("bar-status");
		expect(Array.from(sheet.querySelectorAll("button .text-sm")).map((el) => el.textContent)).toEqual(["Watch", "I’ll complete it myself"]);
	});

	it("draws the Git items in the bar's order: branch, changes, then the actions", () => {
		renderRegions();
		const bar = screen.getByTestId("bar-git");
		const labels = Array.from(bar.querySelectorAll('[aria-label]:not([aria-hidden="true"])')).map((el) => el.getAttribute("aria-label"));
		expect(labels).toEqual([
			"Branch feat/x — copy actions",
			"Commit", "Rebase", "Push", "Create PR", "PR + auto-merge", "Merge", "Refresh branch status",
		]);
	});

	it("draws the Git sheet rows from the same items, without the bar-only ones", () => {
		renderRegions("sheet");
		const sheet = screen.getByTestId("bar-git");
		expect(sheet.querySelector('[data-testid="branch-chip"]')).toBeNull();
		expect(Array.from(sheet.querySelectorAll("button .text-sm")).map((el) => el.textContent)).toEqual([
			"Commit", "Rebase", "Push", "Create PR", "PR + auto-merge", "Merge",
		]);
	});

	it("lays the region out as children of the host's bar (display: contents)", () => {
		renderRegions();
		const wrapper = screen.getByTestId("bar-git").firstElementChild as HTMLElement;
		expect(wrapper.dataset.region).toBe("git");
		expect(wrapper.className).toBe("contents");
	});

	it("isolates a crashing item: its bar and the other bars keep rendering", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		function Crash(): never {
			throw new Error("boom");
		}
		const fiber: Fiber = getAppRoot().plugin({
			name: "crashing-item",
			inject: ["taskHeader"],
			apply(ctx: Context) {
				ctx.taskHeader.register({ id: "builtin:git.crash-test", region: "git", label: "taskHeaderItem.status.watch", order: -1, component: Crash });
				ctx.taskHeader.register({ id: "builtin:status.crash-test", region: "status", label: "taskHeaderItem.status.watch", order: -1, component: Crash });
				ctx.taskHeader.register({ id: "builtin:status.crash-segment-test", region: "status.diff", label: "taskHeaderItem.status.watch", order: -1, component: Crash });
				ctx.taskHeader.register({ id: "builtin:git.crash-action-test", region: "git.actions", label: "taskHeaderItem.status.watch", order: 25, component: Crash });
			},
		});
		await act(async () => {
			await fiber;
		});
		renderRegions();
		expect(screen.getByTestId("diff-summary-badge")).toBeInTheDocument();
		expect(screen.getByTestId("diff-include-tests-toggle")).toBeInTheDocument();
		expect(screen.getByTestId("task-completion-owner")).toBeInTheDocument();
		expect(screen.getByTestId("branch-chip")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Push" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Create PR" })).toBeInTheDocument();
		expect(error.mock.calls.some((call) => String(call[0]).includes("builtin:git.crash-action-test crashed"))).toBe(true);
		expect(error.mock.calls.some((call) => String(call[0]).includes("builtin:git.crash-test crashed"))).toBe(true);
		expect(error.mock.calls.some((call) => String(call[0]).includes("builtin:status.crash-test crashed"))).toBe(true);
		expect(error.mock.calls.some((call) => String(call[0]).includes("builtin:status.crash-segment-test crashed"))).toBe(true);
		error.mockRestore();
	});

	it("[dispose] removes a plugin's items from every bar when the plugin unloads, leaving the built-ins", async () => {
		const Probe = ({ placement }: { placement: string }) => <span data-testid={`probe-${placement}`}>probe</span>;
		const fiber: Fiber = getAppRoot().plugin({
			name: "leaving-items",
			inject: ["taskHeader"],
			apply(ctx: Context) {
				ctx.taskHeader.register({ id: "builtin:git.leaving-test", region: "git", order: -1, component: Probe });
				ctx.taskHeader.register({ id: "builtin:status.leaving-test", region: "status", order: -1, component: Probe });
				ctx.taskHeader.register({ id: "builtin:git.leaving-action-test", region: "git.actions", order: 25, component: Probe });
			},
		});
		await act(async () => {
			await fiber;
		});
		renderRegions();
		expect(screen.getAllByTestId("probe-inline")).toHaveLength(3);
		await act(async () => {
			await fiber.dispose();
		});
		expect(screen.queryAllByTestId(/^probe-/)).toHaveLength(0);
		expect(screen.getByTestId("diff-summary-badge")).toBeInTheDocument();
		expect(screen.getByTestId("branch-chip")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Push" })).toBeInTheDocument();
	});
});
