import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import {
	useLocale,
	useT,
	type TFunction,
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
import { getScrollSpeed, SCROLL_SPEED_CHANGED_EVENT } from "../scroll-speed";
import { getKeymapPreset, setKeymapPreset } from "../terminal-keymaps";
import { trackEvent } from "../analytics";
import AgentAccountsSection from "./global-settings/AgentAccountsSection";
import AgentRateLimitSettingsSection from "./global-settings/AgentRateLimitSettingsSection";
import AgentSettingsSection from "./global-settings/AgentSettingsSection";
import AppearanceSettingsSection from "./global-settings/AppearanceSettingsSection";
import BehaviorSettingsSection from "./global-settings/BehaviorSettingsSection";
import DeveloperToolsSection from "./global-settings/DeveloperToolsSection";
import PxpipeProxySettingsSection from "./global-settings/PxpipeProxySettingsSection";
import SystemSettingsSection from "./global-settings/SystemSettingsSection";
import TerminalSettingsSection from "./global-settings/TerminalSettingsSection";
import WorkspaceSettingsSection from "./global-settings/WorkspaceSettingsSection";
import type { SettingsSectionId } from "../state";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import {
	filterSettingsEntries,
	groupSettingsEntriesByCategory,
	normalizeSettingsCategoryId,
	SETTINGS_CATEGORIES,
	type SettingsCategoryId,
	type SettingsEntry as SettingsRegistryEntry,
} from "../settings-registry";
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

function GlobalSettings({ section }: { section?: SettingsSectionId } = {}) {
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
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>(() =>
		normalizeSettingsCategoryId(section),
	);
	const [mobileCategory, setMobileCategory] = useState<SettingsCategoryId | null>(
		() => (section ? normalizeSettingsCategoryId(section) : null),
	);
	const [searchQuery, setSearchQuery] = useState("");
	const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
	const detailHeadingRef = useRef<HTMLHeadingElement>(null);

	const resetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const globalSettingsRef = useRef<GlobalSettingsType>(DEFAULT_GLOBAL_SETTINGS);
	const pendingAgentsSaveRef = useRef<CodingAgent[] | null>(null);
	const agentsSaveInFlightRef = useRef(false);

	const filteredSettingsEntries = useMemo(
		() => filterSettingsEntries(searchQuery, t),
		[searchQuery, t],
	);
	const groupedSearchResults = useMemo(
		() => groupSettingsEntriesByCategory(filteredSettingsEntries),
		[filteredSettingsEntries],
	);

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

	const handlePreventSleepToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange({ preventSleepWhileRunning: enabled });
		},
		[persistSettingChange],
	);

	const handleConfirmBeforeQuitToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange({ skipQuitDialog: enabled ? undefined : true });
		},
		[persistSettingChange],
	);

	const handleFocusModeToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange({ focusMode: enabled });
		},
		[persistSettingChange],
	);

	const handleRateLimitTrackingToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange({ agentRateLimitTracking: enabled });
		},
		[persistSettingChange],
	);

	const handlePxpipeProxyToggle = useCallback(
		(enabled: boolean) => {
			persistSettingChange(
				{ pxpipeProxyEnabled: enabled ? true : undefined },
				{ tracking: { setting: "pxpipe_proxy_enabled", value: String(enabled) } },
			);
		},
		[persistSettingChange],
	);

	// Deep-links keep accepting legacy section ids while the visible route uses
	// the current category vocabulary.
	useEffect(() => {
		const nextCategory = normalizeSettingsCategoryId(section);
		setActiveCategory(nextCategory);
		if (narrow && section) setMobileCategory(nextCategory);
	}, [narrow, section]);

	useEffect(() => {
		if (!narrow) setMobileCategory(null);
	}, [narrow]);

	useEffect(() => {
		if (!pendingAnchor || searchQuery.trim()) return;
		const element = document.querySelector(
			`[data-settings-entry="${pendingAnchor}"]`,
		) as HTMLElement | null;
		if (!element) return;
		element.scrollIntoView?.({ behavior: "smooth", block: "start" });
		setPendingAnchor(null);
		detailHeadingRef.current?.focus({ preventScroll: true });
	}, [activeCategory, pendingAnchor, searchQuery]);

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

	function renderCategoryPage(category: SettingsCategoryId): ReactNode {
		switch (category) {
			case "appearance":
				return (
					<AppearanceSettingsSection
						t={t}
						locale={locale}
						theme={theme}
						zoomLevel={zoomLevel}
						onThemeChange={applyThemeChange}
						onLocaleChange={handleLocaleChange}
					/>
				);
			case "tasks":
				return (
					<BehaviorSettingsSection
						t={t}
						globalSettings={globalSettings}
						tipsResetDone={tipsResetDone}
						onDefaultDiffViewModeChange={handleDefaultDiffViewModeChange}
						onSoundToggle={handleSoundToggle}
						onWatchByDefaultToggle={handleWatchByDefaultToggle}
						onFocusModeToggle={handleFocusModeToggle}
						onTaskDropPositionChange={handleTaskDropPositionChange}
						onTaskOpenModeChange={handleTaskOpenModeChange}
						onTipsDisabledToggle={handleTipsDisabledToggle}
						onTipsReset={handleTipsReset}
					/>
				);
			case "terminal":
				return (
					<TerminalSettingsSection
						t={t}
						keymapPreset={keymapPreset}
						scrollSpeed={scrollSpeed}
						onKeymapChange={handleKeymapChange}
					/>
				);
			case "agents":
				return (
					<>
						<AgentSettingsSection
							t={t}
							agents={agents}
							globalSettings={globalSettings}
							onAgentsChange={persistAgents}
							onDefaultAgentChange={handleDefaultAgentChange}
							onDefaultConfigChange={handleDefaultConfigChange}
						/>
						<AgentRateLimitSettingsSection
							t={t}
							globalSettings={globalSettings}
							onToggle={handleRateLimitTrackingToggle}
						/>
					</>
				);
			case "accounts":
				return <AgentAccountsSection t={t} />;
			case "workspace":
				return (
					<WorkspaceSettingsSection
						t={t}
						globalSettings={globalSettings}
						onAddExternalApp={handleAddExternalApp}
						onDeleteExternalApp={handleDeleteExternalApp}
						onPickCloneBaseDirectory={handlePickCloneBaseDirectory}
						onUpdateExternalApp={handleUpdateExternalApp}
					/>
				);
			case "system":
				return (
					<>
						<SystemSettingsSection
							t={t}
							globalSettings={globalSettings}
							caffeinateAvailable={caffeinateAvailable}
							onUpdateChannelChange={handleUpdateChannelChange}
							onPreventSleepToggle={handlePreventSleepToggle}
							onConfirmBeforeQuitToggle={handleConfirmBeforeQuitToggle}
						/>
						<PxpipeProxySettingsSection
							t={t}
							globalSettings={globalSettings}
							onToggle={handlePxpipeProxyToggle}
						/>
						<DeveloperToolsSection
							t={t}
							cliInstallStatus={cliInstallStatus}
							onInstallDev3Cli={handleInstallDev3Cli}
						/>
					</>
				);
		}
	}

	const selectCategory = useCallback(
		(category: SettingsCategoryId) => {
			setSearchQuery("");
			setPendingAnchor(null);
			setActiveCategory(category);
			if (narrow) setMobileCategory(category);
		},
		[narrow],
	);

	const selectSearchResult = useCallback(
		(entry: SettingsRegistryEntry) => {
			setSearchQuery("");
			setActiveCategory(entry.category);
			setPendingAnchor(entry.anchor ?? null);
			if (narrow) setMobileCategory(entry.category);
		},
		[narrow],
	);

	const returnToCategoryList = useCallback(() => {
		setSearchQuery("");
		setPendingAnchor(null);
		setMobileCategory(null);
	}, []);

	const selectedCategory =
		SETTINGS_CATEGORIES.find((category) => category.id === activeCategory) ??
		SETTINGS_CATEGORIES[0];
	const settingsNavigation = (
		<SettingsNavigation
			t={t}
			activeCategory={activeCategory}
			query={searchQuery}
			narrow={narrow}
			searchGroups={groupedSearchResults}
			onQueryChange={setSearchQuery}
			onCategorySelect={selectCategory}
			onSearchResult={selectSearchResult}
		/>
	);
	const settingsDetail = (
		<main
			className="min-w-0 min-h-0 flex-1 overflow-y-auto p-5 md:p-7"
			aria-labelledby="settings-category-title"
		>
			{narrow ? (
				<button
					type="button"
					onClick={returnToCategoryList}
					className="mb-5 inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm text-fg-2 hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
				>
					<span aria-hidden="true">←</span>
					{t("settings.categoryBack")}
				</button>
			) : null}
			<div className="mx-auto w-full max-w-5xl">
				{searchQuery.trim() ? (
					<SettingsSearchResults
						t={t}
						groups={groupedSearchResults}
						onSelect={selectSearchResult}
					/>
				) : (
					<>
						<div className="mb-7">
							<h2
								id="settings-category-title"
								ref={detailHeadingRef}
								tabIndex={-1}
								className="text-fg text-xl font-semibold tracking-tight outline-none"
							>
								{t(selectedCategory.labelKey)}
							</h2>
							<p className="mt-1 text-sm text-fg-3">
								{t(selectedCategory.descriptionKey)}
							</p>
						</div>
						<div className="space-y-8">{renderCategoryPage(activeCategory)}</div>
					</>
				)}
			</div>
		</main>
	);

	return (
		<div className="h-full w-full flex flex-col">
			<div className="min-h-0 flex-1 p-2 sm:p-4 md:p-6">
				<div className="h-full min-h-0 max-w-6xl mx-auto overflow-hidden flex flex-col md:flex-row bg-raised/80 backdrop-blur-sm border border-edge/50 rounded-2xl">
					{narrow ? (
						mobileCategory ? settingsDetail : settingsNavigation
					) : (
						<>
							{settingsNavigation}
							{settingsDetail}
						</>
					)}
				</div>
			</div>
		</div>
	);
}

