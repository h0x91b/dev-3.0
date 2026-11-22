import type { MockInstance } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { Context } from "cordis";
import { Component, useEffect, type ReactNode } from "react";
import type { ILink, ILinkProvider, Terminal } from "ghostty-web";
import type { Project, Task } from "../../../shared/types";
import { defaultBoardViewState, withViewType } from "../../../shared/board-view-state";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import { getAppRoot, observeAppSlots } from "../root";
import { applyBuiltinPlugins, resetPluginsForTests } from "../runtime";
import BoardHost from "../../board-views/BoardHost";
import { installKanbanView } from "../../board-views/kanban";
import { resetBoardViewStateCacheForTests } from "../../board-views/useBoardViewState";
import { resetTaskVisibilityForTests } from "../../board-views/useTaskVisibility";
import { resetBoardViewCommandsForTests } from "../../board-views/view-commands";
import { resetPreviousBoardViewsForTests } from "../../board-views/BoardHost";
import CommandPaletteModal from "../../components/CommandPaletteModal";
import { BUILTIN_COMMANDS_PLUGIN } from "../../commands/builtins";
import { runCommandSafely, type CommandItem } from "../../commands/registry";
import type { AppActionContext } from "../../app-actions";
import { BUILTIN_DESTINATION_BODIES } from "../../destination-bodies/builtins";
import { DestinationBody } from "../../destination-bodies/DestinationBody";
import { SettingsCategoryPage, useRegisteredSettingsSections } from "../../settings-sections/SettingsCategoryPage";
import { ACTIVE_TASKS_SIDEBAR_ID } from "../../sidebar/builtins";
import { Sidebar } from "../../sidebar/Sidebar";
import { BUILTIN_TASK_HEADER_PLUGIN } from "../../task-header/builtins";
import { TASK_HEADER_REGIONS } from "../../task-header/registry";
import { TaskHeaderProvider, TaskHeaderRegionItems } from "../../task-header/scope";
import type { TaskSessionController } from "../../task-header/useTaskSession";
import type { TaskBranchStatusController } from "../../components/task-info-panel/useTaskBranchStatus";
import { BUILTIN_TASK_MARKERS_PLUGIN } from "../../task-markers/builtins";
import { TaskMarkers, TaskMarkersProvider } from "../../task-markers/TaskMarkers";
import TaskContextMenu from "../../components/TaskContextMenu";
import { BUILTIN_TASK_MENU_PLUGIN } from "../../task-menu/builtins";
import TaskDock from "../../task-panels/TaskDock";
import TaskPanelInstances from "../../task-panels/TaskPanelInstances";
import { getTaskDock, openTaskPanel, resetTaskDocksForTests } from "../../task-panels/dock-store";
import { FILE_EXPLORER_COMPANION_ID } from "../../terminal-companion/builtins";
import { TerminalCompanion } from "../../terminal-companion/TerminalCompanion";
import { _resetFileExplorerPrefs, setFileExplorerMode } from "../../file-explorer-prefs";
import { installTerminalLinks, type TerminalLinksHandle } from "../../terminal-links/host";
import type { TerminalLinkInstance } from "../../terminal-links/registry";
import TerminalWindowNav from "../../components/TerminalWindowNav";
import { BUILTIN_TERMINAL_TAB_DECORATIONS_PLUGIN } from "../../terminal-tab-decorations/builtins";
import { resetDecorationFailuresForTests } from "../../terminal-tab-decorations/registry";
import { notifyTmuxWindowsChanged } from "../../terminal-window-nav";
import type { TmuxWindowEntry } from "../../../shared/types";
import { importAppSlots } from "./app-slots";
import { BUILTIN_FILE_MENU_PLUGIN } from "../../file-menu/builtins";
import { BUILTIN_TERMINAL_WINDOW_MENU_PLUGIN } from "../../terminal-window-menu/builtins";

