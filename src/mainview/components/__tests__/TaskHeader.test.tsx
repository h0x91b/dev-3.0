import { fireEvent, render, screen, act, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskHeader from "../TaskHeader";
import { I18nProvider } from "../../i18n";
import type { Task, Project, BranchStatus, DevServerStatus, Label } from "../../../shared/types";
import type { AppAction, Route } from "../../state";
import type { TaskInlineDiffRequest } from "../task-inline-diff";
import { applyBuiltinPlugins } from "../../plugins/runtime";
import { BUILTIN_TASK_HEADER_PLUGIN } from "../../task-header/builtins";

// The header's bars render the `taskHeader` slot; main.tsx starts its built-ins at boot.
applyBuiltinPlugins([], [BUILTIN_TASK_HEADER_PLUGIN]);

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
			saveGlobalSettings: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../../analytics", () => ({
	trackEvent: vi.fn(),
	agentNameFromId: vi.fn(() => "unknown"),
}));

vi.mock("../../utils/confirmTaskCompletion", () => ({
	confirmTaskCompletion: vi.fn().mockResolvedValue(true),
	completionSkipsGitCheck: vi.fn().mockReturnValue(true),
	unsavedWorkWarning: vi.fn().mockReturnValue(null),
}));

import { api } from "../../rpc";
import { confirm } from "../../confirm";
import { offerCompletion } from "../../completion-offers";

vi.mock("../../completion-offers", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../completion-offers")>()),
	offerCompletion: vi.fn().mockResolvedValue(false),
}));
import { toast } from "../../toast";
import { trackEvent } from "../../analytics";
import { confirmTaskCompletion } from "../../utils/confirmTaskCompletion";
import { openFolderPicker } from "../../folder-picker";
import { setHiddenControlsForTests, syncHiddenControlsFromGlobalSettings } from "../../hidden-controls";
import { setTaskHeaderLayoutForTests, syncTaskHeaderLayout } from "../../task-header/layout";
import { syncGlobalSettingsCache } from "../../global-settings-cache";

vi.mock("../../folder-picker", () => ({
	openFolderPicker: vi.fn(),
}));

vi.mock("../../confirm", () => ({
	confirm: vi.fn(),
	ConfirmHost: () => null,
}));

vi.mock("../../toast", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
	ToastHost: () => null,
}));

const mockedApi = vi.mocked(api, true);
const mockedTrackEvent = vi.mocked(trackEvent);
const mockedConfirmTaskCompletion = vi.mocked(confirmTaskCompletion);

/**
 * Stub window.matchMedia + innerWidth for a given viewport width. The component
 * reads two independent breakpoints (compact at 1600px, narrow at 768px), so the
 * mock must answer each `max-width` query against a real width rather than a
 * single flat boolean — otherwise "compact" and "narrow" can't be distinguished.
 */
function mockViewport(width: number) {
	Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
	Object.defineProperty(window, "matchMedia", {
		writable: true,
		configurable: true,
		value: vi.fn((query: string) => {
			const m = query.match(/max-width:\s*(\d+)/);
			const matches = m ? width <= Number(m[1]) : false;
			return {
				matches,
				media: query,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
				dispatchEvent: vi.fn(),
			};
		}),
	});
}

/** Back-compat wrapper: `true` = compact (but not narrow), `false` = roomy desktop. */
function mockMatchMedia(compact: boolean) {
	mockViewport(compact ? 1024 : 1920);
}

/** Tooltips open after a 250 ms intent delay: step fake time past it instead of waiting it out. */
async function hoverTooltip(user: ReturnType<typeof userEvent.setup>, anchor: Element) {
	await user.hover(anchor);
	await act(async () => {
		vi.advanceTimersByTime(300);
	});
	const tooltip = screen.getByRole("tooltip");
	return { tooltip, leave: () => user.unhover(anchor) };
}

// Default to the roomy layout (button text labels visible). happy-dom's default
// viewport (1024px) would otherwise trip the compact breakpoint and hide labels.
beforeEach(() => mockMatchMedia(false));

// ---- Fixtures ----

const label1: Label = { id: "lbl1", name: "Bug", color: "#ef4444" };
const label2: Label = { id: "lbl2", name: "Feature", color: "#3b82f6" };

const project: Project = {
	id: "p1",
	name: "Test Project",
	path: "/tmp/test",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	// A remote-backed project always reaches the renderer with this resolved (see
	// resolveProjectConfig). Unset means "no remote", and the panel then names the
	// local base branch instead of inventing `origin/<base>`.
	defaultCompareRef: "origin/main",
	createdAt: "2025-01-01T00:00:00Z",
	labels: [label1, label2],
};

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: "t1",
		seq: 42,
		projectId: "p1",
		title: "Test task",
		description: "",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: "/tmp/wt/t1",
		branchName: "dev3/task-t1",
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2025-06-15T10:30:00Z",
		updatedAt: "2025-06-15T12:00:00Z",
		...overrides,
	};
}

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

const defaultDevServerStatus: DevServerStatus = {
	projectId: "p1",
	taskId: "t1",
	running: true,
	hasDevScript: true,
	worktreePath: "/tmp/wt/t1",
	tmuxSocket: "dev3",
	backend: "tmux",
	taskSessionName: "dev3-t1",
	assignedPorts: [],
	namedPorts: {},
	ports: [],
	configErrors: [],
	servers: [{
		name: "dev",
		title: "Dev Server",
		isDefault: true,
		running: true,
		devSessionName: "dev3-dev-t1",
		viewerPaneId: "%17",
		panePids: [12345],
		namedPorts: {},
		logPath: null,
		devPorts: [],
		publishedPorts: [],
		portConflicts: [],
		extraEnvKeys: [],
		scriptArgs: [],
	}],
};

function renderPanel(
	task: Task,
	opts?: {
		dispatch?: React.Dispatch<AppAction>;
		navigate?: (route: Route) => void;
		project?: Project;
		tasks?: Task[];
		isFullPage?: boolean;
		isTerminalFullscreen?: boolean;
		onToggleTerminalFullscreen?: () => void;
		onOpenInlineDiff?: (request: TaskInlineDiffRequest) => void;
	},
) {
	const dispatch = opts?.dispatch ?? vi.fn();
	const navigate = opts?.navigate ?? vi.fn();
	const usedProject = opts?.project ?? project;
	// Ensure getResolvedProject returns the same project used in this render
	mockedApi.request.getResolvedProject.mockResolvedValue(usedProject);
	return render(
		<I18nProvider>
			<TaskHeader
				task={task}
				project={usedProject}
				dispatch={dispatch}
				navigate={navigate}
				tasks={opts?.tasks}
				isFullPage={opts?.isFullPage}
				isTerminalFullscreen={opts?.isTerminalFullscreen}
				onToggleTerminalFullscreen={opts?.onToggleTerminalFullscreen}
				onOpenInlineDiff={opts?.onOpenInlineDiff}
			/>
		</I18nProvider>,
	);
}