function SettingsNavigation({
	t,
	activeCategory,
	query,
	narrow,
	searchGroups,
	onQueryChange,
	onCategorySelect,
	onSearchResult,
}: {
	t: TFunction;
	activeCategory: SettingsCategoryId;
	query: string;
	narrow: boolean;
	searchGroups: ReturnType<typeof groupSettingsEntriesByCategory>;
	onQueryChange: (query: string) => void;
	onCategorySelect: (category: SettingsCategoryId) => void;
	onSearchResult: (entry: SettingsRegistryEntry) => void;
}) {
	return (
		<aside
			className={`flex min-h-0 w-full shrink-0 flex-col ${
				narrow ? "" : "md:w-64 md:border-r md:border-edge/60"
			}`}
		>
			<div className="border-b border-edge/60 p-4 md:p-5">
				<h1 className="text-fg text-lg font-semibold tracking-tight">
					{t("settings.settingsTitle")}
				</h1>
				<p className="mt-1 text-xs text-fg-3">{t("settings.settingsDesc")}</p>
				<div className="relative mt-4">
					<label htmlFor="settings-search" className="sr-only">
						{t("settings.searchLabel")}
					</label>
					<input
						id="settings-search"
						type="search"
						value={query}
						onChange={(event) => onQueryChange(event.target.value)}
						placeholder={t("settings.searchPlaceholder")}
						className="w-full rounded-xl border border-edge bg-base px-3 py-2.5 pr-10 text-sm text-fg outline-none placeholder:text-fg-muted focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
					/>
					{query ? (
						<button
							type="button"
							onClick={() => onQueryChange("")}
							aria-label={t("settings.searchClear")}
							className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-lg text-fg-muted hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
						>
							×
						</button>
					) : null}
				</div>
			</div>
			<nav
				aria-label={t("settings.categories")}
				className="min-h-0 flex-1 overflow-y-auto p-2"
			>
				{narrow && query.trim() ? (
					<SettingsSearchResults
						t={t}
						groups={searchGroups}
						onSelect={onSearchResult}
					/>
				) : (
					<ul className="space-y-1">
						{SETTINGS_CATEGORIES.map((category) => (
							<li key={category.id}>
								<button
									type="button"
									aria-current={
										activeCategory === category.id ? "page" : undefined
									}
									onClick={() => onCategorySelect(category.id)}
									className={`flex min-h-11 w-full items-center rounded-xl border px-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
										activeCategory === category.id
											? "border-accent/50 bg-accent/10 text-accent"
											: "border-transparent text-fg-2 hover:border-edge hover:bg-elevated hover:text-fg"
									}`}
								>
									{t(category.labelKey)}
								</button>
							</li>
						))}
					</ul>
				)}
			</nav>
		</aside>
	);
}