vi.mock("../../rpc", () => ({
	isElectrobun: false,
	api: {
		request: {
			getAgents: vi.fn().mockResolvedValue([]),
			getProjectPRs: vi.fn().mockResolvedValue([]),
			getTaskLineage: vi.fn().mockResolvedValue({ nodes: [] }),
			getEpics: vi.fn().mockResolvedValue({ version: 1, epics: [] }),
			getEpicMembers: vi.fn().mockResolvedValue([]),
			getBoardViewState: vi.fn(),
			setBoardViewState: vi.fn(async ({ state }) => state),
			getBoardFilterState: vi.fn().mockResolvedValue({ visibility: "all" }),
			setBoardFilterState: vi.fn(async ({ state }) => state),
			getGlobalSettings: vi.fn().mockResolvedValue({ taskSortOrder: "oldest-first" }),
			tmuxWindowNavigate: vi.fn(),
			listExplorerDirectory: vi.fn(),
		},
	},
}));
vi.mock("../../analytics", () => ({ trackEvent: vi.fn(), agentNameFromId: vi.fn(() => "unknown") }));
// The hosts are under test, not the built-in bodies inside them: each stand-in only proves it is still drawn.
vi.mock("../../board-views/kanban/KanbanView", () => ({ KanbanView: () => <div data-testid="kanban" /> }));
vi.mock("../../components/ActiveTasksSidebar", () => ({ default: () => <div data-testid="active-tasks" /> }));
vi.mock("../../components/Changelog", () => ({ default: () => <div data-testid="body-changelog" /> }));
vi.mock("../../components/FileExplorer", () => ({ default: () => <div data-testid="explorer" />, ExplorerRailGlyph: () => null }));

// The terminalCompanion row needs the explorer stubbed; the fileMenu rows need the real one.
const { default: RealFileExplorer } = await vi.importActual<typeof import("../../components/FileExplorer")>("../../components/FileExplorer");

/** Anything that reaches it escaped the slot: the host surface itself went down. */
class EscapeBoundary extends Component<{ children: ReactNode }, { escaped: boolean }> {
	state = { escaped: false };
	static getDerivedStateFromError() {
		return { escaped: true };
	}
	render() {
		return this.state.escaped ? <div data-testid="escaped" /> : this.props.children;
	}
}

function mount(ui: ReactNode) {
	return render(
		<I18nProvider>
			<EscapeBoundary>{ui}</EscapeBoundary>
		</I18nProvider>,
	);
}

async function settle(): Promise<void> {
	for (let tick = 0; tick < 50; tick++) await act(async () => {});
}

const boom = (): never => {
	throw new Error("contribution boom");
};
const Boom = () => boom();

let user: UserEvent;
let errors: MockInstance<typeof console.error>;
const menuClose = vi.fn();

/** The console lines that mention `text`: how a guard proves it caught the throw. */
const logged = (text: string) => errors.mock.calls.filter((call) => call.some((arg) => String(arg).includes(text)));

const task = { id: "t1", projectId: "p1", title: "Task", description: "Task", status: "in-progress", branchName: "feat/x", worktreePath: "/tmp/wt", terminalBackend: "native" } as Task;
const project = { id: "p1", name: "Project", path: "/tmp/p1", labels: [], setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "2025-01-01T00:00:00Z" } as unknown as Project;
const git = {
	baseBranch: "main",
	branchStatus: {
		ahead: 2, behind: 0, insertions: 3, deletions: 1, canRebase: true, hasRemote: true, remoteIsGitHub: true, remoteAhead: 0,
		prNumber: null, prUrl: null, prState: null, diffFiles: 1, diffInsertions: 3, diffDeletions: 1, diffFileStats: [],
	},
	prStatus: null, compareRef: "", displayRef: "origin/main", mergeRoute: "local",
	handleCommit: vi.fn(), handleCreatePR: vi.fn(), handleMerge: vi.fn(), handleOpenPR: vi.fn(), handlePush: vi.fn(),
	handleRebase: vi.fn(), handleRefreshStatus: vi.fn(), refreshStatusQuietly: vi.fn(), selectCompareRef: vi.fn(),
	committing: false, creatingPR: false, merging: false, pushing: false, rebasing: false, refreshingStatus: false,
	localMergeBlocked: false, statusError: null, statusLoading: false,
} as unknown as TaskBranchStatusController;

/** One throwing contribution, on one slot's real host surface. */
interface CrashCase {
	slot: string;
	/** Which of the contribution's callbacks throws. */
	callback: string;
	builtins?: Parameters<typeof applyBuiltinPlugins>[1];
	contribute(ctx: Context): void;
	render(): void;
	/** Drives the surface into calling the callback, when rendering alone does not. */
	interact?(): Promise<void>;
	/** The host's own content, still drawn. */
	alive(): Promise<void> | void;
	/** Part of the line the guard logs: a throw in an event handler never reaches a boundary, so this is the proof. */
	logs?: string;
	/** Renders at phone width. */
	narrow?: boolean;
}