describe("TaskHeader", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers({ shouldAdvanceTime: true });
		localStorage.clear();
		// Default: getBranchStatus resolves immediately
		mockedApi.request.getBranchStatus.mockResolvedValue(defaultBranchStatus);
		mockedApi.request.prepareMergeCompletionPrompt.mockResolvedValue({
			shouldPrompt: true,
			fingerprint: "v1:dev3/task-t1:abc123",
		});
		mockedApi.request.dismissMergeCompletionPrompt.mockResolvedValue(makeTask());
		mockedApi.request.setTaskManualCompletion.mockResolvedValue(makeTask({ manualCompletion: true }));
		// Default: the user approves. Merge (with a remote) and a diverged Push both
		// go through `confirm` now, and an unset mock resolves undefined — which
		// silently CANCELS, making every one of those tests fail for the wrong reason.
		// The tests that care about the refusal set it to false themselves.
		vi.mocked(confirm).mockResolvedValue(true);
		// Default: getResolvedProject returns the project as-is
		mockedApi.request.getResolvedProject.mockResolvedValue(project);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("collapsed view (default)", () => {
		// The bug this closes: the collapsed branch duplicated all four bars WITHOUT
		// their `data-help-id`, so on the screen a task actually opens in, help mode
		// highlighted the header and the sidebar and nothing else. `help.test.ts`
		// stayed green because the expanded branch references the same ids — a
		// reachability check cannot tell which branch mounted them.
		it("carries every help zone help mode needs, on the branch a task opens in", async () => {
			await act(async () => {
				renderPanel(makeTask({ id: "t1" }));
			});

			const zones = [...document.querySelectorAll("[data-help-id]")].map((el) => el.getAttribute("data-help-id"));
			for (const id of ["inspector.context-bar", "inspector.session-bar", "inspector.git-bar", "inspector.runtime-bar", "inspector.panel"]) {
				expect(zones, `collapsed panel is missing the ${id} zone`).toContain(id);
			}
		});

		it("shows numbered status chips without agent glyphs and navigates to another chip", async () => {
			const current = makeTask({ id: "t1", title: "First attempt", groupId: "group-1", variantIndex: 1, agentId: "builtin-claude", configId: "claude-default" });
			const sibling = makeTask({ id: "t2", title: "Renamed attempt", groupId: "group-1", variantIndex: 2, seq: 43, agentId: "builtin-claude", configId: "claude-default" });
			const navigate = vi.fn();
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

			await act(async () => {
				renderPanel(current, { tasks: [current, sibling], navigate });
			});

			expect(screen.getByTestId("variant-switcher")).toBeInTheDocument();
			expect(screen.queryByRole("img", { name: "Claude" })).not.toBeInTheDocument();
			expect(screen.getByTestId("variant-switcher-t1")).toHaveAttribute("aria-current", "true");
			expect(screen.getByTestId("variant-switcher-t1")).toBeDisabled();

			await user.click(screen.getByTestId("variant-switcher-t2"));

			expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p1", activeTaskId: "t2" });
		});

		it("hides the variant switcher for a singleton task", async () => {
			await act(async () => {
				renderPanel(makeTask({ groupId: "group-1", variantIndex: 1 }), { tasks: [makeTask({ groupId: "group-1", variantIndex: 1 })] });
			});

			expect(screen.queryByTestId("variant-switcher")).not.toBeInTheDocument();
		});

		it("draws status, expand and full screen, and keeps labels and metadata off the collapsed bar", async () => {
			await act(async () => {
				renderPanel(makeTask({ status: "in-progress", description: "Some desc", labelIds: ["lbl1", "lbl2", "nonexistent"] }));
			});
			expect(screen.getByText("Agent is Working")).toBeInTheDocument();
			expect(screen.getByLabelText("Expand panel")).toBeInTheDocument();
			expect(screen.getByLabelText("Full screen")).toBeInTheDocument();
			// Labels live in the expanded metadata grid and the breadcrumb hover
			// card; on the bar they only stole width from status and the diff.
			expect(screen.queryByText("Bug")).not.toBeInTheDocument();
			expect(screen.queryByText("Feature")).not.toBeInTheDocument();
			expect(screen.queryByText("nonexistent")).not.toBeInTheDocument();
			// Description only shows in expanded metadata grid
			expect(screen.queryByText("Some desc")).not.toBeInTheDocument();
		});

		it("changes priority from the compact header badge, toasting a failed attempt first", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const task = makeTask({ priority: "P3" });
			const changedTask = { ...task, priority: "P1" as const };
			const dispatch = vi.fn();
			mockedApi.request.setTaskPriority
				.mockRejectedValueOnce(new Error("offline"))
				.mockResolvedValue([changedTask]);

			await act(async () => {
				renderPanel(task, { dispatch });
			});

			const priorityButton = screen.getByRole("button", { name: "Priority P3 (Low) — change" });
			await user.click(priorityButton);
			await user.click(screen.getByRole("menuitemradio", { name: /P1/ }));
			await waitFor(() => {
				expect(toast.error).toHaveBeenCalledWith("Failed to set priority: Error: offline", { taskId: "t1" });
			});
			expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateTask" }));

			await user.click(screen.getByRole("button", { name: "Priority P3 (Low) — change" }));
			await user.click(screen.getByRole("menuitemradio", { name: /P1/ }));

			expect(mockedApi.request.setTaskPriority).toHaveBeenCalledWith({
				taskId: task.id,
				projectId: project.id,
				priority: "P1",
			});
			expect(dispatch).toHaveBeenCalledWith({ type: "updateTask", task: changedTask });
		});


		it("hides tests by default and flips them back from the badge's own segment", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				diffFiles: 2,
				diffInsertions: 12,
				diffDeletions: 4,
				diffFileStats: [
					{ path: "src/app.ts", insertions: 10, deletions: 3 },
					{ path: "src/__tests__/app.test.ts", insertions: 2, deletions: 1 },
				],
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			const toggle = await screen.findByTestId("diff-include-tests-toggle");
			// The segment lives inside the badge, not beside it.
			expect(toggle.closest("div")).toContainElement(screen.getByTestId("diff-summary-badge"));
			expect(toggle).toHaveAttribute("aria-pressed", "false");
			expect(screen.getByText("1 file")).toBeInTheDocument();
			expect(screen.getByText("+10")).toBeInTheDocument();

			await act(async () => {
				await user.click(toggle);
			});

			expect(toggle).toHaveAttribute("aria-pressed", "true");
			expect(screen.getByText("2 files")).toBeInTheDocument();
			expect(screen.getByText("+12")).toBeInTheDocument();
		});

		it("shows the top diff summary badge, opens the branch diff on click and a file's diff from the popup", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const onOpenInlineDiff = vi.fn();
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				diffFiles: 2,
				diffInsertions: 12,
				diffDeletions: 4,
				diffFileStats: [{path:"bun.lock",insertions:1,deletions:0},{path:"src/mainview/App.tsx",insertions:11,deletions:4}],
			});

			await act(async () => {
				renderPanel(makeTask(), { onOpenInlineDiff });
			});

			expect(screen.getByText("2 files")).toBeInTheDocument();
			expect(screen.getByText("+12")).toBeInTheDocument();
			expect(screen.getByText("−4")).toBeInTheDocument();

			await user.click(screen.getByText("2 files").closest("button")!);

			// Pinned: the badge counts committed work, so the remembered viewer mode
			// (default "uncommitted") must not swap in a different scope.
			expect(onOpenInlineDiff).toHaveBeenLastCalledWith({
				mode: "branch",
				pinMode: true,
				compareRef: "origin/main",
				compareLabel: "origin/main",
			});

			await user.hover(screen.getByText("2 files").closest("span")!);

			expect(await screen.findByText("Changed files")).toBeInTheDocument();
			expect(screen.getByText("src/mainview/App.tsx")).toBeInTheDocument();
			const fileRow = screen.getByText("bun.lock").closest("div")!;
			await user.click(within(fileRow).getByRole("button", { name: "Show Diff" }));

			expect(onOpenInlineDiff).toHaveBeenLastCalledWith({
				mode: "branch",
				pinMode: true,
				compareRef: "origin/main",
				compareLabel: "origin/main",
				focusFile: "bun.lock",
			});
		});

		it("stacks the file-row tooltips above the changed files popup and keeps a file Open In menu open after leaving it", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				diffFiles: 1,
				diffInsertions: 12,
				diffDeletions: 4,
				diffFileStats: [{path:"src/mainview/App.tsx",insertions:10,deletions:3}],
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			await user.hover(screen.getByText("1 file").closest("span")!);
			const changedFilesHeader = await screen.findByText("Changed files");
			const popover = changedFilesHeader.parentElement!;
			const fileRow = screen.getByText("src/mainview/App.tsx").closest("div")!;

			// The file-row tooltips stack above the popup.
			const popoverZ = Number(popover.style.zIndex);
			for (const name of ["Show Diff", "Open in..."]) {
				const button = within(fileRow).getByRole("button", { name });
				fireEvent.mouseEnter(button);
				await act(async () => {
					vi.advanceTimersByTime(300);
				});
				const tooltip = screen.getByRole("tooltip");
				const tooltipZ = Number(/z-\[(\d+)\]/.exec(tooltip.className)?.[1]);
				expect(tooltipZ).toBeGreaterThan(popoverZ);
				fireEvent.mouseLeave(button);
			}

			await user.click(within(fileRow).getByRole("button", { name: "Open in..." }));

			expect(screen.getAllByText("Open in...").length).toBeGreaterThanOrEqual(2);

			fireEvent.mouseLeave(popover);
			await act(async () => {
				vi.advanceTimersByTime(150);
			});

			expect(screen.getAllByText("Open in...").length).toBeGreaterThanOrEqual(2);
			expect(await screen.findByText("TextMate")).toBeInTheDocument();
		});

		it("carries the branch as a labelled chip whose menu has the full name, the copy actions and the compare-ref picker", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			await act(async () => {
				renderPanel(makeTask({ branchName: "dev3/my-branch", worktreePath: "/tmp/wt/t1" }), { onOpenInlineDiff: vi.fn() });
			});
			// The bar shows the word, not the string: the name is 200px of mono text and
			// only the chip's name / its menu heading have to carry it.
			const chip = screen.getByTestId("branch-chip");
			expect(chip).toHaveTextContent("Branch");
			expect(chip.getAttribute("aria-label")).toContain("dev3/my-branch");
			expect(screen.queryByText("dev3/my-branch")).not.toBeInTheDocument();
			// The bar stays clean; the compare-ref setting lives one click deep.
			expect(screen.queryByText(/vs origin\/main/)).not.toBeInTheDocument();

			await user.click(chip);

			const menu = screen.getByRole("menu");
			expect(menu).toHaveTextContent("dev3/my-branch");
			expect(within(menu).getByRole("menuitem", { name: "Copy branch name" })).toBeInTheDocument();
			expect(within(menu).getByRole("menuitem", { name: "Copy worktree path" })).toBeInTheDocument();
			expect(within(menu).getByRole("menuitem", { name: "Copy checkout command" })).toBeInTheDocument();
			// A task without a PR must not offer to copy one.
			expect(within(menu).queryByRole("menuitem", { name: "Copy PR link" })).not.toBeInTheDocument();
			expect(menu).toHaveTextContent("Compare against");

			const remote = within(menu).getByRole("menuitemradio", { name: /origin\/main/ });
			const local = within(menu).getByRole("menuitemradio", { name: /main \(local\)/ });
			expect(remote).toHaveAttribute("aria-checked", "true");
			expect(local).toHaveAttribute("aria-checked", "false");

			await user.click(local);

			// Picking a ref refetches the status against it and closes the menu.
			await waitFor(() => {
				expect(mockedApi.request.getBranchStatus).toHaveBeenCalledWith({
					taskId: "t1",
					projectId: "p1",
					compareRef: "main",
				});
			});
			expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		});

		it("copies the PR link once the task has a PR, and the checkout command, saying so out loud", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const writeText = vi.fn().mockResolvedValue(undefined);
			Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

			await act(async () => {
				renderPanel(makeTask({
					branchName: "dev3/my-branch",
					prNumber: 20916,
					prUrl: "https://github.com/h0x91b/dev-3.0/pull/20916",
				}));
			});

			await user.click(screen.getByTestId("branch-chip"));
			await user.click(screen.getByRole("menuitem", { name: "Copy PR link" }));

			expect(writeText).toHaveBeenCalledWith("https://github.com/h0x91b/dev-3.0/pull/20916");
			await waitFor(() => {
				expect(vi.mocked(toast.success)).toHaveBeenCalledWith("PR link copied", { taskId: "t1" });
			});

			await user.click(screen.getByTestId("branch-chip"));
			await user.click(screen.getByRole("menuitem", { name: "Copy checkout command" }));

			expect(writeText).toHaveBeenCalledWith("git checkout dev3/my-branch");
			// Confirmation used to live inside the tooltip, where it was invisible — and it
			// only fires once the clipboard write actually resolved.
			await waitFor(() => {
				expect(vi.mocked(toast.success)).toHaveBeenCalledWith("Checkout command copied", { taskId: "t1" });
			});
			expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		});

		it("says it failed when the clipboard refuses", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const writeText = vi.fn().mockRejectedValue(new Error("denied"));
			Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

			await act(async () => {
				renderPanel(makeTask({ branchName: "dev3/my-branch" }));
			});

			await user.click(screen.getByTestId("branch-chip"));
			await user.click(screen.getByRole("menuitem", { name: "Copy branch name" }));

			await waitFor(() => {
				expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Couldn't copy to the clipboard", { taskId: "t1" });
			});
			expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
		});

	});

	describe("expanded view", () => {
		beforeEach(() => {
			localStorage.setItem("dev3-panel-collapsed", "false");
		});

		it("renders seq, labels, branch, description, worktree path, notes and the collapse button", async () => {
			await act(async () => {
				renderPanel(makeTask({
					seq: 42,
					labelIds: ["lbl1", "lbl2"],
					branchName: "dev3/task-abc",
					description: "Fix the login bug",
					worktreePath: "/tmp/wt/abc",
					notes: [
						{ id: "n1", content: "AI note content", source: "ai", createdAt: "2025-06-15T10:00:00Z", updatedAt: "2025-06-15T10:00:00Z" },
						{ id: "n2", content: "User note content", source: "user", createdAt: "2025-06-15T11:00:00Z", updatedAt: "2025-06-15T11:00:00Z" },
					],
				}));
			});
			expect(screen.getByText("#42")).toBeInTheDocument();
			expect(screen.getByText("Bug")).toBeInTheDocument();
			expect(screen.getByText("Feature")).toBeInTheDocument();
			// The bar carries a chip now, so the metadata grid is the one place the full
			// name is printed without opening anything.
			expect(screen.getAllByText("dev3/task-abc").length).toBe(1);
			expect(screen.getByText("Fix the login bug")).toBeInTheDocument();
			expect(screen.getByText("/tmp/wt/abc")).toBeInTheDocument();
			expect(screen.getByLabelText("Collapse panel")).toBeInTheDocument();
			// AI notes are read-only text, user notes are editable textareas.
			expect(screen.getByText("AI")).toBeInTheDocument();
			expect(screen.getByText("AI note content")).toBeInTheDocument();
			expect(screen.queryByDisplayValue("AI note content")).not.toBeInTheDocument();
			expect(screen.getByText("User")).toBeInTheDocument();
			expect(screen.getByDisplayValue("User note content").tagName).toBe("TEXTAREA");
		});

		it("omits the description row and shows the notes empty state when both are empty", async () => {
			await act(async () => {
				renderPanel(makeTask({ description: "", notes: [] }));
			});
			expect(screen.queryByText("Description")).not.toBeInTheDocument();
			expect(screen.getByText("Notes")).toBeInTheDocument();
			expect(screen.getByText("No notes yet")).toBeInTheDocument();
		});

		it("copies worktree path to clipboard when clicking copy button", async () => {
			const writeText = vi.fn().mockResolvedValue(undefined);
			vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

			await act(async () => {
				renderPanel(makeTask({ worktreePath: "/tmp/wt/abc" }));
			});

			const copyBtn = screen.getByLabelText("Copy path to this git worktree");
			await userEvent.click(copyBtn);

			expect(writeText).toHaveBeenCalledWith("/tmp/wt/abc");
			// The inline confirmation and the (possibly open) tooltip both read "Copied!".
			expect(screen.getAllByText("Copied!").length).toBeGreaterThan(0);
		});

	});

	describe("collapse/expand toggle", () => {
		it("expands on click, keeping the bars, their controls and the toggle's focus, and persists the state", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			await act(async () => {
				renderPanel(makeTask({ seq: 99, description: "Some desc" }));
			});
			const nodes = () => [
				document.querySelector('[data-help-id="inspector.context-bar"]'),
				document.querySelector('[data-help-id="inspector.git-bar"]'),
				document.querySelector('[data-help-id="inspector.runtime-bar"]'),
				screen.getByLabelText("Full screen"),
			];
			const before = nodes();
			before.forEach((node) => expect(node).toBeInTheDocument());

			// Collapsed initially — no description; default is collapsed=true
			expect(screen.queryByText("Some desc")).not.toBeInTheDocument();
			expect(localStorage.getItem("dev3-panel-collapsed")).toBe("true");

			await user.click(screen.getByLabelText("Expand panel"));

			// Now expanded — description visible
			expect(screen.getByText("Some desc")).toBeInTheDocument();
			expect(screen.getByText("#99")).toBeInTheDocument();
			nodes().forEach((node, i) => expect(node).toBe(before[i]));
			expect(document.activeElement).toBe(screen.getByLabelText("Collapse panel"));
			expect(localStorage.getItem("dev3-panel-collapsed")).toBe("false");
		});

		it("collapses panel when clicking collapse button", async () => {
			localStorage.setItem("dev3-panel-collapsed", "false");
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			await act(async () => {
				renderPanel(makeTask({ description: "Visible desc" }));
			});

			// Expanded — description visible
			expect(screen.getByText("Visible desc")).toBeInTheDocument();

			await user.click(screen.getByLabelText("Collapse panel"));

			// Now collapsed — no description
			expect(screen.queryByText("Visible desc")).not.toBeInTheDocument();
		});

		it("ends the Runtime bar, right of Images, in the collapsed panel", async () => {
			await act(async () => {
				renderPanel(makeTask({ sharedImages: [{ id: "i1", storedPath: "/a.png", originalPath: "/a.png", name: "a.png", mime: "image/png", bytes: 1, createdAt: 1 }] }));
			});

			const toggle = screen.getByLabelText("Expand panel");
			const images = screen.getByTestId("shared-images-badge");
			expect(images.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
			// Full screen moved down here too, and sits immediately left of the toggle.
			const fullScreen = screen.getByLabelText("Full screen");
			expect(fullScreen.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
			expect(images.compareDocumentPosition(fullScreen) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		});

		it("ends the Runtime bar, right of Images, in the expanded panel", async () => {
			localStorage.setItem("dev3-panel-collapsed", "false");
			await act(async () => {
				renderPanel(makeTask({ sharedImages: [{ id: "i1", storedPath: "/a.png", originalPath: "/a.png", name: "a.png", mime: "image/png", bytes: 1, createdAt: 1 }] }));
			});

			const toggle = screen.getByLabelText("Collapse panel");
			const runtimeBar = document.querySelector('[data-help-id="inspector.runtime-bar"]');
			expect(runtimeBar).toContainElement(toggle);
			const images = screen.getByTestId("shared-images-badge");
			expect(images.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		});
	});

	describe("status dropdown", () => {
		it("opens the allowed transitions on click and moves the task to the picked status", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const dispatch = vi.fn();
			const task = makeTask({ status: "in-progress" });
			const updatedTask = { ...task, status: "user-questions" as const };
			mockedApi.request.moveTask.mockResolvedValue(updatedTask);

			await act(async () => {
				renderPanel(task, { dispatch });
			});

			await user.click(screen.getByText("Agent is Working"));

			// in-progress can go to all other statuses
			expect(screen.getByText("To Do")).toBeInTheDocument();
			expect(screen.getByText("Completed")).toBeInTheDocument();
			expect(screen.getByText("Cancelled")).toBeInTheDocument();
			await user.click(screen.getByText("Has Questions"));

			expect(mockedApi.request.moveTask).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				newStatus: "user-questions",
				clientPlayedSound: true,
			});
			expect(dispatch).toHaveBeenCalledWith({
				type: "updateTask",
				task: updatedTask,
			});
			expect(mockedTrackEvent).toHaveBeenCalledWith("task_moved", {
				from_status: "in-progress",
				to_status: "user-questions",
				agent_name: "unknown",
			});
		});

		it("retries with force on move failure, and alerts when both attempts fail", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const dispatch = vi.fn();
			const task = makeTask({ status: "in-progress" });
			const updatedTask = { ...task, status: "review-by-user" as const };

			mockedApi.request.moveTask
				.mockRejectedValueOnce(new Error("fail1"))
				.mockRejectedValueOnce(new Error("fail2"))
				.mockRejectedValueOnce(new Error("env broken"))
				.mockResolvedValueOnce(updatedTask);

			await act(async () => {
				renderPanel(task, { dispatch });
			});

			// Both attempts fail: an alert, no update.
			await user.click(screen.getByText("Agent is Working"));
			await user.click(screen.getByText("Your Review"));
			await waitFor(() => expect(toast.error).toHaveBeenCalled());

			await user.click(screen.getByText("Agent is Working"));
			await user.click(screen.getByText("Your Review"));

			expect(mockedApi.request.moveTask).toHaveBeenCalledTimes(4);
			expect(mockedApi.request.moveTask).toHaveBeenLastCalledWith({
				taskId: "t1",
				projectId: "p1",
				newStatus: "review-by-user",
				force: true,
				clientPlayedSound: true,
			});
			expect(dispatch).toHaveBeenCalledWith({
				type: "updateTask",
				task: updatedTask,
			});
		});

		it("navigates away on completed and stamps movedAt via the fast-path", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const dispatch = vi.fn();
			const navigate = vi.fn();
			const task = makeTask({ status: "in-progress" });
			mockedApi.request.moveTask.mockResolvedValue({ ...task, status: "completed" });

			await act(async () => {
				renderPanel(task, { dispatch, navigate });
			});

			await user.click(screen.getByText("Agent is Working"));
			await user.click(screen.getByText("Completed"));

			expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p1", taskView: true });
			expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
				type: "updateTask",
				task: expect.objectContaining({ status: "completed", worktreePath: null, branchName: null }),
			}));
			const dispatchedTask = dispatch.mock.calls.find(
				(c: unknown[]) => (c[0] as AppAction).type === "updateTask",
			)?.[0] as { type: string; task: Task } | undefined;
			expect(typeof dispatchedTask!.task.movedAt).toBe("string");
			// movedAt should be a recent ISO timestamp
			expect(new Date(dispatchedTask!.task.movedAt!).getTime()).toBeGreaterThan(Date.now() - 5000);
		});

		it("does not navigate away from a newer task when terminal preflight resolves late", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const dispatch = vi.fn();
			const navigate = vi.fn();
			const closingTask = makeTask({ id: "closing", title: "Closing task" });
			const newerTask = makeTask({ id: "newer", title: "Newer task" });
			let resolveConfirmation!: (confirmed: boolean) => void;
			mockedConfirmTaskCompletion.mockReturnValue(
				new Promise<boolean>((resolve) => {
					resolveConfirmation = resolve;
				}),
			);
			mockedApi.request.moveTask.mockResolvedValue({ ...closingTask, status: "cancelled" });

			let view!: ReturnType<typeof renderPanel>;
			await act(async () => {
				view = renderPanel(closingTask, { dispatch, navigate });
			});

			await user.click(screen.getByText("Agent is Working"));
			await user.click(screen.getByText("Cancelled"));

			view.rerender(
				<I18nProvider>
					<TaskHeader
						task={newerTask}
						project={project}
						dispatch={dispatch}
						navigate={navigate}
					/>
				</I18nProvider>,
			);

			await act(async () => {
				resolveConfirmation(true);
				await Promise.resolve();
			});

			await waitFor(() => {
				expect(mockedApi.request.moveTask).toHaveBeenCalledWith(
					expect.objectContaining({
						taskId: "closing",
						projectId: "p1",
						newStatus: "cancelled",
					}),
				);
			});
			expect(navigate).not.toHaveBeenCalled();
		});

		it("navigates to the Kanban board on completed in fullscreen open-mode", async () => {
			localStorage.setItem("dev3-task-open-mode", "fullscreen");
			try {
				const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
				const dispatch = vi.fn();
				const navigate = vi.fn();
				const task = makeTask({ status: "in-progress" });
				mockedApi.request.moveTask.mockResolvedValue({ ...task, status: "completed" });

				await act(async () => {
					renderPanel(task, { dispatch, navigate });
				});

				await user.click(screen.getByText("Agent is Working"));
				await user.click(screen.getByText("Completed"));

				expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p1" });
			} finally {
				localStorage.removeItem("dev3-task-open-mode");
			}
		});

		it("sets movedAt when moving to cancelled via fast-path", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const dispatch = vi.fn();
			const navigate = vi.fn();
			const task = makeTask({ status: "in-progress" });
			mockedApi.request.moveTask.mockResolvedValue({ ...task, status: "cancelled" });

			await act(async () => {
				renderPanel(task, { dispatch, navigate });
			});

			await user.click(screen.getByText("Agent is Working"));
			await user.click(screen.getByText("Cancelled"));

			const dispatchedTask = dispatch.mock.calls.find(
				(c: unknown[]) => (c[0] as AppAction).type === "updateTask",
			)?.[0] as { type: string; task: Task } | undefined;
			expect(dispatchedTask).toBeDefined();
			expect(dispatchedTask!.task.movedAt).toBeDefined();
			expect(dispatchedTask!.task.status).toBe("cancelled");
		});

		it("asks for confirmation before completing active task", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedConfirmTaskCompletion.mockResolvedValue(false);
			const task = makeTask({ status: "in-progress" });

			await act(async () => {
				renderPanel(task);
			});

			await user.click(screen.getByText("Agent is Working"));
			await user.click(screen.getByText("Completed"));

			expect(mockedConfirmTaskCompletion).toHaveBeenCalledWith(
				task,
				project,
				"completed",
				expect.any(Function),
				expect.any(Function),
				expect.objectContaining({ alwaysConfirm: false }),
			);
			// Move was blocked
			expect(mockedApi.request.moveTask).not.toHaveBeenCalled();
		});
	});

	describe("notes", () => {
		function manyNotes(count: number) {
			return Array.from({ length: count }, (_, i) => ({
				id: `n${i}`,
				content: `note ${i}`,
				source: "ai" as const,
				createdAt: "2025-06-15T10:00:00Z",
				updatedAt: "2025-06-15T10:00:00Z",
			}));
		}

		it("opens the full note log in its own dialog", async () => {
			localStorage.setItem("dev3-panel-collapsed", "false");
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

			await act(async () => {
				renderPanel(makeTask({ notes: manyNotes(6) }));
			});

			// Inline preview stops at the newest three.
			expect(screen.queryByText("note 0")).not.toBeInTheDocument();
			expect(screen.getByText("note 5")).toBeInTheDocument();

			await user.click(screen.getByTestId("task-notes-show-all"));

			const dialog = screen.getByTestId("task-notes-dialog");
			expect(within(dialog).getByText("note 0")).toBeInTheDocument();
			expect(within(dialog).getByText("note 5")).toBeInTheDocument();
		});

		it("adds and deletes notes through the RPCs and dispatches the result", async () => {
			localStorage.setItem("dev3-panel-collapsed", "false");
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const dispatch = vi.fn();
			const task = makeTask({
				notes: [
					{ id: "n1", content: "Delete me", source: "user", createdAt: "2025-06-15T10:00:00Z", updatedAt: "2025-06-15T10:00:00Z" },
				],
			});
			const added = { ...task, notes: [...task.notes!, { id: "n-new", content: "", source: "user" as const, createdAt: "2025-06-15T12:00:00Z", updatedAt: "2025-06-15T12:00:00Z" }] };
			const deleted = { ...task, notes: [] };
			mockedApi.request.addTaskNote.mockResolvedValue(added);
			mockedApi.request.deleteTaskNote.mockResolvedValue(deleted);

			await act(async () => {
				renderPanel(task, { dispatch });
			});

			await user.click(screen.getByText("+ Add Note"));
			expect(mockedApi.request.addTaskNote).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				content: "",
				source: "user",
			});
			expect(dispatch).toHaveBeenCalledWith({ type: "updateTask", task: added });

			await user.click(screen.getByTitle("Delete note"));
			expect(mockedApi.request.deleteTaskNote).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				noteId: "n1",
			});
			expect(dispatch).toHaveBeenCalledWith({ type: "updateTask", task: deleted });
		});

		it("shows an alert when adding or deleting a note fails", async () => {
			localStorage.setItem("dev3-panel-collapsed", "false");
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const alertSpy = vi.mocked(toast.error);
			mockedApi.request.addTaskNote.mockRejectedValue(new Error("network error"));
			mockedApi.request.deleteTaskNote.mockRejectedValue(new Error("oops"));

			await act(async () => {
				renderPanel(makeTask({
					notes: [
						{ id: "n1", content: "foo", source: "user", createdAt: "2025-06-15T10:00:00Z", updatedAt: "2025-06-15T10:00:00Z" },
					],
				}));
			});

			await user.click(screen.getByText("+ Add Note"));
			await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
			await user.click(screen.getByTitle("Delete note"));
			await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(2));
		});
	});

	describe("dev server button", () => {
		// The resolved config (getResolvedProject) also lacks a devScript here — renderPanel
		// resolves to the project prop — so this covers the worktree-resolved case too.
		it("shows Setup Dev Server button with hint popover when no devScript", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			await act(async () => {
				renderPanel(makeTask(), { project: { ...project, devScript: "" } });
			});
			const btn = screen.getByText("Setup Dev Server").closest("button")!;
			expect(btn).not.toBeDisabled();
			await user.click(btn);
			expect(screen.getByText("Tell your AI agent:")).toBeInTheDocument();
			expect(screen.getByText("Configure dev3 devScript for this project")).toBeInTheDocument();
		});

		it("renders a neutral play state while stopped and calls runDevServer on click", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.checkDevServer.mockResolvedValue({ running: false });
			mockedApi.request.runDevServer.mockResolvedValue(defaultDevServerStatus);

			await act(async () => {
				renderPanel(makeTask(), { project: { ...project, devScript: "bun run dev" } });
			});

			const buttons = screen.getAllByText("Dev Server");
			const btn = buttons[0].closest("button")!;
			expect(btn).not.toBeDisabled();
			await waitFor(() => expect(btn.className).toContain("text-fg-2"));
			expect(btn.className).not.toContain("text-success");
			// play affordance, not a pulsing dot
			expect(btn.querySelector(".animate-pulse")).toBeNull();

			await user.click(btn);

			expect(mockedApi.request.checkDevServer).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				opId: expect.stringMatching(/^[0-9a-f]{8}$/),
			});
			// opId is the renderer-minted correlation id the handler echoes (seq 1407).
			expect(mockedApi.request.runDevServer).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				opId: expect.stringMatching(/^[0-9a-f]{8}$/),
				focus: true,
			});
		});

		it("renders the running state for a native-backend dev server", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.checkDevServer.mockResolvedValue({ running: false });
			mockedApi.request.runDevServer.mockResolvedValue({
				...defaultDevServerStatus,
				backend: "native",
				taskSessionName: "",
				servers: [{ ...defaultDevServerStatus.servers[0], devSessionName: "", viewerPaneId: "pane-3" }],
			});

			await act(async () => {
				renderPanel(makeTask(), { project: { ...project, devScript: "bun run dev" } });
			});

			await user.click(screen.getAllByText("Dev Server")[0].closest("button")!);

			await waitFor(() =>
				expect(screen.getByLabelText("Dev server running — click for options")).toBeInTheDocument(),
			);
		});

		it("renders the green running state and opens the running menu (no args line) instead of starting", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.checkDevServer.mockResolvedValue({ running: true });
			mockedApi.request.getDevServerStatus.mockResolvedValue(defaultDevServerStatus);

			await act(async () => {
				renderPanel(makeTask(), { project: { ...project, devScript: "bun run dev" } });
			});

			const btn = screen.getAllByText("Dev Server")[0].closest("button")!;
			await waitFor(() => expect(btn.className).toContain("text-success"));
			expect(btn.querySelector(".bg-success.animate-pulse")).not.toBeNull();
			expect(btn.getAttribute("aria-label")).toBe("Dev server running — click for options");

			await user.click(btn);

			await waitFor(() => expect(screen.getByText("Dev server is already running")).toBeInTheDocument());
			expect(screen.getByText("Restart")).toBeInTheDocument();
			expect(screen.getByText("Stop")).toBeInTheDocument();
			expect(screen.queryByTestId("dev-server-args")).toBeNull();
			expect(mockedApi.request.runDevServer).not.toHaveBeenCalled();
		});

		it("shows the script args of the running dev server in the menu", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.checkDevServer.mockResolvedValue({ running: true });
			mockedApi.request.getDevServerStatus.mockResolvedValue({
				...defaultDevServerStatus,
				servers: [{ ...defaultDevServerStatus.servers[0], scriptArgs: ["--own-db", "a b"] }],
			});

			await act(async () => {
				renderPanel(makeTask(), { project: { ...project, devScript: "bun run dev" } });
			});
			await user.click(screen.getAllByText("Dev Server")[0].closest("button")!);

			const line = await screen.findByTestId("dev-server-args");
			expect(line.textContent).toBe("--own-db 'a b'");
			expect(line.getAttribute("title")).toBe("Started with arguments: --own-db 'a b'");
		});

		it("restarts dev server via restartDevServer (stop → delay → start)", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.checkDevServer.mockResolvedValue({ running: true });
			mockedApi.request.restartDevServer.mockResolvedValue(defaultDevServerStatus);

			await act(async () => {
				renderPanel(makeTask(), { project: { ...project, devScript: "bun run dev" } });
			});

			const buttons = screen.getAllByText("Dev Server");
			await user.click(buttons[0].closest("button")!);
			await waitFor(() => expect(screen.getByText("Restart")).toBeInTheDocument());

			await user.click(screen.getByText("Restart"));

			await waitFor(() => expect(mockedApi.request.restartDevServer).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				focus: true,
			}));
			expect(mockedApi.request.runDevServer).not.toHaveBeenCalled();
		});

		it("stops dev server from running menu", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.checkDevServer.mockResolvedValue({ running: true });
			mockedApi.request.stopDevServer.mockResolvedValue({
				...defaultDevServerStatus,
				running: false,
				servers: [{ ...defaultDevServerStatus.servers[0], running: false, viewerPaneId: null, panePids: [] }],
			});

			await act(async () => {
				renderPanel(makeTask(), { project: { ...project, devScript: "bun run dev" } });
			});

			const buttons = screen.getAllByText("Dev Server");
			await user.click(buttons[0].closest("button")!);
			await waitFor(() => expect(screen.getByText("Stop")).toBeInTheDocument());

			await user.click(screen.getByText("Stop"));

			await waitFor(() => expect(mockedApi.request.stopDevServer).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				opId: expect.stringMatching(/^[0-9a-f]{8}$/),
			}));
		});

		it("shows alert when dev server fails", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const alertSpy = vi.mocked(toast.error);
			mockedApi.request.checkDevServer.mockResolvedValue({ running: false });
			mockedApi.request.runDevServer.mockRejectedValue(new Error("port busy"));

			await act(async () => {
				renderPanel(makeTask(), { project: { ...project, devScript: "bun run dev" } });
			});

			const buttons = screen.getAllByText("Dev Server");
			await user.click(buttons[0].closest("button")!);

			await waitFor(() => expect(alertSpy).toHaveBeenCalled());
			// alertSpy cleanup handled by clearAllMocks
		});

		it("shows the Starting… spinner state while the server is starting", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.checkDevServer.mockResolvedValue({ running: false });
			// Keep runDevServer pending so the transient "starting" state stays visible.
			mockedApi.request.runDevServer.mockImplementation(() => new Promise(() => {}));

			await act(async () => {
				renderPanel(makeTask(), { project: { ...project, devScript: "bun run dev" } });
			});

			const btn = screen.getAllByText("Dev Server")[0].closest("button")!;
			await waitFor(() => expect(btn.className).toContain("text-fg-2"));
			await user.click(btn);

			await waitFor(() => expect(screen.getByText("Starting…")).toBeInTheDocument());
			const startingBtn = screen.getByText("Starting…").closest("button")!;
			expect(startingBtn.getAttribute("aria-busy")).toBe("true");
			expect(startingBtn.querySelector(".animate-spin")).not.toBeNull();
		});
	});

	// A project with several declared servers cannot answer one click with one
	// action — which server would it start? The list is the control, and the
	// toolbar still carries exactly one button.
	describe("dev server list for several declared servers", () => {
		const multiProject = {
			...project,
			devScript: "bun run dev",
			devServers: { api: { script: "bun run api" } },
		};
		const multiStatus = {
			...defaultDevServerStatus,
			running: true,
			servers: [
				{ ...defaultDevServerStatus.servers[0], name: "dev", isDefault: true, running: false },
				{
					...defaultDevServerStatus.servers[0],
					name: "api",
					title: "API",
					isDefault: false,
					running: true,
					devPorts: [{ port: 55930, pid: 900, processName: "bun" }],
				},
			],
		};

		it("shows a running server's script args under its row, and nothing for one without", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.checkDevServer.mockResolvedValue({ running: false });
			mockedApi.request.getDevServerStatus.mockResolvedValue({
				...multiStatus,
				servers: [
					{ ...multiStatus.servers[0], running: true },
					{ ...multiStatus.servers[1], scriptArgs: ["--verbose", "x y"] },
				],
			});

			await act(async () => {
				renderPanel(makeTask(), { project: multiProject });
			});
			await user.click(screen.getAllByText("Dev Server")[0].closest("button")!);

			const line = await screen.findByTestId("dev-server-args-api");
			expect(line.textContent).toBe("--verbose 'x y'");
			expect(screen.queryByTestId("dev-server-args-dev")).toBeNull();
		});

		async function openList(user: ReturnType<typeof userEvent.setup>) {
			mockedApi.request.checkDevServer.mockResolvedValue({ running: false });
			mockedApi.request.getDevServerStatus.mockResolvedValue(multiStatus);
			mockedApi.request.runDevServer.mockResolvedValue(multiStatus);
			await act(async () => {
				renderPanel(makeTask(), { project: multiProject });
			});
			const trigger = screen.getAllByText("Dev Server")[0].closest("button")!;
			await user.click(trigger);
			const list = await screen.findByTestId("dev-server-list");
			await waitFor(() => expect(screen.getByTestId("dev-server-row-api").textContent).toContain("Stop"));
			return { trigger, list };
		}

		// The user had to hit the small "Start" word exactly; the row text was
		// selectable instead. A stopped row is now one button, name included — and a
		// running row is not a button, so a stray click never stops it.
		it("a stopped server's whole row starts only that server; a running row is not a button; the text is not selectable", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const { list } = await openList(user);

			// One row per server with its state, port and own actions.
			const apiRow = screen.getByTestId("dev-server-row-api");
			expect(apiRow.textContent).toContain(":55930");
			expect(apiRow.textContent).toContain("Stop");
			expect(screen.getByTestId("dev-server-row-dev").textContent).toContain("Start");
			expect(apiRow.tagName).not.toBe("BUTTON");
			await user.click(within(apiRow).getByText("api"));
			expect(mockedApi.request.stopDevServer).not.toHaveBeenCalled();
			expect(mockedApi.request.restartDevServer).not.toHaveBeenCalled();

			const devRow = screen.getByTestId("dev-server-row-dev");
			expect(devRow.tagName).toBe("BUTTON");
			expect(list.className).toContain("select-none");
			await user.click(within(devRow).getByText("dev"));

			expect(mockedApi.request.runDevServer).toHaveBeenCalledWith(expect.objectContaining({ server: "dev", focus: true }));
		});

		// The backdrop exists because a document mousedown listener never saw clicks
		// on the terminal, which captures its own mousedown — nothing outside closed it.
		it("closes on Escape, on a second toolbar press and on the outside backdrop, refocusing the trigger", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const { trigger } = await openList(user);

			await user.keyboard("{Escape}");
			expect(screen.queryByTestId("dev-server-list")).toBeNull();
			expect(document.activeElement).toBe(trigger);

			await user.click(trigger);
			await screen.findByTestId("dev-server-list");
			expect(trigger.getAttribute("aria-expanded")).toBe("true");
			await user.click(trigger);
			expect(screen.queryByTestId("dev-server-list")).toBeNull();
			expect(trigger.getAttribute("aria-expanded")).toBe("false");

			await user.click(trigger);
			await screen.findByTestId("dev-server-list");
			await user.click(screen.getByTestId("dev-server-backdrop"));
			expect(screen.queryByTestId("dev-server-list")).toBeNull();
			expect(document.activeElement).toBe(trigger);
		});

		it("is keyboard-driven: focus lands on the first row, arrows move, Enter starts", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			await openList(user);
			const devRow = screen.getByTestId("dev-server-row-dev");
			await waitFor(() => expect(document.activeElement).toBe(devRow));

			await user.keyboard("{ArrowDown}");
			expect(document.activeElement?.textContent).toBe(":55930");
			await user.keyboard("{ArrowUp}");
			expect(document.activeElement).toBe(devRow);
			await user.keyboard("{Enter}");

			expect(mockedApi.request.runDevServer).toHaveBeenCalledWith(expect.objectContaining({ server: "dev" }));
		});

		it("Start all and a named Restart are user actions: both ask for focus, Stop does not; Stop all stops every server", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.restartDevServer.mockResolvedValue(multiStatus);
			mockedApi.request.stopDevServer.mockResolvedValue(multiStatus);
			const { list } = await openList(user);

			await user.click(within(list).getByText("Start all"));
			expect(mockedApi.request.runDevServer).toHaveBeenCalledWith(expect.objectContaining({ all: true, focus: true }));

			await user.click(within(screen.getByTestId("dev-server-row-api")).getByText("Restart"));
			expect(mockedApi.request.restartDevServer).toHaveBeenCalledWith(expect.objectContaining({ server: "api", focus: true }));

			await user.click(within(screen.getByTestId("dev-server-row-api")).getByText("Stop"));
			expect(mockedApi.request.stopDevServer.mock.calls[0][0]).not.toHaveProperty("focus");

			// Stop all takes down every server in one action.
			await user.click(within(list).getByText("Stop all"));
			expect(mockedApi.request.stopDevServer).toHaveBeenLastCalledWith(expect.objectContaining({ all: true }));
			expect(mockedApi.request.stopDevServer).not.toHaveBeenCalledWith(expect.objectContaining({ server: "dev" }));
		});

		// The common case must not pay for the uncommon one: one declared server
		// still starts on a single click, with no list in between.
		it("a single-server project still starts on one click", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.checkDevServer.mockResolvedValue({ running: false });
			mockedApi.request.runDevServer.mockResolvedValue(defaultDevServerStatus);

			await act(async () => {
				renderPanel(makeTask(), { project: { ...project, devScript: "bun run dev" } });
			});
			await user.click(screen.getAllByText("Dev Server")[0].closest("button")!);

			expect(screen.queryByTestId("dev-server-list")).toBeNull();
			expect(mockedApi.request.runDevServer).toHaveBeenCalled();
		});
	});

	describe("dev server button with worktree-resolved config", () => {
		it("enables button when worktree config has devScript but project does not", async () => {
			const projectWithoutDev = { ...project, devScript: "" };
			const resolvedWithDev = { ...project, devScript: "bun run dev" };
			// Set mock BEFORE renderPanel (renderPanel will override, so use mockResolvedValueOnce in sequence)
			mockedApi.request.getResolvedProject.mockResolvedValue(resolvedWithDev);

			await act(async () => {
				// renderPanel overrides getResolvedProject — re-set after
				render(
					<I18nProvider>
						<TaskHeader
							task={makeTask()}
							project={projectWithoutDev}
							dispatch={vi.fn()}
							navigate={vi.fn()}
						/>
					</I18nProvider>,
				);
			});

			await waitFor(() => {
				const buttons = screen.getAllByText("Dev Server");
				const btn = buttons[0].closest("button")!;
				expect(btn).not.toBeDisabled();
			});
		});

		it("falls back to project prop when getResolvedProject fails", async () => {
			mockedApi.request.getResolvedProject.mockRejectedValue(new Error("fail"));

			await act(async () => {
				renderPanel(makeTask(), { project: { ...project, devScript: "bun run dev" } });
			});

			const buttons = screen.getAllByText("Dev Server");
			const btn = buttons[0].closest("button")!;
			expect(btn).not.toBeDisabled();
		});

		// The backend resolves the task itself, so the config cascade is the same
		// one a start uses — including the main checkout's gitignored
		// config.local.json, which a worktree never has a copy of.
		// The task has no worktreePath yet, which must not stop the resolve either.
		it("resolves by taskId, not by worktree path", async () => {
			await act(async () => {
				renderPanel(makeTask({ id: "task-9", worktreePath: null }), { project: { ...project, devScript: "bun run dev" } });
			});

			expect(mockedApi.request.getResolvedProject).toHaveBeenCalledWith({
				projectId: project.id,
				taskId: "task-9",
			});
		});
	});

	describe("branch status display", () => {
		it("shows an error with Retry when the status poll fails, and Retry forces a refresh", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.getBranchStatus.mockRejectedValueOnce(new Error("git exploded"));

			await act(async () => {
				// A task id no earlier test cached a status for.
				renderPanel(makeTask({ id: "t-status-error" }));
			});

			const label = screen.getAllByText("Branch status failed to load")[0];
			expect(label).toHaveClass("text-danger");
			expect(label.closest("[title]")).toHaveAttribute("title", expect.stringContaining("git exploded"));

			mockedApi.request.getBranchStatus.mockResolvedValue({ ...defaultBranchStatus, ahead: 5, behind: 0 });
			await user.click(screen.getAllByRole("button", { name: "Retry" })[0]);

			await waitFor(() => {
				expect(mockedApi.request.getBranchStatus).toHaveBeenLastCalledWith(expect.objectContaining({ refresh: true }));
			});
			await waitFor(() => expect(screen.getAllByText(/5 commits ahead/).length).toBeGreaterThanOrEqual(1));
			expect(screen.queryByText("Branch status failed to load")).not.toBeInTheDocument();
		});

		it("shows the ahead badge and the uncommitted line counts", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 5,
				behind: 0,
				insertions: 10,
				deletions: 3,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			expect(screen.getAllByText(/5 commits ahead/).length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText("+10").length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText("−3").length).toBeGreaterThanOrEqual(1);
		});

		it("shows both ahead and behind when both > 0, and disables Merge while behind", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 3,
				behind: 1,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			const count = screen.getAllByTestId("behind-count")[0];
			expect(count).toHaveClass("text-danger");
			// The wording is red together with the number; only the ahead half stays muted.
			expect(count).toHaveTextContent("1 behind");
			expect(count.parentElement).toHaveTextContent("3 ahead · 1 behind");
			for (const btn of screen.getAllByText("Merge")) {
				expect(btn.closest("button")).toBeDisabled();
			}
		});

		/**
		 * With no fork point git answers with each side's whole history, which the
		 * bar printed verbatim — "1889 ahead" for a branch that was 2 ahead. The
		 * slot must carry the failure, never a number.
		 */
		it("shows base unreachable instead of a count when there is no merge base", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 0,
				behind: 0,
				baseUnreachable: true,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			expect(screen.getAllByTestId("base-unreachable").length).toBeGreaterThanOrEqual(1);
			expect(screen.queryByText(/commits? ahead/)).toBeNull();
			expect(screen.queryByTestId("behind-count")).toBeNull();
		});

			it("uses task baseBranch as comparison branch", async () => {
				mockedApi.request.getBranchStatus.mockResolvedValue({
					...defaultBranchStatus,
					ahead: 1,
				});

			await act(async () => {
				renderPanel(makeTask({ baseBranch: "develop" }), { onOpenInlineDiff: vi.fn() });
			});

				// The bar no longer prints "vs <ref>" — the compare target lives in the
				// name of the control that acts on it.
				expect(screen.queryByText(/vs develop/)).not.toBeInTheDocument();
				expect(screen.getAllByLabelText(/vs develop/).length).toBeGreaterThanOrEqual(1);
			});

	});

	describe("git action buttons", () => {
		// Default status: 3 ahead, 0 behind, a GitHub remote, nothing diverged, no PR.
		it("shows the git buttons for an active task: rebase off, push/PR live, plain Push, Create PR; push alerts on failure, then calls pushTask", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.pushTask
				.mockRejectedValueOnce(new Error("no remote"))
				.mockResolvedValue(undefined);
			await act(async () => {
				renderPanel(makeTask());
			});

			// The standalone Diff button is gone: the two counters are the diff entry points.
			expect(screen.queryAllByText("Diff")).toHaveLength(0);
			expect(screen.queryByText("Unpushed")).not.toBeInTheDocument();
			expect(screen.getAllByText("Merge").length).toBeGreaterThanOrEqual(1);
			// Not behind: rebase is disabled on every copy.
			for (const btn of screen.getAllByText("Rebase")) {
				expect(btn.closest("button")).toBeDisabled();
			}
			// A remote and nothing diverged: plain Push and PR are live.
			expect(screen.queryAllByText("Force push")).toHaveLength(0);
			expect(screen.getAllByText("Push")[0].closest("button")!).not.toBeDisabled();
			expect(screen.getAllByText("PR")[0].closest("button")!).not.toBeDisabled();
			expect(screen.queryByText("Open PR")).not.toBeInTheDocument();
			// No confirmation for a push that did not diverge; a failed push alerts.
			const enabledPush = () => screen.getAllByText("Push").find(b => !b.closest("button")!.disabled)!;
			await user.click(enabledPush().closest("button")!);
			await waitFor(() => expect(toast.error).toHaveBeenCalled());
			await user.click(enabledPush().closest("button")!);
			await waitFor(() => expect(mockedApi.request.pushTask).toHaveBeenCalledTimes(2));

			expect(mockedApi.request.pushTask).toHaveBeenLastCalledWith({
				taskId: "t1",
				projectId: "p1",
			});
			expect(vi.mocked(confirm)).not.toHaveBeenCalled();
		});

		it("shows agent-assisted git actions for an active Codex task", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 3,
				behind: 2,
				canRebase: false,
			});

			await act(async () => {
				renderPanel(makeTask({ agentId: "builtin-codex" }));
			});

			expect(screen.getAllByText("Rebase (AI)").length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText("PR").length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText("Auto PR").length).toBeGreaterThanOrEqual(1);
		});

		it("shows no git buttons, fetches no branch status and greys the dev server for an inactive task", async () => {
			await act(async () => {
				renderPanel(
					makeTask({ status: "todo", worktreePath: null, branchName: null }),
					{ project: { ...project, devScript: "bun run dev" } },
				);
			});

			expect(screen.queryByText("Rebase")).not.toBeInTheDocument();
			expect(screen.queryByText("Push")).not.toBeInTheDocument();
			expect(screen.queryByText("Merge")).not.toBeInTheDocument();
			expect(mockedApi.request.getBranchStatus).not.toHaveBeenCalled();
			expect(screen.getAllByText("Dev Server")[0].closest("button")!.className).toContain("cursor-not-allowed");
		});

		it("shows the behind badge and explains uncommitted changes on disabled git actions", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 0,
				behind: 2,
				insertions: 10,
				deletions: 3,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			const count = screen.getAllByTestId("behind-count")[0];
			expect(count).toHaveClass("text-danger");
			expect(count).toHaveTextContent("2 commits behind");

			async function expectTooltip(label: string, content: string) {
				const button = screen.getAllByText(label)[0].closest("button")!;
				const { tooltip, leave } = await hoverTooltip(user, button.parentElement!);
				expect(tooltip).toHaveTextContent(content);
				await leave();
			}

			await expectTooltip("Push", "Nothing to push — commit the uncommitted changes first");
			await expectTooltip("PR", "No commits for a PR — commit the uncommitted changes first");
			await expectTooltip("Auto PR", "No commits for a PR — commit the uncommitted changes first");
			await expectTooltip("Merge", "Nothing to merge — commit the uncommitted changes first");
		});

		it("with nothing ahead or behind: no count badges, push/merge/rebase/commit disabled, and Push says why", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 0,
				behind: 0,
				insertions: 0,
				deletions: 0,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			expect(screen.queryByText(/commits? ahead/)).not.toBeInTheDocument();
			expect(screen.queryByText(/commits? behind/)).not.toBeInTheDocument();
			for (const label of ["Push", "Merge", "Rebase"]) {
				for (const btn of screen.getAllByText(label)) {
					expect(btn.closest("button"), label).toBeDisabled();
				}
			}
			const commitButtons = screen.getAllByText("Commit");
			expect(commitButtons.length).toBeGreaterThanOrEqual(1);
			expect(commitButtons.every((b) => b.closest("button")!.disabled)).toBe(true);

			const pushButton = screen.getAllByText("Push")[0].closest("button")!;
			const { tooltip } = await hoverTooltip(user, pushButton.parentElement!);
			expect(tooltip).toHaveTextContent("Nothing to push — no local commits ahead");
		});

		// A project added from a local folder has no `origin`: push and PR have no
		// destination, so they must read as unavailable instead of failing on click.
		it("disables push and PR when the project has no git remote, and merges without a confirmation", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 3,
				hasRemote: false,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			for (const label of ["Push", "PR", "Auto PR"]) {
				const button = screen.getAllByText(label)[0].closest("button")!;
				expect(button).toBeDisabled();
				const { tooltip, leave } = await hoverTooltip(user, button.parentElement!);
				expect(tooltip).toHaveTextContent("This project has no git remote — nothing to push to");
				await leave();
			}

			// Nothing to push the base to, so Merge needs no confirmation.
			mockedApi.request.mergeTask.mockResolvedValue(undefined);
			const merge = screen.getAllByText("Merge").find((b) => !b.closest("button")!.disabled)!;
			await user.click(merge.closest("button")!);
			await waitFor(() => expect(mockedApi.request.mergeTask).toHaveBeenCalled());
			expect(vi.mocked(confirm)).not.toHaveBeenCalled();
		});

		// `gh` is the only forge client dev3 speaks, so a GitLab/Gitea origin must
		// not be offered a PR button whose agent prompt cannot run. Push is still
		// perfectly possible there, so it stays live — the distinction is the point.
		it("disables PR but not push when origin is not GitHub", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 3,
				hasRemote: true,
				remoteIsGitHub: false,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			expect(screen.getAllByText("Push")[0].closest("button")!).not.toBeDisabled();
			for (const label of ["PR", "Auto PR"]) {
				const button = screen.getAllByText(label)[0].closest("button")!;
				expect(button).toBeDisabled();
				const { tooltip, leave } = await hoverTooltip(user, button.parentElement!);
				expect(tooltip).toHaveTextContent("origin is not a GitHub remote");
				await leave();
			}
		});

		// A foreign-code task exists to READ commits the local user did not write. A
		// disabled Push there still invites a click and an explanation; the three
		// write actions are gone instead.
		it("removes push, PR and merge for a foreign-code task", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 3,
				hasRemote: true,
			});

			await act(async () => {
				renderPanel(makeTask({ foreignCode: true }));
			});

			for (const label of ["Push", "Force push", "PR", "Auto PR", "Merge"]) {
				expect(screen.queryAllByText(label)).toHaveLength(0);
			}
			// Read-only git stays: the diff counter and the rebase both serve the review.
			expect(screen.getByText("3 commits ahead")).toBeInTheDocument();
			expect(screen.getAllByText("Rebase").length).toBeGreaterThan(0);
		});

		it("calls rebaseTask on rebase click, alerting when it fails", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				behind: 2,
				canRebase: true,
			});
			mockedApi.request.rebaseTask
				.mockRejectedValueOnce(new Error("conflict"))
				.mockResolvedValue(undefined);

			await act(async () => {
				renderPanel(makeTask());
			});

			const enabledRebase = () => screen.getAllByText("Rebase").find(b => !b.closest("button")!.disabled);
			expect(enabledRebase()).toBeTruthy();
			await user.click(enabledRebase()!.closest("button")!);
			await waitFor(() => expect(toast.error).toHaveBeenCalled());

			await user.click(enabledRebase()!.closest("button")!);
			await waitFor(() => expect(mockedApi.request.rebaseTask).toHaveBeenCalledTimes(2));

			expect(mockedApi.request.rebaseTask).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				compareRef: "origin/main",
			});
		});

		it("asks before merging into a pushed base: declined does nothing, a failure alerts, confirmed calls mergeTask", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 2,
				behind: 0,
			});
			mockedApi.request.mergeTask
				.mockRejectedValueOnce(new Error("merge error"))
				.mockResolvedValue(undefined);
			// With a remote, Merge squashes AND pushes the base branch — that crosses
			// review and CI, so it must not happen on a bare click.
			vi.mocked(confirm).mockResolvedValueOnce(false);

			await act(async () => {
				renderPanel(makeTask());
			});

			const mergeButtons = screen.getAllByText("Merge");
			const enabledBtn = mergeButtons.find(b => !b.closest("button")!.disabled);
			expect(enabledBtn).toBeTruthy();
			await user.click(enabledBtn!.closest("button")!);
			await waitFor(() => expect(vi.mocked(confirm)).toHaveBeenCalledTimes(1));
			expect(mockedApi.request.mergeTask).not.toHaveBeenCalled();

			// Confirmed but the merge fails: an alert.
			await user.click(enabledBtn!.closest("button")!);
			await waitFor(() => expect(toast.error).toHaveBeenCalled());

			await user.click(screen.getAllByText("Merge").find(b => !b.closest("button")!.disabled)!.closest("button")!);
			await waitFor(() => expect(mockedApi.request.mergeTask).toHaveBeenCalledTimes(2));

			expect(mockedApi.request.mergeTask).toHaveBeenLastCalledWith({
				taskId: "t1",
				projectId: "p1",
				// The ref the git bar measured against travels with the click, so the
				// server's rebase guard cannot check a different one.
				compareRef: "origin/main",
				expectRoute: "local-squash",
			});
		});

		/**
		 * The defect: with a PR open, Merge squashed into the local base and pushed it,
		 * bypassing the PR's own review and CI. An open PR makes the button say what it
		 * will do — "Merge PR" — and send the route it promised.
		 */
		it("merges the pull request when the branch has one open", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 2,
				// Behind the base does NOT disable this route: mergeability is GitHub's
				// call, not a reason to demand a local rebase first.
				behind: 4,
				prNumber: 1475,
				prUrl: "https://github.com/h0x91b/dev-3.0/pull/1475",
			});
			mockedApi.request.mergeTask.mockResolvedValue(undefined);
			vi.mocked(confirm).mockResolvedValueOnce(false);

			await act(async () => {
				renderPanel(makeTask());
			});

			const merge = screen.getAllByText("Merge PR").find((b) => !b.closest("button")!.disabled)!;
			expect(merge).toBeTruthy();
			// Declined: nothing merges.
			await user.click(merge.closest("button")!);
			await waitFor(() => expect(vi.mocked(confirm)).toHaveBeenCalledTimes(1));
			expect(mockedApi.request.mergeTask).not.toHaveBeenCalled();

			await user.click(merge.closest("button")!);

			await waitFor(() => expect(mockedApi.request.mergeTask).toHaveBeenCalledWith({
				taskId: "t1",
				compareRef: "origin/main",
				projectId: "p1",
				expectRoute: "pull-request",
			}));
			// Confirmed, but not as a destructive act — GitHub still gates the landing.
			expect(vi.mocked(confirm)).toHaveBeenCalledWith(expect.not.objectContaining({ danger: true }));
		});

		it("opens the uncommitted diff from the changes summary when the tree is dirty", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const onOpenInlineDiff = vi.fn();
			mockedApi.request.getBranchStatus.mockResolvedValue({ ...defaultBranchStatus, ahead: 1, behind: 3, insertions: 700, deletions: 11 });

			await act(async () => {
				renderPanel(makeTask(), { onOpenInlineDiff });
			});

			const summary = await screen.findByTestId("changes-summary");
			expect(summary).toHaveAccessibleName("Open uncommitted changes: 1 ahead · 3 behind, uncommitted +700 −11 lines");
			// One control carries both halves, with no separator between them, so
			// clicking either number opens the diff.
			expect(summary).toContainElement(screen.getAllByTestId("behind-count")[0]);
			expect(summary).toContainElement(screen.getAllByText("+700")[0]);
			expect(summary.textContent).not.toContain("|");
			// The compare-ref picker is gone from the bar — the project setting owns that choice.
			expect(screen.queryByLabelText("Change comparison branch")).not.toBeInTheDocument();
			await user.click(summary);

			// The +/− half is the working tree, so a dirty tree opens that scope.
			expect(onOpenInlineDiff).toHaveBeenCalledWith({ mode: "uncommitted", pinMode: true });
		});

		it("opens the branch diff from the changes summary when the tree is clean", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const onOpenInlineDiff = vi.fn();

			await act(async () => {
				renderPanel(makeTask(), { onOpenInlineDiff });
			});

			const summary = await screen.findByTestId("changes-summary");
			expect(summary).toHaveAccessibleName("Open branch diff vs origin/main: 3 commits ahead");
			await user.click(summary);

			expect(onOpenInlineDiff).toHaveBeenCalledWith({
				mode: "branch",
				pinMode: true,
				compareRef: "origin/main",
				compareLabel: "origin/main",
			});
		});

		it("explains the top diff badge as committed-only", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				insertions: 700,
				deletions: 11,
				diffFiles: 19,
				diffInsertions: 697,
				diffDeletions: 131,
			});

			await act(async () => {
				renderPanel(makeTask(), { onOpenInlineDiff: vi.fn() });
			});

			const badge = await screen.findByTestId("diff-summary-badge");
			expect(badge).toHaveAccessibleName("Open branch diff vs origin/main: 19 files, +697 −131 committed lines");
			expect(badge).toHaveAttribute("title", expect.stringContaining("Uncommitted edits are not counted here"));
		});

		it("opens a fork PR-review diff against the project base", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const onOpenInlineDiff = vi.fn();
			const task = makeTask({
				status: "review-by-colleague",
				branchName: "fix/ctrl-o",
				baseBranch: "contributor/fix/ctrl-o",
				existingBranch: "contributor/fix/ctrl-o",
				prNumber: 1193,
			});

			await act(async () => {
				renderPanel(task, { onOpenInlineDiff });
			});

			await user.click(await screen.findByTestId("changes-summary"));

			expect(onOpenInlineDiff).toHaveBeenCalledWith({
				mode: "branch",
				pinMode: true,
				compareRef: "origin/main",
				compareLabel: "origin/main",
			});
		});

		it("does not show the previous task's branch status while switching to another task", async () => {
			const view = renderPanel(makeTask({ id: "t1" }));
			await waitFor(() => {
				expect(screen.getByText("3 commits ahead")).toBeInTheDocument();
			});

			// New task's status never resolves — the panel must clear the stale
			// badge and show the loading state instead of the old task's data.
			mockedApi.request.getBranchStatus.mockImplementation(() => new Promise(() => {}));

			await act(async () => {
				view.rerender(
					<I18nProvider>
						<TaskHeader
							task={makeTask({ id: "t2", branchName: "dev3/task-t2" })}
							project={project}
							dispatch={vi.fn()}
							navigate={vi.fn()}
						/>
					</I18nProvider>,
				);
			});

			expect(screen.queryByText("3 commits ahead")).not.toBeInTheDocument();
		});

			it("uses the project's default comparison ref when configured", async () => {
				const localCompareProject = {
					...project,
					defaultBaseBranch: "master",
					defaultCompareRef: "master",
			} as Project & { defaultCompareRef: "master" };

			await act(async () => {
				renderPanel(makeTask({ baseBranch: "master" }), {
					project: localCompareProject as Project,
				});
			});

			await waitFor(() => {
				expect(mockedApi.request.getBranchStatus).toHaveBeenCalledWith({
					taskId: "t1",
					projectId: "p1",
					compareRef: "master",
					});
				});
			});

			it("uses a local compare ref for task-specific base branches even when the project default is remote", async () => {
				const remoteCompareProject = {
					...project,
					defaultBaseBranch: "main",
					defaultCompareRef: "origin/main",
				} as Project & { defaultCompareRef: "origin/main" };

				await act(async () => {
					renderPanel(makeTask({ baseBranch: "feat-uber-extra" }), {
						project: remoteCompareProject as Project,
					});
				});

				await waitFor(() => {
					expect(mockedApi.request.getBranchStatus).toHaveBeenCalledWith({
						taskId: "t1",
						projectId: "p1",
						compareRef: "feat-uber-extra",
					});
				});
			});

			it("maps local project compare defaults onto a task-specific base branch", async () => {
				const localCompareProject = {
					...project,
					defaultBaseBranch: "main",
					defaultCompareRef: "main",
				} as Project & { defaultCompareRef: "main" };

				await act(async () => {
					renderPanel(makeTask({ baseBranch: "feat-uber-extra" }), {
						project: localCompareProject as Project,
					});
				});

				await waitFor(() => {
					expect(mockedApi.request.getBranchStatus).toHaveBeenCalledWith({
						taskId: "t1",
						projectId: "p1",
						compareRef: "feat-uber-extra",
					});
				});
			});

		// With a remote, Merge squashes AND pushes the base branch — that crosses
		// review and CI, so it must not happen on a bare click.
		// The rebase-then-push case: origin/<branch> holds commits HEAD does not, so
		// a plain push is refused as non-fast-forward. The label has to say so before
		// the click, because the backend escalates to a leased force push.
		it("renames Push to Force push when the branch diverged, and confirms before it (declined: nothing)", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 1,
				hasRemote: true,
				remoteAhead: 2,
			});
			vi.mocked(confirm).mockResolvedValue(false);

			await act(async () => {
				renderPanel(makeTask());
			});

			expect(screen.queryAllByText("Push")).toHaveLength(0);
			const push = screen.getAllByText("Force push").find((b) => !b.closest("button")!.disabled)!;
			await user.click(push.closest("button")!);

			await waitFor(() => expect(vi.mocked(confirm)).toHaveBeenCalled());
			expect(mockedApi.request.pushTask).not.toHaveBeenCalled();
		});

		it("hands the rebase off to the agent when canRebase is false (conflicts), saying when delivery is unconfirmed or impossible", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				behind: 2,
				canRebase: false,
			});
			mockedApi.request.rebaseTaskViaAgent
				// "unconfirmed" is neither of the two old answers: the prompt may well be in the
				// agent already, so it must read as neither the success line nor "no terminal".
				.mockResolvedValueOnce({ delivery: { status: "unconfirmed", reason: "unacknowledged" } })
				.mockResolvedValueOnce({ delivery: { status: "not-delivered", reason: "pane-absent" } })
				.mockResolvedValue({ delivery: { status: "delivered" } });

			await act(async () => {
				renderPanel(makeTask());
			});

			// The conflict state relabels the (enabled) button "Rebase (AI)".
			const enabledBtn = () => screen.getAllByText("Rebase (AI)").find((b) => !b.closest("button")!.disabled);
			expect(enabledBtn()).toBeTruthy();

			await user.click(enabledBtn()!.closest("button")!);
			await waitFor(() =>
				expect(toast.info).toHaveBeenCalledWith(expect.stringContaining("could not be confirmed"), expect.anything()),
			);
			expect(toast.error).not.toHaveBeenCalled();

			// No agent terminal to hand it to: a warning.
			await user.click(enabledBtn()!.closest("button")!);
			await waitFor(() => expect(toast.error).toHaveBeenCalled());
			vi.mocked(toast.info).mockClear();

			await user.click(enabledBtn()!.closest("button")!);

			expect(mockedApi.request.rebaseTaskViaAgent).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				compareRef: "origin/main",
			});
			// The auto-rebase path must NOT run for a conflicting rebase.
			expect(mockedApi.request.rebaseTask).not.toHaveBeenCalled();
			await waitFor(() => expect(toast.info).toHaveBeenCalled());
		});

		it("hands the commit off to the agent when the worktree is dirty, warning when there is no agent terminal", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				insertions: 12,
				deletions: 3,
			});
			mockedApi.request.commitTaskViaAgent
				.mockResolvedValueOnce({ delivery: { status: "not-delivered", reason: "pane-absent" } })
				.mockResolvedValue({ delivery: { status: "delivered" } });

			await act(async () => {
				renderPanel(makeTask());
			});

			const enabledBtn = () => screen.getAllByText("Commit").find((b) => !b.closest("button")!.disabled);
			expect(enabledBtn()).toBeTruthy();
			// No agent terminal to hand it to: a warning.
			await user.click(enabledBtn()!.closest("button")!);
			await waitFor(() => expect(toast.error).toHaveBeenCalled());

			await user.click(enabledBtn()!.closest("button")!);

			expect(mockedApi.request.commitTaskViaAgent).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
			});
			await waitFor(() => expect(toast.info).toHaveBeenCalled());
		});

		// No reported state, nothing ahead: the badge still shows, stays neutral, refreshes
		// the rich status on open, previews it on hover and opens the PR on click.
		it("shows a neutral PR badge for an existing PR even when ahead=0, hides Create PR, previews and opens it", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const openSpy = vi.fn(); window.open = openSpy;
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 0,
				unpushed: 0,
				prNumber: 42,
				prUrl: "https://github.com/test/repo/pull/42",
				prState: null,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			expect(mockedApi.request.refreshTaskPrStatus).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1", force: false });
			const badges = screen.getAllByText(/PR #42/);
			expect(badges.length).toBeGreaterThanOrEqual(1);
			for (const node of badges) {
				expect(node.closest("button")!.className).not.toMatch(/success|pr-merged|danger/);
			}
			expect(screen.queryByText("PR")).not.toBeInTheDocument();

			const btn = badges[0].closest("button")!;
			await user.hover(btn);
			expect(await screen.findByTestId("pr-status-popover")).toHaveTextContent("PR #42 status");
			await user.click(btn);
			expect(openSpy).toHaveBeenCalledWith("https://github.com/test/repo/pull/42", "_blank");
		});

		// A finished PR is history, not the branch's live PR: its badge stays, but it
		// must neither hide Create PR for the follow-up nor route Merge through it.
		it.each([
			["MERGED", "text-pr-merged", "Merged", true],
			["CLOSED", "text-danger", "Closed", true],
			["OPEN", "text-success", "Open", false],
		])("tints every PR #42 badge by the branch's %s state and names it", async (prState, cls, label, finished) => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 3,
				unpushed: 0,
				prNumber: 42,
				prUrl: "https://github.com/test/repo/pull/42",
				prState,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			const badges = screen.getAllByText(/PR #42/).map((node) => node.closest("button")!);
			expect(badges.length).toBeGreaterThanOrEqual(1);
			for (const badge of badges) {
				expect(badge.className).toContain(cls);
				expect(badge).toHaveTextContent(`PR #42 — ${label}`);
			}
			if (finished) {
				expect(screen.getAllByText("PR").length).toBeGreaterThanOrEqual(1);
				expect(screen.queryByText("Merge PR")).not.toBeInTheDocument();
			} else {
				expect(screen.queryByText("PR")).not.toBeInTheDocument();
			}
		});

		it.each(["MERGED", "CLOSED"])("replaces an earlier open push when refresh reports %s", async (prState) => {
			const pr = { prNumber: 42, prUrl: "https://github.com/test/repo/pull/42" };
			mockedApi.request.getBranchStatus.mockResolvedValue({ ...defaultBranchStatus, ...pr, prState: "OPEN", ahead: 3 });
			await act(async () => { renderPanel(makeTask(pr)); });
			act(() => {
				window.dispatchEvent(new CustomEvent("rpc:taskPrStatus", { detail: {
					projectId: "p1", taskId: "t1", ...pr, ciStatus: "success", reviewState: null,
					unresolvedCount: 0, mergeState: { mergeable: "MERGEABLE", status: "CLEAN", state: "OPEN" },
					checks: [], prTitle: "Earlier open status", isDraft: false,
				} }));
			});
			mockedApi.request.getBranchStatus.mockResolvedValue({ ...defaultBranchStatus, prNumber: null, prUrl: null, prState: null, ahead: 3 });
			mockedApi.request.refreshTaskPrStatus.mockImplementationOnce(async () => {
				window.dispatchEvent(new CustomEvent("rpc:taskPrStatus", { detail: {
					projectId: "p1", taskId: "t1", ...pr, ciStatus: "success", reviewState: null,
					unresolvedCount: 0, mergeState: { mergeable: "UNKNOWN", status: "UNKNOWN", state: prState },
					checks: [], prTitle: "Refreshed status", isDraft: false,
				} }));
				return { outcome: "updated" };
			});
			await act(async () => { fireEvent.click(screen.getAllByLabelText("Refresh branch status")[0]); });
			await waitFor(() => {
				for (const node of screen.getAllByRole("button").filter((button) => button.textContent?.includes("PR #42"))) {
					expect(node).toHaveTextContent(`PR #42 — ${prState === "MERGED" ? "Merged" : "Closed"}`);
				}
			});
		});

		it("updates PR state and CI while the inspector stays open", async () => {
			mockViewport(1440);
			const pr = { prNumber: 42, prUrl: "https://github.com/test/repo/pull/42" };
			mockedApi.request.getBranchStatus.mockResolvedValue({ ...defaultBranchStatus, ...pr, prState: "OPEN" });
			await act(async () => { renderPanel(makeTask(pr)); });
			for (const [state, ciStatus] of [["OPEN", "failure"], ["OPEN", "success"], ["MERGED", "success"]] as const) {
				act(() => {
					window.dispatchEvent(new CustomEvent("rpc:taskPrStatus", { detail: {
						projectId: "p1", taskId: "t1", ...pr, ciStatus, reviewState: null, unresolvedCount: 0,
						mergeState: { mergeable: "MERGEABLE", status: ciStatus === "failure" ? "UNSTABLE" : "CLEAN", state },
						checks: [{ name: "build", status: "COMPLETED", conclusion: ciStatus === "failure" ? "FAILURE" : "SUCCESS", detailsUrl: null }],
						prTitle: "Status changes", isDraft: false,
					} }));
				});
				for (const node of screen.getAllByRole("button").filter((button) => button.textContent?.includes("PR #42"))) {
					expect(node).toHaveTextContent(`PR #42 — ${state === "MERGED" ? "Merged" : "Open"}`);
				}
				await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).hover(screen.getAllByText(/PR #42/)[0].closest("button")!);
				const popover = await screen.findByTestId("pr-status-popover");
				expect(within(popover).getByText("build").closest("li")).toHaveTextContent(ciStatus === "failure" ? "Failed" : "Passed");
				await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).unhover(screen.getAllByText(/PR #42/)[0].closest("button")!);
			}
			// The merged badge stays clickable.
			const openSpy = vi.fn(); window.open = openSpy;
			fireEvent.click(screen.getAllByText(/PR #42/)[0].closest("button")!);
			expect(openSpy).toHaveBeenCalledWith(pr.prUrl, "_blank");
		});

		it("tints the PR #42 badge from the task's stored cache while GitHub gives no state", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 3,
				unpushed: 0,
				prNumber: 42,
				prUrl: "https://github.com/test/repo/pull/42",
				prState: null,
			});

			await act(async () => {
				renderPanel(makeTask({
					prNumber: 42,
					prUrl: "https://github.com/test/repo/pull/42",
					prStatusCache: {
						number: 42,
						url: "https://github.com/test/repo/pull/42",
						ciStatus: null,
						reviewState: null,
						unresolvedCount: 0,
						mergeState: { mergeable: null, status: null, state: "MERGED" },
						checks: [],
						prTitle: null,
						isDraft: false,
						cachedAt: "2026-10-01T00:00:00.000Z",
					},
				}));
			});

			for (const node of screen.getAllByText(/PR #42/)) {
				expect(node.closest("button")!.className).toContain("text-pr-merged");
			}
			// Read as merged, so Create PR is back and Merge does not route through it.
			expect(screen.getAllByText("PR").length).toBeGreaterThanOrEqual(1);
			expect(screen.queryByText("Merge PR")).not.toBeInTheDocument();
		});

		it("opens the git-bar PR popover on the stored merged status, not Unknown, when no push arrived", async () => {
			mockedApi.request.refreshTaskPrStatus.mockResolvedValue({ outcome: "unavailable" });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 3,
				unpushed: 0,
				prNumber: 42,
				prUrl: "https://github.com/test/repo/pull/42",
				prState: "MERGED",
			});

			await act(async () => {
				renderPanel(makeTask({
					prNumber: 42,
					prUrl: "https://github.com/test/repo/pull/42",
					prStatusCache: {
						number: 42, url: "https://github.com/test/repo/pull/42", ciStatus: "success", reviewState: null,
						unresolvedCount: 0, mergeState: { mergeable: "UNKNOWN", status: "UNKNOWN", state: "MERGED" },
						checks: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: null }],
						prTitle: "Merged change", isDraft: false, cachedAt: "2026-10-01T00:00:00.000Z",
					},
				}));
			});

			await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).hover(screen.getAllByText(/PR #42/)[0].closest("button")!);
			const popover = await screen.findByTestId("pr-status-popover");
			expect(within(popover).getByText("PR status").nextElementSibling).toHaveTextContent("Merged");
			expect(within(popover).getByTestId("pr-popover-finished-note")).toBeInTheDocument();
			expect(within(popover).queryByText("Unknown")).not.toBeInTheDocument();
			expect(within(popover).getByText("build")).toBeInTheDocument();
			mockedApi.request.refreshTaskPrStatus.mockResolvedValue({ outcome: "updated" });
		});

		it("does not leak the previous task's pushed PR status after switching tasks", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				prNumber: 42,
				prUrl: "https://github.com/test/repo/pull/42",
			});

			const dispatch = vi.fn();
			const navigate = vi.fn();
			let view!: ReturnType<typeof renderPanel>;
			await act(async () => {
				view = renderPanel(makeTask(), { dispatch, navigate });
			});
			act(() => {
				window.dispatchEvent(new CustomEvent("rpc:taskPrStatus", {
					detail: {
						projectId: "p1",
						taskId: "t1",
						prNumber: 42,
						prUrl: "https://github.com/test/repo/pull/42",
						ciStatus: "pending",
						reviewState: null,
						unresolvedCount: 4,
						mergeState: { mergeable: "MERGEABLE", status: "CLEAN" },
						checks: [],
						prTitle: "Status surface",
						isDraft: false,
					},
				}));
			});
			expect(screen.getAllByText(/PR #42/).length).toBeGreaterThanOrEqual(1);

			// Same panel instance re-rendered for another task without a PR — the
			// pushed status from t1 must not keep rendering on t2.
			mockedApi.request.getBranchStatus.mockResolvedValue(defaultBranchStatus);
			await act(async () => {
				view.rerender(
					<I18nProvider>
						<TaskHeader
							task={makeTask({ id: "t2", seq: 43, worktreePath: "/tmp/wt/t2", branchName: "dev3/task-t2" })}
							project={project}
							dispatch={dispatch}
							navigate={navigate}
						/>
					</I18nProvider>,
				);
			});

			expect(screen.queryByText(/PR #42/)).not.toBeInTheDocument();
		});

		it("calls createPullRequest when Create PR is clicked (no existing PR)", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 3,
				unpushed: 0,
				prNumber: null,
			});
			mockedApi.request.createPullRequest.mockResolvedValue({ delivery: { status: "delivered" } });

			await act(async () => {
				renderPanel(makeTask());
			});

			const createPRButtons = screen.getAllByText("PR");
			const enabledBtn = createPRButtons.find(b => !b.closest("button")!.disabled);
			expect(enabledBtn).toBeTruthy();
			await user.click(enabledBtn!.closest("button")!);

			expect(mockedApi.request.createPullRequest).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				autoMerge: false,
			});
		});

		it("calls createPullRequest with autoMerge when 'PR + auto-merge' is clicked", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 3,
				unpushed: 0,
				prNumber: null,
			});
			mockedApi.request.createPullRequest.mockResolvedValue({ delivery: { status: "delivered" } });

			await act(async () => {
				renderPanel(makeTask());
			});

			const autoMergeButtons = screen.getAllByText("Auto PR");
			const enabledBtn = autoMergeButtons.find(b => !b.closest("button")!.disabled);
			expect(enabledBtn).toBeTruthy();
			await user.click(enabledBtn!.closest("button")!);

			expect(mockedApi.request.createPullRequest).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				autoMerge: true,
			});
		});

		it("shows auto-merge and mergeability details in the PR status popover", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				prNumber: 42,
				prUrl: "https://github.com/test/repo/pull/42",
			});

			await act(async () => {
				renderPanel(makeTask());
			});
			act(() => {
				window.dispatchEvent(new CustomEvent("rpc:taskPrStatus", {
					detail: {
						projectId: "p1",
						taskId: "t1",
						prNumber: 42,
						prUrl: "https://github.com/test/repo/pull/42",
						autoMergeEnabled: false,
						ciStatus: "failure",
						reviewState: null,
						reviewDecision: "review_required",
						unresolvedCount: 2,
						mergeState: { mergeable: "MERGEABLE", status: "BLOCKED" },
						checks: [{ name: "E2E PR Smoke Tests", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: null }],
						prTitle: "Merge status",
						isDraft: false,
					},
				}));
			});

			// The unresolved comment count rides the PR section itself.
			expect(await screen.findAllByLabelText("2 unresolved comments")).not.toHaveLength(0);
			const badge = screen.getAllByText(/PR #42/)[0].closest("button")!;
			await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).hover(badge);
			const popover = await screen.findByTestId("pr-status-popover");
			expect(popover).toHaveTextContent("Merge status");
			expect(within(popover).getByText("Auto-merge")).toBeInTheDocument();
			expect(within(popover).getByText("Not set")).toBeInTheDocument();
			expect(within(popover).getByText("Mergeable")).toBeInTheDocument();
			expect(within(popover).getByText("No")).toBeInTheDocument();
			expect(within(popover).getByText("Unresolved comments")).toBeInTheDocument();
			expect(within(popover).getByText("A required approving review is missing")).toBeInTheDocument();
			expect(within(popover).getByText("Failed checks: E2E PR Smoke Tests")).toBeInTheDocument();
		});

		it("PR badge does not open a tab when prUrl is null", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const openSpy = vi.fn(); window.open = openSpy;
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 3,
				unpushed: 0,
				prNumber: 42,
				prUrl: null,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			// No dedicated "Open PR" button exists anymore — the PR badge is the only entry point.
			expect(screen.queryByText("Open PR")).not.toBeInTheDocument();
			const badge = screen.getAllByText(/PR #42/)[0].closest("button")!;
			await user.click(badge);
			expect(openSpy).not.toHaveBeenCalled();
		});

		it("renders git action buttons icon-only (no text) in compact mode", async () => {
			mockMatchMedia(true);
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 3,
				behind: 2,
				unpushed: 0,
				prNumber: null,
				canRebase: true,
			});

			await act(async () => {
				renderPanel(makeTask());
			});

			// Labels collapse to glyphs; the actions remain reachable via aria-label/title.
			expect(screen.queryByText("PR")).not.toBeInTheDocument();
			expect(screen.queryByText("Rebase")).not.toBeInTheDocument();
			expect(screen.getAllByLabelText("Create PR").length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByLabelText("Merge").length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("full screen navigation", () => {
		it("navigates to the task screen on click, with no panel-restore toggle in split view", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const navigate = vi.fn();
			await act(async () => {
				renderPanel(makeTask(), { navigate });
			});

			expect(screen.queryByTestId("show-active-tasks")).not.toBeInTheDocument();
			await user.click(screen.getByLabelText("Full screen"));

			expect(navigate).toHaveBeenCalledWith({
				screen: "task",
				projectId: "p1",
				taskId: "t1",
			});
		});

		it("in full page mode: exit and the left-edge panel-restore toggle both return to the split view", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const navigate = vi.fn();
			await act(async () => {
				renderPanel(makeTask(), { navigate, isFullPage: true });
			});
			const splitView = { screen: "project", projectId: "p1", activeTaskId: "t1" };

			const toggle = screen.getByTestId("show-active-tasks");
			const gitBar = document.querySelector('[data-help-id="inspector.git-bar"]')!;
			const gitRow = gitBar.parentElement!;
			expect(gitRow.contains(toggle)).toBe(true);
			expect(gitRow.firstElementChild?.contains(toggle)).toBe(true);
			expect(screen.getByTestId("branch-chip").compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();

			await user.click(screen.getByLabelText("Exit full screen"));
			expect(navigate).toHaveBeenCalledWith(splitView);
			navigate.mockClear();
			await user.click(toggle);
			expect(navigate).toHaveBeenCalledWith(splitView);
		});

		it("uses the app immersive toggle when provided instead of navigating, and names its shortcuts", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const navigate = vi.fn();
			const toggle = vi.fn();
			await act(async () => {
				renderPanel(makeTask(), { navigate, onToggleTerminalFullscreen: toggle });
			});

			await user.hover(screen.getByLabelText("Full screen"));
			await act(async () => {
				vi.advanceTimersByTime(300);
			});
			expect(screen.getByText(/F11/)).toBeInTheDocument();

			await user.click(screen.getByLabelText("Full screen"));

			expect(toggle).toHaveBeenCalledTimes(1);
			expect(navigate).not.toHaveBeenCalled();
		});

	});

	describe("branch status polling", () => {
		it("does not fetch branch status when no worktree path", async () => {
			await act(async () => {
				renderPanel(makeTask({ status: "in-progress", worktreePath: null }));
			});

			expect(mockedApi.request.getBranchStatus).not.toHaveBeenCalled();
		});
	});

	describe("post-merge auto-complete", () => {
		// The chip opens a menu; a click on it alone must never change the owner.
		async function chooseOwner(task: Task, option: RegExp, opts: Parameters<typeof renderPanel>[1] = {}) {
			await act(async () => {
				renderPanel(task, opts);
			});
			await act(async () => {
				fireEvent.click(screen.getAllByTestId("task-completion-owner")[0]);
			});
			expect(mockedApi.request.setTaskCompletionOwner).not.toHaveBeenCalled();
			await act(async () => {
				fireEvent.click(screen.getByRole("menuitemradio", { name: option }));
			});
		}

		it("turns on manual completion from the chip's menu", async () => {
			const updated = makeTask({ manualCompletion: true });
			mockedApi.request.setTaskCompletionOwner.mockResolvedValue(updated);
			const dispatch = vi.fn();

			await chooseOwner(makeTask({ manualCompletion: false }), /I’ll complete it myself/, { dispatch });

			expect(mockedApi.request.setTaskCompletionOwner).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1", owner: "user" });
			expect(dispatch).toHaveBeenCalledWith({ type: "updateTask", task: updated });
			expect(vi.mocked(confirm)).not.toHaveBeenCalled();
			expect(vi.mocked(toast.info)).not.toHaveBeenCalled();
		});

		it("turns manual completion off again without passing through the agent", async () => {
			mockedApi.request.setTaskCompletionOwner.mockResolvedValue(makeTask());

			await chooseOwner(makeTask({ manualCompletion: true }), /dev3 suggests completing it/);

			expect(mockedApi.request.setTaskCompletionOwner).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1", owner: "dev3" });
			expect(vi.mocked(confirm)).not.toHaveBeenCalled();
		});

		it("hands completion to the agent only after a danger confirmation; a cancel grants nothing", async () => {
			vi.mocked(confirm).mockResolvedValueOnce(false as never).mockResolvedValue(true as never);
			mockedApi.request.setTaskCompletionOwner.mockResolvedValue(makeTask({ selfCompletion: true }));

			await chooseOwner(makeTask({ manualCompletion: true }), /Agent completes it/);
			expect(mockedApi.request.setTaskCompletionOwner).not.toHaveBeenCalled();
			await act(async () => {
				fireEvent.click(screen.getAllByTestId("task-completion-owner")[0]);
			});
			await act(async () => {
				fireEvent.click(screen.getByRole("menuitemradio", { name: /Agent completes it/ }));
			});

			expect(vi.mocked(confirm)).toHaveBeenCalledWith(expect.objectContaining({ danger: true, confirmLabel: "Let the agent complete it" }));
			expect(mockedApi.request.setTaskCompletionOwner).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1", owner: "agent" });
		});

		it("says in words that the agent completes the task, and what that skips", async () => {
			await act(async () => {
				renderPanel(makeTask({ selfCompletion: true }));
			});

			expect(screen.getAllByText("Agent completes it").length).toBeGreaterThan(0);
			const button = screen.getAllByTestId("task-completion-owner")[0];
			expect(button.getAttribute("aria-label")).toContain("no approval dialog");
			expect(button.className).toContain("text-warning-strong");
		});

		it("states active completion ownership in words, colour and the accessible name, right of the status chip", async () => {
			await act(async () => {
				renderPanel(makeTask({ manualCompletion: true }));
			});

			// Colour is never the only cue: the chip says who owns completion, and the
			// name says what that suppresses — the thing the user read as a bug.
			expect(screen.getAllByText("I’ll complete it myself").length).toBeGreaterThan(0);
			const button = screen.getAllByTestId("task-completion-owner")[0];
			expect(button).toHaveAttribute("aria-pressed", "true");
			expect(button.getAttribute("aria-label")).toContain("won’t suggest completing");
			expect(button.className).toContain("text-warning-strong");
			expect(button.className).not.toContain("text-accent");
			expect(button.querySelector("svg")).toBeTruthy();

			const owner = screen.getByLabelText(/complete it myself/i);
			const status = screen.getByText("Agent is Working");
			expect(
				status.compareDocumentPosition(owner) & Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
		});

		it("keeps the off state quiet — no label, no colour — and the watch toggle a bare bell", async () => {
			await act(async () => {
				renderPanel(makeTask({ manualCompletion: false, watched: true }));
			});

			expect(screen.queryByText("I’ll complete it myself")).not.toBeInTheDocument();
			const button = screen.getAllByTestId("task-completion-owner")[0];
			expect(button).toHaveAttribute("aria-pressed", "false");
			expect(button.className).toContain("text-fg-3");
			expect(button.className).not.toContain("warning");
			// The watch toggle's words live only in its name.
			expect(screen.queryByText("Watching")).not.toBeInTheDocument();
			expect(screen.getByLabelText(/stop notifications/i).querySelector("svg")).toBeTruthy();
		});

		it("persists self-managed completion from the merge popup", async () => {
			const task = makeTask({ status: "review-by-user" });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				mergedByContent: true,
				mergeCompletionFingerprint: "v1:dev3/task-t1:manual",
			});
			vi.mocked(offerCompletion).mockResolvedValue("manual" as never);

			await act(async () => {
				renderPanel(task);
			});

			await waitFor(() => expect(mockedApi.request.setTaskManualCompletion).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				manualCompletion: true,
			}));
			expect(mockedApi.request.moveTask).not.toHaveBeenCalled();
			expect(vi.mocked(offerCompletion)).toHaveBeenCalledWith(expect.objectContaining({ taskId: "t1", kind: "merge" }));
		});

		it("shows a merge notice when the backend suppresses the popup", async () => {
			const task = makeTask({ status: "review-by-user" });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				mergedByContent: true,
				mergeCompletionFingerprint: "v1:dev3/task-t1:notice",
			});
			mockedApi.request.prepareMergeCompletionPrompt.mockResolvedValue({
				shouldPrompt: false,
				shouldNotify: true,
				fingerprint: "v1:dev3/task-t1:notice",
			});

			await act(async () => {
				renderPanel(task);
			});

			await waitFor(() => expect(vi.mocked(toast.info)).toHaveBeenCalledWith(
				'Branch of task "Test task" was merged.',
				expect.objectContaining({ taskId: "t1" }),
			));
			expect(vi.mocked(offerCompletion)).not.toHaveBeenCalled();
		});

		it("does not offer auto-complete for merged AI Review tasks", async () => {
			const dispatch = vi.fn();
			const navigate = vi.fn();
			const task = makeTask({ status: "review-by-ai" });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				mergedByContent: true,
			});
			vi.mocked(offerCompletion).mockResolvedValue(true);
			mockedApi.request.moveTask.mockResolvedValue({ ...task, status: "completed" });

			await act(async () => {
				renderPanel(task, { dispatch, navigate });
			});

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(vi.mocked(offerCompletion)).not.toHaveBeenCalled();
			expect(mockedApi.request.moveTask).not.toHaveBeenCalled();
		});

		it("offers auto-complete for merged PR Review tasks", async () => {
			const dispatch = vi.fn();
			const navigate = vi.fn();
			const task = makeTask({ status: "review-by-colleague" });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				mergedByContent: true,
			});
			vi.mocked(offerCompletion).mockResolvedValue(true);
			mockedApi.request.moveTask.mockResolvedValue({ ...task, status: "completed" });

			await act(async () => {
				renderPanel(task, { dispatch, navigate });
			});

			await waitFor(() => {
				expect(vi.mocked(offerCompletion)).toHaveBeenCalled();
			});
			await waitFor(() => {
				expect(mockedApi.request.moveTask).toHaveBeenCalledWith({
					taskId: "t1",
					projectId: "p1",
					newStatus: "completed",
					clientPlayedSound: true,
				});
			});
		});

		it("completes without moving the user when the offer is answered after the task view closed", async () => {
			const dispatch = vi.fn();
			const navigate = vi.fn();
			const task = makeTask({ status: "review-by-colleague" });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				mergedByContent: true,
			});
			let answer!: (value: boolean) => void;
			vi.mocked(offerCompletion).mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
			mockedApi.request.moveTask.mockResolvedValue({ ...task, status: "completed" });

			let unmount!: () => void;
			await act(async () => {
				({ unmount } = renderPanel(task, { dispatch, navigate }));
			});
			await waitFor(() => expect(vi.mocked(offerCompletion)).toHaveBeenCalled());
			// The user left for another screen and answered there (the dialog, the Ready to complete list).
			unmount();
			await act(async () => { answer(true); });

			await waitFor(() => expect(mockedApi.request.moveTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: "t1", newStatus: "completed" })));
			expect(navigate).not.toHaveBeenCalled();
		});

		it("returns fullscreen open-mode users to the Kanban board after auto-complete", async () => {
			localStorage.setItem("dev3-task-open-mode", "fullscreen");
			try {
				const dispatch = vi.fn();
				const navigate = vi.fn();
				const task = makeTask({ status: "review-by-colleague" });
				mockedApi.request.getBranchStatus.mockResolvedValue({
					...defaultBranchStatus,
					mergedByContent: true,
				});
				vi.mocked(offerCompletion).mockResolvedValue(true);
				mockedApi.request.moveTask.mockResolvedValue({ ...task, status: "completed" });

				await act(async () => {
					renderPanel(task, { dispatch, navigate });
				});

				await waitFor(() => {
					expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p1" });
				});
			} finally {
				localStorage.removeItem("dev3-task-open-mode");
			}
		});

		it("offers auto-complete for merged Has Questions tasks", async () => {
			const dispatch = vi.fn();
			const navigate = vi.fn();
			const task = makeTask({ status: "user-questions" });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				mergedByContent: true,
			});
			vi.mocked(offerCompletion).mockResolvedValue(true);
			mockedApi.request.moveTask.mockResolvedValue({ ...task, status: "completed" });

			await act(async () => {
				renderPanel(task, { dispatch, navigate });
			});

			await waitFor(() => {
				expect(vi.mocked(offerCompletion)).toHaveBeenCalled();
			});
			await waitFor(() => {
				expect(mockedApi.request.moveTask).toHaveBeenCalledWith({
					taskId: "t1",
					projectId: "p1",
					newStatus: "completed",
					clientPlayedSound: true,
				});
			});
		});

		it("does not offer auto-complete when comparing against a non-base ref", async () => {
			// mergedByContent is computed against the user-selected compare ref;
			// a custom ref must never trigger the "Branch Merged" popup.
			const dispatch = vi.fn();
			const navigate = vi.fn();
			const task = makeTask({ status: "review-by-user" });
			const customCompareProject = { ...project, defaultCompareRef: "origin/develop" };
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				mergedByContent: true,
				mergeCompletionFingerprint: "v1:dev3/task-t1:abc123",
			});
			vi.mocked(offerCompletion).mockResolvedValue(true);

			await act(async () => {
				renderPanel(task, { dispatch, navigate, project: customCompareProject });
			});

			await waitFor(() => {
				expect(mockedApi.request.getBranchStatus).toHaveBeenCalledWith({
					taskId: "t1",
					projectId: "p1",
					compareRef: "origin/develop",
				});
			});
			expect(mockedApi.request.prepareMergeCompletionPrompt).not.toHaveBeenCalled();
			expect(vi.mocked(offerCompletion)).not.toHaveBeenCalled();
		});

		it("does not offer auto-complete while the worktree has uncommitted changes", async () => {
			const dispatch = vi.fn();
			const navigate = vi.fn();
			const task = makeTask({ status: "review-by-user" });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				mergedByContent: true,
				insertions: 5,
				deletions: 2,
				mergeCompletionFingerprint: "v1:dev3/task-t1:abc123",
			});
			vi.mocked(offerCompletion).mockResolvedValue(true);

			await act(async () => {
				renderPanel(task, { dispatch, navigate });
			});

			await waitFor(() => {
				expect(mockedApi.request.getBranchStatus).toHaveBeenCalled();
			});
			expect(mockedApi.request.prepareMergeCompletionPrompt).not.toHaveBeenCalled();
			expect(vi.mocked(offerCompletion)).not.toHaveBeenCalled();
		});

		it("does not offer auto-complete after a merge while uncommitted changes remain", async () => {
			const dispatch = vi.fn();
			const navigate = vi.fn();
			const task = makeTask({ status: "in-progress" });
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				insertions: 5,
				deletions: 2,
			});
			vi.mocked(offerCompletion).mockResolvedValue(true);

			await act(async () => {
				renderPanel(task, { dispatch, navigate });
			});

			await act(async () => {
				window.dispatchEvent(
					new CustomEvent("rpc:gitOpCompleted", {
						detail: { taskId: "t1", operation: "merge", ok: true },
					}),
				);
			});

			expect(mockedApi.request.prepareMergeCompletionPrompt).not.toHaveBeenCalled();
			expect(vi.mocked(offerCompletion)).not.toHaveBeenCalled();
		});

		it("does not show a second merge-complete dialog while one is already open", async () => {
			const dispatch = vi.fn();
			const navigate = vi.fn();
			const task = makeTask({ status: "review-by-user" });
			let resolveConfirm: (value: boolean) => void = () => {};

			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				mergedByContent: true,
				mergeCompletionFingerprint: "v1:dev3/task-t1:abc123",
			});
			vi.mocked(offerCompletion).mockReturnValue(
				new Promise<boolean | "manual">((resolve) => {
					resolveConfirm = resolve;
				}),
			);

			await act(async () => {
				renderPanel(task, { dispatch, navigate });
			});

			await waitFor(() => {
				expect(vi.mocked(offerCompletion)).toHaveBeenCalledTimes(1);
			});

			await act(async () => {
				window.dispatchEvent(
					new CustomEvent("rpc:gitOpCompleted", {
						detail: { taskId: "t1", operation: "merge", ok: true },
					}),
				);
			});

			expect(vi.mocked(offerCompletion)).toHaveBeenCalledTimes(1);

			await act(async () => {
				resolveConfirm(false);
			});
			await waitFor(() => {
				expect(mockedApi.request.dismissMergeCompletionPrompt).toHaveBeenCalledWith({
					taskId: "t1",
					projectId: "p1",
					fingerprint: "v1:dev3/task-t1:abc123",
				});
			});
		});

		it("does not ask when backend suppresses the merge-completion prompt", async () => {
			const dispatch = vi.fn();
			const navigate = vi.fn();
			const task = makeTask({ status: "review-by-user" });

			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				mergedByContent: true,
				mergeCompletionFingerprint: "v1:dev3/task-t1:abc123",
			});
			mockedApi.request.prepareMergeCompletionPrompt.mockResolvedValue({
				shouldPrompt: false,
				fingerprint: "v1:dev3/task-t1:abc123",
			});

			await act(async () => {
				renderPanel(task, { dispatch, navigate });
			});

			await waitFor(() => {
				expect(mockedApi.request.prepareMergeCompletionPrompt).toHaveBeenCalled();
			});
			expect(vi.mocked(offerCompletion)).not.toHaveBeenCalled();
			expect(mockedApi.request.moveTask).not.toHaveBeenCalled();
		});

		it("sets movedAt when auto-completing after merge", async () => {
			const dispatch = vi.fn();
			const navigate = vi.fn();
			const task = makeTask({ status: "in-progress" });
			vi.mocked(offerCompletion).mockResolvedValue(true);
			mockedApi.request.moveTask.mockResolvedValue({ ...task, status: "completed" });

			await act(async () => {
				renderPanel(task, { dispatch, navigate });
			});

			// Simulate the gitOpCompleted event for a successful merge
			await act(async () => {
				window.dispatchEvent(
					new CustomEvent("rpc:gitOpCompleted", {
						detail: { taskId: "t1", operation: "merge", ok: true },
					}),
				);
			});

			// Wait for the confirm dialog to resolve
			await waitFor(() => {
				expect(vi.mocked(offerCompletion)).toHaveBeenCalled();
			});

			await waitFor(() => {
				const updateCall = dispatch.mock.calls.find(
					(c: unknown[]) => (c[0] as AppAction).type === "updateTask"
						&& ((c[0] as { task: Task }).task).status === "completed",
				);
				expect(updateCall).toBeDefined();
				const dispatchedTask = (updateCall![0] as { task: Task }).task;
				expect(dispatchedTask.movedAt).toBeDefined();
				expect(typeof dispatchedTask.movedAt).toBe("string");
				expect(dispatchedTask.worktreePath).toBeNull();
				expect(dispatchedTask.branchName).toBeNull();
			});

			expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p1", taskView: true });
		});

		it("optimistically completes after merge even while the move RPC is still pending", async () => {
			const dispatch = vi.fn();
			const navigate = vi.fn();
			const task = makeTask({ status: "review-by-user" });
			vi.mocked(offerCompletion).mockResolvedValue(true);
			mockedApi.request.moveTask.mockReturnValue(new Promise(() => {}) as never);

			await act(async () => {
				renderPanel(task, { dispatch, navigate });
			});

			await act(async () => {
				window.dispatchEvent(
					new CustomEvent("rpc:gitOpCompleted", {
						detail: { taskId: "t1", operation: "merge", ok: true },
					}),
				);
			});

			await waitFor(() => {
				expect(vi.mocked(offerCompletion)).toHaveBeenCalled();
			});

			await waitFor(() => {
				const completedUpdate = dispatch.mock.calls.find(
					(call: unknown[]) => (call[0] as AppAction).type === "updateTask"
						&& ((call[0] as { task: Task }).task).status === "completed",
				);
				expect(completedUpdate).toBeDefined();
			});
			expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p1", taskView: true });
		});

		it("keeps the optimistic completion when both background completion RPC attempts fail", async () => {
			const dispatch = vi.fn();
			const navigate = vi.fn();
			const alertSpy = vi.mocked(toast.error);
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const task = makeTask({ status: "review-by-user" });

			vi.mocked(offerCompletion).mockResolvedValue(true);
			mockedApi.request.moveTask
				.mockRejectedValueOnce(new Error("primary failure"))
				.mockRejectedValueOnce(new Error("forced failure"));

			await act(async () => {
				renderPanel(task, { dispatch, navigate });
			});

			await act(async () => {
				window.dispatchEvent(
					new CustomEvent("rpc:gitOpCompleted", {
						detail: { taskId: "t1", operation: "merge", ok: true },
					}),
				);
			});

			await waitFor(() => {
				expect(vi.mocked(offerCompletion)).toHaveBeenCalled();
			});
			await waitFor(() => {
				expect(mockedApi.request.moveTask).toHaveBeenCalledTimes(2);
			});

			const completedUpdate = dispatch.mock.calls.find(
				(call: unknown[]) => (call[0] as AppAction).type === "updateTask"
					&& ((call[0] as { task: Task }).task).status === "completed",
			);

			expect(completedUpdate).toBeDefined();
			expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p1", taskView: true });
			expect(alertSpy).not.toHaveBeenCalled();
			expect(consoleErrorSpy).toHaveBeenCalled();
			consoleErrorSpy.mockRestore();
		});
	});

	describe("inline rename", () => {
		beforeEach(() => {
			localStorage.setItem("dev3-panel-collapsed", "false");
		});

		it("shows the title with an edit button; editing offers no reset, an unchanged Enter saves nothing, cancel restores", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			await act(async () => {
				renderPanel(makeTask({ title: "My task" }));
			});
			expect(screen.getByText("My task")).toBeInTheDocument();

			await user.click(screen.getByTitle("Edit title"));
			expect(screen.getByDisplayValue("My task")).toBeInTheDocument();
			expect(screen.queryByText("Reset to auto")).not.toBeInTheDocument();
			// Press Enter without changing value
			await user.keyboard("{Enter}");
			expect(mockedApi.request.renameTask).not.toHaveBeenCalled();

			expect(screen.queryByDisplayValue("My task")).not.toBeInTheDocument();
			await user.click(screen.getByTitle("Edit title"));
			await user.click(screen.getByTestId("rename-cancel"));
			expect(screen.queryByDisplayValue("My task")).not.toBeInTheDocument();
			expect(screen.getByText("My task")).toBeInTheDocument();
		});

		it("saves new title on Enter", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const dispatch = vi.fn();
			const updatedTask = makeTask({ title: "My task", customTitle: "New name" });
			mockedApi.request.renameTask.mockResolvedValue(updatedTask);

			await act(async () => {
				renderPanel(makeTask({ title: "My task" }), { dispatch });
			});
			await user.click(screen.getByTitle("Edit title"));
			const input = screen.getByDisplayValue("My task");
			await user.clear(input);
			await user.type(input, "New name{Enter}");

			await waitFor(() => {
				expect(mockedApi.request.renameTask).toHaveBeenCalledWith({
					taskId: "t1",
					projectId: "p1",
					customTitle: "New name",
				});
			});
			expect(dispatch).toHaveBeenCalledWith({ type: "updateTask", task: updatedTask });
			expect(mockedTrackEvent).toHaveBeenCalledWith("task_renamed", { project_id: "p1" });
		});

		it("shows customTitle and resets it to the auto-generated title", async () => {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const dispatch = vi.fn();
			const updatedTask = makeTask({ title: "Auto title", customTitle: null });
			mockedApi.request.renameTask.mockResolvedValue(updatedTask);

			await act(async () => {
				renderPanel(makeTask({ title: "Auto title", customTitle: "Custom name" }), { dispatch });
			});
			// customTitle wins over the title, and editing it offers the reset.
			expect(screen.getByText("Custom name")).toBeInTheDocument();
			await user.click(screen.getByTitle("Edit title"));
			await user.click(screen.getByText("Reset to auto"));

			await waitFor(() => {
				expect(mockedApi.request.renameTask).toHaveBeenCalledWith({
					taskId: "t1",
					projectId: "p1",
					customTitle: null,
				});
			});
			expect(dispatch).toHaveBeenCalledWith({ type: "updateTask", task: updatedTask });
		});

	});

	describe("custom column status display", () => {
		const projectWithCustomColumns: Project = {
			...project,
			customColumns: [
				{ id: "col-1", name: "On Hold", color: "#f59e0b", llmInstruction: "" },
				{ id: "col-2", name: "Blocked", color: "#ef4444", llmInstruction: "" },
			],
		};

		it("shows custom column name instead of built-in status when task is in a custom column", async () => {
			await act(async () => {
				renderPanel(
					makeTask({ status: "review-by-user", customColumnId: "col-1" }),
					{ project: projectWithCustomColumns },
				);
			});
			// Should show the custom column name, not the built-in status
			expect(screen.getByText("On Hold")).toBeInTheDocument();
			// The built-in status "Your Review" should NOT appear in the status button
			expect(screen.queryByText("Your Review")).not.toBeInTheDocument();
		});

		it("shows built-in status when task is not in a custom column", async () => {
			await act(async () => {
				renderPanel(
					makeTask({ status: "review-by-user" }),
					{ project: projectWithCustomColumns },
				);
			});
			expect(screen.getByText("Your Review")).toBeInTheDocument();
		});
	});
});