function SettingsSearchResults({
	t,
	groups,
	onSelect,
}: {
	t: TFunction;
	groups: ReturnType<typeof groupSettingsEntriesByCategory>;
	onSelect: (entry: SettingsRegistryEntry) => void;
}) {
	if (groups.length === 0) {
		return (
			<div className="rounded-xl border border-edge bg-base/50 p-4 text-sm text-fg-3">
				{t("settings.searchNoResults")}
			</div>
		);
	}

	return (
		<div>
			<h2 className="text-fg text-xl font-semibold tracking-tight">
				{t("settings.searchResults")}
			</h2>
			<div className="mt-5 space-y-6">
				{groups.map((group) => (
					<section key={group.category.id}>
						<h3 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
							{t(group.category.labelKey)}
						</h3>
						<div className="mt-2 space-y-2">
							{group.entries.map((entry) => (
								<button
									key={entry.id}
									type="button"
									onClick={() => onSelect(entry)}
									className="block min-h-11 w-full rounded-xl border border-edge bg-raised p-3 text-left transition-colors hover:border-accent/50 hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
								>
									<span className="block text-sm font-semibold text-fg">
										{t(entry.titleKey)}
									</span>
									<span className="mt-0.5 block text-xs text-fg-3">
										{t(entry.descriptionKey)}
									</span>
									<span className="mt-2 block text-[0.6875rem] text-fg-muted">
										{t("settings.searchResultCategory", {
											category: t(group.category.labelKey),
										})}
									</span>
								</button>
							))}
						</div>
					</section>
				))}
			</div>
		</div>
	);
}

export default GlobalSettings;