function LiveSettingsPage() {
	return <SettingsCategoryPage region="projectSettings.global" sections={useRegisteredSettingsSections()} />;
}

const settingsSection = (id: string, component: () => ReactNode) => ({ id, region: "projectSettings.global" as const, order: 0, entries: [], component });

/** A terminal that installs the `terminalLinks` slot on mount, as TerminalView does. */
let links: TerminalLinksHandle | null = null;
let linkProvider: ILinkProvider | null = null;

function LinkTerminal() {
	useEffect(() => {
		const term = {
			registerLinkProvider: (provider: ILinkProvider) => {
				linkProvider = provider;
			},
			buffer: { active: { getLine: () => undefined, length: 0 } },
			rows: 24,
		} as unknown as Terminal;
		const env = { term, container: document.createElement("div"), taskId: "t1", projectId: "p1", t: () => ((key: string) => key) as never, osc8UriFor: () => undefined, requestUnderlineRedraw: () => {} };
		links = installTerminalLinks(env);
		return () => links?.dispose();
	}, []);
	return <div data-testid="terminal" />;
}

const linksAt = () => new Promise<string[] | undefined>((resolve) => linkProvider!.provideLinks(0, (found) => resolve(found?.map((l) => l.text))));
const fineLink: ILink = { text: "fine", range: { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }, activate: () => {} };
const fineLinks: TerminalLinkInstance = {
	provider: { provideLinks: (_y, callback) => callback([fineLink]) },
	underlines: () => [{ start: { x: 0, y: 3 }, end: { x: 2, y: 3 } }],
	touchAt: () => ({ kind: "web", target: "https://fine", open: () => {} }) as never,
	refAt: () => "dev3://seq/1",
};