describe("TaskHeader — virtual (Operations) tasks", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getBranchStatus.mockResolvedValue(defaultBranchStatus);
		mockedApi.request.getResolvedProject.mockResolvedValue(project);
	});

	const vproject: Project = { ...project, kind: "virtual", path: "/tmp/.dev3.0/ops/operations" };

	it("hides the git bar, Dev Server and Scripts for a virtual task and notes 'No repository attached'", async () => {
		await act(async () => {
			renderPanel(
				makeTask({ status: "in-progress", branchName: "dev3/should-not-show", worktreePath: "/tmp/.dev3.0/ops/operations/t1/work" }),
				{ project: vproject },
			);
		});
		expect(screen.queryByText("dev3/should-not-show")).not.toBeInTheDocument();
		expect(screen.getByText("No repository attached")).toBeInTheDocument();
		expect(screen.queryByText("Setup Dev Server")).not.toBeInTheDocument();
		expect(screen.queryByText("Dev Server")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Scripts")).not.toBeInTheDocument();
	});

	it("says the git workflow is off, and shows no branch, on a gitless project", async () => {
		await act(async () => {
			renderPanel(
				makeTask({ status: "in-progress", branchName: "dev3/should-not-show", worktreePath: "/tmp/customer-x" }),
				{ project: { ...project, gitWorkflow: false } },
			);
		});
		expect(screen.getByText("Git workflow is off for this project")).toBeInTheDocument();
		expect(screen.queryByText("dev3/should-not-show")).not.toBeInTheDocument();
	});

	it("still shows the git bar, Dev Server and Scripts for a git task", async () => {
		await act(async () => {
			renderPanel(makeTask({ status: "in-progress", branchName: "dev3/task-shown", worktreePath: "/tmp/wt/t1" }));
		});
		expect(await screen.findByTestId("branch-chip")).toBeInTheDocument();
		expect(screen.getByLabelText("Scripts")).toBeInTheDocument();
	});

	describe("attaching a git repository", () => {
		const opsTask = (overrides: Partial<Task> = {}) =>
			makeTask({ status: "in-progress", worktreePath: "/tmp/.dev3.0/ops/operations/t1/work", ...overrides });

		it("offers Attach repository on an active task and attaches the picked folder", async () => {
			vi.mocked(openFolderPicker).mockResolvedValue("/Users/me/repo");
			await act(async () => {
				renderPanel(opsTask(), { project: vproject });
			});
			await act(async () => {
				fireEvent.click(screen.getByRole("button", { name: "Attach repository" }));
			});
			expect(openFolderPicker).toHaveBeenCalledWith({ initialPath: "/tmp/.dev3.0/ops/operations/t1/work" });
			expect(mockedApi.request.setTaskAttachedRepo).toHaveBeenCalledWith({
				taskId: "t1", projectId: vproject.id, path: "/Users/me/repo",
			});
		});

		it("does not offer it on a task that is not active", async () => {
			await act(async () => {
				renderPanel(opsTask({ status: "todo" }), { project: vproject });
			});
			expect(screen.queryByRole("button", { name: "Attach repository" })).not.toBeInTheDocument();
		});

		it("shows the changes summary, the repo chip and Detach — and no write actions; Detach sends a null path", async () => {
			await act(async () => {
				renderPanel(opsTask({ attachedRepo: "/Users/me/repo" }), { project: vproject, onOpenInlineDiff: vi.fn() });
			});
			expect(await screen.findByTestId("changes-summary")).toBeInTheDocument();
			expect(screen.getByTestId("attached-repo-chip")).toHaveTextContent("repo");
			expect(screen.queryByRole("button", { name: "Attach repository" })).not.toBeInTheDocument();
			for (const name of ["Commit", "Rebase", "Push", "Merge", "Create PR"]) {
				expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
			}
			await act(async () => {
				fireEvent.click(screen.getByRole("button", { name: "Detach repository" }));
			});
			expect(mockedApi.request.setTaskAttachedRepo).toHaveBeenCalledWith({
				taskId: "t1", projectId: vproject.id, path: null,
			});
		});

		it("toasts the backend error when attaching fails", async () => {
			vi.mocked(openFolderPicker).mockResolvedValue("/Users/me/plain");
			mockedApi.request.setTaskAttachedRepo.mockRejectedValueOnce(new Error("Not a git repository: /Users/me/plain"));
			await act(async () => {
				renderPanel(opsTask(), { project: vproject });
			});
			await act(async () => {
				fireEvent.click(screen.getByRole("button", { name: "Attach repository" }));
			});
			expect(toast.error).toHaveBeenCalledWith("Not a git repository: /Users/me/plain", expect.anything());
		});
	});

	describe("narrow viewport (mobile)", () => {
		beforeEach(() => {
			mockViewport(390);
		});
		afterEach(() => {
			mockViewport(1920);
		});

		it("collapses the toolbars into a summary bar whose kebab opens and closes the actions sheet", async () => {
			await act(async () => {
				renderPanel(makeTask({ title: "Mobile task", seq: 7 }));
			});
			// Summary bar: kebab present, full actions sheet not yet open.
			expect(screen.getByTestId("task-actions-kebab")).toBeInTheDocument();
			expect(screen.queryByTestId("task-actions-sheet")).not.toBeInTheDocument();
			// The task title is NOT repeated in the summary bar — it already shows in
			// the breadcrumb row above (GlobalHeader). Only status + kebab live here.
			expect(screen.queryByText("Mobile task")).not.toBeInTheDocument();

			await act(async () => {
				fireEvent.click(screen.getByTestId("task-actions-kebab"));
			});
			const sheet = screen.getByTestId("task-actions-sheet");
			// Sheet header + the details grid moved into the sheet (Title row + task number).
			expect(within(sheet).getByText("Task actions")).toBeInTheDocument();
			expect(within(sheet).getByText("Title")).toBeInTheDocument();
			expect(within(sheet).getByText("#7")).toBeInTheDocument();

			await act(async () => {
				fireEvent.click(screen.getByRole("button", { name: "Close" }));
			});
			expect(screen.queryByTestId("task-actions-sheet")).not.toBeInTheDocument();
		});

		async function openSheet(task: Task, opts?: Parameters<typeof renderPanel>[1]) {
			await act(async () => {
				renderPanel(task, opts);
			});
			await act(async () => {
				fireEvent.click(screen.getByTestId("task-actions-kebab"));
			});
			return screen.getByTestId("task-actions-sheet");
		}

		it("Full screen and Hibernate rows close the sheet; one enters terminal fullscreen, the other runs the confirmed hibernate flow", async () => {
			vi.mocked(confirm).mockResolvedValue(true);
			const task = makeTask();
			mockedApi.request.hibernateTask.mockResolvedValue({ task: { ...task, hibernated: true }, freedRssBytes: null });
			const onToggleTerminalFullscreen = vi.fn();
			const fullscreenSheet = await openSheet(task, { onToggleTerminalFullscreen });

			await act(async () => {
				fireEvent.click(within(fullscreenSheet).getByTestId("task-actions-fullscreen"));
			});
			expect(onToggleTerminalFullscreen).toHaveBeenCalledTimes(1);
			expect(screen.queryByTestId("task-actions-sheet")).not.toBeInTheDocument();

			await act(async () => {
				fireEvent.click(screen.getByTestId("task-actions-kebab"));
			});
			await act(async () => {
				fireEvent.click(within(screen.getByTestId("task-actions-sheet")).getByTestId("task-actions-hibernate"));
			});

			expect(screen.queryByTestId("task-actions-sheet")).not.toBeInTheDocument();
			expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
			expect(mockedApi.request.hibernateTask).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1" });
		});

		it.each([
			["already hibernated", { hibernated: true }],
			["still preparing", { preparing: true }],
			["shutting down", { shuttingDown: true }],
			["without a worktree", { worktreePath: null }],
			["not active", { status: "completed" as const }],
		])("offers no Hibernate row when the task is %s", async (_label, overrides) => {
			const sheet = await openSheet(makeTask(overrides as Partial<Task>));

			expect(within(sheet).queryByTestId("task-actions-hibernate")).not.toBeInTheDocument();
		});

		it("offers no hide buttons, and a control hidden on desktop keeps its sheet row", async () => {
			syncHiddenControlsFromGlobalSettings({ simplifiedMode: false, personalHiddenControls: ["spawn-agent", "bug-hunters", "hibernate"] });
			try {
				const sheet = await openSheet(makeTask());

				expect(within(sheet).queryByRole("button", { name: "Hide" })).not.toBeInTheDocument();
				expect(within(sheet).getByTestId("task-actions-spawn-agent")).toBeInTheDocument();
				expect(within(sheet).getByTestId("task-actions-bug-hunters")).toBeInTheDocument();
				expect(within(sheet).getByTestId("task-actions-hibernate")).toBeInTheDocument();
			} finally {
				syncHiddenControlsFromGlobalSettings({ simplifiedMode: false, personalHiddenControls: [] });
			}
		});

		it("Simplified Mode still trims the advanced rows", async () => {
			syncHiddenControlsFromGlobalSettings({ simplifiedMode: true, personalHiddenControls: [] });
			try {
				const sheet = await openSheet(makeTask());

				expect(within(sheet).queryByTestId("task-actions-spawn-agent")).not.toBeInTheDocument();
				expect(within(sheet).queryByTestId("task-actions-bug-hunters")).not.toBeInTheDocument();
				expect(within(sheet).queryByTestId("task-actions-hibernate")).not.toBeInTheDocument();
				expect(within(sheet).getByTestId("task-actions-fullscreen")).toBeInTheDocument();
			} finally {
				syncHiddenControlsFromGlobalSettings({ simplifiedMode: false, personalHiddenControls: [] });
			}
		});

		it("surfaces the images and artifacts badges in the summary bar, and opens both viewers from the sheet", async () => {
			const openImage = vi.fn();
			window.addEventListener("dev3:openImageViewer", openImage);
			await act(async () => {
				renderPanel(makeTask({
					sharedImages: [{
						id: "image-1",
						storedPath: "/tmp/shared-images/image-1/shot.png",
						originalPath: "/tmp/shot.png",
						name: "shot.png",
						mime: "image/png",
						bytes: 10,
						createdAt: 1,
					}],
					sharedArtifacts: [{
						id: "artifact-1",
						kind: "html",
						title: "Report",
						name: "report.html",
						storedPath: "/tmp/shared-artifacts/artifact-1/report.html",
						originalPath: "/tmp/report.html",
						bytes: 10,
						createdAt: 1,
						assets: [],
					}],
				}));
			});
			// Both ride the bar with the sheet closed — an unread output must be
			// visible without opening the kebab.
			expect(screen.queryByTestId("task-actions-sheet")).not.toBeInTheDocument();
			const badge = within(screen.getByTestId("task-summary-bar")).getByTestId("shared-images-badge");
			expect(within(screen.getByTestId("task-summary-bar")).getByTestId("shared-artifacts-badge")).toBeInTheDocument();
			await act(async () => {
				fireEvent.click(badge);
			});
			expect((openImage.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ taskId: "t1", projectId: "p1" });

			// The sheet rows open the same viewers and dismiss the sheet.
			await act(async () => {
				fireEvent.click(screen.getByTestId("task-actions-kebab"));
			});
			await act(async () => {
				fireEvent.click(within(screen.getByTestId("task-actions-sheet")).getByText("Images"));
			});
			expect(openImage).toHaveBeenCalledTimes(2);
			expect((openImage.mock.calls[1][0] as CustomEvent).detail).toMatchObject({ taskId: "t1", projectId: "p1" });
			expect(screen.queryByTestId("task-actions-sheet")).not.toBeInTheDocument();

			const openArtifact = vi.fn();
			window.addEventListener("dev3:openArtifactViewer", openArtifact);
			await act(async () => {
				fireEvent.click(screen.getByTestId("task-actions-kebab"));
			});
			await act(async () => {
				fireEvent.click(within(screen.getByTestId("task-actions-sheet")).getByText("Artifacts"));
			});
			expect(openArtifact).toHaveBeenCalledOnce();
			// projectId is required by the App-level listener — without it the viewer never opens.
			expect((openArtifact.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ taskId: "t1", projectId: "p1" });
			expect(screen.queryByTestId("task-actions-sheet")).not.toBeInTheDocument();
			window.removeEventListener("dev3:openArtifactViewer", openArtifact);
			window.removeEventListener("dev3:openImageViewer", openImage);
		});

		it("orders the whole actions group: Full screen, status rows, runtime rows, session rows with Hibernate last", async () => {
			const sheet = await openSheet(makeTask({
				sharedArtifacts: [{
					id: "artifact-1",
					kind: "html",
					title: "Report",
					name: "report.html",
					storedPath: "/tmp/shared-artifacts/artifact-1/report.html",
					originalPath: "/tmp/report.html",
					bytes: 10,
					createdAt: 1,
					assets: [],
				}],
			}));
			const group = within(sheet).getByTestId("task-actions-fullscreen").closest(".touch-actions") as HTMLElement;
			const rows = Array.from(group.querySelectorAll("button")).map((button) => button.dataset.testid ?? button.textContent ?? "");
			expect(rows).toEqual([
				"task-actions-fullscreen",
				"Watch",
				"I’ll complete it myself",
				"Artifacts1",
				"task-actions-bug-hunters",
				"task-actions-spawn-agent",
				"task-actions-hibernate",
			]);
		});

		it("opens the Move to bottom sheet from the status chip, moves the task and closes it", async () => {
			const dispatch = vi.fn();
			const task = makeTask({ status: "in-progress" });
			const updatedTask = { ...task, status: "user-questions" as const };
			mockedApi.request.moveTask.mockResolvedValue(updatedTask);

			await act(async () => {
				renderPanel(task, { dispatch });
			});
			await act(async () => {
				fireEvent.click(screen.getByText("Agent is Working"));
			});
			// A bottom sheet, not the anchored popover.
			const statusSheet = screen.getByTestId("task-status-sheet");
			expect(within(statusSheet).getByText("Move to")).toBeInTheDocument();
			expect(within(statusSheet).getByText("Completed")).toBeInTheDocument();
			await act(async () => {
				fireEvent.click(within(statusSheet).getByText("Has Questions"));
			});

			expect(mockedApi.request.moveTask).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				newStatus: "user-questions",
				clientPlayedSound: true,
			});
			expect(dispatch).toHaveBeenCalledWith({ type: "updateTask", task: updatedTask });
			expect(screen.queryByTestId("task-status-sheet")).not.toBeInTheDocument();
		});

		it("keeps Open PR and offers Create PR in the sheet once the PR merged", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 3,
				prNumber: 42,
				prUrl: "https://github.com/test/repo/pull/42",
				prState: "MERGED",
			});
			await act(async () => {
				renderPanel(makeTask());
			});
			await act(async () => {
				fireEvent.click(screen.getByTestId("task-actions-kebab"));
			});
			const sheet = screen.getByTestId("task-actions-sheet");
			expect(within(sheet).getByText("Open PR #42")).toBeInTheDocument();
			expect(within(sheet).getByText("Create PR")).toBeInTheDocument();
			expect(within(sheet).queryByText("Merge PR")).not.toBeInTheDocument();
		});

		it("shows the wide diff badge (tap opens, no hover popover), never wraps, and keeps a compact button for narrower widths", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				diffFiles: 3,
				diffInsertions: 451,
				diffDeletions: 297,
				diffFileStats: [
					{ path: "src/a.ts", insertions: 400, deletions: 200 },
					{ path: "src/b.ts", insertions: 50, deletions: 90 },
					{ path: "src/c.ts", insertions: 1, deletions: 7 },
				],
			});
			const onOpenInlineDiff = vi.fn();
			await act(async () => {
				renderPanel(makeTask(), { onOpenInlineDiff });
			});
			// The wide badge shows once branch status loads, and a tap opens the diff.
			const badge = await screen.findByTestId("diff-summary-badge");
			expect(badge).toHaveTextContent("3 files");
			// Touch fires mouseenter on tap: that must not arm the hover file-list popover.
			await act(async () => {
				fireEvent.mouseEnter(badge);
			});
			expect(screen.queryByText("Changed files")).not.toBeInTheDocument();
			await act(async () => {
				fireEvent.click(badge);
			});
			expect(onOpenInlineDiff).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "branch" }));

			// A second row moves every control the user was aiming at, so the bar
			// never wraps: it is a container, and the badge hides below 400px.
			const classes = screen.getByTestId("task-summary-bar").className.split(/\s+/);
			expect(classes).toContain("flex-nowrap");
			expect(classes).not.toContain("flex-wrap");
			expect(classes).toContain("[container-type:inline-size]");
			expect(screen.getByTestId("summary-bar-diff-slot").className).toContain("[@container(min-width:400px)]:contents");

			const compact = await screen.findByTestId("summary-bar-diff-compact");
			// A square: no numbers at all. The bar's remaining width at 390px is one
			// icon wide, and the wide badge carries the counts from 400px up.
			expect(compact.textContent?.replace(/\s|\u{F0CB}/gu, "")).toBe("");
			expect(compact.className).toContain("min-w-[2.75rem]");
			// The two are exclusive: the compact one steps aside exactly where the
			// wide badge's container query lets the wide one in.
			expect(compact.className).toContain("[@container(min-width:400px)]:hidden");
			await act(async () => {
				fireEvent.click(compact);
			});
			expect(onOpenInlineDiff).toHaveBeenCalledWith(expect.objectContaining({ mode: "branch", pinMode: true }));
		});

		it("shows the compact diff button at every width when the diff is uncommitted-only", async () => {
			// `diffFiles` counts `<compare>...HEAD`, so a branch with no commits and a
			// dirty tree reports zero files — the wide badge renders nothing and the
			// compact button is the only path to the diff.
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 0,
				diffFiles: 0,
				diffInsertions: 0,
				diffDeletions: 0,
				diffFileStats: [],
				insertions: 12,
				deletions: 3,
			});
			const onOpenInlineDiff = vi.fn();
			await act(async () => {
				renderPanel(makeTask(), { onOpenInlineDiff });
			});
			const compact = await screen.findByTestId("summary-bar-diff-compact");
			expect(compact).toHaveTextContent("+12");
			expect(compact.className).not.toContain("[@container(min-width:400px)]:hidden");
			// The dirty totals are unbounded ("+4000 −2000" ≈ 72px), so they are
			// themselves gated: below 440px the chip is a bare square.
			const numbers = screen.getByTestId("summary-bar-diff-compact-numbers");
			expect(numbers.className).toContain("hidden");
			expect(numbers.className).toContain("[@container(min-width:440px)]:flex");
			expect(screen.queryByTestId("diff-summary-badge")).not.toBeInTheDocument();
			await act(async () => {
				fireEvent.click(compact);
			});
			expect(onOpenInlineDiff).toHaveBeenCalledWith(expect.objectContaining({ mode: "uncommitted", pinMode: true }));
		});

		it("keeps the diff off the bar when the branch has neither commits nor dirty files", async () => {
			mockedApi.request.getBranchStatus.mockResolvedValue({
				...defaultBranchStatus,
				ahead: 0,
				diffFiles: 0,
				diffInsertions: 0,
				diffDeletions: 0,
				diffFileStats: [],
				insertions: 0,
				deletions: 0,
			});
			await act(async () => {
				renderPanel(makeTask(), { onOpenInlineDiff: vi.fn() });
			});
			await waitFor(() => expect(mockedApi.request.getBranchStatus).toHaveBeenCalled());
			expect(screen.queryByTestId("summary-bar-diff-compact")).not.toBeInTheDocument();
			expect(screen.queryByTestId("diff-summary-badge")).not.toBeInTheDocument();
		});

		it("feeds the sheet's git rows from the panel-level status (enabled, one remote refresh) and Create PR dismisses it", async () => {
			await act(async () => {
				renderPanel(makeTask(), { onOpenInlineDiff: vi.fn() });
			});
			await waitFor(() => expect(mockedApi.request.getBranchStatus).toHaveBeenCalled());
			const callsBefore = mockedApi.request.getBranchStatus.mock.calls.length;
			await act(async () => {
				fireEvent.click(screen.getByTestId("task-actions-kebab"));
			});
			const sheet = screen.getByTestId("task-actions-sheet");
			// Git section header + the mutation rows are present as full-width rows.
			for (const row of ["Git", "Show Diff", "Rebase", "Push", "Create PR", "PR + auto-merge", "Merge"]) {
				expect(within(sheet).getByText(row)).toBeInTheDocument();
			}
			// Branch status (ahead: 3) loaded before the sheet opened, so Create PR
			// is enabled immediately — no "Loading branch status…" flash.
			const createPR = within(sheet).getByText("Create PR");
			expect(createPR.closest("button")).not.toBeDisabled();
			const openCalls = mockedApi.request.getBranchStatus.mock.calls.slice(callsBefore);
			expect(openCalls).toEqual([[expect.objectContaining({ taskId: "t1", refresh: true })]]);

			mockedApi.request.createPullRequest.mockResolvedValue({ delivery: { status: "delivered" } });
			await act(async () => {
				fireEvent.click(createPR);
			});
			expect(mockedApi.request.createPullRequest).toHaveBeenCalledWith(
				expect.objectContaining({ taskId: "t1", projectId: "p1", autoMerge: false }),
			);
			expect(screen.queryByTestId("task-actions-sheet")).not.toBeInTheDocument();
		});

		it("omits the git section for a virtual (Operations) project", async () => {
			await act(async () => {
				renderPanel(makeTask(), { project: { ...project, kind: "virtual" } });
			});
			await act(async () => {
				fireEvent.click(screen.getByTestId("task-actions-kebab"));
			});
			const sheet = screen.getByTestId("task-actions-sheet");
			expect(within(sheet).queryByText("Git")).not.toBeInTheDocument();
			expect(within(sheet).queryByText("Create PR")).not.toBeInTheDocument();
			expect(mockedApi.request.getBranchStatus).not.toHaveBeenCalled();
		});
	});
	describe("tight panel container", () => {
		/**
		 * The bars adapt to the PANEL's width, not the viewport's (split view makes
		 * the panel much narrower than the window), so the gate is a ResizeObserver.
		 * happy-dom ships none — stub one that reports a fixed width.
		 */
		function mockPanelWidth(width: number) {
			class StubResizeObserver {
				constructor(private cb: ResizeObserverCallback) {}
				observe(el: Element) {
					this.cb(
						[{ target: el, contentRect: { width } } as unknown as ResizeObserverEntry],
						this as unknown as ResizeObserver,
					);
				}
				unobserve() {}
				disconnect() {}
			}
			vi.stubGlobal("ResizeObserver", StubResizeObserver);
		}

		afterEach(() => vi.unstubAllGlobals());

		it("never puts label chips on the summary bar — they live in the title hover card", async () => {
			mockPanelWidth(1600);
			await act(async () => {
				renderPanel(makeTask({ labelIds: [label1.id, label2.id] }));
			});

			expect(screen.queryByText("Bug")).not.toBeInTheDocument();
			expect(screen.queryByTestId("label-strip-overflow")).not.toBeInTheDocument();
		});

		it("drops the completion-ownership label on a tight panel", async () => {
			mockPanelWidth(1000);
			await act(async () => {
				renderPanel(makeTask({ manualCompletion: true }));
			});

			expect(screen.queryByText("I’ll complete it myself")).not.toBeInTheDocument();
			// The toggle itself stays reachable — only its text label goes.
			expect(
				screen.getAllByRole("button", {
					name: "I’ll complete it myself — dev3 won’t suggest completing this task after a merge",
				}).length,
			).toBeGreaterThan(0);
		});

	});
});

