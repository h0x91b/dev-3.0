import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useLocale, useT } from "../i18n";
import { randomUUID } from "../uuid";
import type {
	CodingAgent,
	ExternalApp,
	GlobalSettings as GlobalSettingsType,
	ArtifactTemplateMode,
	NativeTerminalAvailability,
	RemoteTunnelSettings,
	ResourceLevels,
	ShellAvailability,
	ShortcutOverrides,
	TerminalPathOpenMode,
	CompletionOfferStyle,
} from "../../shared/types";
import type { ShellFlavor } from "../../shared/posix-shell";
import type { TerminalBackendIdentity } from "../../shared/terminal-backend-identity";
import { invalidateAvailableApps } from "../hooks/useAvailableApps";
import { useDebouncedCallback } from "../hooks/useDebouncedCallback";
import { api } from "../rpc";
import { openFolderPicker } from "../folder-picker";
import { getInitialThemeState, getWindowInjectedThemeState } from "../theme-bootstrap";
import { getZoom, ZOOM_CHANGED_EVENT } from "../zoom";
import { getScrollSpeed, SCROLL_SPEED_CHANGED_EVENT } from "../scroll-speed";
import { getTerminalFontFamily, getTerminalFontSize, TERMINAL_FONT_CHANGED_EVENT } from "../terminal-font";
import { setShortcutOverrides } from "../keymap-store";
import { destroyAnalytics, trackEvent } from "../analytics";
import posthogClient from "../posthog";
import { setRuntimeTelemetryOptOut } from "../telemetry";
import { confirm } from "../confirm";
import { toast } from "../toast";
import type { UpdateChannel } from "../../shared/update-channel";
import { LOG_RETENTION_CHANGED_MESSAGE, type LogRetentionChoice } from "../../shared/log-retention";
import type { SettingsPresetTarget } from "../state";
import { applySimplifyViewPreset, unapplySimplifyViewPreset } from "../hidden-controls";
import {
	DEFAULT_GLOBAL_SETTINGS,
	normalizeExternalApps,
	resolveTheme,
	toStoredDiffViewMode,
	toStoredTaskOpenMode,
	type Theme,
} from "../components/global-settings/utils";

type GlobalSettingsUpdater = (
	prev: GlobalSettingsType,
) => GlobalSettingsType;

interface PersistOptions {
	onLocalUpdate?: (next: GlobalSettingsType) => void;
}

interface SettingChangeOptions extends PersistOptions {
	tracking?: {
		setting: string;
		value: string;
	};
}

/** The agents page's one-shot deep-link target, owned by the page's navigation. */
export interface SettingsPresetFocus {
	focusPreset: SettingsPresetTarget | null;
	clearFocusPreset: () => void;
}

/**
 * Global Settings' shared state and handlers. The page owns it once and every built-in
 * section reads it, so a save from any section sends one coherent settings object.
 */
