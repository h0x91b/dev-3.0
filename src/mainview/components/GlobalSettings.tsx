import { useCallback, useEffect, useRef, useState } from "react";
import {
	useLocale,
	useT,
} from "../i18n";
import { randomUUID } from "../uuid";
import type {
	CodingAgent,
	ExternalApp,
	GlobalSettings as GlobalSettingsType,
	TerminalKeymapPreset,
} from "../../shared/types";
import { invalidateAvailableApps } from "../hooks/useAvailableApps";
import { useDebouncedCallback } from "../hooks/useDebouncedCallback";
import { api } from "../rpc";
import { openFolderPicker } from "../folder-picker";
import { getInitialThemeState, getWindowInjectedThemeState } from "../theme-bootstrap";
import { getZoom, ZOOM_CHANGED_EVENT } from "../zoom";
import { getKeymapPreset, setKeymapPreset } from "../terminal-keymaps";
import { trackEvent } from "../analytics";
import AgentSettingsSection from "./global-settings/AgentSettingsSection";
import AppearanceSettingsSection from "./global-settings/AppearanceSettingsSection";
import BehaviorSettingsSection from "./global-settings/BehaviorSettingsSection";
import DeveloperToolsSection from "./global-settings/DeveloperToolsSection";
import WorkspaceSettingsSection from "./global-settings/WorkspaceSettingsSection";
import {
	DEFAULT_GLOBAL_SETTINGS,
	normalizeExternalApps,
	resolveTheme,
	toStoredDiffViewMode,
	toStoredTaskOpenMode,
	type Theme,
} from "./global-settings/utils";

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

function GlobalSettings() {
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
	const [cliInstallStatus, setCliInstallStatus] = useState<string | null>(null);
	const [keymapPreset, setKeymapPresetState] = useState<TerminalKeymapPreset>(
		() => getKeymapPreset(),
	);
	const [agents, setAgents] = useState<CodingAgent[]>([]);
	const [globalSettings, setGlobalSettings] = useState<GlobalSettingsType>(
		DEFAULT_GLOBAL_SETTINGS,
	);
	const [tipsResetDone, setTipsResetDone] = useState(false);
	const [caffeinateAvailable, setCaffeinateAvailable] = useState(true);

	const resetTimerRef = useRef<ReturnType<typeof setTimeout>>();
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

	const persistGlobalSettings = useCallback(
		(updater: GlobalSettingsUpdater, options: PersistOptions = {}) => {
			const next = applyGlobalSettingsLocally(updater);
			options.onLocalUpdate?.(next);
			api.request.saveGlobalSettings(next).catch(() => {});
			return next;
		},
		[applyGlobalSettingsLocally],
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
		function onZoomChanged(event: Event) {
			setZoomLevel((event as CustomEvent<number>).detail);
		}

		window.addEventListener(ZOOM_CHANGED_EVENT, onZoomChanged);
		return () => window.removeEventListener(ZOOM_CHANGED_EVENT, onZoomChanged);
	}, []);

	useEffect(() => {
		api.request.getAgents().then(setAgents).catch(() => {});
		api.request.getGlobalSettings().then((settings) => {
			setGlobalSettingsState(settings);
			if (settings.terminalKeymap) {
				setKeymapPresetState(settings.terminalKeymap);
				setKeymapPreset(settings.terminalKeymap);
			}
			if (settings.taskOpenMode === "fullscreen") {
				localStorage.setItem("dev3-task-open-mode", "fullscreen");
			} else {
				localStorage.removeItem("dev3-task-open-mode");
			}
		}).catch(() => {});
	}, [setGlobalSettingsState]);

	useEffect(() => {
		api.request.checkCaffeinateAvailable()
			.then((result) => setCaffeinateAvailable(result.available))
			.catch(() => {});
	}, []);

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

	const handleTaskDropPositionChange = useCallback(
		(position: "top" | "bottom") => {
			persistSettingChange(
				{ taskDropPosition: position },
				{
					tracking: {
						setting: "task_drop_position",
						value: position,
					},
				},
			);
		},
		[persistSettingChange],
	);

	const handleUpdateChannelChange = useCallback(
		(channel: "stable" | "canary") => {
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
		[persistSettingChange],
	);

	const handleKeymapChange = useCallback(
		(preset: TerminalKeymapPreset) => {
			setKeymapPresetState(preset);
			setKeymapPreset(preset);
			persistSettingChange({ terminalKeymap: preset });
		},
		[persistSettingChange],
	);

	const handleSoundToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange({ playSoundOnTaskComplete: enabled });
		},
		[persistSettingChange],
	);

	const handleTipsDisabledToggle = useCallback(
		(disabled: boolean) => {
			persistSettingChange({ tipsDisabled: disabled });
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

	const handleDefaultDiffViewModeChange = useCallback(
		(mode: "split" | "unified") => {
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

	const handlePreventSleepToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange({ preventSleepWhileRunning: enabled });
		},
		[persistSettingChange],
	);

	const saveExternalApps = useCallback(
		(apps: ExternalApp[]) => {
			api.request.saveGlobalSettings({
				...globalSettingsRef.current,
				externalApps: normalizeExternalApps(apps),
			}).then(() => {
				invalidateAvailableApps();
			}).catch(() => {});
		},
		[],
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
			const { installedFrom } = await api.request.installDev3Cli();
			setCliInstallStatus(installedFrom);
		} catch (error) {
			setCliInstallStatus(`Error: ${error}`);
		}
	}, []);

	return (
		<div className="h-full w-full flex flex-col">
			<div className="flex-1 overflow-y-auto p-7">
				<div className="max-w-2xl mx-auto bg-raised/80 backdrop-blur-sm border border-edge/50 rounded-2xl p-6">
					<AppearanceSettingsSection
						t={t}
						locale={locale}
						theme={theme}
						zoomLevel={zoomLevel}
						onThemeChange={applyThemeChange}
						onLocaleChange={handleLocaleChange}
					/>
					<BehaviorSettingsSection
						t={t}
						globalSettings={globalSettings}
						caffeinateAvailable={caffeinateAvailable}
						keymapPreset={keymapPreset}
						tipsResetDone={tipsResetDone}
						onDefaultDiffViewModeChange={handleDefaultDiffViewModeChange}
						onKeymapChange={handleKeymapChange}
						onPreventSleepToggle={handlePreventSleepToggle}
						onSoundToggle={handleSoundToggle}
						onTaskDropPositionChange={handleTaskDropPositionChange}
						onTaskOpenModeChange={handleTaskOpenModeChange}
						onTipsDisabledToggle={handleTipsDisabledToggle}
						onTipsReset={handleTipsReset}
					/>
					<WorkspaceSettingsSection
						t={t}
						globalSettings={globalSettings}
						onAddExternalApp={handleAddExternalApp}
						onDeleteExternalApp={handleDeleteExternalApp}
						onPickCloneBaseDirectory={handlePickCloneBaseDirectory}
						onUpdateChannelChange={handleUpdateChannelChange}
						onUpdateExternalApp={handleUpdateExternalApp}
					/>
					<AgentSettingsSection
						t={t}
						agents={agents}
						globalSettings={globalSettings}
						onAgentsChange={persistAgents}
						onDefaultAgentChange={handleDefaultAgentChange}
						onDefaultConfigChange={handleDefaultConfigChange}
					/>
					<DeveloperToolsSection
						t={t}
						cliInstallStatus={cliInstallStatus}
						onInstallDev3Cli={handleInstallDev3Cli}
					/>
				</div>
			</div>
		</div>
	);
}

export default GlobalSettings;