describe("hibernate button", () => {
	const mockedConfirm = vi.mocked(confirm);

	// This block sits outside the top-level describe that owns the shared
	// clearAllMocks, so call history has to be reset here.
	beforeEach(() => {
		mockedConfirm.mockClear();
		mockedApi.request.hibernateTask.mockClear();
	});

	it("hibernates once confirmed", async () => {
		mockedConfirm.mockResolvedValue(true);
		const task = makeTask();
		mockedApi.request.hibernateTask.mockResolvedValue({
			task: { ...task, hibernated: true },
			freedRssBytes: null,
		});
		let view!: ReturnType<typeof renderPanel>;
		await act(async () => {
			view = renderPanel(task);
		});

		await act(async () => {
			fireEvent.click(view.getAllByTestId("task-hibernate-button")[0]);
		});

		expect(mockedApi.request.hibernateTask).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1" });
	});

	it("hides on desktop, then runs the same flow from the restore control", async () => {
		mockedConfirm.mockResolvedValue(true);
		const task = makeTask();
		mockedApi.request.hibernateTask.mockResolvedValue({ task: { ...task, hibernated: true }, freedRssBytes: null });
		syncHiddenControlsFromGlobalSettings({ simplifiedMode: false, personalHiddenControls: ["hibernate"] });
		try {
			await act(async () => {
				renderPanel(task);
			});
			expect(screen.queryByTestId("task-hibernate-button")).not.toBeInTheDocument();
			fireEvent.click(screen.getByLabelText("Show hidden controls"));
			await act(async () => {
				fireEvent.click(screen.getByRole("menuitem", { name: "Hibernate" }));
			});
			expect(mockedApi.request.hibernateTask).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1" });
		} finally {
			syncHiddenControlsFromGlobalSettings({ simplifiedMode: false, personalHiddenControls: [] });
		}
	});

	it("warns about the extra agents when the task runs more than one pane, and does nothing when declined", async () => {
		mockedConfirm.mockResolvedValue(false);
		let view!: ReturnType<typeof renderPanel>;
		await act(async () => {
			view = renderPanel(makeTask({
				sessionState: {
					panes: [
						{ agentCmd: "claude", sessionId: "s1", agentId: null, configId: null },
						{ agentCmd: "claude", sessionId: "s2", agentId: null, configId: null },
					],
				},
			}));
		});

		await act(async () => {
			fireEvent.click(view.getAllByTestId("task-hibernate-button")[0]);
		});

		expect(mockedConfirm.mock.calls[0][0].message).toContain("2 agents");
		// Declined: nothing hibernates.
		expect(mockedApi.request.hibernateTask).not.toHaveBeenCalled();
	});
});

