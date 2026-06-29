import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useAppState, routeTaskId, projectIdForRoute, routeAfterTaskClosed, type Route } from "./state";
import { api, isElectrobun } from "./rpc";
import { showWebNotificationOrToast, type WebNotificationDetail } from "./utils/webNotification";
import { useT, useLocale } from "./i18n";
import { handleMenuAction } from "./menuRouter";
import { trackPageView, trackEvent, registerAgents } from "./analytics";
import type { CodingAgent, GlobalSettings as GlobalSettingsType, Project, RemoteNetInterface, RequirementCheckResult, Task, TaskStatus } from "../shared/types";
import { orderProjectsForDisplay } from "../shared/types";
import { useGlobalShortcut } from "./hooks/useGlobalShortcut";
import { isRemote } from "./utils/platform";
import { adjustZoom, applyZoom, ZOOM_STEP, DEFAULT_ZOOM } from "./zoom";
import { useViewport } from "./hooks/useViewport";
import GlobalHeader from "./components/GlobalHeader";
import AppMenuBar from "./components/AppMenuBar";
import GlobalSettings from "./components/GlobalSettings";
import Dashboard from "./components/Dashboard";
import AddProjectModal from "./components/AddProjectModal";
import CreateTaskModal from "./components/CreateTaskModal";
import LaunchVariantsModal from "./components/LaunchVariantsModal";
import ProjectView from "./components/ProjectView";
import TaskWorkspaceView from "./components/TaskWorkspaceView";
import ProjectTerminal from "./components/ProjectTerminal";
import ProjectSettings from "./components/ProjectSettings";
import RequirementsCheck from "./components/RequirementsCheck";
import GhWarningBanner, { isGhWarningDismissed } from "./components/GhWarningBanner";
import Changelog from "./components/Changelog";
import GaugeDemo from "./components/gauges/GaugeDemo";
import ProductivityStatsView from "./components/ProductivityStatsView";
import ViewportLab from "./components/ViewportLab";
import { ToastHost, toast } from "./toast";
import StuckPreparationPopover from "./components/StuckPreparationPopover";
import FolderPickerHost from "./components/FolderPickerModal";
import KeyboardShortcutsModal, { type ShortcutsTab } from "./components/KeyboardShortcutsModal";
import RemoteAccessExposedPorts from "./components/RemoteAccessExposedPorts";
import { ConfirmHost, confirm } from "./confirm";
import AboutModal from "./components/AboutModal";
import { initTaskSoundPlayback, playTaskSoundFromPush, setTaskCompletionSoundEnabled } from "./task-sounds";
import { runMergeCompletionPromptOnce } from "./utils/mergeCompletionPrompt";
import { getRecentProjectIds, orderByRecency, recordProjectJump } from "./utils/recentProjects";
import type { NavigationGuard } from "./navigation-guard";
import { useTaskSwitcher } from "./hooks/useTaskSwitcher";
import TaskSwitcherOverlay from "./components/TaskSwitcherOverlay";
import ProjectQuickSwitchModal from "./components/ProjectQuickSwitchModal";
import CommandPaletteModal from "./components/CommandPaletteModal";
import HintOverlay from "./components/HintOverlay";

/**
 * True when keystrokes should go to a focused field or the terminal rather than
 * trigger a bare-key shortcut (used to gate the Vimium-style hint hotkey).
 */
function isTypingContext(): boolean {
	const el = document.activeElement as HTMLElement | null;
	if (!el) return false;
	const tag = el.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	if (el.isContentEditable) return true;
	if (el.closest('[data-terminal="true"]')) return true;
	return false;
}

/** Parse a 1–9 project index from a physical digit code (`"Digit3"` → 3), layout-independent. */
function digitFromCode(code: string): number | null {
	const m = /^Digit([1-9])$/.exec(code);
	return m ? Number(m[1]) : null;
}

/** First on-screen search input (board label filter, sidebar search), for the bare `/` shortcut. */
function findVisibleSearchInput(): HTMLElement | null {
	for (const el of document.querySelectorAll<HTMLElement>('[data-search-input="true"]')) {
		const r = el.getBoundingClientRect();
		if (r.width > 0 && r.height > 0) return el;
	}
	return null;
}