const CASES: CrashCase[] = [
	{
		slot: "boardViews",
		callback: "component",
		builtins: [],
		contribute(ctx) {
			ctx.boardViews.register({ id: "crash:view", label: "crash", component: Boom, supportsNarrow: true });
		},
		render() {
			installKanbanView(getAppRoot());
			vi.mocked(api.request.getBoardViewState).mockResolvedValue(withViewType(defaultBoardViewState(), "wide", "crash:view"));
			mount(<BoardHost project={project} tasks={[]} dispatch={vi.fn()} navigate={vi.fn()} bellCounts={new Map()} taskPorts={new Map()} taskDevServers={new Map()} />);
		},
		async alive() {
			expect(await screen.findByTestId("kanban")).toBeInTheDocument();
			expect(screen.getByRole("alert")).toBeInTheDocument();
		},
	},
	...(["when", "run"] as const).map((callback): CrashCase => ({
		slot: "commands",
		callback,
		builtins: [BUILTIN_COMMANDS_PLUGIN],
		contribute(ctx) {
			ctx.commands.register({
				id: "crash:command", order: 0, labelKey: "command.boardView", labelVars: { name: "Crash probe" }, category: "nav", scope: "always",
				...(callback === "when" ? { when: boom } : {}), run: boom,
			});
		},
		render() {
			// App hands the palette's pick to runCommandSafely.
			const onRun = (command: CommandItem) => runCommandSafely(command, {} as AppActionContext);
			mount(<CommandPaletteModal context={{ hasProject: true, hasTask: true }} onRun={onRun} onClose={vi.fn()} />);
		},
		async interact() {
			if (callback !== "run") return;
			await user.type(screen.getByRole("textbox"), "Crash probe");
			await user.keyboard("{Enter}");
			await user.clear(screen.getByRole("textbox"));
		},
		async alive() {
			await user.type(screen.getByRole("textbox"), "Theme");
			expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
		},
		logs: callback === "run" ? "[commands] crash:command failed" : "crash:command",
	})),
	{
		slot: "destinationBodies",
		callback: "component",
		contribute(ctx) {
			ctx.destinationBodies.register({ id: BUILTIN_DESTINATION_BODIES.changelog.id, region: "changelog", component: Boom });
		},
		render() {
			mount(<DestinationBody destination="changelog" props={{ navigate: vi.fn(), goBack: vi.fn(), canGoBack: false }} />);
		},
		alive() {
			expect(screen.getByTestId("body-changelog")).toBeInTheDocument();
		},
	},
	...(["builtin", "extension"] as const).map((origin): CrashCase => ({
		slot: "settingsSections",
		callback: `component (${origin})`,
		contribute(ctx) {
			ctx.settingsSections.register(settingsSection("builtin:fine", () => <p>fine section</p>));
			ctx.settingsSections.register(settingsSection(origin === "builtin" ? "builtin:crash" : "crash:section", Boom));
		},
		render() {
			mount(<LiveSettingsPage />);
		},
		alive() {
			expect(screen.getByText("fine section")).toBeInTheDocument();
		},
	})),
	{
		slot: "sidebar",
		callback: "component",
		contribute(ctx) {
			ctx.sidebar.register({ id: ACTIVE_TASKS_SIDEBAR_ID, component: Boom });
		},
		render() {
			mount(<Sidebar activeTaskId="t1" dispatch={vi.fn()} navigate={vi.fn()} agents={[]} bellCounts={new Map()} taskPorts={new Map()} />);
		},
		alive() {
			expect(screen.getByTestId("active-tasks")).toBeInTheDocument();
		},
	},
	...(["component", "when"] as const).map((callback): CrashCase => ({
		slot: "taskHeader",
		callback,
		builtins: [BUILTIN_TASK_HEADER_PLUGIN],
		contribute(ctx) {
			for (const region of ["status", "git", "status.diff", "git.actions"] as const) {
				ctx.taskHeader.register({
					id: `builtin:${region}.crash`, region, order: -1,
					component: callback === "component" ? Boom : () => null,
					...(callback === "when" ? { when: boom } : {}),
				});
			}
		},
		render() {
			mount(
				<TaskHeaderProvider
					value={{
						scope: { task, project, dispatch: vi.fn(), navigate: vi.fn() },
						layout: { compact: false, tight: false, collapsed: true, narrow: false },
						isTaskActive: true, git, session: {} as TaskSessionController, closeSheet: vi.fn(), variants: [],
					}}
				>
					{TASK_HEADER_REGIONS.filter((region) => region !== "runtime" && region !== "session").map((region) => (
						<TaskHeaderRegionItems key={region} region={region} surface="bar" />
					))}
				</TaskHeaderProvider>,
			);
		},
		alive() {
			expect(screen.getByTestId("branch-chip")).toBeInTheDocument();
			expect(screen.getByTestId("diff-summary-badge")).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Push" })).toBeInTheDocument();
		},
	})),
	...(["component", "when"] as const).map((callback): CrashCase => ({
		slot: "taskMarkers",
		callback,
		builtins: [BUILTIN_TASK_MARKERS_PLUGIN],
		contribute(ctx) {
			ctx.taskMarkers.register({ id: "builtin:crash", when: callback === "when" ? boom : () => true, label: () => "crash", component: Boom });
		},
		render() {
			mount(
				<TaskMarkersProvider>
					<TaskMarkers task={task} surface="card" />
				</TaskMarkersProvider>,
			);
		},
		alive() {
			expect(screen.getByTestId("task-card-native-backend")).toBeInTheDocument();
		},
	})),
	...(["when", "label", "run", "submenu.flyout", "submenu.sheet"] as const).map((callback): CrashCase => ({
		slot: "taskMenu",
		callback,
		builtins: [BUILTIN_TASK_MENU_PLUGIN],
		narrow: callback === "submenu.sheet",
		contribute(ctx) {
			const base = {
				id: "crash:item", region: "open" as const,
				label: callback === "label" ? boom : () => "Crash item",
				...(callback === "when" ? { when: boom } : {}),
			};
			ctx.taskMenu.register(
				callback.startsWith("submenu")
					? { ...base, submenu: { flyout: callback === "submenu.flyout" ? boom : () => null, sheet: callback === "submenu.sheet" ? boom : () => null } }
					: { ...base, run: boom },
			);
		},
		render() {
			mount(<TaskContextMenu task={task} project={project} dispatch={vi.fn()} pos={{ x: 0, y: 0 }} onClose={menuClose} onOpenTask={vi.fn()} />);
		},
		async interact() {
			if (callback === "run" || callback.startsWith("submenu")) await user.click(screen.getByTestId("task-menu-crash:item"));
		},
		alive() {
			// run and the phone sheet close the menu first, as for any such row; the rest leave it open.
			if (callback === "run") expect(menuClose).toHaveBeenCalledTimes(1);
			else if (callback !== "submenu.sheet") expect(screen.getByTestId("task-menu-open")).toBeInTheDocument();
			if (callback === "submenu.flyout") expect(screen.getByTestId("task-menu-flyout-crash:item")).toBeInTheDocument();
		},
		logs: {
			when: '[taskMenu] "crash:item" failed to resolve',
			label: '[taskMenu] "crash:item" failed to resolve',
			run: '[taskMenu] "crash:item" failed',
			"submenu.flyout": "[slots] taskMenu item crash:item crashed",
			"submenu.sheet": "[slots] taskMenu item crash:item crashed",
		}[callback],
	})),
	...(["component", "title"] as const).map((callback): CrashCase => ({
		slot: "taskPanels",
		callback,
		contribute(ctx) {
			ctx.taskPanels.register({ id: "fine:panel", order: 1, title: () => "fine", component: () => <div data-testid="fine-panel" /> });
			ctx.taskPanels.register({ id: "crash:panel", order: 2, title: callback === "title" ? boom : () => "crash", component: callback === "component" ? Boom : () => <div /> });
		},
		render() {
			mount(
				<>
					<TaskPanelInstances tasks={[]} />
					<div className="flex"><TaskDock taskId="t1" covered={false} canDock /></div>
				</>,
			);
			act(() => {
				openTaskPanel("t1", "fine:panel");
				openTaskPanel("t1", "crash:panel");
			});
		},
		alive() {
			const strip = screen.getByRole("tablist");
			expect(within(strip).getByRole("tab", { name: /fine/ })).toBeInTheDocument();
			fireEvent.click(within(strip).getByRole("tab", { name: /fine/ }));
			expect(screen.getByTestId("fine-panel")).toBeInTheDocument();
			if (callback !== "title") return;
			// The crashed title falls back to the panel id, re-renders without logging again, and stays closable.
			expect(within(strip).getByRole("tab", { name: /crash:panel/ })).toBeInTheDocument();
			expect(logged("title() of task panel crash:panel threw")).toHaveLength(1);
			fireEvent.click(within(strip).getByRole("button", { name: "Close crash:panel" }));
			expect(getTaskDock("t1").open).toEqual(["fine:panel"]);
		},
		logs: callback === "title" ? "title() of task panel crash:panel threw" : "crash:panel",
	})),
	...(["create", "provideLinks", "underlines", "touchAt", "refAt", "dispose"] as const).map((callback): CrashCase => ({
		slot: "terminalLinks",
		callback,
		contribute(ctx) {
			const crash: TerminalLinkInstance = {
				provider: { provideLinks: (_y, cb) => (callback === "provideLinks" ? boom() : cb(undefined)) },
				underlines: callback === "underlines" ? boom : () => [],
				touchAt: callback === "touchAt" ? boom : () => undefined,
				refAt: callback === "refAt" ? boom : () => undefined,
				dispose: callback === "dispose" ? boom : () => {},
			};
			ctx.terminalLinks.register({ id: "crash:links", order: 1, create: () => (callback === "create" ? boom() : crash) });
			ctx.terminalLinks.register({ id: "fine:links", order: 2, create: () => fineLinks });
		},
		render() {
			mount(<LinkTerminal />);
		},
		async interact() {
			// Twice each: a broken provider is logged once per callback, not once per call.
			for (let round = 0; round < 2; round++) {
				await linksAt();
				links!.underlinesForRows([3]);
				links!.touchLinkAt(0, 0);
				links!.refAt(0, 0);
			}
			// A slot change rebuilds every provider, disposing the old instances.
			if (callback === "dispose") getAppRoot().plugin({ name: "late-links", inject: ["terminalLinks"], apply: (c: Context) => void c.terminalLinks.register({ id: "late:links", order: 3, create: () => ({}) }) });
			await settle();
		},
		async alive() {
			expect(screen.getByTestId("terminal")).toBeInTheDocument();
			expect(await linksAt()).toEqual(["fine"]);
			expect(links!.underlinesForRows([3])).toEqual([{ start: { x: 0, y: 3 }, end: { x: 2, y: 3 } }]);
			expect(links!.touchLinkAt(0, 0)).toMatchObject({ target: "https://fine" });
			expect(links!.refAt(0, 0)).toBe("dev3://seq/1");
			expect(logged(`[terminalLinks] crash:links ${callback} failed`)).toHaveLength(1);
		},
		logs: `[terminalLinks] crash:links ${callback} failed`,
	})),
	...(["when", "label", "render"] as const).map((callback): CrashCase => ({
		slot: "terminalTabDecorations",
		callback,
		builtins: [BUILTIN_TERMINAL_TAB_DECORATIONS_PLUGIN],
		contribute(ctx) {
			ctx.terminalTabDecorations.register({
				id: "crash:decoration",
				when: callback === "when" ? boom : () => true,
				label: callback === "label" ? boom : () => "crash",
				component: callback === "render" ? Boom : () => <span data-testid="crash-decoration" />,
			});
		},
		render() {
			resetDecorationFailuresForTests();
			const win = (index: number, extra: Partial<TmuxWindowEntry>): TmuxWindowEntry => ({ windowId: `@${index}`, index, label: `w${index}`, active: false, home: false, panes: 1, activity: 100, bell: false, ...extra });
			vi.mocked(api.request.tmuxWindowNavigate).mockResolvedValue({ windows: [win(1, { active: true, home: true }), win(2, { bell: true }), win(3, { bell: true })] } as never);
			mount(
				<TerminalWindowNav taskId="t1">
					<div data-testid="terminal" />
				</TerminalWindowNav>,
			);
		},
		async interact() {
			// Re-reads redraw every tab: a broken decoration is logged once per callback, not once per tab or poll.
			for (let round = 0; round < 2; round++) {
				await act(async () => {
					notifyTmuxWindowsChanged("t1");
				});
				await settle();
			}
		},
		async alive() {
			expect(screen.getByTestId("terminal")).toBeInTheDocument();
			expect(await screen.findAllByRole("tab")).toHaveLength(3);
			expect(document.querySelectorAll('[data-window-marker="bell"]')).toHaveLength(2);
			expect(screen.getByRole("tab", { name: "w2, bell" })).toBeInTheDocument();
			expect(screen.queryAllByTestId("crash-decoration")).toHaveLength(0);
			expect(logged(`${callback} of terminal tab decoration crash:decoration threw`)).toHaveLength(1);
		},
		logs: `${callback} of terminal tab decoration crash:decoration threw`,
	})),
	...(["when", "label", "icon", "run"] as const).map((callback): CrashCase => ({
		slot: "fileMenu",
		callback,
		builtins: [BUILTIN_FILE_MENU_PLUGIN],
		contribute(ctx) {
			ctx.fileMenu.register({
				id: "crash:item",
				region: "open",
				when: callback === "when" ? boom : () => true,
				label: callback === "label" ? boom : () => "Crash item",
				icon: callback === "icon" ? Boom : undefined,
				run: boom,
			});
		},
		render() {
			const readme = { name: "README.md", path: "/wt/README.md", relPath: "README.md", kind: "file", ignored: false };
			vi.mocked(api.request.listExplorerDirectory).mockImplementation((async ({ relPath }: { relPath?: string }) => ({ root: "/wt", relPath: relPath ?? "", entries: relPath ? [] : [readme] })) as never);
			mount(<RealFileExplorer projectId="p1" taskId="t1" rootLabel="branch" pinned onTogglePin={vi.fn()} onHide={vi.fn()} />);
		},
		async interact() {
			fireEvent.contextMenu(await screen.findByRole("treeitem", { name: /README\.md/ }));
			if (callback === "run" || callback === "icon") await user.click(screen.getByRole("menuitem", { name: "Crash item" }));
		},
		alive() {
			expect(screen.getByRole("treeitem", { name: /README\.md/ })).toBeInTheDocument();
			// run closes the menu first, as for any row; the rest leave it open with dev3's rows.
			if (callback !== "run" && callback !== "icon") expect(screen.getByRole("menuitem", { name: "Copy path" })).toBeInTheDocument();
		},
		logs: {
			when: '[fileMenu] "crash:item" failed to resolve',
			label: '[fileMenu] "crash:item" failed to resolve',
			icon: "[slots] fileMenu item crash:item crashed",
			run: '[fileMenu] "crash:item" failed',
		}[callback],
	})),
	...(["when", "label", "run"] as const).map((callback): CrashCase => ({
		slot: "terminalWindowMenu",
		callback,
		builtins: [BUILTIN_TERMINAL_WINDOW_MENU_PLUGIN],
		contribute(ctx) {
			ctx.terminalWindowMenu.register({
				id: "crash:item",
				region: "window",
				when: callback === "when" ? boom : () => true,
				label: callback === "label" ? boom : () => "Crash item",
				run: boom,
			});
		},
		render() {
			const win = (index: number, extra: Partial<TmuxWindowEntry>): TmuxWindowEntry => ({ windowId: `@${index}`, index, label: `w${index}`, active: false, home: false, panes: 1, activity: 100, bell: false, ...extra });
			vi.mocked(api.request.tmuxWindowNavigate).mockResolvedValue({ windows: [win(1, { active: true, home: true }), win(2, {})] } as never);
			mount(
				<TerminalWindowNav taskId="t1">
					<div data-testid="terminal" />
				</TerminalWindowNav>,
			);
		},
		async interact() {
			fireEvent.contextMenu(await screen.findByRole("tab", { name: "w2" }));
			if (callback === "run") await user.click(screen.getByRole("menuitem", { name: "Crash item" }));
		},
		alive() {
			expect(screen.getByTestId("terminal")).toBeInTheDocument();
			expect(screen.getAllByRole("tab")).toHaveLength(2);
			if (callback !== "run") expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
		},
		logs: {
			when: '[terminalWindowMenu] "crash:item" failed to resolve',
			label: '[terminalWindowMenu] "crash:item" failed to resolve',
			run: '[terminalWindowMenu] "crash:item" failed',
		}[callback],
	})),
	{
		slot: "terminalCompanion",
		callback: "component",
		contribute(ctx) {
			ctx.terminalCompanion.register({ id: FILE_EXPLORER_COMPANION_ID, component: Boom });
		},
		render() {
			_resetFileExplorerPrefs();
			setFileExplorerMode("pinned");
			mount(
				<TerminalCompanion projectId="p1" taskId="t1" rootLabel="branch" enabled>
					<div data-testid="terminal" />
				</TerminalCompanion>,
			);
		},
		alive() {
			expect(screen.getByTestId("terminal")).toBeInTheDocument();
			expect(screen.getByTestId("explorer")).toBeInTheDocument();
		},
	},
];