describe("task header user layout", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		mockedApi.request.getBranchStatus.mockResolvedValue(defaultBranchStatus);
		mockedApi.request.prepareMergeCompletionPrompt.mockResolvedValue({ shouldPrompt: false, fingerprint: null });
		mockedApi.request.getResolvedProject.mockResolvedValue(project);
		syncGlobalSettingsCache({ defaultAgentId: "builtin-claude", defaultConfigId: "claude-default", taskSortOrder: "oldest-first", updateChannel: "stable" });
		setHiddenControlsForTests([]);
		setTaskHeaderLayoutForTests({});
	});

	afterEach(() => {
		setHiddenControlsForTests([]);
		setTaskHeaderLayoutForTests({});
	});

	/** The items drawn in one desktop bar, left to right, by registry id. */
	function drawn(region: string): string[] {
		const bar = document.querySelector(`[data-slot="taskHeader"][data-region="${region}"]`)!;
		return Array.from(bar.querySelectorAll<HTMLElement>(":scope > [data-slot-item]"))
			.filter((frame) => frame.firstChild)
			.map((frame) => frame.dataset.slotItem!);
	}

	async function render() {
		await act(async () => {
			renderPanel(makeTask());
		});
	}

	function openItemMenu(name: string) {
		fireEvent.contextMenu(screen.getByRole("button", { name }), { clientX: 10, clientY: 10 });
		return screen.getByRole("menu");
	}

	async function choose(name: string) {
		await act(async () => {
			fireEvent.click(screen.getByRole("menuitem", { name }));
		});
	}

	function lastSave() {
		const calls = mockedApi.request.saveGlobalSettings.mock.calls;
		return calls[calls.length - 1][0];
	}

	function savedOrder(region: string): string[] {
		return lastSave().taskHeaderLayout?.order?.[region] ?? [];
	}

	it("offers move, More, swap and hide on a bar item", async () => {
		syncHiddenControlsFromGlobalSettings({ simplifiedMode: false, personalHiddenControls: ["builtin:session.bug-hunters"] });
		await render();
		const menu = openItemMenu("Hibernate");
		expect(within(menu).getAllByRole("menuitem").map((row) => row.textContent)).toEqual([
			"Move left", "Move right", "Move to More", "Use instead of…›", "Hide",
		]);
		expect(menu).toHaveAccessibleName("Hibernate");
	});

	it("moves an item left among what is drawn, and the order survives a reload", async () => {
		await render();
		const before = drawn("session");
		const at = before.indexOf("builtin:session.hibernate");
		openItemMenu("Hibernate");
		await choose("Move left");
		const after = drawn("session");
		expect(after.indexOf("builtin:session.hibernate")).toBe(at - 1);
		const saved = lastSave();
		expect(savedOrder("session")).toContain("builtin:session.hibernate");

		cleanupAndReload(saved);
		await render();
		expect(drawn("session")).toEqual(after);
	});

	function cleanupAndReload(saved: { taskHeaderLayout?: object; hiddenControls?: string[]; personalHiddenControls?: string[]; simplifiedMode?: boolean }) {
		document.body.innerHTML = "";
		setTaskHeaderLayoutForTests({});
		setHiddenControlsForTests([]);
		syncTaskHeaderLayout(saved.taskHeaderLayout);
		syncHiddenControlsFromGlobalSettings(saved);
	}

	it("sends an item to More and shows it in the bar again from there", async () => {
		await render();
		openItemMenu("Hibernate");
		await choose("Move to More");
		expect(drawn("session")).not.toContain("builtin:session.hibernate");
		expect(lastSave().taskHeaderLayout).toEqual({ overflow: ["builtin:session.hibernate"], pinned: undefined });

		fireEvent.click(screen.getByRole("button", { name: "More" }));
		// A built-in in More keeps its bar form, its first control the menu row's focus.
		const row = within(screen.getByRole("menu")).getByRole("button", { name: "Hibernate" });
		expect(row).toHaveFocus();
		fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
		expect(screen.getAllByRole("menuitem").map((row) => row.textContent)).toEqual(["Show in bar", "Hide"]);
		await choose("Show in bar");
		expect(drawn("session")).toContain("builtin:session.hibernate");
		expect(screen.queryByRole("button", { name: "More" })).toBeNull();
		// The row and the More trigger went with the panel: focus stays in the bar.
		await waitFor(() => expect(document.activeElement?.closest('[data-region="session"]')).not.toBeNull());
	});

	it("keeps focus in the bar after hiding the last item in More", async () => {
		await render();
		openItemMenu("Hibernate");
		await choose("Move to More");
		fireEvent.click(screen.getByRole("button", { name: "More" }));
		const row = within(screen.getByRole("menu")).getByRole("button", { name: "Hibernate" });
		fireEvent.keyDown(row, { key: "F10", shiftKey: true });
		await choose("Hide");
		expect(screen.queryByRole("button", { name: "More" })).toBeNull();
		await waitFor(() => expect(document.activeElement?.closest('[data-region="session"]')).not.toBeNull());
	});

	it("uses a hidden item instead of a drawn one in one step and one write", async () => {
		syncHiddenControlsFromGlobalSettings({ simplifiedMode: false, personalHiddenControls: ["builtin:session.bug-hunters"] });
		await render();
		const at = drawn("session").indexOf("builtin:session.hibernate");
		openItemMenu("Hibernate");
		await choose("Use instead of…");
		expect(screen.getAllByRole("menuitem").map((row) => row.textContent)).toEqual(["‹Back", "Find bugs"]);
		mockedApi.request.saveGlobalSettings.mockClear();
		await choose("Find bugs");

		expect(drawn("session")).not.toContain("builtin:session.hibernate");
		expect(drawn("session").indexOf("builtin:session.bug-hunters")).toBe(at);
		expect(mockedApi.request.saveGlobalSettings).toHaveBeenCalledOnce();
		const saved = lastSave();
		expect(saved.personalHiddenControls).toEqual(["builtin:session.hibernate", "hibernate"]);
		expect(savedOrder("session").indexOf("builtin:session.bug-hunters")).toBeLessThan(savedOrder("session").indexOf("builtin:session.hibernate"));
	});

	it("hides an item; the restore control lists it under its bar and brings it back", async () => {
		await render();
		openItemMenu("Push");
		await choose("Hide");
		expect(screen.queryByRole("button", { name: "Push" })).toBeNull();
		fireEvent.click(screen.getByLabelText("Show hidden controls"));
		expect(screen.getByRole("group", { name: "Git" })).toBeInTheDocument();
		await act(async () => {
			fireEvent.click(screen.getByLabelText("Restore Push"));
		});
		expect(screen.getByRole("button", { name: "Push" })).toBeInTheDocument();
	});

	it("never offers the menu on chrome: fullscreen, collapse, worktree settings, help", async () => {
		await render();
		for (const name of ["Full screen", "Expand panel", "Worktree Config"]) {
			fireEvent.contextMenu(screen.getByRole("button", { name }), { clientX: 10, clientY: 10 });
			expect(screen.queryByRole("menu")).toBeNull();
		}
		expect(document.querySelectorAll("[data-slot-item] [aria-label='Full screen']")).toHaveLength(0);
	});

	it("is keyboard-driven: the menu key opens it on the focused item, arrows move, Escape returns focus", async () => {
		await render();
		const hibernate = screen.getByRole("button", { name: "Hibernate" });
		hibernate.focus();
		fireEvent.contextMenu(hibernate, { clientX: 0, clientY: 0 });
		const rows = within(screen.getByRole("menu")).getAllByRole("menuitem");
		expect(rows[0]).toHaveFocus();
		fireEvent.keyDown(rows[0], { key: "ArrowDown" });
		expect(rows[1]).toHaveFocus();
		fireEvent.keyDown(rows[1], { key: "Escape" });
		expect(screen.queryByRole("menu")).toBeNull();
		expect(hibernate).toHaveFocus();
	});

	it("gives touch a restore path: the narrow sheet lists hidden items as rows that bring them back", async () => {
		syncHiddenControlsFromGlobalSettings({ simplifiedMode: false, personalHiddenControls: ["builtin:git.push"] });
		mockViewport(390);
		try {
			await render();
			await act(async () => {
				fireEvent.click(screen.getByTestId("task-actions-kebab"));
			});
			const section = screen.getByTestId("task-actions-hidden-items");
			expect(section.querySelector(".touch-actions")).not.toBeNull();
			await act(async () => {
				fireEvent.click(within(section).getByRole("button", { name: "Restore Push" }));
			});
			expect(lastSave().personalHiddenControls).toEqual([]);
			expect(screen.queryByTestId("task-actions-hidden-items")).toBeNull();
		} finally {
			mockViewport(1920);
		}
	});

	it("applies the Simplify View preset through the same registry ids", async () => {
		syncHiddenControlsFromGlobalSettings({ simplifiedMode: true, personalHiddenControls: [] });
		await render();
		for (const id of ["builtin:session.bug-hunters", "builtin:session.spawn-agent", "builtin:session.send-later", "builtin:session.hibernate", "builtin:session.pane-controls"]) {
			expect(drawn("session")).not.toContain(id);
		}
		expect(drawn("runtime")).not.toContain("builtin:runtime.scripts");
	});
});