export function useGlobalSettingsController(focus: SettingsPresetFocus) {
	const t = useT();
	const [locale, setLocale] = useLocale();
	const injectedThemeState = getWindowInjectedThemeState();

	const [theme, setTheme] = useState<Theme>(
		() =>
			getInitialThemeState({
				localStorageTheme: localStorage.getItem("dev3-theme"),
				prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
				...injectedThemeState,
			}).preference,
	);
	const [zoomLevel, setZoomLevel] = useState(() => getZoom());
	const [scrollSpeed, setScrollSpeed] = useState(() => getScrollSpeed());
	const [terminalFontFamily, setTerminalFontFamily] = useState(() => getTerminalFontFamily());
	const [terminalFontSize, setTerminalFontSize] = useState(() => getTerminalFontSize());
	const [cliInstallStatus, setCliInstallStatus] = useState<string | null>(null);
	const [cliArmedInstance, setCliArmedInstance] = useState<string | null>(null);
	const [agents, setAgents] = useState<CodingAgent[]>([]);
	const [globalSettings, setGlobalSettings] = useState<GlobalSettingsType>(
		DEFAULT_GLOBAL_SETTINGS,
	);
	const [tipsResetDone, setTipsResetDone] = useState(false);
	const [caffeinateAvailable, setCaffeinateAvailable] = useState(true);
	// FALSE until the host answers: the channel publishes per platform, and defaulting to
	// true would flash an enabled control that then leads to a 403 on a platform with no build.
	const [canaryAvailable, setCanaryAvailable] = useState(false);
	// TRUE until the host answers: the unsupported branch shows Windows-specific copy,
	// and flashing that on every macOS/Linux launch would put a plainly wrong sentence
	// on screen — worse than a toggle that is briefly live on Windows.
	const [prOriginTaskLinkSupported, setPrOriginTaskLinkSupported] = useState(true);
	// Null until the host answers whether this machine can be sampled at all.
	const [freezeDiagnostics, setFreezeDiagnostics] = useState<
		{ supported: boolean; running: boolean; directory: string } | null
	>(null);
	// Null until the host answers — the backend picker stays inert rather than
	// guessing that native is (un)available.
	const [nativeTerminalAvailability, setNativeTerminalAvailability] =
		useState<NativeTerminalAvailability | null>(null);
	const [newTaskTerminalBackend, setNewTaskTerminalBackend] =
		useState<TerminalBackendIdentity | undefined>(undefined);
	// Null until the host answers — the shell picker hides rather than claiming a
	// machine has no zsh before anyone has looked.
	const [shellAvailability, setShellAvailability] = useState<ShellAvailability | null>(null);

	const resetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const globalSettingsRef = useRef<GlobalSettingsType>(DEFAULT_GLOBAL_SETTINGS);
	const pendingAgentsSaveRef = useRef<CodingAgent[] | null>(null);
	const agentsSaveInFlightRef = useRef(false);

	const setGlobalSettingsState = useCallback((next: GlobalSettingsType) => {
		globalSettingsRef.current = next;
		setGlobalSettings(next);
	}, []);

	const applyGlobalSettingsLocally = useCallback(
		(updater: GlobalSettingsUpdater) => {
			const next = updater(globalSettingsRef.current);
			setGlobalSettingsState(next);
			return next;
		},
		[setGlobalSettingsState],
	);

	const hostSettingsLoadedRef = useRef(false);
	const [hostSettingsLoaded, setHostSettingsLoaded] = useState(false);
	const adoptHostSettings = useCallback((next: GlobalSettingsType) => {
		hostSettingsLoadedRef.current = true;
		setHostSettingsLoaded(true);
		setGlobalSettingsState(next);
	}, [setGlobalSettingsState]);

	// Every save sends the WHOLE object. Until the host has answered that object is
	// DEFAULT_GLOBAL_SETTINGS, and saving it would overwrite the user's settings.json.
	const whenHostSettingsLoaded = useCallback((run: () => void) => {
		if (hostSettingsLoadedRef.current) {
			run();
			return;
		}
		api.request.getGlobalSettings()
			.then((loaded) => {
				if (!hostSettingsLoadedRef.current) adoptHostSettings(loaded);
				run();
			})
			.catch(() => {});
	}, [adoptHostSettings]);

	const persistGlobalSettings = useCallback(
		(updater: GlobalSettingsUpdater, options: PersistOptions = {}) => {
			whenHostSettingsLoaded(() => {
				const next = applyGlobalSettingsLocally(updater);
				options.onLocalUpdate?.(next);
				api.request.saveGlobalSettings(next).catch(() => {});
			});
		},
		[applyGlobalSettingsLocally, whenHostSettingsLoaded],
	);

	const persistGlobalSettingsPatch = useCallback(
		(patch: Partial<GlobalSettingsType>, options?: PersistOptions) =>
			persistGlobalSettings((prev) => ({ ...prev, ...patch }), options),
		[persistGlobalSettings],
	);

	const persistSettingChange = useCallback(
		(patch: Partial<GlobalSettingsType>, options: SettingChangeOptions = {}) => {
			persistGlobalSettingsPatch(patch, options);
			if (options.tracking) {
				trackEvent("settings_changed", options.tracking);
			}
		},
		[persistGlobalSettingsPatch],
	);

	useEffect(() => {
		function onZoomChanged() {
			// The event detail carries the effective zoom (incl. the mobile dense
			// factor); settings display the user's saved zoom setting.
			setZoomLevel(getZoom());
		}

		window.addEventListener(ZOOM_CHANGED_EVENT, onZoomChanged);
		return () => window.removeEventListener(ZOOM_CHANGED_EVENT, onZoomChanged);
	}, []);

	useEffect(() => {
		function onScrollSpeedChanged(event: Event) {
			setScrollSpeed((event as CustomEvent<number>).detail);
		}

		window.addEventListener(SCROLL_SPEED_CHANGED_EVENT, onScrollSpeedChanged);
		return () =>
			window.removeEventListener(
				SCROLL_SPEED_CHANGED_EVENT,
				onScrollSpeedChanged,
			);
	}, []);

	useEffect(() => {
		function onTerminalFontChanged(event: Event) {
			const { family, size } = (event as CustomEvent<{ family: string; size: number }>).detail;
			setTerminalFontFamily(family);
			setTerminalFontSize(size);
		}

		window.addEventListener(TERMINAL_FONT_CHANGED_EVENT, onTerminalFontChanged);
		return () =>
			window.removeEventListener(TERMINAL_FONT_CHANGED_EVENT, onTerminalFontChanged);
	}, []);

	useEffect(() => {
		api.request.getAgents().then(setAgents).catch(() => {});
		api.request.getGlobalSettings().then((settings) => {
			adoptHostSettings(settings);
			if (settings.taskOpenMode === "fullscreen") {
				localStorage.setItem("dev3-task-open-mode", "fullscreen");
			} else {
				localStorage.removeItem("dev3-task-open-mode");
			}
		}).catch(() => {});
		// Follow the settings push, like the board host does. Every save here sends the
		// WHOLE object, so a snapshot taken at mount silently reverts anything written
		// from outside this screen since — `hiddenControls` (a right-click "Hide", the
		// Simplify View preset) being the field that actually got erased.
		function onSettingsUpdated(e: Event) {
			adoptHostSettings((e as CustomEvent<GlobalSettingsType>).detail);
		}
		window.addEventListener("rpc:globalSettingsUpdated", onSettingsUpdated);
		return () => window.removeEventListener("rpc:globalSettingsUpdated", onSettingsUpdated);
	}, [adoptHostSettings]);

	useEffect(() => {
		api.request.getNativeTerminalAvailability()
			.then(setNativeTerminalAvailability)
			.catch(() => {});
		api.request.getNewTaskTerminalBackend()
			.then(({ backend }) => setNewTaskTerminalBackend(backend ?? undefined))
			.catch(() => {});
		api.request.getShellAvailability()
			.then(setShellAvailability)
			.catch(() => {});
	}, []);

	useEffect(() => {
		api.request.checkCaffeinateAvailable()
			.then((result) => setCaffeinateAvailable(result.available))
			.catch(() => {});
	}, []);

	useEffect(() => {
		api.request.checkCanaryChannelAvailable()
			.then((result) => setCanaryAvailable(result.available))
			.catch(() => {});
	}, []);

	useEffect(() => {
		api.request.checkPrOriginTaskLinkSupported()
			.then((result) => setPrOriginTaskLinkSupported(result.supported))
			.catch(() => {});
	}, []);

	// Null until the host answers — the freeze row stays inert rather than
	// claiming a machine can be sampled before anyone has looked.
	const refreshFreezeDiagnostics = useCallback(() => {
		api.request.getFreezeDiagnosticsStatus()
			.then((status) => setFreezeDiagnostics(status))
			.catch(() => {});
	}, []);

	useEffect(() => {
		refreshFreezeDiagnostics();
	}, [refreshFreezeDiagnostics]);

	useEffect(() => {
		return () => clearTimeout(resetTimerRef.current);
	}, []);

	const applyThemeChange = useCallback((nextTheme: Theme) => {
		setTheme(nextTheme);
		const prefersDark = window.matchMedia(
			"(prefers-color-scheme: dark)",
		).matches;
		const resolvedTheme = resolveTheme(nextTheme, prefersDark);
		document.documentElement.dataset.theme = resolvedTheme;
		localStorage.setItem("dev3-theme", nextTheme);
		api.request.setTmuxTheme({ theme: resolvedTheme, preference: nextTheme }).catch(() => {});
		trackEvent("theme_changed", { theme: nextTheme });
	}, []);

	const handleTaskSortOrderChange = useCallback(
		(order: GlobalSettingsType["taskSortOrder"]) => {
			persistSettingChange(
				{ taskSortOrder: order },
				{ tracking: { setting: "task_sort_order", value: order } },
			);
		},
		[persistSettingChange],
	);

	// Switching channels is not an ordinary preference write: it leads to installing a
	// different bundle, and going back to stable installs an OLDER one that then reads
	// state a newer build wrote. Both directions are confirmed, and each states its own
	// consequence — the stable direction is the one nobody would guess.
	const handleUpdateChannelChange = useCallback(
		async (channel: UpdateChannel) => {
			const toCanary = channel === "canary";
			const ok = await confirm({
				title: t(toCanary ? "settings.updateChannelSwitchToCanaryTitle" : "settings.updateChannelSwitchToStableTitle"),
				message: t(toCanary ? "settings.updateChannelSwitchToCanaryBody" : "settings.updateChannelSwitchToStableBody"),
				confirmLabel: t(
					toCanary ? "settings.updateChannelSwitchToCanaryConfirm" : "settings.updateChannelSwitchToStableConfirm",
				),
			});
			if (!ok) return;
			persistSettingChange(
				{ updateChannel: channel },
				{
					tracking: {
						setting: "update_channel",
						value: channel,
					},
				},
			);
		},
		[persistSettingChange, t],
	);

	const handleShortcutsChange = useCallback(
		(next: ShortcutOverrides) => {
			// Mirror into the keymap store first so the new combo is live in the same
			// frame; the RPC round-trip only makes it durable.
			setShortcutOverrides(next);
			persistSettingChange({ keyboardShortcuts: next });
		},
		[persistSettingChange],
	);

	// Sidecar-backed, not part of GlobalSettings — see terminal-backend-preference.ts.
	const handleNewTaskTerminalBackendChange = useCallback(
		(backend: TerminalBackendIdentity) => {
			setNewTaskTerminalBackend(backend);
			api.request.setNewTaskTerminalBackend({ backend }).catch(() => {});
			trackEvent("settings_changed", { setting: "new_task_terminal_backend", value: backend });
		},
		[],
	);

	const handleSoundToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange({ playSoundOnTaskComplete: enabled });
		},
		[persistSettingChange],
	);

	const handleQuestionsSoundToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange({ playSoundOnTaskQuestions: enabled });
		},
		[persistSettingChange],
	);

	const handleReviewSoundToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange({ playSoundOnTaskReview: enabled });
		},
		[persistSettingChange],
	);

	const handleWatchByDefaultToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange(
				{ watchByDefault: enabled },
				{
					tracking: {
						setting: "watch_by_default",
						value: String(enabled),
					},
				},
			);
		},
		[persistSettingChange],
	);

	const handleSuggestCompletingTasksAfterMergeToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange({ suggestCompletingTasksAfterMerge: enabled });
		},
		[persistSettingChange],
	);

	const handleCompletionOfferStyleChange = useCallback(
		(style: CompletionOfferStyle) => {
			persistSettingChange(
				{ completionOfferStyle: style },
				{ tracking: { setting: "completion_offer_style", value: style } },
			);
		},
		[persistSettingChange],
	);

	const handlePrOriginTaskLinkToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange({ prOriginTaskLink: enabled });
		},
		[persistSettingChange],
	);

	const handleAgentLaunchAutoApproveChange = useCallback(
		(minutes: number) => {
			persistSettingChange({ agentLaunchAutoApproveMinutes: minutes });
		},
		[persistSettingChange],
	);
	const handleAutoHibernateChange = useCallback(
		(minutes: number) => persistSettingChange({ autoHibernateMinutes: minutes }),
		[persistSettingChange],
	);

	const handleAutoHibernateConfirmChange = useCallback(
		(minutes: number) => persistSettingChange({ autoHibernateConfirmMinutes: minutes }),
		[persistSettingChange],
	);

	const handleTipsDisabledToggle = useCallback(
		(disabled: boolean) => {
			persistSettingChange({ tipsDisabled: disabled });
		},
		[persistSettingChange],
	);

	const handleReviewModePromptChange = useCallback(
		(prompt: string) => {
			persistSettingChange({ reviewModePrompt: prompt.trim() ? prompt : undefined });
		},
		[persistSettingChange],
	);

	const handleCoordinatorPromptChange = useCallback(
		(prompt: string) => {
			persistSettingChange({ coordinatorPrompt: prompt.trim() ? prompt : undefined });
		},
		[persistSettingChange],
	);

	const handleTipsReset = useCallback(() => {
		api.request.resetTipState().then(() => {
			setTipsResetDone(true);
			clearTimeout(resetTimerRef.current);
			resetTimerRef.current = setTimeout(
				() => setTipsResetDone(false),
				3000,
			);
		}).catch(() => {});
	}, []);

	const handleTaskOpenModeChange = useCallback(
		(mode: "split" | "fullscreen") => {
			persistSettingChange(
				{ taskOpenMode: toStoredTaskOpenMode(mode) },
				{
					onLocalUpdate: () => {
						if (mode === "fullscreen") {
							localStorage.setItem("dev3-task-open-mode", "fullscreen");
						} else {
							localStorage.removeItem("dev3-task-open-mode");
						}
					},
					tracking: {
						setting: "task_open_mode",
						value: mode,
					},
				},
			);
		},
		[persistSettingChange],
	);

	const handleOpenArtifactsInPopupToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange(
				{ openArtifactsInPopup: enabled },
				{ tracking: { setting: "open_artifacts_in_popup", value: enabled ? "popup" : "panel" } },
			);
		},
		[persistSettingChange],
	);

	const handleArtifactTemplateChange = useCallback(
		(mode: ArtifactTemplateMode) => {
			persistSettingChange(
				{ artifactTemplate: mode === "on" ? undefined : mode },
				{ tracking: { setting: "artifact_template", value: mode } },
			);
			// Fill the default folder right away, so "My template" has something to open and edit.
			if (mode === "custom") {
				api.request.prepareCustomArtifactTemplate({ path: globalSettings?.artifactTemplatePath, seed: true }).catch(() => {});
			}
		},
		[persistSettingChange, globalSettings?.artifactTemplatePath],
	);

	// No tracking: the value is a local path, and paths never leave the machine.
	const handleArtifactTemplatePathChange = useCallback(
		(path: string) => persistSettingChange({ artifactTemplatePath: path || undefined }),
		[persistSettingChange],
	);

	const handleDefaultDiffViewModeChange = useCallback(
		(mode: "split" | "unified" | "auto") => {
			persistSettingChange(
				{ defaultDiffViewMode: toStoredDiffViewMode(mode) },
				{
					tracking: {
						setting: "default_diff_view_mode",
						value: mode,
					},
				},
			);
		},
		[persistSettingChange],
	);

	const handleTerminalPathOpenModeChange = useCallback(
		(mode: TerminalPathOpenMode) => {
			persistSettingChange(
				{ terminalPathOpenMode: mode },
				{
					tracking: {
						setting: "terminal_path_open_mode",
						value: mode,
					},
				},
			);
		},
		[persistSettingChange],
	);

	const handlePaneTitlesToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange(
				{ paneTitles: enabled },
				{ tracking: { setting: "pane_titles", value: enabled ? "on" : "off" } },
			);
		},
		[persistSettingChange],
	);

	const handleConfirmClosePaneToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange(
				{ confirmClosePane: enabled },
				{ tracking: { setting: "confirm_close_pane", value: enabled ? "on" : "off" } },
			);
		},
		[persistSettingChange],
	);

	const handleDimInactivePanesToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange(
				{ dimInactivePanes: enabled },
				{
					tracking: {
						setting: "dim_inactive_panes",
						value: enabled ? "on" : "off",
					},
				},
			);
		},
		[persistSettingChange],
	);

	const handleShellPromptChange = useCallback(
		(choice: string) => {
			persistSettingChange(
				{ shellPrompt: choice },
				{ tracking: { setting: "shell_prompt", value: choice } },
			);
		},
		[persistSettingChange],
	);

	// The code itself never reaches telemetry — only that a custom prompt was saved.
	const handleShellPromptCustomSave = useCallback(
		(source: string) => {
			persistSettingChange(
				{ shellPrompt: "custom", shellPromptCustom: source },
				{ tracking: { setting: "shell_prompt", value: "custom" } },
			);
		},
		[persistSettingChange],
	);

	const handleTerminalShellChange = useCallback(
		(shell: ShellFlavor | undefined) => {
			persistSettingChange(
				{ terminalShell: shell },
				{
					tracking: {
						setting: "terminal_shell",
						value: shell ?? "auto",
					},
				},
			);
			// The host re-resolves on save; re-read so a missing shell reports its
			// fallback immediately instead of after a reopen.
			api.request.getShellAvailability().then(setShellAvailability).catch(() => {});
		},
		[persistSettingChange],
	);

	const handleRemoteTunnelChange = useCallback(
		(tunnel: RemoteTunnelSettings | undefined) => {
			persistSettingChange(
				{ remoteTunnel: tunnel },
				{ tracking: { setting: "remote_tunnel_provider", value: tunnel?.provider ?? "cloudflare" } },
			);
		},
		[persistSettingChange],
	);

	const handleStaticAccessCodeChange = useCallback(
		(code: string) => {
			persistSettingChange(
				// Undefined rather than "" so an unset code leaves no key behind in
				// settings.json — getStaticCode() reads absence, not emptiness.
				{ staticAccessCode: code || undefined },
				{ tracking: { setting: "remote_static_access_code", value: code ? "set" : "cleared" } },
			);
		},
		[persistSettingChange],
	);

	const handleRemotePortChange = useCallback(
		(port: number | undefined) => {
			persistSettingChange(
				{ remotePort: port },
				{ tracking: { setting: "remote_port", value: port === undefined ? "auto" : "pinned" } },
			);
		},
		[persistSettingChange],
	);

	const handleDigitsFollowSpacesToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange(
				{ digitsFollowSpaces: enabled },
				{ tracking: { setting: "digits_follow_spaces", value: enabled ? "spaces" : "projects" } },
			);
		},
		[persistSettingChange],
	);

	const handleRemoteSilentUpdateToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange({ remoteSilentUpdate: enabled });
		},
		[persistSettingChange],
	);

	const handlePreventSleepToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange({ preventSleepWhileRunning: enabled });
		},
		[persistSettingChange],
	);

	const handleResourceLevelsChange = useCallback(
		(resourceLevels: Partial<ResourceLevels>) => {
			persistSettingChange({ resourceLevels });
		},
		[persistSettingChange],
	);

	const handleConfirmBeforeQuitToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange({ skipQuitDialog: enabled ? undefined : true });
		},
		[persistSettingChange],
	);

	const handleAutoCleanupTaskHistoryToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange({ autoCleanupTaskHistory: enabled ? undefined : false });
		},
		[persistSettingChange],
	);

	// Host-owned: the host saves it and prunes, so this adopts the saved settings it returns.
	const handleLogRetentionChange = useCallback(
		async (choice: LogRetentionChoice, expectedCurrent: LogRetentionChoice) => {
			try {
				adoptHostSettings(await api.request.setLogRetention({ value: choice, expectedCurrent }));
			} catch (err) {
				// The host refused because the retention changed since the user chose; show the real one.
				const stale = String(err).includes(LOG_RETENTION_CHANGED_MESSAGE);
				// A lost reply can follow a save, so whatever failed, show what the host holds now.
				await api.request.getGlobalSettings().then(adoptHostSettings).catch(() => {});
				if (stale) toast.info(t("settings.logRetentionChangedElsewhere"), { source: "settings" });
				else toast.error(t("settings.logRetentionSaveFailed"), { source: "settings" });
			}
		},
		[adoptHostSettings, t],
	);

	const handleFocusModeToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange({ focusMode: enabled });
		},
		[persistSettingChange],
	);

	const handleAgentEnvDefaultsChange = useCallback(
		(env: Record<string, string> | undefined) => {
			persistSettingChange({ agentEnvDefaults: env });
		},
		[persistSettingChange],
	);

	const handleRateLimitTrackingToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange({ agentRateLimitTracking: enabled });
		},
		[persistSettingChange],
	);

	const handleLeanProtocolToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange({ leanAgentProtocol: enabled });
		},
		[persistSettingChange],
	);

	const handleTelemetryToggle = useCallback(
		(disabled: boolean) => {
			// Silence the live channels before anything else, so the write that
			// records the opt-out is not itself the last event sent.
			setRuntimeTelemetryOptOut(disabled);
			if (disabled) {
				posthogClient.opt_out_capturing();
				destroyAnalytics();
			}
			persistSettingChange({ telemetryDisabled: disabled ? true : undefined });
		},
		[persistSettingChange],
	);

	const handleTerminalBidiToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange(
				// Stored either way: an explicit false is the opt-out from a default-on beta.
				{ experimentalTerminalBidi: enabled },
				{
					tracking: {
						setting: "experimental_terminal_bidi",
						value: String(enabled),
					},
				},
			);
		},
		[persistSettingChange],
	);

	const handleAgentTrafficToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange(
				// Stored either way: an explicit false is the opt-out from a default-on beta.
				{ experimentalAgentTraffic: enabled },
				{
					tracking: {
						setting: "experimental_agent_traffic",
						value: String(enabled),
					},
				},
			);
		},
		[persistSettingChange],
	);

	const handleFreezeDiagnosticsToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange(
				// Default-off opt-in: the key only exists while recording is wanted.
				{ freezeDiagnosticsEnabled: enabled ? true : undefined },
				{ tracking: { setting: "freeze_diagnostics_enabled", value: String(enabled) } },
			);
			// The host starts or stops the collector on save; read back what it did
			// instead of assuming the switch and the worker agree.
			refreshFreezeDiagnostics();
		},
		[persistSettingChange, refreshFreezeDiagnostics],
	);

	const handleSimplifyModeToggle = useCallback((enabled: boolean) => {

		if (enabled) applySimplifyViewPreset();
		else unapplySimplifyViewPreset();
		trackEvent("settings_changed", { setting: "simplify_mode", value: String(enabled) });
	}, []);

	const handlePxpipeProxyToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange(
				{ pxpipeProxyEnabled: enabled ? true : undefined },
				{ tracking: { setting: "pxpipe_proxy_enabled", value: String(enabled) } },
			);
		},
		[persistSettingChange],
	);

	const saveExternalApps = useCallback(
		(apps: ExternalApp[]) => {
			whenHostSettingsLoaded(() => {
				api.request.saveGlobalSettings({
					...globalSettingsRef.current,
					externalApps: normalizeExternalApps(apps),
				}).then(() => {
					invalidateAvailableApps();
				}).catch(() => {});
			});
		},
		[whenHostSettingsLoaded],
	);

	const debouncedSaveExternalApps = useDebouncedCallback(saveExternalApps, 500);

	const handleAddExternalApp = useCallback(() => {
		const newApp: ExternalApp = {
			id: randomUUID(),
			name: "",
			macAppName: "",
		};
		applyGlobalSettingsLocally((prev) => ({
			...prev,
			externalApps: [...(prev.externalApps ?? []), newApp],
		}));
	}, [applyGlobalSettingsLocally]);

	const handleUpdateExternalApp = useCallback(
		(appId: string, patch: Partial<ExternalApp>) => {
			const apps = (globalSettingsRef.current.externalApps ?? []).map((app) =>
				app.id === appId ? { ...app, ...patch } : app,
			);
			applyGlobalSettingsLocally((prev) => ({
				...prev,
				externalApps: apps,
			}));
			debouncedSaveExternalApps(apps);
		},
		[applyGlobalSettingsLocally, debouncedSaveExternalApps],
	);

	const handleDeleteExternalApp = useCallback(
		(appId: string) => {
			const apps = (globalSettingsRef.current.externalApps ?? []).filter(
				(app) => app.id !== appId,
			);
			persistGlobalSettings(
				(prev) => ({
					...prev,
					externalApps: normalizeExternalApps(apps),
				}),
				{
					onLocalUpdate: () => invalidateAvailableApps(),
				},
			);
		},
		[persistGlobalSettings],
	);

	const handlePickCloneBaseDirectory = useCallback(async () => {
		try {
			const folder = await openFolderPicker();
			if (!folder) return;
			persistSettingChange({ cloneBaseDirectory: folder });
		} catch (error) {
			console.error("[GlobalSettings] openFolderPicker failed:", error);
		}
	}, [persistSettingChange]);

	const handleDefaultAgentChange = useCallback(
		(agentId: string) => {
			const agent = agents.find((item) => item.id === agentId);
			const configId =
				agent?.defaultConfigId ?? agent?.configurations[0]?.id ?? "";
			persistSettingChange({
				defaultAgentId: agentId,
				defaultConfigId: configId,
			});
		},
		[agents, persistSettingChange],
	);

	const handleCoordinatorDefaultChange = useCallback(
		(agentId: string, configId: string | null) => {
			persistSettingChange({ coordinatorAgentId: agentId, coordinatorConfigId: configId ?? undefined });
		},
		[persistSettingChange],
	);

	const handleDefaultConfigChange = useCallback(
		(configId: string) => {
			persistSettingChange({ defaultConfigId: configId });
		},
		[persistSettingChange],
	);

	const flushPendingAgentsSave = useCallback(async () => {
		if (agentsSaveInFlightRef.current) {
			return;
		}

		agentsSaveInFlightRef.current = true;
		try {
			while (pendingAgentsSaveRef.current) {
				const next = pendingAgentsSaveRef.current;
				pendingAgentsSaveRef.current = null;
				try {
					await api.request.saveAgents({ agents: next });
				} catch {
					// Best-effort save; keep local UI state and continue with the newest pending payload.
				}
			}
		} finally {
			agentsSaveInFlightRef.current = false;
		}
	}, []);

	const persistAgents = useCallback((updated: CodingAgent[]) => {
		setAgents(updated);
		pendingAgentsSaveRef.current = updated;
		void flushPendingAgentsSave();
	}, [flushPendingAgentsSave]);

	const handleLocaleChange = useCallback((nextLocale: "en" | "ru" | "es") => {
		setLocale(nextLocale);
		trackEvent("locale_changed", { locale: nextLocale });
	}, [setLocale]);

	const handleInstallDev3Cli = useCallback(async () => {
		try {
			setCliInstallStatus(null);
			setCliArmedInstance(null);
			const { installedFrom, selfShimPath, selfInstance } = await api.request.installDev3Cli();
			setCliInstallStatus(installedFrom);
			setCliArmedInstance(t("settings.installDev3CliArmed", { shim: selfShimPath, instance: selfInstance }));
		} catch (error) {
			setCliInstallStatus(`Error: ${error}`);
		}
	}, [t]);

	return {
		...focus,
		t,
		locale,
		theme,
		zoomLevel,
		applyThemeChange,
		handleLocaleChange,
		handleSimplifyModeToggle,
		globalSettings,
		setGlobalSettings,
		tipsResetDone,
		agents,
		persistAgents,
		caffeinateAvailable,
		canaryAvailable,
		cliArmedInstance,
		cliInstallStatus,
		freezeDiagnostics,
		hostSettingsLoaded,
		nativeTerminalAvailability,
		newTaskTerminalBackend,
		prOriginTaskLinkSupported,
		scrollSpeed,
		shellAvailability,
		terminalFontFamily,
		terminalFontSize,
		handleAddExternalApp,
		handleAgentEnvDefaultsChange,
		handleAgentLaunchAutoApproveChange,
		handleAgentTrafficToggle,
		handleArtifactTemplateChange,
		handleArtifactTemplatePathChange,
		handleAutoCleanupTaskHistoryToggle,
		handleAutoHibernateChange,
		handleAutoHibernateConfirmChange,
		handleCompletionOfferStyleChange,
		handleConfirmBeforeQuitToggle,
		handleConfirmClosePaneToggle,
		handleCoordinatorDefaultChange,
		handleCoordinatorPromptChange,
		handleDefaultAgentChange,
		handleDefaultConfigChange,
		handleDefaultDiffViewModeChange,
		handleDeleteExternalApp,
		handleDigitsFollowSpacesToggle,
		handleDimInactivePanesToggle,
		handleFocusModeToggle,
		handleFreezeDiagnosticsToggle,
		handleInstallDev3Cli,
		handleLeanProtocolToggle,
		handleLogRetentionChange,
		handleNewTaskTerminalBackendChange,
		handleOpenArtifactsInPopupToggle,
		handlePaneTitlesToggle,
		handlePickCloneBaseDirectory,
		handlePrOriginTaskLinkToggle,
		handlePreventSleepToggle,
		handlePxpipeProxyToggle,
		handleQuestionsSoundToggle,
		handleRateLimitTrackingToggle,
		handleRemotePortChange,
		handleRemoteSilentUpdateToggle,
		handleRemoteTunnelChange,
		handleResourceLevelsChange,
		handleReviewModePromptChange,
		handleReviewSoundToggle,
		handleShellPromptChange,
		handleShellPromptCustomSave,
		handleShortcutsChange,
		handleSoundToggle,
		handleStaticAccessCodeChange,
		handleSuggestCompletingTasksAfterMergeToggle,
		handleTaskOpenModeChange,
		handleTaskSortOrderChange,
		handleTelemetryToggle,
		handleTerminalBidiToggle,
		handleTerminalPathOpenModeChange,
		handleTerminalShellChange,
		handleTipsDisabledToggle,
		handleTipsReset,
		handleUpdateChannelChange,
		handleUpdateExternalApp,
		handleWatchByDefaultToggle,
	};
}

export type GlobalSettingsController = ReturnType<typeof useGlobalSettingsController>;

export const SettingsControllerContext = createContext<GlobalSettingsController | null>(null);

export function useSettingsController(): GlobalSettingsController {
	const controller = useContext(SettingsControllerContext);
	if (!controller) throw new Error("useSettingsController() outside the Global Settings page");
	return controller;
}
