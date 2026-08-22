import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useAppState, routeTaskId, projectIdForRoute, routeAfterTaskClosed, getTaskOpenMode, OPEN_SETTINGS_SECTION_EVENT, type OpenSettingsSectionDetail, type Route } from "./state";
import { api, isElectrobun, getRpcConnectionState } from "./rpc";
import { setWebNotificationsSuppressed, showWebNotificationOrToast, type WebNotificationDetail } from "./utils/webNotification";
import { useT, useLocale } from "./i18n";
import { useStreamerMode } from "./streamer-mode";
import { isProjectSilencedForDisplay, setSensitiveProjectIds } from "./sensitive-projects";
import { statusKey } from "./i18n/status";
import { columnAgentFailureCopy } from "./utils/columnAgentFailureToast";
import { handleMenuAction } from "./menuRouter";
import { trackPageView, trackEvent, registerAgents } from "./analytics";
import type { AgentLaunchRequest, AppRPCSchema, CodingAgent, GlobalSettings as GlobalSettingsType, Project, RemoteNetInterface, RequirementCheckResult, RosettaWarningInfo, SharedArtifact, SharedImage, Task, TaskDialogSubject, TaskStatus, UpdateChangelog } from "../shared/types";
import { orderProjectsForDisplay, taskSeqLabel, getTaskTitle } from "../shared/types";
import type { DeepLinkNav } from "../shared/deep-link";
import { useGlobalShortcut } from "./hooks/useGlobalShortcut";
import { isRemote } from "./utils/platform";
import { isTypingContext } from "./utils/typing-context";
import { matchesShortcut } from "./keymap";
import { setShortcutOverrides } from "./keymap-store";
import { syncTerminalBidiFromGlobalSettings } from "./terminal-bidi/flag";
import { adjustZoom, applyZoom, mobileDensityForRoute, setMobileDensity, ZOOM_STEP, DEFAULT_ZOOM } from "./zoom";
import { useViewport } from "./hooks/useViewport";
import { useMobile } from "./hooks/useMobile";
import { useAndroidBackGuard } from "./hooks/useAndroidBackGuard";
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
import NativePaneLayoutLab from "./labs/native-pane/NativePaneLayoutLab";
import { setToastSuppressed, taskToastContext, ToastHost, toast, type ToastEntry, type ToastOrigin } from "./toast";
import StuckPreparationPopover from "./components/StuckPreparationPopover";
import FolderPickerHost from "./components/FolderPickerModal";
import KeyboardShortcutsModal, { type ShortcutsTab } from "./components/KeyboardShortcutsModal";
import UpdatePopoverSimulatorModal from "./components/UpdatePopoverSimulatorModal";
import RemoteAccessDialog from "./components/RemoteAccessDialog";
import RemoteAccessExposedPorts from "./components/RemoteAccessExposedPorts";
import { ConfirmHost, confirm } from "./confirm";
import AgentLaunchRequestModal from "./components/AgentLaunchRequestModal";
import AboutModal from "./components/AboutModal";
import FeatureFlagsModal from "./components/FeatureFlagsModal";
import TerminalPerfOverlay from "./components/TerminalPerfOverlay";
import FilePreviewModal from "./components/FilePreviewModal";
import { OPEN_FILE_PREVIEW_EVENT, type OpenFilePreviewDetail } from "./terminal-path-open";
import RosettaWarningModal from "./components/RosettaWarningModal";
import { initTaskSoundPlayback, playTaskCompletionSound, playTaskSoundFromPush, setTaskCompletionSoundEnabled } from "./task-sounds";
import { offerMergeCompletion } from "./utils/offerMergeCompletion";
import { taskDialogInfoFromSubject } from "./utils/taskDialogInfo";
import { createAgentRequestAbort } from "./utils/agentRequestAbort";
import { getRecentProjectIds, orderByRecency, recordProjectJump } from "./utils/recentProjects";
import type { NavigationGuard } from "./navigation-guard";
import { useTaskSwitcher } from "./hooks/useTaskSwitcher";
import TaskSwitcherOverlay from "./components/TaskSwitcherOverlay";
import ProjectQuickSwitchModal from "./components/ProjectQuickSwitchModal";
import CommandPaletteModal from "./components/CommandPaletteModal";
import OpenInPickerModal from "./components/OpenInPickerModal";
import TaskImageViewer from "./components/TaskImageViewer";
import TaskArtifactViewer from "./components/TaskArtifactViewer";
import HintOverlay from "./components/HintOverlay";
import HelpOverlay from "./components/HelpOverlay";
import { HELP_LINK_ACTION_EVENT, type HelpLinkAction } from "./help";
import BootstrapScreen, { type BootPhase } from "./components/BootstrapScreen";
import DiagnosticsPanel from "./components/DiagnosticsPanel";
import StatusDock from "./components/StatusDock";
import TerminalImmersiveChrome from "./components/TerminalImmersiveChrome";
import { useRpcStatus } from "./hooks/useDiagnostics";
import { reconnectRpc } from "./rpc";
import { DIAGNOSTICS_OPEN_EVENT } from "./diagnostics";
import { getAdjacentAliveVariant } from "./utils/variantGroups";
import { isTaskTerminalRoute } from "./utils/terminalFullscreen";

/** Command shown when cloudflared is missing (Cloudflare Tunnel remote access). */
const CLOUDFLARED_INSTALL_CMD = "brew install cloudflared";

/** QR token rotation period; the token's own TTL (`QR_TOKEN_TTL_S`) adds 5s headroom. */
const QR_REFRESH_SECONDS = 60;

/** Whether the Debug → Terminal Performance overlay is showing. */
const TERMINAL_PERF_KEY = "dev3-terminal-perf";

type RemoteAccessQRData = {
	qrDataUrl: string;
	accessUrl: string;
	tunnelState: string;
	cloudflaredInstalled: boolean;
	interfaces?: RemoteNetInterface[];
	selectedHost?: string;
};

