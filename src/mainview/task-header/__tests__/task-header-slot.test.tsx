import { act, render, screen } from "@testing-library/react";
import type { Context, Fiber } from "cordis";
import { I18nProvider } from "../../i18n";
import { applyBuiltinPlugins, resetPluginsForTests } from "../../plugins/runtime";
import { getAppRoot } from "../../plugins/root";
import type { Project, Task } from "../../../shared/types";
import type { TaskBranchStatusController } from "../../components/task-info-panel/useTaskBranchStatus";
import { BUILTIN_TASK_HEADER_PLUGIN, LEGACY_REGIONS, legacyClusterId } from "../builtins";
import { BUILTIN_GIT_ITEMS } from "../builtin-git";
import { getTaskHeaderRegistry, TASK_HEADER_REGIONS } from "../registry";
import { TaskHeaderProvider, TaskHeaderRegionItems, type LegacyClusters, type LegacyRegion } from "../scope";

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

function clusters(surface: "bar" | "sheet"): LegacyClusters {
	const make = (region: LegacyRegion) => ({ [surface]: <span data-testid={`legacy-${region}-${surface}`}>{region}</span> });
	return { status: make("status"), session: make("session"), runtime: make("runtime") };
}

function renderRegions(legacy: LegacyClusters, surface: "bar" | "sheet" = "bar") {
	return render(
		<I18nProvider>
			<TaskHeaderProvider
				value={{
					scope: { task, project, dispatch: vi.fn(), navigate: vi.fn() },
					legacy,
					layout: { compact: false, tight: false, collapsed: true },
					git,
				}}
			>
				{TASK_HEADER_REGIONS.map((region) => (
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
	it("registers one built-in legacy cluster per region not yet split, in its own region", () => {
		const registry = getTaskHeaderRegistry();
		expect(registry.kind).toBe("contribute");
		for (const region of LEGACY_REGIONS) {
			expect(registry.listRegion(region).map((entry) => entry.def.id)).toEqual([legacyClusterId(region)]);
		}
	});

	it("gives the Git bar its own items and no legacy cluster", () => {
		const registry = getTaskHeaderRegistry();
		expect(registry.listRegion("git").map((entry) => entry.def.id)).toEqual([
			"builtin:git.ops-repo", "builtin:git.workflow-off", "builtin:git.branch", "builtin:git.changes", "builtin:git.pr-status",
			"builtin:git.actions",
		]);
		expect(registry.listRegion("git.actions").map((entry) => entry.def.id)).toEqual([
			"builtin:git.commit", "builtin:git.rebase", "builtin:git.push", "builtin:git.pr", "builtin:git.auto-pr",
			"builtin:git.merge", "builtin:git.refresh",
		]);
		expect(registry.list()).toHaveLength(LEGACY_REGIONS.length + BUILTIN_GIT_ITEMS.length);
	});

	it("renders each legacy region's cluster inside its own bar, for the surface asked", () => {
		renderRegions(clusters("bar"));
		for (const region of LEGACY_REGIONS) {
			expect(screen.getByTestId(`bar-${region}`)).toContainElement(screen.getByTestId(`legacy-${region}-bar`));
		}
	});

	it("draws the Git items in the bar's order: branch, changes, then the actions", () => {
		renderRegions(clusters("bar"));
		const bar = screen.getByTestId("bar-git");
		const labels = Array.from(bar.querySelectorAll('[aria-label]:not([aria-hidden="true"])')).map((el) => el.getAttribute("aria-label"));
		expect(labels).toEqual([
			"Branch feat/x — copy actions",
			"Commit", "Rebase", "Push", "Create PR", "PR + auto-merge", "Merge", "Refresh branch status",
		]);
	});

	it("draws the Git sheet rows from the same items, without the bar-only ones", () => {
		renderRegions(clusters("sheet"), "sheet");
		const sheet = screen.getByTestId("bar-git");
		expect(sheet.querySelector('[data-testid="branch-chip"]')).toBeNull();
		expect(Array.from(sheet.querySelectorAll("button .text-sm")).map((el) => el.textContent)).toEqual([
			"Commit", "Rebase", "Push", "Create PR", "PR + auto-merge", "Merge",
		]);
	});

	it("renders the sheet form on the narrow sheet, and nothing for a region without one", () => {
		const legacy = clusters("sheet");
		legacy.session = {};
		renderRegions(legacy, "sheet");
		expect(screen.getByTestId("legacy-status-sheet")).toBeInTheDocument();
		expect(screen.queryByText("session")).toBeNull();
		expect(screen.getByTestId("bar-session").textContent).toBe("");
	});

	it("lays the region out as children of the host's bar (display: contents)", () => {
		renderRegions(clusters("bar"));
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
				ctx.taskHeader.register({ id: "builtin:git.crash-test", region: "git", order: -1, component: Crash });
				ctx.taskHeader.register({ id: "builtin:git.crash-action-test", region: "git.actions", order: 25, component: Crash });
			},
		});
		await act(async () => {
			await fiber;
		});
		renderRegions(clusters("bar"));
		for (const region of LEGACY_REGIONS) expect(screen.getByTestId(`legacy-${region}-bar`)).toBeInTheDocument();
		expect(screen.getByTestId("branch-chip")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Push" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Create PR" })).toBeInTheDocument();
		expect(error.mock.calls.some((call) => String(call[0]).includes("builtin:git.crash-action-test crashed"))).toBe(true);
		expect(error.mock.calls.some((call) => String(call[0]).includes("builtin:git.crash-test crashed"))).toBe(true);
		error.mockRestore();
	});
});