function App() {
	const [state, dispatch] = useAppState();
	const t = useT();
	const [, setLocale] = useLocale();
	useViewport(state.route);

	// Listen for menu actions routed from the bun side. Any menu item that the
	// renderer is responsible for arrives here as `rpc:menuAction` with
	// `{ action: <string> }`. The router in `menuRouter.ts` handles dispatch.
	useEffect(() => {
		function onMenuAction(e: Event) {
			const detail = (e as CustomEvent).detail;
			if (!detail?.action) return;
			handleMenuAction(detail.action, { state, dispatch, setLocale }).catch((err) => {
				console.error("[App] handleMenuAction failed", err);
			});
		}
		window.addEventListener("rpc:menuAction", onMenuAction);
		return () => window.removeEventListener("rpc:menuAction", onMenuAction);
	}, [state, dispatch, setLocale]);

	// Unified keyboard-shortcuts overlay (App + Terminal tabs).
	//  - Help > Keyboard Shortcuts / ⌘/      → App tab
	//  - Help/Terminal > Show Tmux Cheat Sheet → Terminal tab
	const [shortcutsModal, setShortcutsModal] = useState<{ open: boolean; tab: ShortcutsTab }>({
		open: false,
		tab: "app",
	});
	useEffect(() => {
		function onShowTmux() { setShortcutsModal({ open: true, tab: "terminal" }); }
		function onShowKeyboard() { setShortcutsModal({ open: true, tab: "app" }); }
		window.addEventListener("menu:show-tmux-cheat-sheet", onShowTmux);
		window.addEventListener("menu:show-keyboard-shortcuts", onShowKeyboard);
		return () => {
			window.removeEventListener("menu:show-tmux-cheat-sheet", onShowTmux);
			window.removeEventListener("menu:show-keyboard-shortcuts", onShowKeyboard);
		};
	}, []);

	// Context that drives which menu items apply, derived from the current route.
	// Used both to grey out native-menu items (pushed to bun below) and to build
	// the browser-mode React menu bar (`AppMenuBar`).
	const menuContext = useMemo(() => {
		const r = state.route;
		const hasProject = r.screen === "project" || r.screen === "task" || r.screen === "project-terminal" || r.screen === "project-settings";
		const hasTask = r.screen === "task" || (r.screen === "project" && Boolean(r.activeTaskId));
		const hasTerminal = r.screen === "task" || r.screen === "project-terminal";
		return { hasTask, hasProject, hasTerminal };
	}, [state.route]);

	// Push the current MenuContext to the bun side on every route change so the
	// native menu can grey out task / project / terminal items that don't apply.
	useEffect(() => {
		try {
			void api.request.updateMenuContext?.(menuContext)?.catch(() => {});
		} catch {
			// In tests `api.request` is mocked without this method; safe to ignore.
		}
	}, [menuContext]);

	// Quit dialog
	const [showQuitDialog, setShowQuitDialog] = useState(false);
	const [dontShowAgain, setDontShowAgain] = useState(false);

	// The bun `before-quit` gate asks us to confirm before the app actually quits
	// (Cmd+Q, menu Quit, dock Quit). We just open the dialog; the real quit
	// happens when the user confirms via `quitApp`.
	useEffect(() => {
		function onShowQuitDialog() {
			setDontShowAgain(false);
			setShowQuitDialog(true);
		}
		window.addEventListener("rpc:showQuitDialog", onShowQuitDialog);
		return () => window.removeEventListener("rpc:showQuitDialog", onShowQuitDialog);
	}, []);

	// If this window was reopened solely to host the quit dialog (a quit was
	// requested while the app sat window-less in the dock), pull the pending flag
	// on mount and show the dialog. Pulling (rather than the gate pushing) avoids
	// racing this window's not-yet-registered `rpc:showQuitDialog` listener.
	useEffect(() => {
		api.request
			.consumePendingQuitDialog()
			.then((pending) => {
				if (pending) {
					setDontShowAgain(false);
					setShowQuitDialog(true);
				}
			})
			.catch(() => {});
	}, []);

	// About dialog (opened from the native menu's "About" item via rpc:showAbout)
	const [aboutVersion, setAboutVersion] = useState<string | null>(null);

	// Silent update indicator
	const [updateVersion, setUpdateVersion] = useState<string | null>(null);
	// Download progress: null = idle, "checking" | "downloading" | "error"
	const [updateDownloadStatus, setUpdateDownloadStatus] = useState<string | null>(null);
	const updateStatusShownAtRef = useRef<number>(0);
	const updateClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Remote access QR code modal
	const [remoteQR, setRemoteQR] = useState<{ qrDataUrl: string; accessUrl: string; tunnelState: string; cloudflaredInstalled: boolean; interfaces?: RemoteNetInterface[]; selectedHost?: string } | null>(null);
	const [tunnelWanted, setTunnelWanted] = useState(false);
	const [tunnelStarting, setTunnelStarting] = useState(false);

	// System requirements gate
	const [reqStatus, setReqStatus] = useState<"checking" | "failed" | "passed">("checking");
	const [reqResults, setReqResults] = useState<RequirementCheckResult[]>([]);
	const [reqChecking, setReqChecking] = useState(false);

	// GitHub CLI availability warning
	const [ghWarning, setGhWarning] = useState<{ notInstalled: boolean } | null>(null);
	const [showAddProjectModal, setShowAddProjectModal] = useState(false);
	const [openAddProjectOnDashboard, setOpenAddProjectOnDashboard] = useState(false);
	const [showProjectSwitch, setShowProjectSwitch] = useState(false);
	const [showCommandPalette, setShowCommandPalette] = useState(false);
	// Vimium-style task hint navigation overlay (toggled with `f` on the board).
	const [hintMode, setHintMode] = useState(false);
	const [createTaskProjectId, setCreateTaskProjectId] = useState<string | null>(null);
	const [launchModal, setLaunchModal] = useState<{ task: Task; targetStatus: TaskStatus; project: Project } | null>(null);
	const [agents, setAgents] = useState<CodingAgent[]>([]);
	const [globalSettings, setGlobalSettings] = useState<GlobalSettingsType>({
		defaultAgentId: "builtin-claude",
		defaultConfigId: "claude-auto",
		taskDropPosition: "top",
		updateChannel: "stable",
	});

	// Auth failure for browser remote access (expired/invalid QR token)
	const [authFailed, setAuthFailed] = useState(false);

	useEffect(() => {
		function onAuthFailed() { setAuthFailed(true); }
		window.addEventListener("rpc:authFailed", onAuthFailed);
		return () => window.removeEventListener("rpc:authFailed", onAuthFailed);
	}, []);

	useEffect(() => {
		initTaskSoundPlayback();
	}, []);

	// Mirror the completion-sound setting into the task-sounds module so the UI
	// can gate its instant client-side playback without a round-trip.
	useEffect(() => {
		setTaskCompletionSoundEnabled(globalSettings.playSoundOnTaskComplete !== false);
	}, [globalSettings.playSoundOnTaskComplete]);

	const checkRequirements = useCallback(async () => {
		setReqChecking(true);
		try {
			const results = await api.request.checkSystemRequirements();
			const allOk = results.every((r) => r.installed || r.optional);
			setReqResults(results);
			setReqStatus(allOk ? "passed" : "failed");
		} catch (err) {
			console.error("Failed to check system requirements:", err);
			// If we can't check, assume OK to avoid blocking the app
			setReqStatus("passed");
		}
		setReqChecking(false);
	}, []);

	// Refresh results without dismissing the screen (used after Set path)
	const refreshResults = useCallback(async () => {
		try {
			const results = await api.request.checkSystemRequirements();
			setReqResults(results);
		} catch (err) {
			console.error("Failed to refresh requirements:", err);
		}
	}, []);

	useEffect(() => {
		checkRequirements();
	}, [checkRequirements]);

	// Navigation guard for unsaved-changes prompts (e.g. ProjectSettings, diff viewer)
	const navigationGuardRef = useRef<NavigationGuard | null>(null);
	const [pendingNavigation, setPendingNavigation] = useState<Route | null>(null);

	// Latest route mirror — async event handlers read this to make routing decisions
	// without re-subscribing every navigation.
	const routeRef = useRef<Route>(state.route);
	useEffect(() => {
		routeRef.current = state.route;
	}, [state.route]);

	// Close the task-hint overlay on any navigation so it never lingers with
	// detached card references (e.g. after a hint commits or an async route change).
	useEffect(() => {
		setHintMode(false);
	}, [state.route]);

	// Single chokepoint for committing a navigation. Records a project "jump"
	// for the Cmd+K recency list whenever the destination route lands on a
	// project, so every entry point (Dashboard click, Cmd+1..9, Cmd+Shift+1..9,
	// the palette, the `g`-prefix go-to, terminal toggles, future ones…) is
	// covered automatically — they all funnel through here.
	const commitNavigation = useCallback(
		(route: Route) => {
			const projectId = projectIdForRoute(route);
			if (projectId) recordProjectJump(projectId);
			dispatch({ type: "navigate", route });
		},
		[dispatch],
	);
	const navigate = useCallback(
		(route: Route) => {
			if (navigationGuardRef.current?.isDirty()) {
				setPendingNavigation(route);
				return;
			}
			commitNavigation(route);
		},
		[commitNavigation],
	);

	// Switch to a project, preserving the current view shape the same way Cmd+1..9
	// does: in a task view with split open-mode, land in the target's task view
	// (no task selected); otherwise land on its Kanban board. Shared by the
	// Cmd+1..9 index shortcuts and the Cmd+K quick-switch palette.
	const navigateToProject = useCallback(
		(projectId: string) => {
			const route = state.route;
			const taskOpenMode = localStorage.getItem("dev3-task-open-mode") === "fullscreen" ? "fullscreen" : "split";
			const inTaskView =
				route.screen === "task" ||
				(route.screen === "project" && (Boolean(route.activeTaskId) || Boolean(route.taskView)));
			navigate(
				inTaskView && taskOpenMode === "split"
					? { screen: "project", projectId, taskView: true }
					: { screen: "project", projectId },
			);
		},
		[navigate, state.route],
	);

	// Quick shell (⇧⌘`): spawn a fresh scratch op in the built-in Operations board
	// and jump to it. The backend launches it with the default agent + config.
	const openQuickShell = useCallback(async () => {
		try {
			const task = await api.request.openQuickShell({});
			navigate({ screen: "task", projectId: task.projectId, taskId: task.id });
		} catch (err) {
			toast.error(String(err));
		}
	}, [navigate]);

	useEffect(() => {
		function onOpenQuickShell() { void openQuickShell(); }
		window.addEventListener("menu:open-quick-shell", onOpenQuickShell);
		return () => window.removeEventListener("menu:open-quick-shell", onOpenQuickShell);
	}, [openQuickShell]);

	// `g`-prefix "go to" sequence (Linear/GitHub style), kept in refs so the
	// global keydown handler stays pure. Tiny state machine:
	//   g          → arm "verb": expect d/p/t/s, or a 1–9 digit (= project N, keep view)
	//   g p / g t  → arm "index": expect an optional 1–9 digit (= project N board/tasks);
	//                on timeout or a non-digit, fall back to the CURRENT project
	//   g d / g s  → dashboard / settings (immediate)
	const goToModeRef = useRef<null | { stage: "verb" } | { stage: "index"; view: "project" | "task" }>(null);
	const goToTimerRef = useRef<number | null>(null);
	const clearGoTo = useCallback(() => {
		goToModeRef.current = null;
		if (goToTimerRef.current !== null) {
			window.clearTimeout(goToTimerRef.current);
			goToTimerRef.current = null;
		}
	}, []);
	const goToProjectView = useCallback(
		(projectId: string, view: "project" | "task") =>
			navigate(view === "task" ? { screen: "project", projectId, taskView: true } : { screen: "project", projectId }),
		[navigate],
	);
	const goToCurrentProject = useCallback(
		(view: "project" | "task") => {
			const projectId = "projectId" in state.route ? state.route.projectId : state.projects.find((p) => !p.deleted)?.id;
			if (!projectId) return navigate({ screen: "dashboard" });
			goToProjectView(projectId, view);
		},
		[navigate, state.route, state.projects, goToProjectView],
	);
	const goToProjectIndex = useCallback(
		(n: number, view: "project" | "task" | "preserve") => {
			const project = state.projects.filter((p) => !p.deleted)[n - 1];
			if (!project) return; // out of range — no-op
			if (view === "preserve") navigateToProject(project.id);
			else goToProjectView(project.id, view);
		},
		[state.projects, navigateToProject, goToProjectView],
	);
	const armGoToVerb = useCallback(() => {
		goToModeRef.current = { stage: "verb" };
		if (goToTimerRef.current !== null) window.clearTimeout(goToTimerRef.current);
		goToTimerRef.current = window.setTimeout(clearGoTo, 1500);
	}, [clearGoTo]);
	const armGoToIndex = useCallback(
		(view: "project" | "task") => {
			goToModeRef.current = { stage: "index", view };
			if (goToTimerRef.current !== null) window.clearTimeout(goToTimerRef.current);
			// No digit within the window → land on the current project in that view.
			goToTimerRef.current = window.setTimeout(() => {
				goToModeRef.current = null;
				goToTimerRef.current = null;
				goToCurrentProject(view);
			}, 1000);
		},
		[goToCurrentProject],
	);

	// Option+Tab (project) / Option+Shift+Tab (global) task switcher.
	const switcher = useTaskSwitcher({
		projectTasks: state.currentProjectTasks,
		currentProjectId: "projectId" in state.route ? state.route.projectId : null,
		currentTaskId: routeTaskId(state.route),
		mru: state.taskMru,
		navigate,
		disabled: hintMode,
	});
	const switcherProjectById = useMemo(() => {
		const map = new Map<string, Project>();
		for (const p of state.projects) map.set(p.id, p);
		return map;
	}, [state.projects]);

	// Quick-switch (Cmd+K) data, recomputed each time the palette opens so the
	// recency ordering reflects the latest jumps. Rows are MRU-first (then board
	// order); the ⌘N badge stays keyed to the stable board index.
	const quickSwitch = useMemo(() => {
		const boardProjects = state.projects.filter((p) => !p.deleted);
		// ⌘1..9 address ordinary projects only — the builtin Operations board owns
		// ⌘0 (see the keydown handler). The ⌘N badge index must mirror that same
		// builtin-excluded ordering, or the badge would disagree with the shortcut.
		const ordinary = boardProjects.filter((p) => !(p.builtin && p.kind === "virtual"));
		const shortcutIndexById: Record<string, number> = {};
		ordinary.forEach((p, i) => {
			shortcutIndexById[p.id] = i;
		});
		// Pin the builtin Operations board first (consistent with the dashboard,
		// header switcher, and sidebar), then recency, then board order.
		const ordered = orderProjectsForDisplay(
			showProjectSwitch ? orderByRecency(boardProjects, getRecentProjectIds()) : boardProjects,
		);
		return { projects: ordered, shortcutIndexById };
	}, [state.projects, showProjectSwitch]);

	const getProjectIdForRoute = useCallback((route: Route): string | null => projectIdForRoute(route), []);

	const openCreateTaskModal = useCallback(() => {
		const projectId = getProjectIdForRoute(state.route);
		if (!projectId) return false;
		if (document.querySelector('[data-create-task-modal="true"]')) return false;
		setCreateTaskProjectId((current) => current ?? projectId);
		return true;
	}, [getProjectIdForRoute, state.route]);

	const openAddProject = useCallback(() => {
		if (state.route.screen === "dashboard") {
			setOpenAddProjectOnDashboard(false);
			setShowAddProjectModal(true);
			return;
		}
		setOpenAddProjectOnDashboard(true);
		navigate({ screen: "dashboard" });
	}, [navigate, state.route.screen]);

	// Run a command from the Cmd+Shift+P action palette. Every command dispatches
	// through the same `handleMenuAction` router the native menu uses, so the
	// palette is a DOM mirror of the menu rather than a second command runner.
	const runCommand = useCallback(
		(actionId: string) => {
			setShowCommandPalette(false);
			handleMenuAction(actionId, { state, dispatch, setLocale }).catch((err) => {
				console.error("[App] runCommand failed", err);
			});
		},
		[state, dispatch, setLocale],
	);

	// Browser-mode menu bar (`AppMenuBar`) dispatches through the same router as
	// the native menu and the command palette.
	const handleMenuBarAction = useCallback(
		(actionId: string) => {
			handleMenuAction(actionId, { state, dispatch, setLocale }).catch((err) => {
				console.error("[App] menu bar action failed", err);
			});
		},
		[state, dispatch, setLocale],
	);

	// The create-flow commands (`open-new-task` / `open-add-project`) live as
	// App-owned modals, so the router emits CustomEvents the App opens here.
	useEffect(() => {
		const onNewTask = () => openCreateTaskModal();
		const onAddProject = () => openAddProject();
		// The View-menu palette items open (not toggle) the palettes — the
		// Cmd+K / Cmd+Shift+P keydown handlers below own the toggle behavior.
		const onProjectSwitch = () => setShowProjectSwitch(true);
		const onCommandPalette = () => setShowCommandPalette(true);
		window.addEventListener("menu:open-new-task", onNewTask);
		window.addEventListener("menu:open-add-project", onAddProject);
		window.addEventListener("menu:open-project-switch", onProjectSwitch);
		window.addEventListener("menu:open-command-palette", onCommandPalette);
		return () => {
			window.removeEventListener("menu:open-new-task", onNewTask);
			window.removeEventListener("menu:open-add-project", onAddProject);
			window.removeEventListener("menu:open-project-switch", onProjectSwitch);
			window.removeEventListener("menu:open-command-palette", onCommandPalette);
		};
	}, [openCreateTaskModal, openAddProject]);

	// Cmd/Ctrl+Q, Cmd/Ctrl+N, Cmd/Ctrl+,, Cmd/Ctrl+=/- (zoom) — capture phase so terminal can't swallow them
	useGlobalShortcut(
		(e) => {
			// While hint mode is active the overlay owns every keystroke.
			if (hintMode) return;
			// In browser remote mode the native menu is gone and the browser claims
			// several modifier combos. Drop-fated shortcuts (shell-level or
			// browser-owned) bail BEFORE preventDefault so the browser keeps its
			// native behavior; aliased ones (⌘1–9 → `G then 1–9`, ⌘N → `C`) fall back
			// to their bare-key path. Source of truth: `keymap.ts` scope/remoteKeys.
			const remote = isRemote();
			if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "q") {
				if (remote) return; // ⌘Q quits the browser — leave it to the browser.
				// WKWebView swallows the native menu Cmd+Q accelerator while a
				// terminal has focus, so we catch it here (capture phase) and ask
				// the main process to start the quit. The `before-quit` gate then
				// pushes `showQuitDialog` back, or quits if the user opted out.
				e.preventDefault();
				e.stopPropagation();
				api.request.requestQuit().catch(() => {});
			} else if ((e.metaKey || e.ctrlKey) && e.key === "h") {
				if (remote) return; // ⌘H hides the browser — leave it to the browser.
				e.preventDefault();
				e.stopPropagation();
				api.request.hideApp().catch(() => {});
			} else if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
				// Cmd+Shift+N — open a new window (the native menu item has no
				// accelerator because Electrobun can't bind chord shortcuts; see
				// decision 044). Cmd+N (no shift) opens a new task instead.
				if (remote) return; // No second app window over one browser tab.
				e.preventDefault();
				e.stopPropagation();
				api.request.openNewWindow().catch(() => {});
			} else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
				// ⌘N opens a new browser window in remote (not cancelable) — fall back
				// to the bare `C` shortcut there. See keymap.ts `new-task` remoteKeys.
				if (remote) return;
				if (createTaskProjectId || showAddProjectModal || showQuitDialog) return;
				if (!openCreateTaskModal()) return;
				e.preventDefault();
				e.stopPropagation();
			} else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
				e.preventDefault();
				e.stopPropagation();
				if (showQuitDialog) return;
				openAddProject();
			} else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
				// Cmd/Ctrl+K — open the project quick-switch palette (Slack/Linear/VSCode
				// "go to anything" convention). Not Cmd+T: that's the universal new-tab key
				// and the live terminal underneath (ghostty/tmux) intercepts it.
				e.preventDefault();
				e.stopPropagation();
				if (showQuitDialog || createTaskProjectId || showAddProjectModal) return;
				setShowProjectSwitch((open) => !open);
			} else if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
				// Cmd/Ctrl+Shift+P — open the action (command) palette (VSCode
				// convention). The navigation sibling is Cmd+K.
				e.preventDefault();
				e.stopPropagation();
				if (showQuitDialog || createTaskProjectId || showAddProjectModal) return;
				setShowCommandPalette((open) => !open);
			} else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "/") {
				// Cmd/Ctrl+/ — toggle the keyboard-shortcuts reference overlay (App tab).
				// Capture phase so the live terminal underneath can't swallow it. Bare
				// `?` is intentionally NOT used — the terminal must still receive it.
				e.preventDefault();
				e.stopPropagation();
				setShortcutsModal((s) => (s.open ? { ...s, open: false } : { open: true, tab: "app" }));
			} else if ((e.metaKey || e.ctrlKey) && e.key === ",") {
				e.preventDefault();
				e.stopPropagation();
				navigate({ screen: "settings" });
			} else if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) {
				if (remote) return; // Yield to the browser's native page zoom in remote.
				e.preventDefault();
				e.stopPropagation();
				adjustZoom(ZOOM_STEP);
			} else if ((e.metaKey || e.ctrlKey) && e.key === "-") {
				if (remote) return; // Yield to the browser's native page zoom in remote.
				e.preventDefault();
				e.stopPropagation();
				adjustZoom(-ZOOM_STEP);
			} else if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === "Digit0") {
				// Cmd+Shift+0 — reset zoom to 100%. Relocated from Cmd+0, which now
				// jumps to the built-in Operations board (see below). `e.code` because
				// Shift+0 yields ")" in `e.key`.
				if (remote) return; // Yield to the browser's native zoom reset in remote.
				e.preventDefault();
				e.stopPropagation();
				applyZoom(DEFAULT_ZOOM);
			} else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "0") {
				// Cmd+0 — jump to the built-in Operations board (the special "slot 0"
				// of the Cmd+digit project family; Cmd+1..9 address ordinary projects).
				const ops = state.projects.find((p) => p.builtin && p.kind === "virtual" && !p.deleted);
				if (ops) {
					e.preventDefault();
					e.stopPropagation();
					navigateToProject(ops.id);
				}
			} else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "[") {
				// Cmd+[ — navigate back through route history
				e.preventDefault();
				e.stopPropagation();
				dispatch({ type: "goBack" });
			} else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "]") {
				// Cmd+] — navigate forward through route history
				e.preventDefault();
				e.stopPropagation();
				dispatch({ type: "goForward" });
			} else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "~") {
				// Cmd+Shift+` — open/focus the Quick shell operation (key="~" because Shift+` produces ~)
				e.preventDefault();
				e.stopPropagation();
				void openQuickShell();
			} else if ((e.metaKey || e.ctrlKey) && e.key === "`") {
				// Cmd+` — toggle project terminal
				const { route } = state;
				if (route.screen === "project-terminal") {
					e.preventDefault();
					e.stopPropagation();
					navigate({ screen: "project", projectId: route.projectId });
				} else if ("projectId" in route) {
					// Virtual ("Operations") boards have no project terminal — their
					// synthetic path is created lazily per-task, so opening one throws
					// "Project path does not exist". Ignore the hotkey there.
					const isVirtual = state.projects.find((p) => p.id === route.projectId)?.kind === "virtual";
					if (!isVirtual) {
						e.preventDefault();
						e.stopPropagation();
						navigate({ screen: "project-terminal", projectId: route.projectId });
					}
				}
			} else if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) {
				// Cmd+Shift+1..9 — switch to project by index landing on the
				// OPPOSITE view of the current one (the mirror of Cmd+1..9, which
				// PRESERVES the view):
				//  - on the Kanban board  → target project's task view (split layout,
				//                            empty terminal placeholder, no task picked).
				//  - in a task view       → target project's Kanban board.
				// `e.code` (not `e.key`) because Shift+digit yields the shifted symbol
				// ("!", "@", …) in `e.key`. Open-mode is intentionally ignored here —
				// the explicit Shift means "give me the other view" regardless of the
				// `dev3-task-open-mode` preference. Note: macOS reserves Cmd+Shift+3/4/5
				// for screenshots, so those may be swallowed by the OS before reaching us.
				const idx = parseInt(e.code.slice(5), 10) - 1;
				// The built-in Operations board owns Cmd+0, so it is excluded here —
				// Cmd+1..9 address ordinary projects only.
				const available = state.projects.filter((p) => !p.deleted && !(p.builtin && p.kind === "virtual"));
				if (idx < available.length) {
					e.preventDefault();
					e.stopPropagation();
					const { route } = state;
					const inTaskView =
						route.screen === "task" ||
						(route.screen === "project" && (Boolean(route.activeTaskId) || Boolean(route.taskView)));
					navigate(
						inTaskView
							? { screen: "project", projectId: available[idx].id }
							: { screen: "project", projectId: available[idx].id, taskView: true },
					);
				}
			} else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key >= "1" && e.key <= "9") {
				// ⌘1..9 switches the browser's own tabs in remote (not cancelable), so
				// don't double-fire a project switch — the `G then 1–9` go-to chord is
				// the remote alias (keymap.ts `switch-project` remoteKeys).
				if (remote) return;
				// Cmd+1..9 — switch to project by index (like Slack workspaces).
				// View-mode preservation is gated on the `dev3-task-open-mode` setting:
				//  - "split"      users live in the sidebar+terminal layout, so if they
				//                 are in a task view we land in the target project's task
				//                 view with no task selected (empty terminal placeholder).
				//  - "fullscreen" users have no task to show full-page after a switch, so
				//                 dropping them into a split they never use is jarring —
				//                 land on the Kanban board instead (pre-#619 behavior).
				const idx = parseInt(e.key, 10) - 1;
				// Built-in Operations board is reached via Cmd+0, not Cmd+1..9.
				const available = state.projects.filter((p) => !p.deleted && !(p.builtin && p.kind === "virtual"));
				if (idx < available.length) {
					e.preventDefault();
					e.stopPropagation();
					navigateToProject(available[idx].id);
				}
			} else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === "KeyG") {
				// Cmd/Ctrl+G — Mac-friendly chord alias for the bare-`f` hint mode.
				if (isTypingContext()) return;
				if (!document.querySelector("[data-hint-id]")) return;
				e.preventDefault();
				e.stopPropagation();
				setHintMode(true);
			} else if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
				// ── Bare-key shortcuts. Matched on `e.code` (physical key) so they
				// work on every keyboard layout (Cyrillic, Hebrew, …), and only when
				// no field/terminal has focus. ──
				if (isTypingContext()) return;

				// Advance / resolve a `g …` go-to sequence.
				if (goToModeRef.current) {
					const mode = goToModeRef.current;
					clearGoTo();
					if (mode.stage === "verb") {
						if (e.code === "KeyD") {
							e.preventDefault();
							e.stopPropagation();
							return navigate({ screen: "dashboard" });
						}
						if (e.code === "KeyS") {
							e.preventDefault();
							e.stopPropagation();
							return navigate({ screen: "settings" });
						}
						if (e.code === "KeyP" || e.code === "KeyT") {
							e.preventDefault();
							e.stopPropagation();
							return armGoToIndex(e.code === "KeyT" ? "task" : "project");
						}
						const n = digitFromCode(e.code);
						if (n !== null) {
							// `g <digit>` — jump to project N keeping the current view (like Cmd+N).
							e.preventDefault();
							e.stopPropagation();
							return goToProjectIndex(n, "preserve");
						}
						return; // anything else cancels
					}
					// stage === "index": an optional digit picks project N in this view;
					// otherwise fall back to the current project.
					e.preventDefault();
					e.stopPropagation();
					const n = digitFromCode(e.code);
					if (n !== null) goToProjectIndex(n, mode.view);
					else goToCurrentProject(mode.view);
					return;
				}

				if (e.code === "KeyF") {
					// `f` — Vimium-style hint navigation. Works on any screen that has
					// hint targets ([data-hint-id]); the overlay self-closes if nothing
					// is actually visible (e.g. a modal covers the board).
					if (!document.querySelector("[data-hint-id]")) return;
					e.preventDefault();
					e.stopPropagation();
					setHintMode(true);
				} else if (e.code === "KeyG") {
					// `g` — arm a "go to" sequence; the next key picks d/p/t/s or a project digit.
					e.preventDefault();
					e.stopPropagation();
					armGoToVerb();
				} else if (e.code === "KeyC") {
					// `c` — new task (Linear `C` = create); bare-key alias of Cmd/Ctrl+N.
					// No-op off a project route (openCreateTaskModal returns false).
					if (createTaskProjectId || showAddProjectModal || showQuitDialog) return;
					if (!openCreateTaskModal()) return;
					e.preventDefault();
					e.stopPropagation();
				} else if (e.code === "Slash") {
					// `/` — focus the visible search input (Linear/Gmail convention).
					const input = findVisibleSearchInput();
					if (!input) return;
					e.preventDefault();
					e.stopPropagation();
					input.focus();
				}
			}
		},
		[armGoToIndex, armGoToVerb, clearGoTo, createTaskProjectId, dispatch, goToCurrentProject, goToProjectIndex, hintMode, navigate, navigateToProject, openAddProject, openCreateTaskModal, openQuickShell, showAddProjectModal, showQuitDialog, state.projects, state.route],
		{ capture: true },
	);

	// Mouse side buttons (back = button 3, forward = button 4) drive route history,
	// mirroring browser navigation. WKWebView has no native back/forward to fight,
	// but we preventDefault to avoid any stray default handling.
	useEffect(() => {
		function handleMouseUp(e: MouseEvent) {
			if (e.button === 3) {
				e.preventDefault();
				dispatch({ type: "goBack" });
			} else if (e.button === 4) {
				e.preventDefault();
				dispatch({ type: "goForward" });
			}
		}
		window.addEventListener("mouseup", handleMouseUp);
		return () => window.removeEventListener("mouseup", handleMouseUp);
	}, [dispatch]);

	function handleConfirmQuit() {
		api.request.quitApp({ dontShowAgain }).catch(() => {});
	}

	// Check gh availability after requirements pass (non-blocking)
	useEffect(() => {
		if (reqStatus !== "passed") return;
		if (isGhWarningDismissed()) return;
		api.request.checkGhAvailable()
			.then(({ available, notInstalled }) => {
				if (!available) {
					setGhWarning({ notInstalled });
				}
			})
			.catch(() => {
				// Ignore — don't block the app if this check fails
			});
	}, [reqStatus]);

	// Load projects on mount — gated on requirements passing
	useEffect(() => {
		if (reqStatus !== "passed") return;
		(async () => {
			try {
				const projects = await api.request.getProjects();
				dispatch({ type: "setProjects", projects });

				// Restore route saved before an update restart
				try {
					const { route: savedRoute } = await api.request.getUpdateRoute();
					if (savedRoute) {
						const route = JSON.parse(savedRoute) as Route;
						dispatch({ type: "navigate", route });
					}
				} catch {
					// Ignore — file may not exist or be malformed
				}
			} catch (err) {
				console.error("Failed to load projects:", err);
			}
			dispatch({ type: "setLoading", loading: false });
		})();
	}, [dispatch, reqStatus]);

	// Refresh projects from disk whenever user returns to the dashboard project list
	useEffect(() => {
		if (state.route.screen !== "dashboard" || state.loading) return;
		(async () => {
			try {
				const projects = await api.request.getProjects();
				dispatch({ type: "setProjects", projects });
			} catch (err) {
				console.error("Failed to refresh projects:", err);
			}
		})();
	}, [dispatch, state.route.screen, state.loading]);

	// Listen for push messages from bun
	useEffect(() => {
		function onTaskUpdated(e: Event) {
			const { task } = (e as CustomEvent).detail;
			dispatch({ type: "updateTask", task });
		}
		window.addEventListener("rpc:taskUpdated", onTaskUpdated);
		return () => window.removeEventListener("rpc:taskUpdated", onTaskUpdated);
	}, [dispatch]);

	useEffect(() => {
		function onProjectUpdated(e: Event) {
			const { project } = (e as CustomEvent).detail;
			dispatch({ type: "updateProject", project });
		}
		window.addEventListener("rpc:projectUpdated", onProjectUpdated);
		return () => window.removeEventListener("rpc:projectUpdated", onProjectUpdated);
	}, [dispatch]);

	useEffect(() => {
		function onTaskSound(e: Event) {
			const { status } = (e as CustomEvent).detail;
			playTaskSoundFromPush(status);
		}
		window.addEventListener("rpc:taskSound", onTaskSound);
		return () => window.removeEventListener("rpc:taskSound", onTaskSound);
	}, []);

	useEffect(() => {
		function onTerminalBell(e: Event) {
			const { taskId } = (e as CustomEvent).detail;
			dispatch({ type: "addBell", taskId });
		}
		window.addEventListener("rpc:terminalBell", onTerminalBell);
		return () => window.removeEventListener("rpc:terminalBell", onTerminalBell);
	}, [dispatch]);

	// CLI-initiated attention badge (`dev3 attention "reason"`). Same red badge as
	// the terminal bell, but carries a hoverable reason.
	useEffect(() => {
		function onCliAttention(e: Event) {
			const { taskId, reason } = (e as CustomEvent).detail as { taskId: string; reason: string };
			if (!taskId) return;
			dispatch({ type: "addBell", taskId, reason: reason ?? "" });
		}
		window.addEventListener("rpc:cliAttention", onCliAttention);
		return () => window.removeEventListener("rpc:cliAttention", onCliAttention);
	}, [dispatch]);

	// CLI-initiated in-app toast (`dev3 notify`). When a task is attached the toast
	// is clickable and opens that task, honoring the user's task-open-mode.
	useEffect(() => {
		function onCliToast(e: Event) {
			const { taskId, projectId, message, level, taskSeq, taskTitle, projectName } = (e as CustomEvent).detail as {
				taskId: string | null;
				projectId: string | null;
				message: string;
				level: "info" | "success" | "error";
				taskSeq?: number;
				taskTitle?: string;
				projectName?: string;
			};
			if (!message) return;
			const onClick =
				taskId && projectId
					? () => {
							const openMode = localStorage.getItem("dev3-task-open-mode") === "fullscreen" ? "fullscreen" : "split";
							if (openMode === "fullscreen") navigate({ screen: "task", projectId, taskId });
							else navigate({ screen: "project", projectId, activeTaskId: taskId });
						}
					: undefined;
			// Compact source line, e.g. "#804 · dev-3.0 · Task title".
			const context = taskSeq !== undefined
				? [`#${taskSeq}`, projectName, taskTitle].filter(Boolean).join(" · ")
				: undefined;
			toast[level](message, { onClick, context });
		}
		window.addEventListener("rpc:cliToast", onCliToast);
		return () => window.removeEventListener("rpc:cliToast", onCliToast);
	}, [navigate]);

	// Browser Web Notifications (remote mode). The desktop WKWebView already shows
	// the native banner, so it ignores this push; only browsers act on it, falling
	// back to an in-app toast on insecure LAN contexts or when permission is denied.
	useEffect(() => {
		if (isElectrobun) return;
		function onWebNotification(e: Event) {
			const detail = (e as CustomEvent).detail as WebNotificationDetail;
			if (!detail?.body) return;
			showWebNotificationOrToast(detail, (taskId, projectId) => {
				const openMode = localStorage.getItem("dev3-task-open-mode") === "fullscreen" ? "fullscreen" : "split";
				if (openMode === "fullscreen") navigate({ screen: "task", projectId, taskId });
				else navigate({ screen: "project", projectId, activeTaskId: taskId });
			});
		}
		window.addEventListener("rpc:webNotification", onWebNotification);
		return () => window.removeEventListener("rpc:webNotification", onWebNotification);
	}, [navigate]);

	// Listen for port scan updates
	useEffect(() => {
		function onPortsUpdated(e: Event) {
			const { taskId, ports } = (e as CustomEvent).detail;
			dispatch({ type: "setPorts", taskId, ports });
		}
		window.addEventListener("rpc:portsUpdated", onPortsUpdated);
		return () => window.removeEventListener("rpc:portsUpdated", onPortsUpdated);
	}, [dispatch]);

	// Listen for resource usage updates
	useEffect(() => {
		function onResourceUsageUpdated(e: Event) {
			const { taskId, usage } = (e as CustomEvent).detail;
			dispatch({ type: "setResourceUsage", taskId, usage });
		}
		window.addEventListener("rpc:resourceUsageUpdated", onResourceUsageUpdated);
		return () => window.removeEventListener("rpc:resourceUsageUpdated", onResourceUsageUpdated);
	}, [dispatch]);

	// Listen for branch merge detection — offer to complete the task
	useEffect(() => {
		async function onBranchMerged(e: Event) {
			const { taskId, projectId, taskTitle, branchName } = (e as CustomEvent).detail as {
				taskId: string;
				projectId: string;
				taskTitle: string;
				branchName: string;
				fingerprint?: string | null;
			};
			const fingerprint = ((e as CustomEvent).detail as { fingerprint?: string | null }).fingerprint ?? null;
			const shouldComplete = await runMergeCompletionPromptOnce(taskId, fingerprint, async () => {
				try {
					return await confirm({
						title: t("app.branchMergedTitle"),
						message: t("app.branchMergedMessage", { taskTitle, branchName }),
					});
				} catch (err) {
					console.error("[App] confirm (branch-merged) failed:", err);
					return false;
				}
			});
			if (shouldComplete === null) return;
			if (shouldComplete) {
				// If the user is currently inside this task's view, leave it BEFORE the
				// worktree is destroyed (otherwise TaskTerminal reacts to ptyDied /
				// missing worktree and shows the "session ended / restart session"
				// screen). Stay on the same surface: a task view collapses to "no task
				// selected", a Kanban board is left untouched.
				const dest = routeAfterTaskClosed(routeRef.current, taskId);
				if (dest) navigate(dest);
				dispatch({
					type: "updateTask",
					task: {
						id: taskId,
						projectId,
						status: "completed",
						worktreePath: null,
						branchName: null,
						movedAt: new Date().toISOString(),
						columnOrder: undefined,
					} as any,
				});
				dispatch({ type: "clearBell", taskId });
				trackEvent("task_moved", { from_status: "review-by-user", to_status: "completed" });
				api.request.moveTask({
					taskId,
					projectId,
					newStatus: "completed",
				}).catch(() => {
					api.request.moveTask({
						taskId,
						projectId,
						newStatus: "completed",
						force: true,
					}).catch((err) => console.error("moveTask (branch-merged) failed:", err));
				});
			} else {
				api.request.dismissMergeCompletionPrompt({
					taskId,
					projectId,
					fingerprint,
				}).catch((err) => console.error("dismissMergeCompletionPrompt failed:", err));
			}
		}
		window.addEventListener("rpc:branchMerged", onBranchMerged);
		return () => window.removeEventListener("rpc:branchMerged", onBranchMerged);
	}, [dispatch, navigate, t]);

	// Listen for agent-initiated completion requests — the CLI is blocked on a
	// socket waiting for the user's decision, so always respond, even on cancel.
	useEffect(() => {
		async function onAgentCompletionRequested(e: Event) {
			const { requestId, taskId, taskTitle, taskOverview } = (e as CustomEvent).detail as {
				requestId: string;
				taskId: string;
				taskTitle: string;
				taskOverview?: string;
			};
			let approved = false;
			try {
				approved = await confirm({
					title: t("app.agentCompletionTitle"),
					message: t("app.agentCompletionMessage"),
					info: { title: taskTitle, body: taskOverview },
					confirmLabel: t("app.agentCompletionConfirm"),
					cancelLabel: t("app.agentCompletionCancel"),
					danger: true,
					agentInitiated: true,
				});
			} catch (err) {
				console.error("[App] confirm (agent-completion) failed:", err);
			}
			if (approved) {
				// Leave the task's view BEFORE the worktree is destroyed (same
				// reasoning as the branch-merged flow above). Stay on the same
				// surface: a task view collapses to "no task selected".
				const dest = routeAfterTaskClosed(routeRef.current, taskId);
				if (dest) navigate(dest);
				dispatch({ type: "clearBell", taskId });
				trackEvent("task_moved", { to_status: "completed", agent_requested: true });
			}
			api.request.respondToAgentCompletionRequest({ requestId, approved }).catch((err) =>
				console.error("respondToAgentCompletionRequest failed:", err),
			);
		}
		window.addEventListener("rpc:agentCompletionRequested", onAgentCompletionRequested);
		return () => window.removeEventListener("rpc:agentCompletionRequested", onAgentCompletionRequested);
	}, [dispatch, navigate, t]);

	// Listen for silent update ready notification
	useEffect(() => {
		function onUpdateAvailable(e: Event) {
			const { version } = (e as CustomEvent).detail;
			setUpdateVersion(version);
			setUpdateDownloadStatus(null); // clear download indicator once ready
		}
		window.addEventListener("rpc:updateAvailable", onUpdateAvailable);
		return () => window.removeEventListener("rpc:updateAvailable", onUpdateAvailable);
	}, []);

	// Open the in-app About dialog when the native menu's "About" item is clicked.
	useEffect(() => {
		function onShowAbout(e: Event) {
			const { version } = (e as CustomEvent).detail as { version: string };
			setAboutVersion(version);
		}
		window.addEventListener("rpc:showAbout", onShowAbout);
		return () => window.removeEventListener("rpc:showAbout", onShowAbout);
	}, []);

	// Surface the result of a manual "Check for Updates" menu action as a toast.
	// (Available updates flow through rpc:updateAvailable → the header plaque.)
	useEffect(() => {
		function onUpdateCheckOutcome(e: Event) {
			const { status, version, detail } = (e as CustomEvent).detail as {
				status: "none" | "error";
				version?: string;
				detail?: string;
			};
			if (status === "none") {
				toast.info(t("update.upToDateVersion", { version: version ?? "" }));
			} else {
				toast.error(t("update.checkFailedDetail", { error: detail ?? "" }));
			}
		}
		window.addEventListener("rpc:updateCheckOutcome", onUpdateCheckOutcome);
		return () => window.removeEventListener("rpc:updateCheckOutcome", onUpdateCheckOutcome);
	}, [t]);

	// Click-to-open for watched-task notifications.
	// Bun observes the main window's `focus` event after a notification fires and pushes us
	// the target taskId/projectId. We navigate straight into the task.
	useEffect(() => {
		function onOpenTaskFromNotification(e: Event) {
			const { taskId, projectId } = (e as CustomEvent).detail as { taskId: string; projectId: string };
			if (!taskId || !projectId) return;
			// Open the task the same way a normal card click does — honoring the user's
			// `dev3-task-open-mode` preference. Default is "split" (task terminal next to
			// the board), NOT fullscreen zoom. Only users who chose fullscreen get zoomed.
			const openMode = localStorage.getItem("dev3-task-open-mode") === "fullscreen" ? "fullscreen" : "split";
			if (openMode === "fullscreen") {
				navigate({ screen: "task", projectId, taskId });
			} else {
				navigate({ screen: "project", projectId, activeTaskId: taskId });
			}
		}
		window.addEventListener("rpc:openTaskFromNotification", onOpenTaskFromNotification);
		return () => window.removeEventListener("rpc:openTaskFromNotification", onOpenTaskFromNotification);
	}, [navigate]);

	// Report window focus state to the backend. It uses this to suppress
	// notification click-to-open arming while the app is already in the foreground —
	// otherwise an in-app click that re-keys the window gets misread as a
	// notification click and zooms the user into the task.
	useEffect(() => {
		const report = (focused: boolean) => {
			// Optional-chained: best-effort telemetry, and some tests mock `api`
			// without this method.
			void api.request.setWindowForeground?.({ focused })?.catch?.(() => { /* best-effort */ });
		};
		const onFocus = () => report(true);
		const onBlur = () => report(false);
		window.addEventListener("focus", onFocus);
		window.addEventListener("blur", onBlur);
		// Sync the initial state on mount (the window may already be focused).
		report(document.hasFocus());
		return () => {
			window.removeEventListener("focus", onFocus);
			window.removeEventListener("blur", onBlur);
		};
	}, []);

	// Report the active project board / task to the backend so its background git
	// pollers poll the on-screen project at full cadence and throttle every
	// off-screen project heavily — the fix for the git-process storm that stalled
	// the main loop when many worktrees were polled blindly.
	useEffect(() => {
		const route = state.route;
		const projectId =
			route.screen === "project" ||
			route.screen === "project-terminal" ||
			route.screen === "task" ||
			route.screen === "project-settings"
				? route.projectId
				: null;
		const taskId = routeTaskId(route);
		void api.request.setActiveContext?.({ projectId, taskId })?.catch?.(() => { /* best-effort */ });
	}, [state.route]);

	// Notify user when a column-agent launch fails (custom columns have no automatic fallback)
	useEffect(() => {
		function onColumnAgentFailed(e: Event) {
			const { columnName, error } = (e as CustomEvent).detail as {
				taskId: string;
				projectId: string;
				columnName: string;
				error: string;
			};
			// The task is parked in the target column with no running agent; surface the
			// failure so the user can relaunch (move out and back in) or fix the column config.
			toast.error(t("kanban.columnAgentFailed", { columnName, error }));
		}
		window.addEventListener("rpc:columnAgentFailed", onColumnAgentFailed);
		return () => window.removeEventListener("rpc:columnAgentFailed", onColumnAgentFailed);
	}, []);

	// Notify user when background worktree/PTY preparation fails (e.g. empty repo,
	// missing base branch). The task is reverted to todo on the backend; surface
	// the real error so the user isn't left with a misleading "[session ended]".
	useEffect(() => {
		function onTaskPreparationFailed(e: Event) {
			const { taskTitle, error } = (e as CustomEvent).detail as {
				taskId: string;
				projectId: string;
				taskTitle: string;
				error: string;
			};
			toast.error(t("kanban.taskPreparationFailed", { taskTitle, error }));
		}
		window.addEventListener("rpc:taskPreparationFailed", onTaskPreparationFailed);
		return () => window.removeEventListener("rpc:taskPreparationFailed", onTaskPreparationFailed);
	}, []);

	// Listen for update download progress (minimum 5s display time)
	useEffect(() => {
		const MIN_DISPLAY_MS = 5_000;
		function onDownloadProgress(e: Event) {
			const { status } = (e as CustomEvent).detail;
			if (status === "complete" || status === "idle") {
				// Clear after minimum display time
				const elapsed = Date.now() - updateStatusShownAtRef.current;
				const remaining = Math.max(0, MIN_DISPLAY_MS - elapsed);
				if (updateClearTimerRef.current) clearTimeout(updateClearTimerRef.current);
				updateClearTimerRef.current = setTimeout(() => {
					setUpdateDownloadStatus(null);
					updateClearTimerRef.current = null;
				}, remaining);
			} else {
				// Show immediately, record timestamp
				if (updateClearTimerRef.current) {
					clearTimeout(updateClearTimerRef.current);
					updateClearTimerRef.current = null;
				}
				updateStatusShownAtRef.current = Date.now();
				setUpdateDownloadStatus(status); // "checking", "downloading", "error"
			}
		}
		window.addEventListener("rpc:updateDownloadProgress", onDownloadProgress);
		return () => {
			window.removeEventListener("rpc:updateDownloadProgress", onDownloadProgress);
			if (updateClearTimerRef.current) clearTimeout(updateClearTimerRef.current);
		};
	}, []);

	// Listen for Cmd+, (Settings menu item)
	useEffect(() => {
		if (!openAddProjectOnDashboard) return;
		if (state.route.screen === "dashboard") {
			setShowAddProjectModal(true);
			setOpenAddProjectOnDashboard(false);
			return;
		}
		if (pendingNavigation === null) {
			setOpenAddProjectOnDashboard(false);
		}
	}, [openAddProjectOnDashboard, pendingNavigation, state.route.screen]);

	useEffect(() => {
		function onNavigateToSettings() {
			navigate({ screen: "settings" });
		}
		window.addEventListener("rpc:navigateToSettings", onNavigateToSettings);
		return () => window.removeEventListener("rpc:navigateToSettings", onNavigateToSettings);
	}, [navigate]);

	useEffect(() => {
		function onOpenCreateTaskModal() {
			openCreateTaskModal();
		}
		window.addEventListener("rpc:openCreateTaskModal", onOpenCreateTaskModal);
		return () => window.removeEventListener("rpc:openCreateTaskModal", onOpenCreateTaskModal);
	}, [openCreateTaskModal]);

	// Load agents + global settings the first time the create-task modal opens.
	// Needed by the LaunchVariantsModal that follows "Create & Run" / "Scratch".
	const agentsLoadedRef = useRef(false);
	useEffect(() => {
		if (!createTaskProjectId || agentsLoadedRef.current) return;
		agentsLoadedRef.current = true;
		api.request.getAgents().then(setAgents).catch(() => {});
		api.request.getGlobalSettings().then(setGlobalSettings).catch(() => {});
	}, [createTaskProjectId]);

	// Register agents with analytics on mount so events like `task_moved` can
	// carry a human-readable agent name (the modal load above is lazy).
	useEffect(() => {
		api.request.getAgents().then(registerAgents).catch(() => {});
	}, []);

	useEffect(() => {
		function onOpenAddProjectModal() {
			openAddProject();
		}
		window.addEventListener("rpc:openAddProjectModal", onOpenAddProjectModal);
		return () => window.removeEventListener("rpc:openAddProjectModal", onOpenAddProjectModal);
	}, [openAddProject]);

	// Listen for View > Gauge Demo menu item
	useEffect(() => {
		function onNavigateToGaugeDemo() {
			navigate({ screen: "gauge-demo" });
		}
		window.addEventListener("rpc:navigateToGaugeDemo", onNavigateToGaugeDemo);
		return () => window.removeEventListener("rpc:navigateToGaugeDemo", onNavigateToGaugeDemo);
	}, [navigate]);

	// Listen for View > Viewport Lab menu item
	useEffect(() => {
		function onNavigateToViewportLab() {
			navigate({ screen: "viewport-lab" });
		}
		window.addEventListener("rpc:navigateToViewportLab", onNavigateToViewportLab);
		return () => window.removeEventListener("rpc:navigateToViewportLab", onNavigateToViewportLab);
	}, [navigate]);

	// QR token consumed — someone connected via the QR code
	const [qrConsumed, setQrConsumed] = useState(false);

	useEffect(() => {
		function onQrConsumed() { setQrConsumed(true); }
		window.addEventListener("rpc:qrTokenConsumed", onQrConsumed);
		return () => window.removeEventListener("rpc:qrTokenConsumed", onQrConsumed);
	}, []);

	// Listen for View > Remote Access QR Code menu item
	useEffect(() => {
		function onShowRemoteQR(e: Event) {
			const detail = (e as CustomEvent).detail;
			setRemoteQR(detail);
			setQrConsumed(false); // Reset consumed state when opening fresh QR
			// Sync tunnel checkbox with actual tunnel state
			setTunnelWanted(detail?.tunnelState === "connected" || detail?.tunnelState === "starting");
			setTunnelStarting(detail?.tunnelState === "starting");
		}
		window.addEventListener("rpc:showRemoteAccessQR", onShowRemoteQR);
		return () => window.removeEventListener("rpc:showRemoteAccessQR", onShowRemoteQR);
	}, []);

	// Auto-refresh QR code every 25 seconds while modal is open (JWT tokens expire in 30s)
	// Stops when QR is consumed (someone connected).
	const qrModalOpen = remoteQR !== null;
	const [qrCountdown, setQrCountdown] = useState(25);
	const tunnelWantedRef = useRef(tunnelWanted);
	tunnelWantedRef.current = tunnelWanted;
	// Preserve the chosen interface/IP across the 25s token refresh — without
	// this, picking a host would snap back to the auto-pick on the next tick.
	const selectedHostRef = useRef<string | undefined>(undefined);
	selectedHostRef.current = remoteQR?.selectedHost;
	useEffect(() => {
		if (!qrModalOpen || qrConsumed) return;
		setQrCountdown(25);
		let counter = 25;
		const tick = setInterval(() => {
			counter -= 1;
			if (counter <= 0) {
				counter = 25;
				const host = tunnelWantedRef.current ? undefined : selectedHostRef.current;
				api.request.getRemoteAccessQR({ tunnel: tunnelWantedRef.current, host }).then(setRemoteQR).catch(() => {});
			}
			setQrCountdown(counter);
		}, 1000);
		return () => clearInterval(tick);
	}, [qrModalOpen, qrConsumed]);

	// Track page views on route changes
	useEffect(() => {
		const { screen } = state.route;
		trackPageView(screen);
	}, [state.route]);

	// Escape: close quit dialog or navigate back from settings screens
	// (skipped when a terminal has focus — Escape must reach the shell)
	useGlobalShortcut(
		(e) => {
			if (e.key !== "Escape") return;
			const terminalEl = document.querySelector('[data-terminal="true"]');
			if (terminalEl?.contains(document.activeElement)) return;
			if (showQuitDialog) {
				// preventDefault so Escape closes the dialog instead of dropping the
				// app out of native fullscreen (WKWebView forwards an unconsumed
				// Escape to AppKit's cancelOperation: → exit fullscreen).
				e.preventDefault();
				setShowQuitDialog(false);
				return;
			}
			const { route } = state;
			if (route.screen === "settings") {
				e.preventDefault();
				navigate({ screen: "dashboard" });
			} else if (route.screen === "project-settings") {
				e.preventDefault();
				navigate({ screen: "project", projectId: route.projectId });
			} else if (route.screen === "project-terminal") {
				e.preventDefault();
				navigate({ screen: "project", projectId: route.projectId });
			} else if (route.screen === "project" && (route.activeTaskId || route.taskView)) {
				e.preventDefault();
				navigate({ screen: "project", projectId: route.projectId });
			} else if (route.screen === "project") {
				e.preventDefault();
				navigate({ screen: "dashboard" });
			}
		},
		[state, navigate, showQuitDialog],
	);

	if (authFailed) {
		return (
			<div className="h-full w-full flex items-center justify-center bg-base">
				<div className="bg-raised border border-edge rounded-lg p-6 max-w-sm w-full space-y-3 text-center">
					<div className="text-3xl">{"\uD83D\uDD12"}</div>
					<h2 className="text-fg text-lg font-semibold">{t("remote.authFailed")}</h2>
					<p className="text-fg-3 text-sm">{t("remote.authFailedDesc")}</p>
				</div>
			</div>
		);
	}

	if (reqStatus === "checking") {
		return (
			<div className="h-full w-full flex items-center justify-center bg-base">
				<div className="flex items-center gap-3">
					<div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
					<span className="text-fg-3 text-sm">{t("app.loading")}</span>
				</div>
			</div>
		);
	}

	if (reqStatus === "failed") {
		return (
			<RequirementsCheck
				results={reqResults}
				checking={reqChecking}
				onRefresh={checkRequirements}
				onRefreshResults={refreshResults}
			/>
		);
	}

	if (state.loading) {
		return (
			<div className="h-full w-full flex items-center justify-center bg-base">
				<div className="flex items-center gap-3">
					<div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
					<span className="text-fg-3 text-sm">{t("app.loading")}</span>
				</div>
			</div>
		);
	}

	const { route } = state;
	const createTaskProject = createTaskProjectId
		? state.projects.find((project) => project.id === createTaskProjectId) ?? null
		: null;

	return (
		<div className="h-full w-full flex flex-col">
			{!isElectrobun && <AppMenuBar context={menuContext} onAction={handleMenuBarAction} />}
			<GlobalHeader
				route={route}
				projects={state.projects}
				tasks={state.currentProjectTasks}
				navigate={navigate}
				goBack={() => dispatch({ type: "goBack" })}
				goForward={() => dispatch({ type: "goForward" })}
				canGoBack={state.historyIndex > 0}
				canGoForward={state.historyIndex < state.routeHistory.length - 1}
				updateVersion={updateVersion}
				updateDownloadStatus={updateDownloadStatus}
			/>
			{ghWarning && (
				<GhWarningBanner
					notInstalled={ghWarning.notInstalled}
					onDismiss={() => setGhWarning(null)}
				/>
			)}
			<div className="flex-1 min-h-0 flex flex-col overflow-hidden">{renderScreen()}</div>
			{switcher.session && (
				<TaskSwitcherOverlay
					session={switcher.session}
					projectById={switcherProjectById}
					onHover={switcher.setIndex}
					onCommit={switcher.commit}
					onCancel={switcher.cancel}
				/>
			)}
			{hintMode && <HintOverlay onExit={() => setHintMode(false)} />}
			{showProjectSwitch && (
				<ProjectQuickSwitchModal
					projects={quickSwitch.projects}
					shortcutIndexById={quickSwitch.shortcutIndexById}
					onSelect={(projectId) => {
						setShowProjectSwitch(false);
						navigateToProject(projectId);
					}}
					onClose={() => setShowProjectSwitch(false)}
				/>
			)}
			{showCommandPalette && (
				<CommandPaletteModal
					context={{
						hasProject: Boolean(getProjectIdForRoute(state.route)),
						hasTask: Boolean(routeTaskId(state.route)),
						isVirtual: state.projects.find((p) => p.id === getProjectIdForRoute(state.route))?.kind === "virtual",
						remote: isRemote(),
					}}
					onRun={runCommand}
					onClose={() => setShowCommandPalette(false)}
				/>
			)}
			{showAddProjectModal && (
				<AddProjectModal
					dispatch={dispatch}
					onClose={() => setShowAddProjectModal(false)}
				/>
			)}
			{createTaskProject && (
				<CreateTaskModal
					project={createTaskProject}
					dispatch={dispatch}
					onClose={() => setCreateTaskProjectId(null)}
					onCreateAndRun={(task) => {
						setCreateTaskProjectId(null);
						setLaunchModal({ task, targetStatus: "in-progress", project: createTaskProject });
					}}
				/>
			)}
			{launchModal && (
				<LaunchVariantsModal
					task={launchModal.task}
					project={launchModal.project}
					targetStatus={launchModal.targetStatus}
					agents={agents}
					globalSettings={globalSettings}
					dispatch={dispatch}
					onClose={() => setLaunchModal(null)}
					onGlobalSettingsChange={setGlobalSettings}
				/>
			)}
			{pendingNavigation && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
					onMouseDown={(e) => {
						if (e.target === e.currentTarget) setPendingNavigation(null);
					}}
				>
					<div className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[26.25rem] p-6 space-y-4">
						<h2 className="text-fg text-lg font-semibold">{t("unsavedChanges.title")}</h2>
						<p className="text-fg-2 text-sm leading-relaxed">{t("unsavedChanges.message")}</p>
						<div className="flex justify-end gap-2 pt-1">
							<button
								onClick={() => setPendingNavigation(null)}
								className="px-4 py-2 text-sm rounded-lg text-fg-2 hover:text-fg hover:bg-elevated transition-colors"
							>
								{t("unsavedChanges.cancel")}
							</button>
							<button
								onClick={() => {
									const route = pendingNavigation;
									navigationGuardRef.current = null;
									setPendingNavigation(null);
									commitNavigation(route);
								}}
								className="px-4 py-2 text-sm rounded-lg text-danger hover:bg-danger/10 transition-colors"
							>
								{t("unsavedChanges.discard")}
							</button>
							<button
								onClick={async () => {
									const route = pendingNavigation;
									if (navigationGuardRef.current) {
										await navigationGuardRef.current.onSave();
									}
									navigationGuardRef.current = null;
									setPendingNavigation(null);
									commitNavigation(route);
								}}
								className="px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
							>
								{t("unsavedChanges.save")}
							</button>
						</div>
					</div>
				</div>
			)}
			{showQuitDialog && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
					onMouseDown={(e) => {
						if (e.target === e.currentTarget) setShowQuitDialog(false);
					}}
				>
					<div className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[26.25rem] p-6 space-y-4">
						<h2 className="text-fg text-lg font-semibold">{t("quit.dialogTitle")}</h2>
						<p className="text-fg-2 text-sm leading-relaxed">{t("quit.dialogMessage")}</p>
						<label className="flex items-center gap-2.5 cursor-pointer select-none">
							<input
								type="checkbox"
								checked={dontShowAgain}
								onChange={(e) => setDontShowAgain(e.target.checked)}
								className="w-4 h-4 rounded accent-accent"
							/>
							<span className="text-fg-2 text-sm">{t("quit.dontShowAgain")}</span>
						</label>
						<div className="flex justify-end gap-2 pt-1">
							<button
								onClick={() => setShowQuitDialog(false)}
								className="px-4 py-2 text-sm rounded-lg text-fg-2 hover:text-fg hover:bg-elevated transition-colors"
							>
								{t("quit.cancel")}
							</button>
							<button
								onClick={handleConfirmQuit}
								className="px-4 py-2 text-sm rounded-lg bg-danger text-white hover:bg-danger/80 transition-colors"
							>
								{t("quit.confirm")}
							</button>
						</div>
					</div>
				</div>
			)}
			{remoteQR && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
					onMouseDown={(e) => {
						if (e.target === e.currentTarget) { setRemoteQR(null); setTunnelStarting(false); }
					}}
				>
					<div className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[28rem] p-6 space-y-4 text-center">
						<h2 className="text-fg text-lg font-semibold">{t("remote.title")}</h2>
						<p className="text-fg-2 text-sm">{t("remote.subtitle")}</p>
						<div className="flex justify-center relative">
							<img src={remoteQR.qrDataUrl} alt="QR Code" className={`w-56 h-56 rounded-lg transition-all duration-500 ${qrConsumed ? "opacity-20 grayscale" : ""}`} />
							{qrConsumed && (
								<div className="absolute inset-0 flex items-center justify-center">
									<div className="bg-base/90 rounded-lg px-4 py-2">
										<span className="text-accent text-sm font-medium">{t("remote.connected")}</span>
									</div>
								</div>
							)}
						</div>
						{!qrConsumed && (
							<div className="flex items-center justify-center gap-2 text-fg-muted text-xs">
								<div className="w-4 h-4 relative">
									<svg className="w-4 h-4 -rotate-90" viewBox="0 0 20 20">
										<circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
										<circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2"
											strokeDasharray={`${(qrCountdown / 25) * 50.3} 50.3`}
											strokeLinecap="round"
											className="transition-all duration-1000 ease-linear"
										/>
									</svg>
								</div>
								<span>{t("remote.refreshIn", { seconds: String(qrCountdown) })}</span>
							</div>
						)}
						{/* Interface picker — choose which local IP the QR/URL points at.
						    Only relevant when the tunnel is off (the tunnel URL is public). */}
						{!tunnelWanted && remoteQR.interfaces && remoteQR.interfaces.length > 0 && (
							<div className="text-left">
								<label htmlFor="remote-iface-select" className="text-fg-2 text-xs">{t("remote.addressLabel")}</label>
								<select
									id="remote-iface-select"
									value={remoteQR.selectedHost ?? ""}
									disabled={qrConsumed}
									onChange={(e) => {
										const host = e.target.value;
										api.request.getRemoteAccessQR({ tunnel: false, host }).then((res) => {
											setRemoteQR(res);
											setQrCountdown(25);
										}).catch(() => {});
									}}
									className="mt-1 w-full px-2 py-1.5 bg-elevated border border-edge rounded-lg text-fg text-xs outline-none focus:border-accent/40 transition-colors disabled:opacity-40"
								>
									{remoteQR.interfaces.map((iface) => (
										<option key={`${iface.name}-${iface.address}`} value={iface.address}>
											{iface.internal ? `${t("remote.localhostLabel")} · ${iface.address}` : `${iface.name} · ${iface.address}`}
										</option>
									))}
								</select>
							</div>
						)}
						<div className={`bg-base rounded-lg p-3 ${qrConsumed ? "opacity-40" : ""}`}>
							<code className={`text-xs break-all ${qrConsumed ? "text-fg-3" : "text-fg select-all"}`}>{remoteQR.accessUrl}</code>
						</div>

						{/* Tunnel toggle */}
						<div className="bg-base rounded-lg p-3 text-left space-y-2">
							<label className="flex items-center gap-2 cursor-pointer select-none">
								<input
									type="checkbox"
									checked={tunnelWanted}
									onChange={(e) => {
										const want = e.target.checked;
										setTunnelWanted(want);
										if (want && remoteQR.cloudflaredInstalled && remoteQR.tunnelState === "idle") {
											setTunnelStarting(true);
											api.request.getRemoteAccessQR({ tunnel: true }).then((res) => {
												setRemoteQR(res);
												setTunnelStarting(false);
												setQrCountdown(25);
											}).catch(() => setTunnelStarting(false));
										} else if (!want && remoteQR.tunnelState === "connected") {
											api.request.stopTunnel().then(() => {
												api.request.getRemoteAccessQR({ tunnel: false }).then((res) => {
													setRemoteQR(res);
													setQrCountdown(25);
												}).catch(() => {});
											}).catch(() => {});
										}
									}}
									className="accent-accent w-4 h-4"
								/>
								<span className="text-fg text-sm">{t("remote.anywhereToggle")}</span>
							</label>

							{tunnelWanted && !remoteQR.cloudflaredInstalled && (
								<div className="text-left space-y-1.5">
									<p className="text-danger text-xs">{t("remote.cloudflaredNotFound")}</p>
									<p className="text-fg-muted text-xs">{t("remote.cloudflaredInstall")}</p>
									<button
										onClick={() => {
											api.request.getRemoteAccessQR({ tunnel: tunnelWanted }).then((res) => {
												setRemoteQR(res);
											}).catch(() => {});
										}}
										className="text-xs text-accent hover:text-accent-hover transition-colors"
									>
										{t("remote.recheckCloudflared")}
									</button>
								</div>
							)}

							{tunnelWanted && remoteQR.cloudflaredInstalled && (tunnelStarting || remoteQR.tunnelState === "starting") && (
								<div className="flex items-center gap-2">
									<div className="w-3 h-3 rounded-full bg-accent animate-pulse" />
									<span className="text-fg-3 text-xs">{t("remote.tunnelStarting")}</span>
								</div>
							)}

							{tunnelWanted && remoteQR.tunnelState === "connected" && (
								<div className="flex items-center gap-2">
									<div className="w-2 h-2 rounded-full bg-green-400" />
									<span className="text-green-400 text-xs">{t("remote.tunnelConnected")}</span>
								</div>
							)}

							{tunnelWanted && remoteQR.tunnelState === "failed" && (
								<div className="flex items-center gap-2">
									<div className="w-2 h-2 rounded-full bg-danger" />
									<span className="text-danger text-xs">{t("remote.tunnelFailed")}</span>
								</div>
							)}
						</div>

						<RemoteAccessExposedPorts />

						<div className="flex items-center justify-center gap-2">
							<button
								onClick={() => {
									if (!qrConsumed) navigator.clipboard.writeText(remoteQR.accessUrl).catch(() => {});
								}}
								disabled={qrConsumed}
								className={`px-4 py-2 text-sm rounded-lg transition-colors ${qrConsumed ? "bg-elevated text-fg-3 cursor-not-allowed" : "bg-accent text-white hover:bg-accent-hover"}`}
							>
								{t("remote.copyUrl")}
							</button>
							<button
								onClick={() => { setRemoteQR(null); setTunnelStarting(false); }}
								className="px-4 py-2 text-sm rounded-lg text-fg-2 hover:text-fg hover:bg-elevated transition-colors"
							>
								{t("remote.close")}
							</button>
						</div>
					</div>
				</div>
			)}
			<ToastHost />
			<StuckPreparationPopover tasks={state.currentProjectTasks} />
			<FolderPickerHost />
			<KeyboardShortcutsModal
				open={shortcutsModal.open}
				tab={shortcutsModal.tab}
				onTabChange={(tab) => setShortcutsModal((s) => ({ ...s, tab }))}
				onClose={() => setShortcutsModal((s) => ({ ...s, open: false }))}
			/>
			<ConfirmHost />
			{aboutVersion && <AboutModal version={aboutVersion} onClose={() => setAboutVersion(null)} />}
		</div>
	);

	function renderScreen() {
		switch (route.screen) {
			case "dashboard":
				return (
					<Dashboard
						projects={state.projects}
						dispatch={dispatch}
						navigate={navigate}
						bellCounts={state.bellCounts}
						onOpenAddProject={() => setShowAddProjectModal(true)}
					/>
				);
			case "project":
				return (
					<ProjectView
						projectId={route.projectId}
						projects={state.projects}
						tasks={state.currentProjectTasks}
						dispatch={dispatch}
						navigate={navigate}
						bellCounts={state.bellCounts}
						bellReasons={state.bellReasons}
						taskPorts={state.taskPorts}
						taskResourceUsage={state.taskResourceUsage}
						activeTaskId={route.activeTaskId}
						taskView={route.taskView}
						navigationGuardRef={navigationGuardRef}
					/>
				);
			case "project-terminal": {
				const proj = state.projects.find((p) => p.id === route.projectId);
				return proj ? (
					<div className="flex-1 min-h-0 flex flex-col">
						<ProjectTerminal
							projectId={route.projectId}
							projectPath={proj.path}
							onBack={() => navigate({ screen: "project", projectId: route.projectId })}
						/>
					</div>
				) : null;
			}
			case "task":
				return (
					<TaskWorkspaceView
						projectId={route.projectId}
						taskId={route.taskId}
						tasks={state.currentProjectTasks}
						projects={state.projects}
						navigate={navigate}
						dispatch={dispatch}
						navigationGuardRef={navigationGuardRef}
					/>
				);
			case "project-settings":
				return (
					<ProjectSettings
						projectId={route.projectId}
						projects={state.projects}
						tasks={state.currentProjectTasks}
						dispatch={dispatch}
						navigate={navigate}
						navigationGuardRef={navigationGuardRef}
						initialTab={route.tab}
						initialWorktreeTaskId={route.worktreeTaskId}
					/>
				);
			case "settings":
				return <GlobalSettings />;
			case "changelog":
				return (
					<Changelog
						navigate={navigate}
						goBack={() => dispatch({ type: "goBack" })}
						canGoBack={state.historyIndex > 0}
					/>
				);
			case "stats":
				return (
					<ProductivityStatsView
						navigate={navigate}
						goBack={() => dispatch({ type: "goBack" })}
						canGoBack={state.historyIndex > 0}
					/>
				);
			case "gauge-demo":
				return <GaugeDemo navigate={navigate} />;
			case "viewport-lab":
				return <ViewportLab navigate={navigate} />;
			default:
				return null;
		}
	}
}

export default App;