beforeAll(importAppSlots, 30_000);

const innerWidth = window.innerWidth;
const matchMedia = window.matchMedia;

function setPhoneWidth() {
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
	window.matchMedia = ((query: string) => ({ ...matchMedia(query), matches: query.includes("max-width") })) as typeof window.matchMedia;
}

beforeEach(() => {
	user = userEvent.setup();
	menuClose.mockClear();
	errors = vi.spyOn(console, "error").mockImplementation(() => {});
	resetPluginsForTests();
	resetBoardViewStateCacheForTests();
	resetTaskVisibilityForTests();
	resetBoardViewCommandsForTests();
	resetPreviousBoardViewsForTests();
	resetTaskDocksForTests();
	localStorage.clear();
	vi.mocked(api.request.getBoardViewState).mockResolvedValue(defaultBoardViewState());
});

afterEach(() => {
	vi.restoreAllMocks();
	Object.defineProperty(window, "innerWidth", { configurable: true, value: innerWidth });
	window.matchMedia = matchMedia;
});

describe("slot crash escape", () => {
	it("throws from every slot on the app root", () => {
		const slots = new Set<string>();
		getAppRoot();
		observeAppSlots((slot) => slots.add(slot.name));
		expect([...new Set(CASES.map((c) => c.slot))].sort()).toEqual([...slots].sort());
	});

	it.each(CASES.map((c) => [c.slot, c.callback, c] as const))("%s: a throwing %s never takes down the host surface", async (_slot, _callback, crash) => {
		if (crash.narrow) setPhoneWidth();
		const uncaught: unknown[] = [];
		const onError = (event: ErrorEvent) => uncaught.push(event.error);
		window.addEventListener("error", onError);
		if (crash.builtins) applyBuiltinPlugins([], crash.builtins);
		getAppRoot().plugin({ name: "crashing", inject: [crash.slot], apply: (ctx: Context) => crash.contribute(ctx) });
		await settle();
		crash.render();
		await settle();
		await crash.interact?.();
		await waitFor(() => expect(screen.queryByTestId("escaped")).toBeNull());
		await crash.alive();
		expect(screen.queryByTestId("escaped")).toBeNull();
		window.removeEventListener("error", onError);
		expect(uncaught).toEqual([]);
		if (crash.logs) expect(logged(crash.logs).length, `no "${crash.logs}" in the console`).toBeGreaterThan(0);
	});
});