function isRemoteTunnelActive(tunnelState?: string): boolean {
	return tunnelState === "starting" || tunnelState === "connected";
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
	const handleToastOverflow = useCallback((entry: ToastEntry) => {
		if (!entry.taskId) return;
		dispatch({ type: "addBell", taskId: entry.taskId, reason: entry.message, force: true });
	}, [dispatch]);
	const t = useT();
	const [, setLocale] = useLocale();
	const [terminalImmersive, setTerminalImmersive] = useState(false);
	const terminalImmersiveVisible = terminalImmersive && isTaskTerminalRoute(state.route);
	const skipNextTerminalCopyResetRef = useRef(false);
	const skipTerminalCopyReset = terminalImmersiveVisible || skipNextTerminalCopyResetRef.current;
	const setTerminalImmersiveActive = useCallback((active: boolean) => {
		if (active) {
			skipNextTerminalCopyResetRef.current = true;
			setToastSuppressed(true);
			setWebNotificationsSuppressed(true);
			setTerminalImmersive(true);
			void api.request.setTerminalFocus?.({ active: true })?.catch?.(() => { /* best-effort */ });
			return;
		}

		skipNextTerminalCopyResetRef.current = true;
		setTerminalImmersive(false);
		// Release the renderer gate before asking the backend to flush. The backend
		// remains authoritative for agent notifications, while this ordering keeps
		// locally generated toasts from racing the queued push messages.
		setWebNotificationsSuppressed(false);
		setToastSuppressed(false);
		void api.request.setTerminalFocus?.({ active: false })?.catch?.(() => { /* best-effort */ });
	}, []);
	useEffect(() => {
		// Immersive toggling remounts the workspace tree. Clear the one-shot marker
		// after its new tree has rendered so ordinary task navigation still resets a
		// genuinely stale tmux copy-mode session.
		skipNextTerminalCopyResetRef.current = false;
	}, [terminalImmersiveVisible]);

	useEffect(() => {
		return () => {
			setWebNotificationsSuppressed(false);
			setToastSuppressed(false);
			void api.request.setTerminalFocus?.({ active: false })?.catch?.(() => { /* best-effort */ });
		};
	}, []);
	useViewport(state.route);
	// A phone scales differently per screen: dense inside a task, roomy on the
	// screens the user only browses. No-op on a desktop-width viewport.
	useEffect(() => {
		setMobileDensity(mobileDensityForRoute(state.route));
	}, [state.route]);
	// Android hardware/gesture Back drives in-app navigation in mobile remote
	// mode: close the topmost layer → route back → double-back-to-exit toast.
	// Reads history depth through a ref so the popstate handler stays stable.
	const isMobileDevice = useMobile();
	const historyIndexRef = useRef(state.historyIndex);
	historyIndexRef.current = state.historyIndex;
	useAndroidBackGuard({
		enabled: isMobileDevice && !isElectrobun,
		routeBack: () => {
			if (historyIndexRef.current <= 0) return false;
			dispatch({ type: "goBack" });
			return true;
		},
		showExitToast: () => toast.info(t("mobile.backExitToast"), { durationMs: 2_500 }),
	});
	// RPC/WebSocket connection state — drives the bootstrap screen's "Connecting…"
	// phase so a stuck remote/mobile launch tells the user WHERE it's stuck.
	const rpcState = useRpcStatus();
	// In-UI diagnostics viewer (opened from the floating indicator / menu).
	const [showDiagnostics, setShowDiagnostics] = useState(false);

	// Listen for menu actions routed from the bun side. Any menu item that the
	// renderer is responsible for arrives here as `rpc:menuAction` with
	// `{ action: <string> }`. The router in `menuRouter.ts` handles dispatch.
	useEffect(() => {
		function onMenuAction(e: Event) {
			const detail = (e as CustomEvent).detail;
			if (!detail?.action) return;
			handleMenuAction(detail.action, { state, dispatch, setLocale, t }).catch((err) => {
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
	// Dev-only update-popover simulator (View → Debug → Update Popover Preview).
	const [updatePreviewOpen, setUpdatePreviewOpen] = useState(false);
	useEffect(() => {
		function onShowTmux() { setShortcutsModal({ open: true, tab: "terminal" }); }
		function onShowKeyboard() { setShortcutsModal({ open: true, tab: "app" }); }
		function onEnterHelpMode() { setHelpMode(true); }
		function onShowUpdatePreview() { setUpdatePreviewOpen(true); }
		window.addEventListener("menu:show-tmux-cheat-sheet", onShowTmux);
		window.addEventListener("menu:show-keyboard-shortcuts", onShowKeyboard);
		window.addEventListener("menu:enter-help-mode", onEnterHelpMode);
		window.addEventListener("menu:show-update-popover-preview", onShowUpdatePreview);
		return () => {
			window.removeEventListener("menu:show-tmux-cheat-sheet", onShowTmux);
			window.removeEventListener("menu:show-keyboard-shortcuts", onShowKeyboard);
			window.removeEventListener("menu:enter-help-mode", onEnterHelpMode);
			window.removeEventListener("menu:show-update-popover-preview", onShowUpdatePreview);
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

	// Pending agent-initiated launch requests; only the head is on screen.
	const [launchRequests, setLaunchRequests] = useState<AgentLaunchRequest[]>([]);

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
	/** The channel baked into the running bundle — what tells a canary install from the release. */
	const [aboutBuildChannel, setAboutBuildChannel] = useState<string | null>(null);
	const [showFeatureFlags, setShowFeatureFlags] = useState(false);
	// Perf work means restarting the app between code changes, so the HUD survives
	// a reload rather than making the user re-open the menu every single time.
	const [showTerminalPerf, setShowTerminalPerf] = useState(
		() => localStorage.getItem(TERMINAL_PERF_KEY) === "1",
	);

	// Silent update indicator
	const [updateVersion, setUpdateVersion] = useState<string | null>(null);
	// "What's new" summary for the ready update (features-first), shown in the header popover
	const [updateChangelog, setUpdateChangelog] = useState<UpdateChangelog | null>(null);
	// Bumped on every update announcement so a repeat one (same version, user
	// postponed earlier) re-opens the restart prompt instead of being swallowed
	// by unchanged `updateVersion` state.
	const [updateAnnouncement, setUpdateAnnouncement] = useState(0);
	// Download progress: null = idle, "checking" | "downloading" | "error"
	const [updateDownloadStatus, setUpdateDownloadStatus] = useState<string | null>(null);
	const updateStatusShownAtRef = useRef<number>(0);
	const updateClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Remote access QR code modal
	const [remoteQR, setRemoteQR] = useState<RemoteAccessQRData | null>(null);
	const [remoteAccessActive, setRemoteAccessActive] = useState(false);
	const [tunnelWanted, setTunnelWanted] = useState(false);
	const [tunnelStarting, setTunnelStarting] = useState(false);
	const [cloudflaredCopied, setCloudflaredCopied] = useState(false);
	const [remoteUrlCopyState, setRemoteUrlCopyState] = useState<"idle" | "copying" | "copied">("idle");
	const applyRemoteQR = useCallback((next: RemoteAccessQRData) => {
		setRemoteQR(next);
		setRemoteAccessActive(isRemoteTunnelActive(next.tunnelState));
	}, []);

	// System requirements gate
	const [reqStatus, setReqStatus] = useState<"checking" | "failed" | "passed">("checking");
	const [reqResults, setReqResults] = useState<RequirementCheckResult[]>([]);
	const [reqChecking, setReqChecking] = useState(false);

	// GitHub CLI availability warning
	const [ghWarning, setGhWarning] = useState<{ notInstalled: boolean } | null>(null);
	const [showAddProjectModal, setShowAddProjectModal] = useState(false);
	// Spaces a project created from a space flow should join on creation.
	const [addProjectSpaceIds, setAddProjectSpaceIds] = useState<string[]>([]);
	const [openAddProjectOnDashboard, setOpenAddProjectOnDashboard] = useState(false);
	const [showProjectSwitch, setShowProjectSwitch] = useState(false);
	// Cmd/Ctrl+O picker when no app is chosen yet (or the chosen one is gone).
	const [openInPicker, setOpenInPicker] = useState<{ path: string; taskId?: string } | null>(null);
	const [showCommandPalette, setShowCommandPalette] = useState(false);
	// Vimium-style task hint navigation overlay (toggled with `f` on the board).
	const [hintMode, setHintMode] = useState(false);
	// Help mode — the "Explain this screen" overlay (bible §5.4). Entered via
	// ⇧⌘/, Help menu, the ⇧⌘P palette, or a HelpCard "Explain this screen" link.
	const [helpMode, setHelpMode] = useState(false);

	// HelpCard navigation links dispatch a window event (no prop drilling from
	// arbitrary HelpSpot hosts) — route them to the owning overlays here.
	useEffect(() => {
		function onHelpLink(e: Event) {
			const action = (e as CustomEvent<HelpLinkAction>).detail;
			if (action === "open-keyboard-shortcuts") setShortcutsModal({ open: true, tab: "app" });
			else if (action === "enter-help-mode") setHelpMode(true);
		}
		window.addEventListener(HELP_LINK_ACTION_EVENT, onHelpLink);
		return () => window.removeEventListener(HELP_LINK_ACTION_EVENT, onHelpLink);
	}, []);
	const [createTaskProjectId, setCreateTaskProjectId] = useState<string | null>(null);
	// Prefill for the Create Task modal when opened from a `dev3://new-task` deep
	// link. Consumed once by CreateTaskModal's initial description; cleared on close.
	const [createTaskInitialText, setCreateTaskInitialText] = useState<string>("");
	const [launchModal, setLaunchModal] = useState<{ task: Task; targetStatus: TaskStatus; project: Project } | null>(null);
	// Lightbox for images an agent surfaced via `dev3 show-image`, bound to a task.
	// `newIds` freezes which images were unread at open time: opening marks them
	// read, so without the snapshot the "these three are new" highlight would
	// vanish on the same tick. It only ever grows while the viewer stays open.
	const [imageViewer, setImageViewer] = useState<{ taskId: string; images: SharedImage[]; index: number; newIds: string[] } | null>(null);
	const [filePreview, setFilePreview] = useState<OpenFilePreviewDetail | null>(null);
	// `standalone` requests come from surfaces with no workspace pane to dock into
	// (the archived task modal) and are hosted as an overlay here instead.
	const [artifactViewer, setArtifactViewer] = useState<{ taskId: string; artifacts: SharedArtifact[]; index: number; standalone?: boolean } | null>(null);
	const markSharedItemsRead = useCallback((
		projectId: string,
		taskId: string,
		kind: "images" | "artifacts",
		items: Array<{ id: string; isUnread?: boolean }>,
	) => {
		const itemIds = items.filter((item) => item.isUnread).map((item) => item.id);
		if (itemIds.length === 0) return;
		void api.request.markTaskSharedItemsRead({ projectId, taskId, kind, itemIds })
			.then((task) => dispatch({ type: "updateTask", task }))
			.catch((error) => console.error("Failed to mark shared items read:", error));
	}, [dispatch]);
	/**
	 * Single entry point for the shared-images lightbox. Marks the batch read,
	 * remembers which ids were new, and — unless the caller picked a specific
	 * image — opens on the FIRST unread one so a batch of three is read in the
	 * order the agent published it. Re-opening while the viewer is already up for
	 * that task keeps the user's position and only widens the highlight.
	 */
	const openImageViewer = useCallback((
		projectId: string,
		taskId: string,
		images: SharedImage[],
		index?: number,
	) => {
		const unreadIds = images.filter((image) => image.isUnread).map((image) => image.id);
		const firstUnread = images.findIndex((image) => image.isUnread);
		markSharedItemsRead(projectId, taskId, "images", images);
		setImageViewer((prev) => {
			if (prev?.taskId === taskId) {
				return { ...prev, images, newIds: [...new Set([...prev.newIds, ...unreadIds])] };
			}
			return {
				taskId,
				images,
				index: index ?? (firstUnread >= 0 ? firstUnread : images.length - 1),
				newIds: unreadIds,
			};
		});
	}, [markSharedItemsRead]);
	const closeArtifactViewer = useCallback(() => {
		setArtifactViewer(null);
		requestAnimationFrame(() => {
			document.querySelector<HTMLButtonElement>("[data-testid='shared-artifacts-badge']")?.focus();
		});
	}, []);
	const [agents, setAgents] = useState<CodingAgent[]>([]);
	const [agentSettingsLoaded, setAgentSettingsLoaded] = useState(false);
	const [globalSettings, setGlobalSettings] = useState<GlobalSettingsType>({
		defaultAgentId: "builtin-claude",
		defaultConfigId: "claude-auto",
		taskSortOrder: "oldest-first",
		updateChannel: "stable",
	});
	// Auth failure for browser remote access (expired/invalid session).
	// Seeded from the transport: with a dead session the expired verdict lands
	// BEFORE React mounts (the boot probe on localhost beats the app bootstrap),
	// so waiting for the rpc:authFailed event alone would miss it and leave the
	// user on an eternal "Loading…" spinner.
	const [authFailed, setAuthFailed] = useState(() => getRpcConnectionState() === "auth-failed");

	useEffect(() => {
		function onAuthFailed() { setAuthFailed(true); }
		window.addEventListener("rpc:authFailed", onAuthFailed);
		return () => window.removeEventListener("rpc:authFailed", onAuthFailed);
	}, []);

	// Open the diagnostics viewer on request (floating indicator / menu action).
	useEffect(() => {
		function onOpenDiagnostics() { setShowDiagnostics(true); }
		window.addEventListener(DIAGNOSTICS_OPEN_EVENT, onOpenDiagnostics);
		return () => window.removeEventListener(DIAGNOSTICS_OPEN_EVENT, onOpenDiagnostics);
	}, []);

	useEffect(() => {
		initTaskSoundPlayback();
	}, []);

	// Load the settings this component mirrors into module state (completion
	// sound, shortcut rebinds, terminal BiDi). Without it they stay at the
	// hardcoded defaults until the user opens Settings — which re-enabled the
	// completion sound on every launch for users who had turned it off (#1337).
	useEffect(() => {
		let alive = true;
		api.request.getGlobalSettings()
			.then((next) => { if (alive) setGlobalSettings(next); })
			.catch(() => {});
		return () => { alive = false; };
	}, []);

	// Mirror the completion-sound setting into the task-sounds module so the UI
	// can gate its instant client-side playback without a round-trip.
	useEffect(() => {
		setTaskCompletionSoundEnabled(globalSettings.playSoundOnTaskComplete !== false);
	}, [globalSettings.playSoundOnTaskComplete]);

	// Mirror user shortcut rebinds into the keymap store — the keydown dispatcher
	// reads it synchronously, so it cannot go through React state.
	useEffect(() => {
		setShortcutOverrides(globalSettings.keyboardShortcuts);
	}, [globalSettings.keyboardShortcuts]);

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

	// Rosetta warning: an Intel (x64) build running translated on Apple Silicon.
	// Shown once per launch while the condition persists — it clears itself
	// after the user reinstalls the native arm64 build.
	const [rosettaWarning, setRosettaWarning] = useState<RosettaWarningInfo>(null);
	useEffect(() => {
		api.request
			.getRosettaWarning()
			.then(setRosettaWarning)
			.catch((err) => console.error("Failed to check Rosetta status:", err));
	}, []);

	// Navigation guard for unsaved-changes prompts (e.g. ProjectSettings, diff viewer)
	const navigationGuardRef = useRef<NavigationGuard | null>(null);
	const [pendingNavigation, setPendingNavigation] = useState<Route | null>(null);

	// Latest route mirror — async event handlers read this to make routing decisions
	// without re-subscribing every navigation.
	const routeRef = useRef<Route>(state.route);
	useEffect(() => {
		routeRef.current = state.route;
	}, [state.route]);

	// Drive document.title from the current route so the browser tab shows the
	// project/task name — the only orientation cue in remote (browser) mode.
	// Streamer mode locks every project the user flagged `sensitive`: it cannot be
	// entered, so a stray click during a recording cannot expose it.
	const streamerModeOn = useStreamerMode();
	const isRouteLocked = useCallback(
		(route: Route) => {
			if (!streamerModeOn) return false;
			const projectId = projectIdForRoute(route);
			if (!projectId) return false;
			return Boolean(state.projects.find((p) => p.id === projectId)?.sensitive);
		},
		[streamerModeOn, state.projects],
	);

	// The base title (version string) from main.tsx is captured once on first run
	// and preserved as the suffix; only the context prefix changes per route.
	const baseTitleRef = useRef("");
	useEffect(() => {
		const { route } = state;
		if (!baseTitleRef.current) baseTitleRef.current = document.title;
		const base = baseTitleRef.current || "dev-3.0";
		let prefix = "";
		// A tab title cannot be blurred (CSS reaches the document, not the chrome),
		// so a sensitive project's context is replaced rather than masked.
		const locked = isRouteLocked(route);
		if (locked) {
			prefix = `${t("streamer.privateTitle")} · `;
		} else if (route.screen === "project" || route.screen === "project-terminal" || route.screen === "project-settings") {
			const project = state.projects.find((p) => p.id === route.projectId);
			if (project) prefix = `${project.name} · `;
		} else if (route.screen === "task") {
			const task = state.currentProjectTasks.find((task) => task.id === route.taskId);
			if (task) prefix = `${getTaskTitle(task)} · `;
		}
		document.title = prefix ? `${prefix}${base}` : base;
	}, [state.route, state.currentProjectTasks, state.projects, isRouteLocked, t]);

	// Route persistence is enabled only after the initial restore attempt has
	// run (see the projects-load effect). Without this gate, the bootstrap
	// dashboard render would immediately overwrite the persisted last route
	// before we get a chance to read it back.
	const routePersistEnabledRef = useRef(false);

	// Persist the current route (debounced) so the app reopens on the same
	// surface after any restart — quit, reboot, or auto-update — mirroring the
	// window position restore. Read back once at launch by the projects-load
	// effect below.
	useEffect(() => {
		if (!routePersistEnabledRef.current) return;
		const route = state.route;
		const id = setTimeout(() => {
			api.request.saveLastRoute({ route: JSON.stringify(route) }).catch(() => {
				// Best-effort persistence — a failed write just means the next
				// launch falls back to the previous saved route (or dashboard).
			});
		}, 400);
		return () => clearTimeout(id);
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
			// One guard for every entry point into a sensitive project (card, Cmd+1..9,
			// Cmd+K, palette, deep link, notification click, hint overlay). Checked
			// before the dirty-form guard: a refused route must not prompt to save.
			if (isRouteLocked(route)) {
				toast.info(t("streamer.projectLocked"), { projectId: projectIdForRoute(route) ?? undefined });
				return;
			}
			if (navigationGuardRef.current?.isDirty()) {
				setPendingNavigation(route);
				return;
			}
			commitNavigation(route);
		},
		[commitNavigation, isRouteLocked, t],
	);

	const toggleTerminalImmersive = useCallback(() => {
		if (!isTaskTerminalRoute(routeRef.current)) return;
		setTerminalImmersiveActive(!terminalImmersive);
	}, [setTerminalImmersiveActive, terminalImmersive]);

	// Shared click-to-open path for every task notification surface. Exiting the
	// ephemeral terminal view happens before applying the user's normal open mode.
	const openTaskFromNotification = useCallback(
		(taskId: string, projectId: string) => {
			setTerminalImmersiveActive(false);
			if (!taskId || !projectId) return;
			const openMode = getTaskOpenMode();
			if (openMode === "fullscreen") {
				navigate({ screen: "task", projectId, taskId });
			} else {
				navigate({ screen: "project", projectId, activeTaskId: taskId });
			}
		},
		[navigate, setTerminalImmersiveActive],
	);


	useEffect(() => {
		if (terminalImmersive && !isTaskTerminalRoute(state.route)) {
			setTerminalImmersiveActive(false);
		}
	}, [state.route, setTerminalImmersiveActive, terminalImmersive]);

	// Deep-link into a Global Settings section (e.g. clicking a proxy-gated
	// preset in the launch picker dispatches this). Kept as a window event so no
	// surface needs a navigate prop threaded through it.
	useEffect(() => {
		function onOpenSettingsSection(e: Event) {
			const detail = (e as CustomEvent<OpenSettingsSectionDetail>).detail;
			if (typeof detail === "string") {
				navigate({ screen: "settings", section: detail });
				return;
			}
			navigate({ screen: "settings", section: detail.section, preset: detail.preset });
		}
		window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, onOpenSettingsSection);
		return () => window.removeEventListener(OPEN_SETTINGS_SECTION_EVENT, onOpenSettingsSection);
	}, [navigate]);

	// Switch to a project, preserving the current view shape the same way Cmd+1..9
	// does: in a task view with split open-mode, land in the target's task view
	// (no task selected); otherwise land on its Kanban board. Shared by the
	// Cmd+1..9 index shortcuts and the Cmd+K quick-switch palette.
	const navigateToProject = useCallback(
		(projectId: string) => {
			const route = state.route;
			const taskOpenMode = getTaskOpenMode();
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

	// Every toast has the same anatomy, so a call site only names where it came from
	// — a task, a project, or an app area — and the source line plus the default
	// click target are composed here. Task beats project; an app area needs no state
	// and is localized by the host itself. An unknown id resolves to nothing rather
	// than to a made-up source line.
	const currentProjectTasks = state.currentProjectTasks;
	const projects = state.projects;
	const resolveToastOrigin = useCallback(
		({ taskId, projectId }: ToastOrigin) => {
			const task = taskId ? currentProjectTasks.find((candidate) => candidate.id === taskId) : undefined;
			if (task) {
				const projectName = projects.find((p) => p.id === task.projectId)?.name;
				return {
					// getTaskTitle, not task.title — the push path composes the same line
					// through it, and the two must not disagree for the same task.
					context: taskToastContext(task.seq, projectName, getTaskTitle(task)),
					onClick: () => openTaskFromNotification(task.id, task.projectId),
				};
			}
			const project = projectId ? projects.find((p) => p.id === projectId) : undefined;
			if (project) return { context: project.name, onClick: () => navigateToProject(project.id) };
			return undefined;
		},
		[currentProjectTasks, projects, openTaskFromNotification, navigateToProject],
	);

	// Route an inbound `dev3://…` deep link (resolved by the backend) to the right
	// surface: jump to a task, open a project board, or open the Create Task modal
	// on a project prefilled with text. Reuses the same navigation the notification
	// click and Cmd+1..9 paths use.
	const handleDeepLink = useCallback(
		(nav: DeepLinkNav) => {
			if (nav.kind === "task") {
				openTaskFromNotification(nav.taskId, nav.projectId);
			} else if (nav.kind === "project") {
				navigateToProject(nav.projectId);
			} else {
				navigateToProject(nav.projectId);
				setCreateTaskInitialText(nav.text);
				setCreateTaskProjectId(nav.projectId);
			}
		},
		[navigateToProject, openTaskFromNotification],
	);

	const cycleVariant = useCallback((direction: -1 | 1): boolean => {
		const taskId = routeTaskId(state.route);
		const projectId = projectIdForRoute(state.route);
		if (!taskId || !projectId) return false;
		const currentTask = state.currentProjectTasks.find((candidate) => candidate.id === taskId);
		if (!currentTask?.groupId) return false;
		const variants = state.currentProjectTasks.filter(
			(candidate) => candidate.projectId === projectId && candidate.groupId === currentTask.groupId,
		);
		const next = getAdjacentAliveVariant(variants, currentTask.id, direction);
		if (!next) return false;
		navigate(state.route.screen === "task"
			? { screen: "task", projectId, taskId: next.id }
			: { screen: "project", projectId, activeTaskId: next.id });
		return true;
	}, [navigate, state.currentProjectTasks, state.route]);

	// Quick shell (⇧⌘`): spawn a fresh scratch op in the built-in Operations board
	// and jump to it. The backend launches it with the default agent + config.
	// Honor the `dev3-task-open-mode` preference like every other task-open path
	// (card click, notification, toast) — default "split" lands on the Operations
	// board with the task's workspace beside it (matching what the user sees when
	// they open the same task from the board), NOT a bare fullscreen terminal.
	const openQuickShell = useCallback(async () => {
		try {
			const task = await api.request.openQuickShell({});
			const openMode = getTaskOpenMode();
			if (openMode === "fullscreen") {
				navigate({ screen: "task", projectId: task.projectId, taskId: task.id });
			} else {
				navigate({ screen: "project", projectId: task.projectId, activeTaskId: task.id });
			}
		} catch (err) {
			toast.error(String(err), { source: "dashboard" });
		}
	}, [navigate]);

	useEffect(() => {
		function onOpenQuickShell() { void openQuickShell(); }
		window.addEventListener("menu:open-quick-shell", onOpenQuickShell);
		return () => window.removeEventListener("menu:open-quick-shell", onOpenQuickShell);
	}, [openQuickShell]);

	// Cmd/Ctrl+O — always open the "Open in…" picker for the active task's worktree,
	// or the current project when no task is active. The picker lists the installed
	// apps and opens the chosen one (see OpenInPickerModal).
	const openInCurrent = useCallback(() => {
		const taskId = routeTaskId(state.route);
		const activeTask = taskId ? state.currentProjectTasks.find((task) => task.id === taskId) : null;
		const projectId = projectIdForRoute(state.route);
		const project = projectId ? state.projects.find((p) => p.id === projectId) : null;
		const path = activeTask?.worktreePath || project?.path || null;
		if (!path) return;
		setOpenInPicker({ path, taskId: activeTask?.id });
	}, [state.route, state.currentProjectTasks, state.projects]);

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
			handleMenuAction(actionId, { state, dispatch, setLocale, t }).catch((err) => {
				console.error("[App] runCommand failed", err);
			});
		},
		[state, dispatch, setLocale],
	);

	// Browser-mode menu bar (`AppMenuBar`) dispatches through the same router as
	// the native menu and the command palette.
	const handleMenuBarAction = useCallback(
		(actionId: string) => {
			handleMenuAction(actionId, { state, dispatch, setLocale, t }).catch((err) => {
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

	// Global app shortcuts — capture phase so the terminal can't swallow them.
	//
	// Every condition below is `matchesShortcut(e, "<keymap.ts id>")`: the registry
	// owns the combos, so a user rebind in Settings → Keyboard lands here for free.
	// Never hand-write a modifier condition — add the binding to `keymap.ts`.
	useGlobalShortcut(
		(e) => {
			if (!e.repeat && matchesShortcut(e, "terminal-fullscreen")) {
				if (!isTaskTerminalRoute(state.route)) return;
				e.preventDefault();
				e.stopPropagation();
				toggleTerminalImmersive();
				return;
			}
			// While hint mode is active the overlay owns every keystroke.
			if (hintMode) return;

			// ── A `g …` go-to sequence in flight owns the next keystroke, ahead of
			// every combo below — otherwise `g` then `c` would create a task instead
			// of cancelling. Structural (a key sequence, not a combo), so it stays
			// hand-written and non-remappable; see keymap.ts `go-to`. Matched on
			// `e.code` so it works on every layout (Cyrillic, Hebrew, …). ──
			if (goToModeRef.current && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !isTypingContext()) {
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
					if (e.code === "Digit0") {
						// `g 0` — the Operations board, mirroring ⌘0. The chord is the
						// only route in remote, where ⌘0 is the browser's reset-zoom.
						const ops = state.projects.find((p) => p.builtin && p.kind === "virtual" && !p.deleted);
						if (!ops) return;
						e.preventDefault();
						e.stopPropagation();
						return navigateToProject(ops.id);
					}
					const n = digitFromCode(e.code);
					if (n !== null) {
						// `g <digit>` — jump to project N keeping the current view.
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
			// In browser remote mode the native menu is gone and the browser claims
			// several modifier combos. `scope: "desktop"` shortcuts and `desktopOnly`
			// bindings simply stop matching there, so the browser keeps its native
			// behavior; aliased ones (⌘1–9 → `G then 1–9`, ⌘N → `C`) fall back to
			// their bare-key path. Source of truth: `keymap.ts`.
			const remote = isRemote();
			if (matchesShortcut(e, "quit")) {
				// WKWebView swallows the native menu Cmd+Q accelerator while a
				// terminal has focus, so we catch it here (capture phase) and ask
				// the main process to start the quit. The `before-quit` gate then
				// pushes `showQuitDialog` back, or quits if the user opted out.
				e.preventDefault();
				e.stopPropagation();
				api.request.requestQuit().catch(() => {});
			} else if (matchesShortcut(e, "hide")) {
				e.preventDefault();
				e.stopPropagation();
				api.request.hideApp().catch(() => {});
			} else if (matchesShortcut(e, "open-in")) {
				// Open the current project/worktree in the selected app, or the
				// "Open in..." picker when nothing is chosen yet.
				e.preventDefault();
				e.stopPropagation();
				openInCurrent();
			} else if (matchesShortcut(e, "new-window")) {
				// The native menu item has no accelerator because Electrobun can't bind
				// chord shortcuts (decision 044), so the renderer owns this one.
				e.preventDefault();
				e.stopPropagation();
				api.request.openNewWindow().catch(() => {});
			} else if (matchesShortcut(e, "new-task")) {
				if (createTaskProjectId || showAddProjectModal || showQuitDialog) return;
				if (!openCreateTaskModal()) return;
				e.preventDefault();
				e.stopPropagation();
			} else if (matchesShortcut(e, "add-project")) {
				e.preventDefault();
				e.stopPropagation();
				if (showQuitDialog) return;
				openAddProject();
			} else if (matchesShortcut(e, "go-to-project")) {
				// Project quick-switch palette (Slack/Linear/VSCode "go to anything").
				// Not Cmd+T: that's the universal new-tab key and the live terminal
				// underneath (ghostty/tmux) intercepts it.
				e.preventDefault();
				e.stopPropagation();
				if (showQuitDialog || createTaskProjectId || showAddProjectModal) return;
				setShowProjectSwitch((open) => !open);
			} else if (matchesShortcut(e, "command-palette")) {
				// The action (command) palette (VSCode convention). The navigation
				// sibling is `go-to-project`.
				e.preventDefault();
				e.stopPropagation();
				if (showQuitDialog || createTaskProjectId || showAddProjectModal) return;
				setShowCommandPalette((open) => !open);
			} else if (matchesShortcut(e, "keyboard-shortcuts")) {
				// Capture phase so the live terminal underneath can't swallow it. Bare
				// `?` is intentionally NOT used — the terminal must still receive it.
				e.preventDefault();
				e.stopPropagation();
				setShortcutsModal((s) => (s.open ? { ...s, open: false } : { open: true, tab: "app" }));
			} else if (matchesShortcut(e, "help-mode")) {
				// Help mode ("Explain this screen"): every data-help-id zone gets an (i)
				// badge with a HelpCard. Sibling of the shortcuts reference overlay.
				e.preventDefault();
				e.stopPropagation();
				if (showQuitDialog) return;
				setHelpMode((open) => !open);
			} else if (matchesShortcut(e, "settings")) {
				e.preventDefault();
				e.stopPropagation();
				navigate({ screen: "settings" });
			} else if (matchesShortcut(e, "zoom-in")) {
				e.preventDefault();
				e.stopPropagation();
				adjustZoom(ZOOM_STEP);
			} else if (matchesShortcut(e, "zoom-out")) {
				e.preventDefault();
				e.stopPropagation();
				adjustZoom(-ZOOM_STEP);
			} else if (matchesShortcut(e, "zoom-reset")) {
				e.preventDefault();
				e.stopPropagation();
				applyZoom(DEFAULT_ZOOM);
			} else if (matchesShortcut(e, "jump-operations")) {
				// The built-in Operations board is the special "slot 0" of the
				// Cmd+digit project family; Cmd+1..9 address ordinary projects.
				const ops = state.projects.find((p) => p.builtin && p.kind === "virtual" && !p.deleted);
				if (ops) {
					e.preventDefault();
					e.stopPropagation();
					navigateToProject(ops.id);
				}
			} else if (matchesShortcut(e, "previous-variant")) {
				if (!cycleVariant(-1)) return;
				e.preventDefault();
				e.stopPropagation();
			} else if (matchesShortcut(e, "next-variant")) {
				if (!cycleVariant(1)) return;
				e.preventDefault();
				e.stopPropagation();
			} else if (matchesShortcut(e, "back")) {
				e.preventDefault();
				e.stopPropagation();
				dispatch({ type: "goBack" });
			} else if (matchesShortcut(e, "forward")) {
				e.preventDefault();
				e.stopPropagation();
				dispatch({ type: "goForward" });
			} else if (matchesShortcut(e, "open-quick-shell")) {
				e.preventDefault();
				e.stopPropagation();
				void openQuickShell();
			} else if (matchesShortcut(e, "toggle-project-terminal")) {
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
			} else if (matchesShortcut(e, "task-hints")) {
				// Vimium-style hint navigation. Works on any screen that has hint
				// targets ([data-hint-id]); the overlay self-closes if nothing is
				// actually visible (e.g. a modal covers the board).
				if (!document.querySelector("[data-hint-id]")) return;
				e.preventDefault();
				e.stopPropagation();
				setHintMode(true);
			} else if (matchesShortcut(e, "focus-search")) {
				// Focus the visible search input (Linear/Gmail convention).
				const input = findVisibleSearchInput();
				if (!input) return;
				e.preventDefault();
				e.stopPropagation();
				input.focus();
			} else if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !isTypingContext()) {
				// `g` arms a "go to" sequence; the next key picks d/p/t/s or a project
				// digit. Consumption of that next key happens at the top of this handler.
				if (e.code === "KeyG") {
					e.preventDefault();
					e.stopPropagation();
					armGoToVerb();
				}
			}
		},
		[armGoToIndex, armGoToVerb, clearGoTo, createTaskProjectId, cycleVariant, dispatch, goToCurrentProject, goToProjectIndex, hintMode, navigate, navigateToProject, openAddProject, openCreateTaskModal, openInCurrent, openQuickShell, showAddProjectModal, showQuitDialog, state.projects, state.route, toggleTerminalImmersive],
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

	// Load projects + restore the last route. Extracted from the mount effect so
	// the bootstrap "Retry" button can re-run it when a load hangs (remote/mobile).
	const loadProjects = useCallback(async () => {
		dispatch({ type: "setLoading", loading: true });
		try {
			const projects = await api.request.getProjects();
			dispatch({ type: "setProjects", projects });

			// Restore the last route the user was on (persisted across quit,
			// reboot, and update restarts). Guard against a stale project route
			// whose project no longer exists — fall back to the dashboard.
			try {
				const { route: savedRoute } = await api.request.getLastRoute();
				if (savedRoute) {
					const route = JSON.parse(savedRoute) as Route;
					const projectId = projectIdForRoute(route);
					const projectExists =
						!projectId || projects.some((p) => p.id === projectId && !p.deleted);
					if (projectExists && route.screen !== "dashboard") {
						dispatch({ type: "navigate", route });
					}
				}
			} catch {
				// Ignore — file may not exist or be malformed.
			}
		} catch (err) {
			console.error("Failed to load projects:", err);
		} finally {
			// Enable route persistence now that the restore attempt is done,
			// so subsequent navigations (and the restored route) are saved.
			routePersistEnabledRef.current = true;
		}
		dispatch({ type: "setLoading", loading: false });
	}, [dispatch]);

	// Load projects on mount — gated on requirements passing
	useEffect(() => {
		if (reqStatus !== "passed") return;
		void loadProjects();
	}, [reqStatus, loadProjects]);

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

	// A task left a project's board (moved to another project). Scoped to the
	// source project so a window viewing the TARGET keeps the just-added card.
	useEffect(() => {
		function onTaskRemoved(e: Event) {
			const { taskId, projectId } = (e as CustomEvent).detail;
			dispatch({ type: "removeTask", taskId, projectId });
		}
		window.addEventListener("rpc:taskRemoved", onTaskRemoved);
		return () => window.removeEventListener("rpc:taskRemoved", onTaskRemoved);
	}, [dispatch]);

	useEffect(() => {
		function onGlobalSettingsUpdated(e: Event) {
			setGlobalSettings((e as CustomEvent<GlobalSettingsType>).detail);
		}
		window.addEventListener("rpc:globalSettingsUpdated", onGlobalSettingsUpdated);
		return () => window.removeEventListener("rpc:globalSettingsUpdated", onGlobalSettingsUpdated);
	}, []);

	// Terminal panes read the BiDi flag from a module cache, not from React state —
	// one effect here covers every path that lands settings (initial load, push,
	// the Settings screen's own setter).
	useEffect(() => {
		syncTerminalBidiFromGlobalSettings(globalSettings);
	}, [globalSettings]);

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
			const { taskId, projectId, reason } = (e as CustomEvent).detail as { taskId: string; projectId?: string; reason: string };
			if (!taskId) return;
			if (isProjectSilencedForDisplay(projectId)) return;
			dispatch({ type: "addBell", taskId, reason: reason ?? "" });
		}
		window.addEventListener("rpc:cliAttention", onCliAttention);
		return () => window.removeEventListener("rpc:cliAttention", onCliAttention);
	}, [dispatch]);

	// CLI-initiated in-app toast (`dev3 notify`). When a task is attached the toast
	// is clickable and opens that task, honoring the user's task-open-mode.
	useEffect(() => {
		function onCliToast(e: Event) {
			const { taskId, projectId, message, level, durationMs, taskSeq, taskTitle, projectName } = (e as CustomEvent).detail as {
				taskId: string | null;
				projectId: string | null;
				message: string;
				level: "info" | "success" | "error";
				durationMs?: number;
				taskSeq?: number;
				taskTitle?: string;
				projectName?: string;
			};
			if (!message) return;
			if (isProjectSilencedForDisplay(projectId)) return;
			const onClick =
				taskId && projectId
					? () => openTaskFromNotification(taskId, projectId)
					: undefined;
			const context = taskToastContext(taskSeq, projectName, taskTitle);
			toast[level](message, { durationMs, onClick, context, taskId: taskId ?? undefined });
		}
		window.addEventListener("rpc:cliToast", onCliToast);
		return () => window.removeEventListener("rpc:cliToast", onCliToast);
	}, [openTaskFromNotification]);

	// One agent wrote into another task's agent (`dev3 message` from a worktree).
	// Its own violet variant and a two-identity source line — the only toast whose
	// event has a sender AND a receiver. The click goes to the RECEIVER: that is
	// where the text landed and where the reply gets typed.
	useEffect(() => {
		function onAgentMessage(e: Event) {
			const { taskId, projectId, fromProjectId, toSeq, toTitle, fromSeq, fromTitle, preview } = (e as CustomEvent)
				.detail as {
				taskId: string;
				projectId: string;
				fromProjectId?: string;
				toSeq: number;
				toTitle: string;
				fromSeq: number;
				fromTitle?: string;
				preview: string;
			};
			if (!taskId || !preview) return;
			// Either side sensitive on camera drops the whole toast: it names both.
			if (isProjectSilencedForDisplay(projectId) || isProjectSilencedForDisplay(fromProjectId)) return;
			const from = [`#${fromSeq}`, fromTitle].filter(Boolean).join(" ");
			const to = [`#${toSeq}`, toTitle].filter(Boolean).join(" ");
			toast.agent(t("toast.agentMessage", { preview }), {
				context: `${from} → ${to}`,
				taskId,
				onClick: () => openTaskFromNotification(taskId, projectId),
			});
		}
		window.addEventListener("rpc:agentMessage", onAgentMessage);
		return () => window.removeEventListener("rpc:agentMessage", onAgentMessage);
	}, [openTaskFromNotification, t]);

	// Cmd/Ctrl+Click on a file path in any terminal (preview mode).
	useEffect(() => {
		function onOpenFilePreview(e: Event) {
			const detail = (e as CustomEvent<OpenFilePreviewDetail>).detail;
			if (detail?.path) setFilePreview(detail);
		}
		window.addEventListener(OPEN_FILE_PREVIEW_EVENT, onOpenFilePreview);
		return () => window.removeEventListener(OPEN_FILE_PREVIEW_EVENT, onOpenFilePreview);
	}, []);

	// Keep the current viewer visible to the cliShowImage listener without
	// re-subscribing it every time the viewer opens/closes.
	const imageViewerRef = useRef(imageViewer);
	imageViewerRef.current = imageViewer;
	const artifactViewerRef = useRef(artifactViewer);
	artifactViewerRef.current = artifactViewer;

	// CLI-shared images (`dev3 show-image`). Always raise the attention badge; auto-open
	// the lightbox ONLY when the user is already looking at this task (never steal focus).
	useEffect(() => {
		function onCliShowImage(e: Event) {
			const { taskId, projectId, images, newCount, taskSeq, taskTitle, projectName } = (e as CustomEvent).detail as {
				taskId: string;
				projectId: string;
				images: SharedImage[];
				newCount: number;
				taskSeq?: number;
				taskTitle?: string;
				projectName?: string;
			};
			if (!taskId || !images?.length) return;

			// Attention badge (the reducer self-suppresses it when already viewing the task).
			dispatch({ type: "addBell", taskId, reason: t.plural("showImage.attention", newCount ?? 1) });

			const viewingThisTask =
				(state.route.screen === "task" && state.route.taskId === taskId) ||
				(state.route.screen === "project" && state.route.activeTaskId === taskId);
			const autoOpen = localStorage.getItem("dev3-auto-open-shared-images") !== "off";
			const foreground = typeof document === "undefined" || (document.visibilityState === "visible" && document.hasFocus());
			const alreadyOpenForTask = imageViewerRef.current?.taskId === taskId;

			if (alreadyOpenForTask || (viewingThisTask && autoOpen && foreground)) {
				openImageViewer(projectId, taskId, images);
				return;
			}

			// Elsewhere: don't steal focus automatically — a clickable toast both
			// navigates to the owning task and opens the viewer (honoring open-mode).
			const context = taskToastContext(taskSeq, projectName, taskTitle);
			toast.info(t.plural("showImage.toast", newCount ?? 1), {
				context,
				onClick: () => {
					openTaskFromNotification(taskId, projectId);
					openImageViewer(projectId, taskId, images);
				},
			});
		}
		window.addEventListener("rpc:cliShowImage", onCliShowImage);
		return () => window.removeEventListener("rpc:cliShowImage", onCliShowImage);
	}, [dispatch, openImageViewer, openTaskFromNotification, t, state.route]);

	// Reopen the image viewer from a task-scoped trigger (the inspector image badge).
	useEffect(() => {
		function onOpenViewer(e: Event) {
			const { taskId, projectId, images, index } = (e as CustomEvent).detail as {
				taskId: string;
				projectId: string;
				images: SharedImage[];
				index?: number;
			};
			if (!taskId || !projectId || !images?.length) return;
			openImageViewer(projectId, taskId, images, index);
		}
		window.addEventListener("dev3:openImageViewer", onOpenViewer);
		return () => window.removeEventListener("dev3:openImageViewer", onOpenViewer);
	}, [openImageViewer]);

	useEffect(() => {
		function onCliShowArtifact(e: Event) {
			const { taskId, projectId, artifacts, newCount, taskSeq, taskTitle, projectName } = (e as CustomEvent).detail as {
				taskId: string;
				projectId: string;
				artifacts: SharedArtifact[];
				newCount: number;
				taskSeq?: number;
				taskTitle?: string;
				projectName?: string;
			};
			if (!taskId || !artifacts?.length) return;
			dispatch({ type: "addBell", taskId, reason: t.plural("showArtifact.attention", newCount ?? 1) });
			const viewingThisTask =
				(state.route.screen === "task" && state.route.taskId === taskId) ||
				(state.route.screen === "project" && state.route.activeTaskId === taskId);
			const foreground = typeof document === "undefined" || (document.visibilityState === "visible" && document.hasFocus());
			const alreadyOpenForTask = artifactViewerRef.current?.taskId === taskId;
			if (alreadyOpenForTask || (viewingThisTask && foreground)) {
				markSharedItemsRead(projectId, taskId, "artifacts", artifacts);
				// An already-open standalone overlay keeps its host; it has no pane to dock into.
				const standalone = alreadyOpenForTask ? artifactViewerRef.current?.standalone : undefined;
				setArtifactViewer({ taskId, artifacts, index: artifacts.length - 1, standalone });
				return;
			}
			const context = taskToastContext(taskSeq, projectName, taskTitle);
			toast.info(t.plural("showArtifact.toast", newCount ?? 1), {
				context,
				onClick: () => {
					openTaskFromNotification(taskId, projectId);
					markSharedItemsRead(projectId, taskId, "artifacts", artifacts);
					setArtifactViewer({ taskId, artifacts, index: artifacts.length - 1 });
				},
			});
		}
		window.addEventListener("rpc:cliShowArtifact", onCliShowArtifact);
		return () => window.removeEventListener("rpc:cliShowArtifact", onCliShowArtifact);
	}, [dispatch, markSharedItemsRead, openTaskFromNotification, state.route, t]);

	useEffect(() => {
		function onOpenArtifactViewer(e: Event) {
			const { taskId, projectId, artifacts, index, standalone } = (e as CustomEvent).detail as {
				taskId: string;
				projectId: string;
				artifacts: SharedArtifact[];
				index?: number;
				standalone?: boolean;
			};
			if (!taskId || !projectId || !artifacts?.length) return;
			markSharedItemsRead(projectId, taskId, "artifacts", artifacts);
			setArtifactViewer({ taskId, artifacts, index: index ?? artifacts.length - 1, standalone });
		}
		window.addEventListener("dev3:openArtifactViewer", onOpenArtifactViewer);
		return () => window.removeEventListener("dev3:openArtifactViewer", onOpenArtifactViewer);
	}, [markSharedItemsRead]);

	// Browser Web Notifications (remote mode). The desktop WKWebView already shows
	// the native banner, so it ignores this push; only browsers act on it, falling
	// back to an in-app toast on insecure LAN contexts or when permission is denied.
	useEffect(() => {
		if (isElectrobun) return;
		function onWebNotification(e: Event) {
			const detail = (e as CustomEvent).detail as WebNotificationDetail;
			if (!detail?.body) return;
			if (isProjectSilencedForDisplay(detail.projectId)) return;
			showWebNotificationOrToast(detail, openTaskFromNotification);
		}
		window.addEventListener("rpc:webNotification", onWebNotification);
		return () => window.removeEventListener("rpc:webNotification", onWebNotification);
	}, [openTaskFromNotification]);

	// Listen for port scan updates
	useEffect(() => {
		function onPortsUpdated(e: Event) {
			const { taskId, ports } = (e as CustomEvent).detail;
			dispatch({ type: "setPorts", taskId, ports });
		}
		window.addEventListener("rpc:portsUpdated", onPortsUpdated);
		return () => window.removeEventListener("rpc:portsUpdated", onPortsUpdated);
	}, [dispatch]);

	// Listen for dev-server state, which the board's dev control renders
	useEffect(() => {
		function onDevServerUpdated(e: Event) {
			dispatch({ type: "setDevServer", summary: (e as CustomEvent).detail });
		}
		window.addEventListener("rpc:devServerUpdated", onDevServerUpdated);
		return () => window.removeEventListener("rpc:devServerUpdated", onDevServerUpdated);
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
			const { taskId, projectId, taskTitle, branchName, fingerprint, subject, shouldPrompt, shouldNotify } = (e as CustomEvent).detail as {
				taskId: string;
				projectId: string;
				taskTitle: string;
				branchName: string;
				fingerprint?: string | null;
				subject?: TaskDialogSubject;
				shouldPrompt?: boolean;
				shouldNotify?: boolean;
			};
			// Reservation + shouldPrompt/shouldNotify were decided server-side in the
			// poller before pushing, so this path does not re-reserve. The shared
			// primitive owns the dialog copy, context card, notify/suppress gate,
			// cross-client abort, once-guard de-dup, manual opt-out and dismiss.
			await offerMergeCompletion({
				context: { taskId, projectId, taskTitle, branchName, subject },
				t,
				fingerprint: fingerprint ?? null,
				shouldPrompt,
				shouldNotify,
				onOpenTask: () => openTaskFromNotification(taskId, projectId),
				onComplete: () => {
					// Sound first, exactly like `moveTaskToStatus` does for the board
					// surfaces — this handler is a hand-rolled move and used to leave the
					// chime to the backend push, which lands after the whole teardown.
					const playedLocally = playTaskCompletionSound("completed");
					// If the user is currently inside this task's view, leave it BEFORE
					// the worktree is destroyed (otherwise TaskTerminal reacts to
					// ptyDied / missing worktree and shows the "session ended / restart
					// session" screen). routeAfterTaskClosed sends the user back to their
					// configured home surface: fullscreen open-mode → the board, split
					// open-mode → the split task view (task deselected). A Kanban board is
					// left untouched.
					const openMode = getTaskOpenMode();
					const dest = routeAfterTaskClosed(routeRef.current, taskId, openMode);
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
						} as any,
					});
					dispatch({ type: "clearBell", taskId });
					trackEvent("task_moved", { from_status: "review-by-user", to_status: "completed" });
					api.request.moveTask({
						taskId,
						projectId,
						newStatus: "completed",
						clientPlayedSound: playedLocally,
					}).catch(() => {
						api.request.moveTask({
							taskId,
							projectId,
							newStatus: "completed",
							force: true,
							clientPlayedSound: playedLocally,
						}).catch((err) => console.error("moveTask (branch-merged) failed:", err));
					});
				},
			});
		}
		window.addEventListener("rpc:branchMerged", onBranchMerged);
		return () => window.removeEventListener("rpc:branchMerged", onBranchMerged);
	}, [dispatch, navigate, openTaskFromNotification, t]);

	// Agent-initiated changes are intentionally visible because they change how
	// future merge events behave; user toggles in the inspector stay silent.
	useEffect(() => {
		function onManualCompletionChanged(e: Event) {
			const { taskId, projectId, manualCompletion, taskSeq, taskTitle, projectName } = (e as CustomEvent).detail as {
				taskId: string;
				projectId: string;
				manualCompletion: boolean;
				taskSeq?: number;
				taskTitle?: string;
				projectName?: string;
			};
			toast.info(
				t(manualCompletion ? "app.manualCompletionAgentEnabled" : "app.manualCompletionAgentDisabled"),
				{
					taskId,
					context: taskToastContext(taskSeq, projectName, taskTitle),
					onClick: () => openTaskFromNotification(taskId, projectId),
				},
			);
		}
		window.addEventListener("rpc:manualCompletionChanged", onManualCompletionChanged);
		return () => window.removeEventListener("rpc:manualCompletionChanged", onManualCompletionChanged);
	}, [openTaskFromNotification, t]);

	// Listen for agent-initiated completion requests — the CLI is blocked on a
	// socket waiting for the user's decision, so always respond, even on cancel.
	useEffect(() => {
		async function onAgentCompletionRequested(e: Event) {
			const { requestId, taskId, taskTitle, subject } = (e as CustomEvent).detail as {
				requestId: string;
				taskId: string;
				taskTitle: string;
				subject?: TaskDialogSubject;
			};
			let approved = false;
			// The same dialog is up on every connected client; the first answer
			// closes the rest (see createAgentRequestAbort).
			const abort = createAgentRequestAbort(requestId);
			try {
				approved = await confirm({
					title: t("app.agentCompletionTitle"),
					message: t("app.agentCompletionMessage"),
					info: taskDialogInfoFromSubject(taskTitle, subject),
					confirmLabel: t("app.agentCompletionConfirm"),
					cancelLabel: t("app.agentCompletionCancel"),
					danger: true,
					agentInitiated: true,
					signal: abort.signal,
				});
			} catch (err) {
				console.error("[App] confirm (agent-completion) failed:", err);
			} finally {
				abort.cleanup();
			}
			// Answered on another client — that client owns every side effect, and
			// the CLI already has its decision.
			if (abort.signal.aborted) return;
			if (approved) {
				// Leave the task's view BEFORE the worktree is destroyed (same
				// reasoning as the branch-merged flow above). routeAfterTaskClosed sends
				// the user to their configured home (fullscreen → board, split → split
				// task view, deselected).
				const openMode = getTaskOpenMode();
				const dest = routeAfterTaskClosed(routeRef.current, taskId, openMode);
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

	// An agent wants to set another task running. Queued, never stacked: two
	// agents can ask at once, and overlapping dialogs would make the user answer
	// the wrong one. The head of the queue is on screen; the rest wait their turn.
	useEffect(() => {
		function onAgentLaunchRequested(e: Event) {
			const request = (e as CustomEvent).detail as AgentLaunchRequest;
			setLaunchRequests((queue) => (
				queue.some((r) => r.requestId === request.requestId) ? queue : [...queue, request]
			));
		}
		// Someone answered on another window / the remote browser: drop the request
		// here too, whether it is on screen or still waiting in the queue.
		function onAgentRequestResolved(e: Event) {
			const { requestId } = (e as CustomEvent).detail as { requestId: string };
			setLaunchRequests((queue) => queue.filter((r) => r.requestId !== requestId));
		}
		window.addEventListener("rpc:agentLaunchRequested", onAgentLaunchRequested);
		window.addEventListener("rpc:agentRequestResolved", onAgentRequestResolved);
		return () => {
			window.removeEventListener("rpc:agentLaunchRequested", onAgentLaunchRequested);
			window.removeEventListener("rpc:agentRequestResolved", onAgentRequestResolved);
		};
	}, []);

	const respondToLaunchRequest = useCallback((
		requestId: string,
		approved: boolean,
		launch?: { agentId: string | null; configId: string | null; accountId?: string | null },
	) => {
		setLaunchRequests((queue) => queue.filter((r) => r.requestId !== requestId));
		if (approved) trackEvent("task_moved", { to_status: "in-progress", agent_requested: true });
		api.request.respondToAgentLaunchRequest({
			requestId,
			approved,
			...(approved && launch ? { launch } : {}),
		}).catch((err) => console.error("respondToAgentLaunchRequest failed:", err));
	}, []);

	// Listen for silent update ready notification
	useEffect(() => {
		function onUpdateAvailable(e: Event) {
			const { version, changelog } = (e as CustomEvent).detail as { version: string; changelog?: UpdateChangelog };
			setUpdateVersion(version);
			setUpdateChangelog(changelog ?? null);
			setUpdateDownloadStatus(null); // clear download indicator once ready
			setUpdateAnnouncement((n) => n + 1);
		}
		window.addEventListener("rpc:updateAvailable", onUpdateAvailable);
		return () => window.removeEventListener("rpc:updateAvailable", onUpdateAvailable);
	}, []);

	// Open the in-app About dialog when the native menu's "About" item is clicked.
	useEffect(() => {
		function onShowAbout(e: Event) {
			const { version, buildChannel } = (e as CustomEvent).detail as { version: string; buildChannel?: string };
			setAboutVersion(version);
			setAboutBuildChannel(buildChannel ?? null);
		}
		window.addEventListener("rpc:showAbout", onShowAbout);
		return () => window.removeEventListener("rpc:showAbout", onShowAbout);
	}, []);

	// Debug -> Feature Flags: a read-only look at what the app is gating code on.
	useEffect(() => {
		function onShowFeatureFlags() {
			setShowFeatureFlags(true);
		}
		window.addEventListener("rpc:showFeatureFlags", onShowFeatureFlags);
		return () => window.removeEventListener("rpc:showFeatureFlags", onShowFeatureFlags);
	}, []);

	// Debug -> Terminal Performance: the live fps/latency HUD. A toggle, because
	// the menu item is the only way in and the only way back out of it.
	useEffect(() => {
		function onToggle() {
			setShowTerminalPerf((on) => {
				localStorage.setItem(TERMINAL_PERF_KEY, on ? "0" : "1");
				return !on;
			});
		}
		window.addEventListener("rpc:toggleTerminalPerf", onToggle);
		return () => window.removeEventListener("rpc:toggleTerminalPerf", onToggle);
	}, []);

	// Surface the result of a manual "Check for Updates" menu action as a toast.
	// (Available updates flow through rpc:updateAvailable → the header plaque.)
	useEffect(() => {
		function onUpdateCheckOutcome(e: Event) {
			const { status, version, detail } = (e as CustomEvent).detail as {
				status: "none" | "error" | "dev";
				version?: string;
				detail?: string;
			};
			if (status === "dev") {
				toast.info(t("update.devBuildNotice"), { source: "update" });
			} else if (status === "none") {
				toast.info(t("update.upToDateVersion", { version: version ?? "" }), { source: "update" });
			} else {
				toast.error(t("update.checkFailedDetail", { error: detail ?? "" }), { source: "update" });
			}
		}
		window.addEventListener("rpc:updateCheckOutcome", onUpdateCheckOutcome);
		return () => window.removeEventListener("rpc:updateCheckOutcome", onUpdateCheckOutcome);
	}, [t]);

	useEffect(() => {
		function onOpenTaskFromNotification(e: Event) {
			const { taskId, projectId } = (e as CustomEvent).detail as { taskId: string; projectId: string };
			openTaskFromNotification(taskId, projectId);
		}
		window.addEventListener("rpc:openTaskFromNotification", onOpenTaskFromNotification);
		return () => window.removeEventListener("rpc:openTaskFromNotification", onOpenTaskFromNotification);
	}, [openTaskFromNotification]);

	useEffect(() => {
		function onOpenDeepLink(e: Event) {
			handleDeepLink((e as CustomEvent).detail as DeepLinkNav);
		}
		window.addEventListener("rpc:openDeepLink", onOpenDeepLink);
		return () => window.removeEventListener("rpc:openDeepLink", onOpenDeepLink);
	}, [handleDeepLink]);

	// If this window was reopened by a notification click while the app sat
	// window-less in the dock, the click target is waiting in the backend — pull
	// it on mount and navigate. Pulling (rather than bun pushing) avoids racing
	// the listener registration above; same pattern as consumePendingQuitDialog.
	// Optional-chained: some tests mock `api.request` without this method.
	useEffect(() => {
		const pending = api.request.consumePendingNotificationNav?.();
		if (!pending) return;
		pending
			.then((target) => {
				if (target) openTaskFromNotification(target.taskId, target.projectId);
			})
			.catch(() => {});
		// Mount-only on purpose: the backend slot is consumed on first read, so
		// re-running on `openTaskFromNotification` identity changes would only
		// ever read null.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Same cold-start pull for a `dev3://…` deep link that reopened this window.
	useEffect(() => {
		const pending = api.request.consumePendingDeepLinkNav?.();
		if (!pending) return;
		pending
			.then((nav) => {
				if (nav) handleDeepLink(nav);
			})
			.catch(() => {});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

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

	// Publish the sensitive ids so surfaces that only know a projectId (tmux
	// sessions, notification payloads) can ask for the privacy verdict.
	useEffect(() => {
		setSensitiveProjectIds(state.projects.filter((p) => p.sensitive).map((p) => p.id));
	}, [state.projects]);

	// Report streamer mode + the sensitive projects so the backend drops the OS
	// notifications no renderer gate can intercept. Streamer mode is per-client
	// localStorage state, so the renderer is its only authority.
	useEffect(() => {
		void api.request.setStreamerPrivacy?.({
			streamerMode: streamerModeOn,
			sensitiveProjectIds: state.projects.filter((p) => p.sensitive).map((p) => p.id),
		})?.catch?.(() => { /* best-effort */ });
	}, [streamerModeOn, state.projects]);

	// A sensitive project must not stay on screen the moment the camera goes on.
	useEffect(() => {
		if (!streamerModeOn) return;
		const projectId = projectIdForRoute(state.route);
		if (!projectId) return;
		if (!state.projects.find((p) => p.id === projectId)?.sensitive) return;
		commitNavigation({ screen: "dashboard" });
		toast.info(t("streamer.projectLocked"), { projectId });
	}, [streamerModeOn, state.route, state.projects, commitNavigation, t]);

	// Notify user when a column-agent launch fails. Built-in AI Review also parks the
	// task in Your Review; a custom column leaves it where it is.
	useEffect(() => {
		function onColumnAgentFailed(e: Event) {
			const payload = (e as CustomEvent).detail as AppRPCSchema["bun"]["messages"]["columnAgentFailed"];
			// Copy is chosen from the failure's structural `reason` and whether the task
			// was moved — never by reading the backend's English error string. Saying
			// where the task ended up is what stops a card moving on its own from
			// reading as "the action did nothing".
			const copy = columnAgentFailureCopy(payload, (status) => t(statusKey(status)));
			toast.error(t(copy.key, copy.params), { taskId: payload.taskId });
		}
		window.addEventListener("rpc:columnAgentFailed", onColumnAgentFailed);
		return () => window.removeEventListener("rpc:columnAgentFailed", onColumnAgentFailed);
	}, []);

	// Notify user when background worktree/PTY preparation fails (e.g. empty repo,
	// missing base branch). The task is reverted to todo on the backend; surface
	// the real error so the user isn't left with a misleading "[session ended]".
	useEffect(() => {
		function onTaskPreparationFailed(e: Event) {
			const { taskId, taskTitle, error } = (e as CustomEvent).detail as {
				taskId: string;
				projectId: string;
				taskTitle: string;
				error: string;
			};
			toast.error(t("kanban.taskPreparationFailed", { taskTitle, error }), { taskId });
		}
		window.addEventListener("rpc:taskPreparationFailed", onTaskPreparationFailed);
		return () => window.removeEventListener("rpc:taskPreparationFailed", onTaskPreparationFailed);
	}, []);

	// Surface automation occurrences that were missed while the app was offline —
	// missed runs are never silently skipped (scheduler pushes this on startup).
	useEffect(() => {
		function onAutomationRunsMissed(e: Event) {
			const { projectId, automationName, missedCount, caughtUp } = (e as CustomEvent).detail as {
				projectId: string;
				automationId: string;
				automationName: string;
				missedCount: number;
				caughtUp: boolean;
			};
			const message = caughtUp
				? t.plural("automations.missedToastCaughtUp", missedCount, { name: automationName })
				: t.plural("automations.missedToast", missedCount, { name: automationName });
			toast.warning(message, { projectId, contextDetail: automationName });
		}
		window.addEventListener("rpc:automationRunsMissed", onAutomationRunsMissed);
		return () => window.removeEventListener("rpc:automationRunsMissed", onAutomationRunsMissed);
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

	// Load agents before the subsequent launch dialog opens. Skill autocomplete
	// accepts both agent syntaxes because that dialog chooses the final agent.
	const agentSettingsLoadingRef = useRef(false);
	useEffect(() => {
		if (!createTaskProjectId || agentSettingsLoaded || agentSettingsLoadingRef.current) return;
		agentSettingsLoadingRef.current = true;
		Promise.all([api.request.getAgents(), api.request.getGlobalSettings()])
			.then(([nextAgents, nextSettings]) => {
				setAgents(nextAgents);
				setGlobalSettings(nextSettings);
				setAgentSettingsLoaded(true);
			})
			.catch(() => {})
			.finally(() => {
				agentSettingsLoadingRef.current = false;
			});
	}, [agentSettingsLoaded, createTaskProjectId]);

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
	const [qrCountdown, setQrCountdown] = useState(QR_REFRESH_SECONDS);

	useEffect(() => {
		function onQrConsumed() {
			setQrConsumed(true);
			setRemoteUrlCopyState("idle");
		}
		window.addEventListener("rpc:qrTokenConsumed", onQrConsumed);
		return () => window.removeEventListener("rpc:qrTokenConsumed", onQrConsumed);
	}, []);

	// Bring the public Cloudflare tunnel up in the background while the modal is
	// already open, driving the in-modal "starting…" state. Opening Remote Access
	// must never block on this handshake — awaiting it froze the header button.
	const startRemoteTunnel = useCallback(() => {
		setTunnelWanted(true);
		setRemoteAccessActive(true);
		setTunnelStarting(true);
		api.request.getRemoteAccessQR({ tunnel: true }).then((res) => {
			applyRemoteQR(res);
			setTunnelStarting(false);
			setQrCountdown(25);
		}).catch(() => {
			setTunnelStarting(false);
			setRemoteAccessActive(false);
		});
	}, [applyRemoteQR]);

	const closeRemoteQR = useCallback(() => {
		setRemoteQR(null);
		setRemoteUrlCopyState("idle");
		setTunnelStarting(false);
	}, []);

	// Tear the public tunnel down and fall back to the local-network QR. Shared by
	// the toggle and the explicit Stop button so both paths behave identically.
	const stopRemoteTunnel = useCallback(() => {
		setTunnelWanted(false);
		setTunnelStarting(false);
		setRemoteAccessActive(false);
		api.request.stopTunnel().then(() => {
			api.request.getRemoteAccessQR({ tunnel: false }).then((res) => {
				applyRemoteQR(res);
				setQrCountdown(25);
			}).catch(() => {});
		}).catch(() => {});
	}, [applyRemoteQR]);

	// Listen for the Remote Access open request (header button, kebab, native menu)
	useEffect(() => {
		function onShowRemoteQR(e: Event) {
			const detail = (e as CustomEvent<RemoteAccessQRData & { autoStartTunnel?: boolean }>).detail;
			if (!detail) return;
			applyRemoteQR(detail);
			setRemoteUrlCopyState("idle");
			setQrConsumed(false); // Reset consumed state when opening fresh QR
			// A share-intent open auto-starts the public tunnel in the background
			// rather than blocking the modal on the handshake.
			if (detail.autoStartTunnel && detail.cloudflaredInstalled && detail.tunnelState === "idle") {
				startRemoteTunnel();
				return;
			}
			// Sync tunnel checkbox with actual tunnel state
			setTunnelWanted(detail.tunnelState === "connected" || detail.tunnelState === "starting");
			setTunnelStarting(detail.tunnelState === "starting");
		}
		window.addEventListener("rpc:showRemoteAccessQR", onShowRemoteQR);
		return () => window.removeEventListener("rpc:showRemoteAccessQR", onShowRemoteQR);
	}, [applyRemoteQR, startRemoteTunnel]);

	// Auto-refresh QR code every 60 seconds while modal is open (JWT tokens expire in 65s)
	// After a QR is consumed, keep polling without visually rotating the token:
	// a recovered Quick Tunnel gets a new hostname, and the open modal must
	// reactivate with that new URL instead of staying green on a dead domain.
	const qrModalOpen = remoteQR !== null;
	const tunnelWantedRef = useRef(tunnelWanted);
	tunnelWantedRef.current = tunnelWanted;
	const qrConsumedRef = useRef(qrConsumed);
	qrConsumedRef.current = qrConsumed;
	const remoteQRRef = useRef(remoteQR);
	remoteQRRef.current = remoteQR;
	// Preserve the chosen interface/IP across the 60s token refresh — without
	// this, picking a host would snap back to the auto-pick on the next tick.
	const selectedHostRef = useRef<string | undefined>(undefined);
	selectedHostRef.current = remoteQR?.selectedHost;
	useEffect(() => {
		if (!qrModalOpen) return;
		setQrCountdown(QR_REFRESH_SECONDS);
		let counter = QR_REFRESH_SECONDS;
		let refreshInFlight = false;
		const tick = setInterval(() => {
			counter -= 1;
			if (counter <= 0) {
				counter = QR_REFRESH_SECONDS;
				const host = tunnelWantedRef.current ? undefined : selectedHostRef.current;
				if (!refreshInFlight) {
					refreshInFlight = true;
					api.request.getRemoteAccessQR({ tunnel: tunnelWantedRef.current, host }).then((next) => {
						const current = remoteQRRef.current;
						let hostnameChanged = false;
						if (current?.tunnelState === "connected" && next.tunnelState === "connected") {
							try {
								hostnameChanged = new URL(current.accessUrl).hostname !== new URL(next.accessUrl).hostname;
							} catch {
								hostnameChanged = current.accessUrl !== next.accessUrl;
							}
						}
						if (!qrConsumedRef.current || hostnameChanged) {
							applyRemoteQR(next);
							if (hostnameChanged) setQrConsumed(false);
						} else {
							setRemoteAccessActive(isRemoteTunnelActive(next.tunnelState));
						}
					}).catch(() => {}).finally(() => {
						refreshInFlight = false;
					});
				}
			}
			if (!qrConsumedRef.current) setQrCountdown(counter);
		}, 1000);
		return () => clearInterval(tick);
	}, [applyRemoteQR, qrModalOpen]);

	// Track page views on route changes. Resolve the task's human-readable seq id
	// (e.g. "981-1") from the loaded task list so analytics paths carry the task
	// number, not the opaque hash; falls back to the raw id if not yet loaded.
	useEffect(() => {
		const taskId = routeTaskId(state.route);
		const task = taskId ? state.currentProjectTasks.find((t) => t.id === taskId) : undefined;
		trackPageView(state.route, task ? taskSeqLabel(task) : undefined);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per navigation; task list read at that moment
	}, [state.route]);

	// Escape: close quit dialog or navigate back from settings screens
	// (skipped when a terminal has focus — Escape must reach the shell)
	useGlobalShortcut(
		(e) => {
			if (e.key !== "Escape") return;
			// Help mode owns Escape while active — HelpOverlay (or its open card)
			// consumes it; navigating away at the same time would double-act.
			if (helpMode) return;
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
		[state, navigate, showQuitDialog, helpMode],
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

	// Requirements check failed \u2014 a real, actionable screen; keep it ahead of the
	// generic bootstrap loader.
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

	if (reqStatus === "checking" || state.loading) {
		// In remote mode a not-yet-connected socket is the real reason the bootstrap
		// hangs, so surface that phase first; otherwise name the local step.
		const remote = isRemote();
		const connectionStuck = remote && rpcState !== "connected" && rpcState !== "auth-failed";
		const phase: BootPhase = connectionStuck
			? rpcState === "authenticating"
				? "authenticating"
				: rpcState === "connecting"
					? "connecting"
					: "reconnecting" // "reconnecting" | "closed"
			: reqStatus === "checking"
				? "checking"
				: "loading";

		const onBootRetry = () => {
			if (connectionStuck) {
				reconnectRpc();
				return;
			}
			if (reqStatus !== "passed") {
				void checkRequirements();
				return;
			}
			void loadProjects();
		};

		return <BootstrapScreen phase={phase} onRetry={onBootRetry} />;
	}

	const { route } = state;

	// Screen-reader heading for the current route — gives AT users an h1 to orient by.
	const routeH1 = (() => {
		switch (route.screen) {
			case "dashboard": return t("dashboard.screenTitle");
			case "project":
			case "project-terminal":
			case "project-settings": {
				const proj = state.projects.find((p) => p.id === route.projectId);
				return proj?.name ?? "";
			}
			case "task": {
				const task = state.currentProjectTasks.find((task) => task.id === route.taskId);
				return task ? getTaskTitle(task) : "";
			}
			case "settings": return t("settings.screenTitle");
			case "changelog": return t("changelog.screenTitle");
			case "stats": return t("stats.title");
			default: return "";
		}
	})();

	const createTaskProject = createTaskProjectId
		? state.projects.find((project) => project.id === createTaskProjectId) ?? null
		: null;
	// While the public tunnel is still coming up, the QR and the URL still point at
	// the LAN address. Scanned from another network that link just fails, so publish
	// nothing until the tunnel hostname lands.
	const tunnelUrlPending = remoteQR !== null
		&& tunnelWanted
		&& remoteQR.cloudflaredInstalled
		&& (tunnelStarting || remoteQR.tunnelState === "starting");
	const remoteCopyLabel = qrConsumed
		? "remote.copyUrl"
		: remoteUrlCopyState === "copying"
			? "remote.copyingUrl"
			: remoteUrlCopyState === "copied"
				? "remote.urlCopied"
				: "remote.copyUrl";

	return (
		<div className="h-full w-full flex flex-col">
			{terminalImmersiveVisible ? (
				<TerminalImmersiveChrome onExit={() => setTerminalImmersiveActive(false)} />
			) : (
				<header aria-label={t("nav.appHeader")}>
					{!isElectrobun && <AppMenuBar context={menuContext} onAction={handleMenuBarAction} />}
					<GlobalHeader
						route={route}
						projects={state.projects}
						tasks={state.currentProjectTasks}
						agents={agents}
						navigate={navigate}
						goBack={() => dispatch({ type: "goBack" })}
						goForward={() => dispatch({ type: "goForward" })}
						canGoBack={state.historyIndex > 0}
						canGoForward={state.historyIndex < state.routeHistory.length - 1}
						updateVersion={updateVersion}
						updateAnnouncement={updateAnnouncement}
						updateChangelog={updateChangelog}
						updateDownloadStatus={updateDownloadStatus}
						remoteAccessActive={remoteAccessActive}
					/>
					{ghWarning && (
						<GhWarningBanner
							notInstalled={ghWarning.notInstalled}
							onDismiss={() => setGhWarning(null)}
						/>
					)}
				</header>
			)}
			<main className="flex-1 min-h-0 flex flex-col overflow-hidden">
				{routeH1 && <h1 className="sr-only">{routeH1}</h1>}
				{terminalImmersiveVisible ? renderTerminalImmersiveScreen() : renderScreen()}
			</main>
			{!terminalImmersiveVisible && (
			<>
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
			{helpMode && <HelpOverlay onExit={() => setHelpMode(false)} />}
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
			{openInPicker && (
				<OpenInPickerModal
					path={openInPicker.path}
					taskId={openInPicker.taskId}
					onClose={() => setOpenInPicker(null)}
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
					initialSpaceIds={addProjectSpaceIds}
					onClose={() => {
						setShowAddProjectModal(false);
						setAddProjectSpaceIds([]);
					}}
				/>
			)}
			{createTaskProject && (
				<CreateTaskModal
					project={createTaskProject}
					projects={state.projects}
					dispatch={dispatch}
					initialText={createTaskInitialText}
					onClose={() => {
						setCreateTaskProjectId(null);
						setCreateTaskInitialText("");
					}}
					onCreateAndRun={(task, project) => {
						setCreateTaskProjectId(null);
						setCreateTaskInitialText("");
						setLaunchModal({ task, targetStatus: "in-progress", project });
					}}
					onOpenAutomations={(project) => {
						setCreateTaskProjectId(null);
						setCreateTaskInitialText("");
						navigate({ screen: "project-settings", projectId: project.id, tab: "automations" });
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
								className="px-4 py-2 text-sm rounded-lg bg-accent-fill text-white hover:bg-accent-fill-hover transition-colors"
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
								className="px-4 py-2 text-sm rounded-lg bg-danger-fill text-white hover:bg-danger-fill-hover transition-colors"
							>
								{t("quit.confirm")}
							</button>
						</div>
					</div>
				</div>
			)}
			{remoteQR && (
				<RemoteAccessDialog titleId="remote-access-dialog-title" onClose={closeRemoteQR}>
					<>
						<h2 id="remote-access-dialog-title" className="text-fg text-lg font-semibold">{t("remote.title")}</h2>
						<p className="text-fg-2 text-sm">{t("remote.subtitle")}</p>
						<div className="flex justify-center relative">
							{tunnelUrlPending ? (
								<div
									data-testid="remote-qr-pending"
									className="w-56 h-56 rounded-lg bg-base border border-edge flex flex-col items-center justify-center gap-3 px-4"
								>
									<svg className="w-7 h-7 animate-spin text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
										<circle cx="12" cy="12" r="9" strokeWidth="3" opacity="0.25" />
										<path d="M21 12a9 9 0 0 1-9 9" strokeWidth="3" strokeLinecap="round" />
									</svg>
									<span className="text-fg-2 text-sm">{t("remote.qrWaitingTunnel")}</span>
									<span className="text-fg-muted text-xs leading-snug">{t("remote.qrWaitingTunnelHint")}</span>
								</div>
							) : (
								<img src={remoteQR.qrDataUrl} alt="QR Code" className={`w-56 h-56 rounded-lg transition-[opacity,filter] duration-500 streamer-private-media ${qrConsumed ? "opacity-20 grayscale" : ""}`} />
							)}
							{qrConsumed && !tunnelUrlPending && (
								<div className="absolute inset-0 flex items-center justify-center">
									<div className="bg-base/90 rounded-lg px-4 py-2">
										<span className="text-accent text-sm font-medium">{t("remote.connected")}</span>
									</div>
								</div>
							)}
						</div>
						{!qrConsumed && !tunnelUrlPending && (
							<div className="flex items-center justify-center gap-2 text-fg-muted text-xs">
								<div className="w-4 h-4 relative">
									<svg className="w-4 h-4 -rotate-90" viewBox="0 0 20 20">
										<circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
										<circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2"
											strokeDasharray={`${(qrCountdown / QR_REFRESH_SECONDS) * 50.3} 50.3`}
											strokeLinecap="round"
											className="transition-[stroke-dasharray] duration-1000 ease-linear"
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
											applyRemoteQR(res);
											setQrCountdown(25);
										}).catch(() => {});
									}}
									className="mt-1 w-full px-2 py-1.5 bg-elevated border border-edge rounded-lg text-fg text-xs outline-none focus:border-accent/40 transition-colors disabled:opacity-40 streamer-private"
								>
									{remoteQR.interfaces.map((iface) => (
										<option key={`${iface.name}-${iface.address}`} value={iface.address}>
											{iface.internal ? `${t("remote.localhostLabel")} · ${iface.address}` : `${iface.name} · ${iface.address}`}
										</option>
									))}
								</select>
							</div>
						)}
						{!tunnelUrlPending && (
							<div className={`bg-base rounded-lg p-3 ${qrConsumed ? "opacity-40" : ""}`}>
								<code className={`text-xs break-all streamer-private ${qrConsumed ? "text-fg-3" : "text-fg select-all"}`}>{remoteQR.accessUrl}</code>
							</div>
						)}

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
											startRemoteTunnel();
										} else if (!want && remoteQR.tunnelState === "connected") {
											stopRemoteTunnel();
										}
									}}
									className="accent-accent w-4 h-4"
								/>
								<span className="text-fg text-sm">{t("remote.anywhereToggle")}</span>
							</label>

							{tunnelWanted && !remoteQR.cloudflaredInstalled && (
								<div className="text-left space-y-2">
									<p className="text-danger text-xs font-medium">{t("remote.cloudflaredNotFound")}</p>
									<p className="text-fg-2 text-xs">{t("remote.cloudflaredInstallHint")}</p>
									<div className="flex items-center gap-2">
										<code className="flex-1 text-warning-strong bg-warning/10 px-3 py-2 rounded text-xs font-mono break-all select-all">
											{CLOUDFLARED_INSTALL_CMD}
										</code>
										<button
											onClick={() => {
												navigator.clipboard.writeText(CLOUDFLARED_INSTALL_CMD).catch(() => {});
												setCloudflaredCopied(true);
												setTimeout(() => setCloudflaredCopied(false), 2000);
											}}
											className="p-2 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg shrink-0"
											aria-label={t("remote.copyCommand")}
											title={t("remote.copyCommand")}
										>
											{cloudflaredCopied ? (
												<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
													<polyline points="20 6 9 17 4 12" />
												</svg>
											) : (
												<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
													<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
													<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
												</svg>
											)}
										</button>
									</div>
									{cloudflaredCopied && <p className="text-success text-xs">{t("requirements.copied")}</p>}
									<button
										onClick={() => {
											api.request.getRemoteAccessQR({ tunnel: tunnelWanted }).then((res) => {
												applyRemoteQR(res);
											}).catch(() => {});
										}}
										className="text-xs text-accent hover:text-accent-emphasis transition-colors"
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
									<div className="w-2 h-2 rounded-full bg-success" />
									<span className="text-success text-xs">{t("remote.tunnelConnected")}</span>
									<button
										type="button"
										data-testid="remote-stop-tunnel"
										onClick={stopRemoteTunnel}
										title={t("remote.stopTunnelHint")}
										className="ml-auto min-h-6 px-2 py-1.5 rounded-lg border border-edge text-fg-2 text-xs hover:text-fg hover:bg-elevated hover:border-edge-active transition-[color,background-color,border-color,transform] active:scale-[0.96]"
									>
										{t("remote.stopTunnel")}
									</button>
								</div>
							)}

							{tunnelWanted && remoteQR.tunnelState === "connected" && (
								<div className="flex items-start gap-2 rounded-lg bg-warning/10 border border-warning/20 px-2.5 py-2 text-left">
									<span
										aria-hidden="true"
										className="text-warning-strong text-sm leading-none mt-px shrink-0"
										style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
									>
										{"\uF071"}
									</span>
									<p className="text-warning-strong/90 text-xs leading-snug">{t("remote.tunnelPropagationHint")}</p>
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
								type="button"
								onClick={async () => {
									if (qrConsumed || tunnelUrlPending || remoteUrlCopyState === "copying") return;
									setRemoteUrlCopyState("copying");
									try {
										await navigator.clipboard.writeText(remoteQR.accessUrl);
										setRemoteUrlCopyState("copied");
										setTimeout(() => setRemoteUrlCopyState("idle"), 2000);
									} catch {
										setRemoteUrlCopyState("idle");
									}
								}}
								disabled={qrConsumed || tunnelUrlPending || remoteUrlCopyState === "copying"}
								aria-label={t(remoteCopyLabel)}
								className={`inline-flex min-w-[7.25rem] items-center justify-center gap-1.5 px-4 py-2 text-sm rounded-lg transition-[background-color,color,transform] active:scale-[0.98] ${qrConsumed || tunnelUrlPending ? "bg-elevated text-fg-3 cursor-not-allowed" : remoteUrlCopyState === "copying" ? "bg-accent/80 text-white cursor-wait" : remoteUrlCopyState === "copied" ? "bg-success-fill text-white hover:bg-success-fill-hover" : "bg-accent-fill text-white hover:bg-accent-fill-hover"}`}
							>
								{remoteUrlCopyState === "copying" && (
									<svg
										className="w-3.5 h-3.5 animate-spin"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										aria-hidden="true"
									>
										<circle cx="12" cy="12" r="9" strokeWidth="3" opacity="0.25" />
										<path d="M21 12a9 9 0 0 1-9 9" strokeWidth="3" strokeLinecap="round" />
									</svg>
								)}
								{remoteUrlCopyState === "copied" && (
									<span
										aria-hidden="true"
										className="leading-none"
										style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
									>
										{"\uF00C"}
									</span>
								)}
								{t(remoteCopyLabel)}
							</button>
							<button
								type="button"
								onClick={closeRemoteQR}
								className="px-4 py-2 text-sm rounded-lg text-fg-2 hover:text-fg hover:bg-elevated transition-colors"
							>
								{t("remote.close")}
							</button>
						</div>
					</>
				</RemoteAccessDialog>
			)}
			<StuckPreparationPopover tasks={state.currentProjectTasks} />
			<FolderPickerHost />
			<KeyboardShortcutsModal
				open={shortcutsModal.open}
				tab={shortcutsModal.tab}
				onTabChange={(tab) => setShortcutsModal((s) => ({ ...s, tab }))}
				onClose={() => setShortcutsModal((s) => ({ ...s, open: false }))}
			/>
			{updatePreviewOpen && <UpdatePopoverSimulatorModal onClose={() => setUpdatePreviewOpen(false)} />}
			<ConfirmHost />
			{launchRequests[0] && (
				<AgentLaunchRequestModal
					key={launchRequests[0].requestId}
					request={launchRequests[0]}
					onRespond={(approved, launch) => respondToLaunchRequest(launchRequests[0]!.requestId, approved, launch)}
				/>
			)}
			{artifactViewer?.standalone && (
				<TaskArtifactViewer
					standalone
					taskId={artifactViewer.taskId}
					artifacts={artifactViewer.artifacts}
					initialIndex={artifactViewer.index}
					onClose={closeArtifactViewer}
				/>
			)}
			{imageViewer && (
				<TaskImageViewer
					taskId={imageViewer.taskId}
					images={imageViewer.images}
					initialIndex={imageViewer.index}
					newIds={imageViewer.newIds}
					onClose={() => setImageViewer(null)}
				/>
			)}
			{aboutVersion && (
				<AboutModal
					version={aboutVersion}
					buildChannel={aboutBuildChannel}
					onClose={() => setAboutVersion(null)}
				/>
			)}
			{showFeatureFlags && <FeatureFlagsModal onClose={() => setShowFeatureFlags(false)} />}
			{showTerminalPerf && (
				<TerminalPerfOverlay
					onClose={() => {
						localStorage.setItem(TERMINAL_PERF_KEY, "0");
						setShowTerminalPerf(false);
					}}
				/>
			)}
			{rosettaWarning && (
				<RosettaWarningModal
					command={rosettaWarning.command}
					kind={rosettaWarning.kind}
					onClose={() => setRosettaWarning(null)}
				/>
			)}
			</>
			)}
			{/* File preview opens from Cmd/Ctrl+Click in ANY terminal, including the
			    immersive fullscreen one, so it lives outside the chrome conditional. */}
			{filePreview && (
				<FilePreviewModal
					path={filePreview.path}
					line={filePreview.line}
					taskId={filePreview.taskId}
					onClose={() => setFilePreview(null)}
				/>
			)}
			{/* Transport health is not immersive chrome either — a dropped socket must
			    stay visible (and retryable) while the terminal is fullscreen. */}
			<StatusDock />
			{showDiagnostics && <DiagnosticsPanel onClose={() => setShowDiagnostics(false)} />}
			{/* Toasts are transient feedback, not immersive chrome; notification toasts
			    must remain clickable so their handler can exit fullscreen first. */}
			<ToastHost onTaskOverflow={handleToastOverflow} resolveOrigin={resolveToastOrigin} />
		</div>
	);

	function renderTerminalImmersiveScreen() {
		const taskId = routeTaskId(route);
		const projectId = projectIdForRoute(route);
		if (!taskId || !projectId) return null;
		return (
			<TaskWorkspaceView
				projectId={projectId}
				taskId={taskId}
				tasks={state.currentProjectTasks}
				projects={state.projects}
				route={state.route}
				navigate={navigate}
				dispatch={dispatch}
				navigationGuardRef={navigationGuardRef}
				immersive
				isTerminalFullscreen
				onToggleTerminalFullscreen={toggleTerminalImmersive}
				artifactViewer={null}
				onCloseArtifactViewer={closeArtifactViewer}
				skipCopyModeReset={skipTerminalCopyReset}
				openUnresolvedComments={route.screen === "task" ? route.openUnresolvedComments : undefined}
			/>
		);
	}

	function renderScreen() {
		switch (route.screen) {
			case "dashboard":
				return (
					<Dashboard
						projects={state.projects}
						dispatch={dispatch}
						navigate={navigate}
						bellCounts={state.bellCounts}
						onOpenAddProject={(spaceIds) => {
							setAddProjectSpaceIds(spaceIds ?? []);
							setShowAddProjectModal(true);
						}}
					/>
				);
			case "project":
				return (
					<ProjectView
						projectId={route.projectId}
						projects={state.projects}
						tasks={state.currentProjectTasks}
						dispatch={dispatch}
						route={state.route}
						navigate={navigate}
						bellCounts={state.bellCounts}
						bellReasons={state.bellReasons}
						taskPorts={state.taskPorts}
						taskDevServers={state.taskDevServers}
						taskResourceUsage={state.taskResourceUsage}
						activeTaskId={route.activeTaskId}
						taskView={route.taskView}
						navigationGuardRef={navigationGuardRef}
						artifactViewer={artifactViewer?.standalone ? null : artifactViewer}
						onCloseArtifactViewer={closeArtifactViewer}
						isTerminalFullscreen={terminalImmersiveVisible}
						onToggleTerminalFullscreen={toggleTerminalImmersive}
						skipCopyModeReset={skipTerminalCopyReset}
						openUnresolvedComments={route.openUnresolvedComments}
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
						route={state.route}
						navigate={navigate}
						dispatch={dispatch}
						navigationGuardRef={navigationGuardRef}
						artifactViewer={artifactViewer?.standalone ? null : artifactViewer}
						onCloseArtifactViewer={closeArtifactViewer}
						isTerminalFullscreen={terminalImmersiveVisible}
						onToggleTerminalFullscreen={toggleTerminalImmersive}
						skipCopyModeReset={skipTerminalCopyReset}
						openUnresolvedComments={route.openUnresolvedComments}
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
				return <GlobalSettings section={route.section} preset={route.preset} />;
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
			case "native-pane-layout-lab":
				return <NativePaneLayoutLab navigate={navigate} />;
			default:
				return null;
		}
	}
}

export default App;
