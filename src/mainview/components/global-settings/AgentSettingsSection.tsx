import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
	AgentCheckResult,
	AgentConfiguration,
	AgentFamily,
	BedrockGeo,
	CodingAgent,
	EffortLevel,
	GlobalSettings,
	LlmProvider,
	PermissionMode,
	ProviderConfig,
	ProviderSettings,
} from "../../../shared/types";
import { LLM_PROVIDER } from "../../../shared/types";
import { agentKey, autoAgentFamily, isKnownAgentCommand, SELECTABLE_AGENT_FAMILIES } from "../../../shared/agent-adapters/families";
import { randomUUID } from "../../uuid";
import { ListEditor } from "../ListEditor";
import AgentConfigPicker from "../AgentConfigPicker";
import Select, { type SelectOption } from "../Select";
import { confirm } from "../../confirm";
import { toast } from "../../toast";
import { api } from "../../rpc";
import { openFilePicker } from "../../folder-picker";
import type { TFunction, TranslationKey } from "../../i18n";
import { buildPickerGroups, getModeLeafLabel, getModelGroupLabel, type PickerGroup } from "../../utils/agentPicker";
import { useToggleFavorite } from "../../hooks/useToggleFavorite";
import PresetModelRoles from "./PresetModelRoles";
import { useModelCatalog } from "../../hooks/useModelCatalog";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";
import {
	BEDROCK_GEOS,
	DEFAULT_BEDROCK_GEO,
	defaultModelMap,
	getProviderDefinition,
	providersForAgent,
} from "../../../shared/llm-provider";
import { buildCommandPreview } from "./utils";
import type { SettingsPresetTarget } from "../../state";

/** One star, recoloured per state: outline = not a favorite, filled = favorite.
 *  Inline SVG rather than a Nerd Font glyph, which renders as tofu until the
 *  icon face loads. */
function StarIcon({ filled }: { filled: boolean }) {
	return (
		<svg
			aria-hidden
			className="w-3.5 h-3.5 flex-shrink-0"
			viewBox="0 0 24 24"
			fill={filled ? "currentColor" : "none"}
			stroke="currentColor"
			strokeWidth={1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8z" />
		</svg>
	);
}

interface AgentSettingsSectionProps {
	t: TFunction;
	agents: CodingAgent[];
	globalSettings: GlobalSettings;
	onAgentsChange: (updated: CodingAgent[]) => void | Promise<void>;
	onDefaultAgentChange: (agentId: string) => void;
	onDefaultConfigChange: (configId: string) => void;
	/** Fresh settings after a favorite toggle, so the stars re-render. */
	onGlobalSettingsChange: (settings: GlobalSettings) => void;
	/** A preset a deep-link wants shown: selected, revealed on narrow viewports,
	 *  and scrolled into view inside the list's own scroll box. */
	focusPreset?: SettingsPresetTarget | null;
	/** Fired once the target has been applied — or once it is certain the preset
	 *  no longer exists — so the caller can drop it. */
	onFocusPresetHandled?: () => void;
}

/** What the library's one detail pane is showing: the agent itself, or one of
 *  its presets. */
type LibrarySelection = { kind: "agent" } | { kind: "preset"; configId: string };

export default function AgentSettingsSection({
	t,
	agents,
	globalSettings,
	onAgentsChange,
	onDefaultAgentChange,
	onDefaultConfigChange,
	onGlobalSettingsChange,
	focusPreset,
	onFocusPresetHandled,
}: AgentSettingsSectionProps) {
	const toggleFavorite = useToggleFavorite(onGlobalSettingsChange);
	const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
	const [selection, setSelection] = useState<LibrarySelection>({ kind: "agent" });
	const [presetQuery, setPresetQuery] = useState("");
	/** Narrow viewports show one pane at a time; wide ones show both. */
	const [narrowShowsEditor, setNarrowShowsEditor] = useState(false);
	const [scrollToConfigId, setScrollToConfigId] = useState<string | null>(null);
	const [agentAvailability, setAgentAvailability] = useState<AgentCheckResult[]>(
		[],
	);
	const [agentCheckLoading, setAgentCheckLoading] = useState(false);
	const [agentCustomPaths, setAgentCustomPaths] = useState<Record<string, string>>(
		{},
	);
	const [agentSavingId, setAgentSavingId] = useState<string | null>(null);
	const [agentCopiedId, setAgentCopiedId] = useState<string | null>(null);

	const selectedDefaultAgent = agents.find(
		(agent) => agent.id === globalSettings.defaultAgentId,
	);
	const defaultAgentConfigs = selectedDefaultAgent?.configurations || [];

	const activeAgent = agents.find((agent) => agent.id === activeAgentId) ?? agents[0];
	const availability = agentAvailability.find((item) => item.agentId === activeAgent?.id);
	const selectedPreset = selection.kind === "preset"
		? activeAgent?.configurations.find((config) => config.id === selection.configId)
		: undefined;
	const favorites = globalSettings.favorites ?? [];

	const groups = useMemo(
		() => filterPresetGroups(activeAgent, presetQuery),
		[activeAgent, presetQuery],
	);
	const matchCount = groups.reduce((sum, group) => sum + group.configs.length, 0);

	const loadAgentAvailability = useCallback(() => {
		setAgentCheckLoading(true);
		api.request.checkAgentAvailability()
			.then(setAgentAvailability)
			.catch(() => {})
			.finally(() => setAgentCheckLoading(false));
	}, []);

	useEffect(() => {
		loadAgentAvailability();
	}, [loadAgentAvailability]);

	// Point the library at the preset a deep-link named. The agents arrive from
	// an RPC, so an empty list means "not loaded yet" — waiting is the difference
	// between landing on the preset and landing on whatever was selected before.
	useEffect(() => {
		if (!focusPreset || agents.length === 0) return;
		const agent = agents.find((item) => item.id === focusPreset.agentId);
		const config = agent?.configurations.find((item) => item.id === focusPreset.configId);
		if (agent && config) {
			setActiveAgentId(agent.id);
			setSelection({ kind: "preset", configId: config.id });
			// A filter left over from an earlier visit can hide the very row this
			// jump exists to show.
			setPresetQuery("");
			setNarrowShowsEditor(true);
			setScrollToConfigId(config.id);
		}
		// Deleted preset: nothing to select, and the page it lives on is already
		// open — the jump is spent either way.
		onFocusPresetHandled?.();
	}, [agents, focusPreset, onFocusPresetHandled]);

	// Runs after the row has rendered under its (possibly cleared) filter.
	// `nearest` scrolls the list's own box; `start` would drag the whole settings
	// page along with it.
	useEffect(() => {
		if (!scrollToConfigId) return;
		const row = document.querySelector(`[data-preset-row="${scrollToConfigId}"]`) as HTMLElement | null;
		row?.scrollIntoView?.({ block: "nearest" });
		setScrollToConfigId(null);
	}, [scrollToConfigId, groups]);

	function persistAgents(updated: CodingAgent[]) {
		// Persistence is immediate (§8) — a rejected write used to vanish silently.
		Promise.resolve(onAgentsChange(updated)).catch(() =>
			toast.error(t("settings.agentsSaveFailed"), { source: "settings" }),
		);
	}

	function selectAgent(agentId: string) {
		setActiveAgentId(agentId);
		setSelection({ kind: "agent" });
		setPresetQuery("");
	}

	function selectPreset(configId: string) {
		setSelection({ kind: "preset", configId });
		setNarrowShowsEditor(true);
	}

	function updateAgent(agentId: string, patch: Partial<CodingAgent>) {
		const updated = agents.map((agent) =>
			agent.id === agentId ? { ...agent, ...patch } : agent,
		);
		persistAgents(updated);
	}

	function updateConfig(
		agentId: string,
		configId: string,
		patch: Partial<AgentConfiguration>,
	) {
		const updated = agents.map((agent) => {
			if (agent.id !== agentId) return agent;
			return {
				...agent,
				configurations: agent.configurations.map((config) =>
					config.id === configId ? { ...config, ...patch } : config,
				),
			};
		});
		persistAgents(updated);
	}

	/** Add a preset, optionally seeded from an existing one — starting from a
	 *  working preset beats an empty nine-field form. */
	function addConfig(agentId: string, seed?: AgentConfiguration) {
		const newConfig: AgentConfiguration = seed
			? {
				...seed,
				id: randomUUID(),
				name: t("settings.presetCopyName", { name: seed.name }),
				groupLabel: seed.groupLabel,
				modeLabel: undefined,
			}
			: { id: randomUUID(), name: t("settings.newPresetName") };
		const updated = agents.map((agent) => {
			if (agent.id !== agentId) return agent;
			const at = seed ? agent.configurations.findIndex((c) => c.id === seed.id) + 1 : agent.configurations.length;
			const configurations = [...agent.configurations];
			configurations.splice(at, 0, newConfig);
			return { ...agent, configurations };
		});
		persistAgents(updated);
		setPresetQuery("");
		selectPreset(newConfig.id);
	}

	async function deleteConfig(agentId: string, config: AgentConfiguration) {
		const ok = await confirm({
			title: t("settings.deleteConfigConfirmTitle"),
			message: t("settings.deleteConfigConfirmMessage", { name: config.name }),
			confirmLabel: t("settings.deleteConfig"),
			danger: true,
		});
		if (!ok) return;
		const updated = agents.map((agent) => {
			if (agent.id !== agentId) return agent;
			const filtered = agent.configurations.filter((item) => item.id !== config.id);
			const newDefault =
				agent.defaultConfigId === config.id
					? filtered[0]?.id
					: agent.defaultConfigId;
			return {
				...agent,
				configurations: filtered,
				defaultConfigId: newDefault,
			};
		});
		persistAgents(updated);
		setSelection({ kind: "agent" });
		setNarrowShowsEditor(false);
	}

	function addAgent() {
		const agentId = randomUUID();
		const configId = randomUUID();
		const newAgent: CodingAgent = {
			id: agentId,
			name: "New Agent",
			baseCommand: "",
			configurations: [{ id: configId, name: "Default" }],
			defaultConfigId: configId,
		};
		persistAgents([...agents, newAgent]);
		selectAgent(agentId);
		setNarrowShowsEditor(true);
	}

	async function deleteAgent(agent: CodingAgent) {
		const ok = await confirm({
			title: t("settings.deleteAgentConfirmTitle"),
			message: t("settings.deleteAgentConfirmMessage", {
				name: agent.name,
				count: String(agent.configurations.length),
			}),
			confirmLabel: t("settings.deleteAgent"),
			danger: true,
		});
		if (!ok) return;
		const remaining = agents.filter((item) => item.id !== agent.id);
		persistAgents(remaining);
		setActiveAgentId(remaining[0]?.id ?? null);
		setSelection({ kind: "agent" });
	}

	return (
		<SettingsSection title={t("settings.categoryAgents")} helpTopicId="settings.agents">
			<SettingsEntry anchor="default-agent">
			<div>
				<p className="block text-fg text-sm font-semibold mb-2">
					{t("settings.defaultAgent")}
				</p>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.defaultAgentDesc")}
				</p>
				<AgentConfigPicker
					idPrefix="default-agent"
					agents={agents}
					agentId={globalSettings.defaultAgentId}
					configId={globalSettings.defaultConfigId}
					agentAvailability={agentAvailability}
					pxpipeProxyEnabled={globalSettings.pxpipeProxyEnabled ?? false}
					onChange={(next) => {
						if (next.agentId && next.agentId !== globalSettings.defaultAgentId) {
							// Switching provider also resets the config to that agent's
							// default — the same value the picker just computed, so a
							// single persist keeps agent + config consistent.
							onDefaultAgentChange(next.agentId);
						} else if (next.configId) {
							onDefaultConfigChange(next.configId);
						}
					}}
				/>

{defaultAgentConfigs.length > 0 ? (() => {
				const selectedConfig =
					defaultAgentConfigs.find(
						(config) => config.id === globalSettings.defaultConfigId,
					) ?? defaultAgentConfigs[0];
				if (!selectedConfig) return null;
				return (
					<div className="mt-4">
						<ConfigPreviewCard
							config={selectedConfig}
							agentBaseCommand={selectedDefaultAgent?.baseCommand ?? ""}
							agentFamily={selectedDefaultAgent?.agentFamily}
							t={t}
							llmProvider={selectedDefaultAgent?.llmProvider}
							providerConfig={selectedDefaultAgent?.providerConfig}
						/>
					</div>
				);
			})() : null}
			</div>

			</SettingsEntry>
			<SettingsEntry anchor="agents-editor">
			<div className="space-y-3">
				{/* Toolbar: which agent the library is showing, plus its one primary action. */}
				<div className="flex flex-wrap items-center gap-2">
					<div className="w-56 max-w-full">
						<Select
							id="agent-library-agent"
							value={activeAgent?.id ?? ""}
							options={agents.map((agent): SelectOption => ({ value: agent.id, label: agent.name }))}
							searchable={agents.length > 6}
							searchPlaceholder={t("settings.filterAgents")}
							emptyLabel={t("settings.presetSearchEmpty")}
							onChange={selectAgent}
							renderOption={(option) => {
								const agentAvail = agentAvailability.find((item) => item.agentId === option.value);
								return (
									<span className="flex items-center gap-2">
										{option.label}
										{agentAvail && !agentAvail.installed ? (
											<span className="text-danger text-micro font-medium opacity-80">
												{t("settings.agentNotInstalled")}
											</span>
										) : null}
									</span>
								);
							}}
						/>
					</div>
					{activeAgent ? (
						<span className="text-fg-3 text-xs font-mono">{activeAgent.baseCommand}</span>
					) : null}
					{availability ? (
						<span
							className={`text-xs px-1.5 py-0.5 rounded ${
								availability.installed ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
							}`}
						>
							{availability.installed ? t("settings.agentInstalled") : t("settings.agentNotInstalled")}
						</span>
					) : null}
					<span className="flex-1" />
					{activeAgent ? (
						<button
							type="button"
							onClick={() => addConfig(activeAgent.id)}
							className="px-3 py-1.5 rounded-lg bg-accent-fill text-white text-xs font-semibold hover:bg-accent-fill-hover transition-colors"
						>
							+ {t("settings.newPreset")}
						</button>
					) : null}
				</div>

				{activeAgent ? (
					<div className="bg-raised border border-edge rounded-xl overflow-hidden md:grid md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
						{/* Left pane — the preset list. */}
						<div className={`md:border-r border-edge ${narrowShowsEditor ? "hidden md:block" : "block"}`}>
							<div className="p-2 border-b border-edge">
								<input
									type="search"
									value={presetQuery}
									onChange={(event) => setPresetQuery(event.target.value)}
									placeholder={t("settings.presetSearch", {
										count: String(activeAgent.configurations.length),
									})}
									aria-label={t("settings.presetSearchLabel")}
									className="w-full px-2.5 py-1.5 bg-elevated border border-edge rounded-lg text-fg text-sm placeholder:text-fg-muted outline-none focus:border-accent transition-colors"
								/>
							</div>
							<div className="max-h-[26rem] overflow-y-auto p-1.5" role="listbox" aria-label={t("settings.configurations")}>
								<button
									type="button"
									role="option"
									aria-selected={selection.kind === "agent"}
									onClick={() => {
										setSelection({ kind: "agent" });
										setNarrowShowsEditor(true);
									}}
									className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-sm transition-colors border ${
										selection.kind === "agent"
											? "bg-elevated border-accent text-fg"
											: "border-transparent text-fg-2 hover:bg-elevated-hover hover:text-fg"
									}`}
								>
									<span className="text-fg-3">&#9881;</span>
									<span className="flex-1 min-w-0 truncate">{t("settings.agentSettingsRow")}</span>
								</button>
								{groups.map((group) => (
									<div key={group.label}>
										<p className="px-2 pt-3 pb-1 text-fg-muted text-micro font-semibold uppercase tracking-wide">
											{group.label} · {group.configs.length}
										</p>
										{group.configs.map((config) => {
											const isSelected = selection.kind === "preset" && selection.configId === config.id;
											const isFavorite = favorites.some(
												(fav) => fav.agentId === activeAgent.id && fav.configId === config.id,
											);
											return (
												<button
													key={config.id}
													type="button"
													role="option"
													data-preset-row={config.id}
													aria-selected={isSelected}
													onClick={() => selectPreset(config.id)}
													className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-sm transition-colors border ${
														isSelected
															? "bg-elevated border-accent text-fg"
															: "border-transparent text-fg-2 hover:bg-elevated-hover hover:text-fg"
													}`}
												>
													<span className={isFavorite ? "text-warning-strong" : "text-transparent"}>
														<StarIcon filled={isFavorite} />
													</span>
													<span className="flex-1 min-w-0 truncate">{getModeLeafLabel(config)}</span>
													{config.requiresPxpipeProxy ? (
														<span className="text-warning-strong text-micro shrink-0">{t("settings.presetNeedsProxy")}</span>
													) : null}
													{activeAgent.defaultConfigId === config.id ? (
														<span className="text-accent text-micro shrink-0">{t("settings.defaultBadge")}</span>
													) : null}
												</button>
											);
										})}
									</div>
								))}
								{matchCount === 0 ? (
									<p className="px-2 py-3 text-fg-muted text-sm">{t("settings.presetSearchEmpty")}</p>
								) : null}
							</div>
						</div>

						{/* Right pane — exactly one record's editor. */}
						<div className={`p-4 ${narrowShowsEditor ? "block" : "hidden md:block"}`}>
							<button
								type="button"
								onClick={() => setNarrowShowsEditor(false)}
								className="md:hidden mb-3 text-accent text-xs font-semibold hover:underline"
							>
								&#8249; {t("settings.backToPresets")}
							</button>
							{selection.kind === "preset" && selectedPreset ? (
								<PresetEditor
									key={selectedPreset.id}
									t={t}
									agent={activeAgent}
									config={selectedPreset}
									isDefault={activeAgent.defaultConfigId === selectedPreset.id}
									isFavorite={favorites.some(
										(fav) => fav.agentId === activeAgent.id && fav.configId === selectedPreset.id,
									)}
									onToggleFavorite={() => toggleFavorite(activeAgent.id, selectedPreset.id)}
									canDelete={activeAgent.configurations.length > 1}
									onChange={(patch) => updateConfig(activeAgent.id, selectedPreset.id, patch)}
									onDuplicate={() => addConfig(activeAgent.id, selectedPreset)}
									onMakeDefault={() => updateAgent(activeAgent.id, { defaultConfigId: selectedPreset.id })}
									onDelete={() => deleteConfig(activeAgent.id, selectedPreset)}
								/>
							) : (
								<AgentPane
									t={t}
									agent={activeAgent}
									availability={availability}
									customPath={agentCustomPaths[activeAgent.id] ?? ""}
									copied={agentCopiedId === activeAgent.id}
									saving={agentSavingId === activeAgent.id}
									onCustomPathChange={(path) =>
										setAgentCustomPaths((current) => ({ ...current, [activeAgent.id]: path }))
									}
									onCopyInstall={(command) => {
										navigator.clipboard.writeText(command);
										setAgentCopiedId(activeAgent.id);
										setTimeout(
											() => setAgentCopiedId((current) => (current === activeAgent.id ? null : current)),
											2000,
										);
									}}
									onSavePath={async () => {
										const path = agentCustomPaths[activeAgent.id]?.trim();
										if (!path) return;
										setAgentSavingId(activeAgent.id);
										try {
											await api.request.setAgentBinaryPath({ agentId: activeAgent.id, path });
											loadAgentAvailability();
										} catch {
											toast.error(t("settings.agentPathSaveFailed"), { source: "settings" });
										}
										setAgentSavingId(null);
									}}
									onChange={(patch) => updateAgent(activeAgent.id, patch)}
									onDelete={() => deleteAgent(activeAgent)}
								/>
							)}
						</div>
					</div>
				) : null}

				<div className="flex items-center gap-3">
					<button
						onClick={addAgent}
						className="px-4 py-2 text-accent text-sm font-semibold hover:bg-accent/10 rounded-lg transition-colors"
					>
						+ {t("settings.addAgent")}
					</button>
					<button
						onClick={loadAgentAvailability}
						disabled={agentCheckLoading}
						className="px-4 py-2 text-fg-3 text-sm hover:text-fg hover:bg-elevated rounded-lg transition-colors disabled:opacity-50"
					>
						{agentCheckLoading ? (
							<span className="flex items-center gap-1.5">
								<span className="w-2.5 h-2.5 rounded-full border-2 border-fg-muted/30 border-t-fg-muted animate-spin" />
								{t("settings.recheckAgents")}
							</span>
						) : (
							t("settings.recheckAgents")
						)}
					</button>
				</div>
			</div>
			</SettingsEntry>
		</SettingsSection>
	);
}

function ConfigPreviewCard({
	config,
	agentBaseCommand,
	agentFamily,
	t,
	llmProvider,
	providerConfig,
}: {
	config: AgentConfiguration;
	agentBaseCommand: string;
	agentFamily?: AgentFamily;
	t: TFunction;
	llmProvider?: LlmProvider;
	providerConfig?: ProviderConfig;
}) {
	const tags: { label: string; value: string }[] = [];
	const isCodex = agentKey(config.baseCommandOverride || agentBaseCommand || "", agentFamily) === "codex";

	if (config.model) {
		tags.push({ label: t("settings.configModel"), value: config.model });
	}
	if (!isCodex && config.permissionMode && config.permissionMode !== "default") {
		const modeLabels: Record<string, string> = {
			plan: t("settings.permPlan"),
			auto: t("settings.permAuto"),
			acceptEdits: t("settings.permAcceptEdits"),
			dontAsk: t("settings.permDontAsk"),
			bypassPermissions: t("settings.permBypass"),
		};
		tags.push({
			label: t("settings.configPermissionMode"),
			value: modeLabels[config.permissionMode] ?? config.permissionMode,
		});
	}
	if (!isCodex && config.effort) {
		const effortLabels: Record<string, string> = {
			low: t("settings.effortLow"),
			medium: t("settings.effortMedium"),
			high: t("settings.effortHigh"),
		};
		tags.push({
			label: t("settings.configEffort"),
			value: effortLabels[config.effort] ?? config.effort,
		});
	}
	if (!isCodex && config.maxBudgetUsd != null && config.maxBudgetUsd > 0) {
		tags.push({
			label: t("settings.configMaxBudget"),
			value: `$${config.maxBudgetUsd}`,
		});
	}

	const { command, envLine } = buildCommandPreview(agentBaseCommand, config, llmProvider, providerConfig, agentFamily);

	return (
		<div className="mt-3 bg-base border border-edge rounded-xl p-3 space-y-2">
			{tags.length > 0 ? (
				<div className="flex flex-wrap gap-2">
					{tags.map((tag) => (
						<span
							key={tag.label}
							className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-raised rounded-lg text-xs"
						>
							<span className="text-fg-3">{tag.label}:</span>
							<span className="text-fg font-medium">{tag.value}</span>
						</span>
					))}
				</div>
			) : null}
			<CommandPreview command={command} envLine={envLine} />
		</div>
	);
}

function CommandPreview({
	command,
	envLine,
}: {
	command: string;
	envLine: string | null;
}) {
	const parts = command.split(/(\{\{\w+\}\})/g);

	return (
		<div className="bg-base border border-edge rounded-lg p-3 font-mono text-xs leading-relaxed overflow-x-auto">
			{envLine ? (
				<div className="text-fg-3 mb-1">
					<span className="text-fg-muted">env: </span>
					{envLine}
				</div>
			) : null}
			<div className="text-fg-2">
				<span className="text-fg-muted">$ </span>
				{parts.map((part, index) =>
					/^\{\{\w+\}\}$/.test(part) ? (
						<span key={index} className="text-accent font-semibold">
							{part}
						</span>
					) : (
						<span key={index}>{part}</span>
					),
				)}
			</div>
		</div>
	);
}

/** Loose match so "xhigh" finds "X-High" and "opus5" finds "Opus 5". */
function looseMatch(haystack: string, needle: string): boolean {
	const strip = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
	return haystack.toLowerCase().includes(needle.toLowerCase()) || strip(haystack).includes(strip(needle));
}

/** The list pane's rows: the launch picker's own Model → Mode grouping, filtered. */
function filterPresetGroups(agent: CodingAgent | undefined, query: string): PickerGroup[] {
	const groups = buildPickerGroups(agent);
	const trimmed = query.trim();
	if (!trimmed) return groups;
	return groups
		.map((group) => ({
			label: group.label,
			configs: group.configs.filter((config) =>
				looseMatch(`${config.name} ${group.label} ${getModeLeafLabel(config)} ${config.model ?? ""}`, trimmed),
			),
		}))
		.filter((group) => group.configs.length > 0);
}

/** One labelled field in the editor grid. */
function Field({
	label,
	htmlFor,
	hint,
	children,
}: {
	label: string;
	htmlFor?: string;
	hint?: string;
	children: ReactNode;
}) {
	return (
		<div>
			<label htmlFor={htmlFor} className="block text-fg-2 text-xs mb-1">{label}</label>
			{children}
			{hint ? <p className="text-fg-muted text-xs mt-1">{hint}</p> : null}
		</div>
	);
}

/** Editor for exactly one preset: identity and actions on top, the five fields
 *  that decide a launch, the live command, then everything else behind Advanced. */
function PresetEditor({
	t,
	agent,
	config,
	isDefault,
	isFavorite,
	canDelete,
	onChange,
	onDuplicate,
	onMakeDefault,
	onToggleFavorite,
	onDelete,
}: {
	t: TFunction;
	agent: CodingAgent;
	config: AgentConfiguration;
	isDefault: boolean;
	isFavorite: boolean;
	canDelete: boolean;
	onChange: (patch: Partial<AgentConfiguration>) => void;
	onDuplicate: () => void;
	onMakeDefault: () => void;
	onToggleFavorite: () => void;
	onDelete: () => void;
}) {
	const catalog = useModelCatalog();
	const preview = buildCommandPreview(
		agent.baseCommand,
		config,
		agent.llmProvider,
		agent.providerConfig,
		agent.agentFamily,
		catalog ?? undefined,
	);
	const baseCommandName = agent.baseCommand.split("/").pop() ?? agent.baseCommand;
	const modelOptions: SelectOption[] = modelsForAgent(agent).map((model) => ({ value: model, label: model }));
	const filterHint = t("settings.selectFilterHint");
	const useTyped = (query: string) => t("settings.useTypedValue", { value: query });

	const permissionOptions: SelectOption[] = [
		{ value: "", label: t("settings.permDefault") },
		{ value: "plan", label: t("settings.permPlan") },
		{ value: "auto", label: t("settings.permAuto") },
		{ value: "acceptEdits", label: t("settings.permAcceptEdits") },
		{ value: "dontAsk", label: t("settings.permDontAsk") },
		{ value: "bypassPermissions", label: t("settings.permBypass") },
	];
	const effortOptions: SelectOption[] = [
		{ value: "", label: t("settings.effortDefault") },
		{ value: "low", label: t("settings.effortLow") },
		{ value: "medium", label: t("settings.effortMedium") },
		{ value: "high", label: t("settings.effortHigh") },
		{ value: "xhigh", label: t("settings.effortXHigh") },
	];
	const budgetOptions: SelectOption[] = [
		{ value: "", label: t("settings.budgetNoCap") },
		...[1, 5, 10, 20, 50].map((amount) => ({ value: String(amount), label: `$${amount}` })),
	];

	return (
		<div className="space-y-3">
			{/* Title owns its own row: five actions cannot share one line with a
			    preset name inside a settings pane. */}
			<div>
				<div className="min-w-0">
					<p className="text-fg text-sm font-semibold truncate">{getModeLeafLabel(config)}</p>
					<p className="text-fg-muted text-xs truncate">
						{agent.name} · {getModelGroupLabel(config)}
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-1.5 mt-2">
					<button
						type="button"
						onClick={onToggleFavorite}
						aria-pressed={isFavorite}
						title={isFavorite ? t("settings.favoriteRemoveHint") : t("settings.favoriteAddHint")}
						className={`px-2.5 py-1 rounded-lg border text-xs flex items-center gap-1.5 transition-colors ${
							isFavorite
								? "bg-warning/10 border-warning/30 text-warning-strong hover:bg-warning/15"
								: "bg-elevated border-edge text-fg-2 hover:text-fg hover:border-edge-active"
						}`}
					>
						<StarIcon filled={isFavorite} />
						{isFavorite ? t("settings.favoriteRemove") : t("settings.favoriteAdd")}
					</button>
					<button
						type="button"
						onClick={onDuplicate}
						className="px-2.5 py-1 rounded-lg bg-elevated border border-edge text-fg-2 text-xs hover:text-fg hover:border-edge-active transition-colors"
					>
						{t("settings.duplicatePreset")}
					</button>
					{isDefault ? (
						<span className="px-2.5 py-1 rounded-lg bg-accent/10 text-accent text-xs font-medium">
							{t("settings.defaultBadge")}
						</span>
					) : (
						<button
							type="button"
							onClick={onMakeDefault}
							className="px-2.5 py-1 rounded-lg bg-elevated border border-edge text-fg-2 text-xs hover:text-fg hover:border-edge-active transition-colors"
						>
							{t("settings.setDefaultConfig")}
						</button>
					)}
					{canDelete ? (
						<button
							type="button"
							onClick={onDelete}
							className="px-2.5 py-1 rounded-lg text-danger text-xs hover:bg-danger/10 border border-transparent hover:border-danger/30 transition-colors"
						>
							{t("settings.deleteConfig")}
						</button>
					) : null}
				</div>
			</div>

			<div className="grid gap-3 sm:grid-cols-2">
				<Field label={t("settings.configName")}>
					<input
						type="text"
						value={config.name}
						onChange={(event) => onChange({ name: event.target.value })}
						className="w-full px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm outline-none focus:border-accent/40 transition-colors"
					/>
				</Field>
				<Field label={t("settings.configModel")} htmlFor="preset-model">
					<Select
						id="preset-model"
						value={config.model ?? ""}
						options={[{ value: "", label: t("settings.modelAgentDefault") }, ...modelOptions]}
						allowCustom
						searchPlaceholder={
							baseCommandName === "codex"
								? "gpt-5.6, o3…"
								: baseCommandName === "gemini"
									? "gemini-3.1-pro…"
									: "opus, sonnet…"
						}
						customOptionLabel={useTyped}
						emptyLabel={t("settings.presetSearchEmpty")}
						onChange={(value) => onChange({ model: value || undefined })}
					/>
				</Field>
				<Field label={t("settings.configPermissionMode")} htmlFor="preset-permission">
					<Select
						id="preset-permission"
						value={config.permissionMode ?? ""}
						options={permissionOptions}
						allowCustom
						searchPlaceholder={filterHint}
						customOptionLabel={useTyped}
						emptyLabel={t("settings.presetSearchEmpty")}
						onChange={(value) => onChange({ permissionMode: (value || undefined) as PermissionMode | undefined })}
					/>
				</Field>
				<Field label={t("settings.configEffort")} htmlFor="preset-effort">
					<Select
						id="preset-effort"
						value={config.effort ?? ""}
						options={effortOptions}
						allowCustom
						searchPlaceholder={filterHint}
						customOptionLabel={useTyped}
						emptyLabel={t("settings.presetSearchEmpty")}
						onChange={(value) => onChange({ effort: (value || undefined) as EffortLevel | undefined })}
					/>
				</Field>
				<Field label={t("settings.configMaxBudget")} htmlFor="preset-budget" hint={t("settings.configMaxBudgetHint")}>
					<Select
						id="preset-budget"
						value={config.maxBudgetUsd == null ? "" : String(config.maxBudgetUsd)}
						options={budgetOptions}
						allowCustom
						inputMode="decimal"
						searchPlaceholder={t("settings.budgetFilterHint")}
						customOptionLabel={(query) => `$${query}`}
						emptyLabel={t("settings.presetSearchEmpty")}
						onChange={(value) => {
							const amount = Number(value.replace(/[^0-9.]/g, ""));
							onChange({ maxBudgetUsd: value && Number.isFinite(amount) && amount > 0 ? amount : undefined });
						}}
					/>
				</Field>
			</div>

			{/* Model roles sit with the model, not under "Advanced": they decide which
			    model actually runs, which is the preset's headline meaning. */}
			<PresetModelRoles
				t={t}
				baseCommand={baseCommandName}
				config={config}
				catalog={catalog}
				onChange={onChange}
			/>

			<div>
				<p className="block text-fg-2 text-xs font-semibold mb-1.5">{t("settings.commandPreview")}</p>
				<CommandPreview command={preview.command} envLine={preview.envLine} />
			</div>

			<details className="group">
				<summary className="text-fg-3 text-xs cursor-pointer hover:text-fg transition-colors select-none">
					{t("settings.presetAdvanced")}
				</summary>
				<div className="mt-3 space-y-3">
					<Field label={t("settings.configAppendPrompt")} hint={t("settings.configAppendPromptHint")}>
						<textarea
							value={config.appendPrompt || ""}
							onChange={(event) => onChange({ appendPrompt: event.target.value || undefined })}
							rows={3}
							className="w-full px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
						/>
					</Field>
					<div>
						<p className="block text-fg-2 text-xs mb-1">{t("settings.configAdditionalArgs")}</p>
						<ListEditor
							items={config.additionalArgs || []}
							onChange={(items) => onChange({ additionalArgs: items.length > 0 ? items : undefined })}
							placeholder="--flag"
							addLabel={t("settings.configAddArg")}
							removeLabel={t("listEditor.removeItem")}
						/>
					</div>
					<div>
						<p className="block text-fg-2 text-xs mb-1">{t("settings.configEnvVars")}</p>
						<KeyValueEditor
							entries={config.envVars || {}}
							onChange={(entries) => onChange({ envVars: Object.keys(entries).length > 0 ? entries : undefined })}
							addLabel={t("settings.configAddEnvVar")}
						/>
					</div>
					<Field label={t("settings.configBaseCommandOverride")}>
						<input
							type="text"
							value={config.baseCommandOverride || ""}
							onChange={(event) => onChange({ baseCommandOverride: event.target.value || undefined })}
							placeholder={agent.baseCommand}
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
							className="w-full px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
						/>
					</Field>
				</div>
			</details>
		</div>
	);
}

/** The agent itself: install state, identity, backend, order, removal. */
/** Which agent CLI this command actually is, and a warning when the base command
 *  is one dev3 cannot recognize — the case that used to fail in silence: an
 *  unrecognized command loses hooks, session resume and the dev3 protocol. */
function AgentFamilyField({
	t,
	agent,
	onChange,
}: {
	t: TFunction;
	agent: CodingAgent;
	onChange: (patch: Partial<CodingAgent>) => void;
}) {
	const familyLabel = (family: AgentFamily) =>
		family === "none" ? t("settings.familyNone") : t(`settings.family.${family}` as TranslationKey);
	const options: SelectOption[] = [
		{ value: "", label: t("settings.familyAuto", { family: familyLabel(autoAgentFamily(agent.baseCommand)) }) },
		...SELECTABLE_AGENT_FAMILIES.map((family) => ({ value: family, label: familyLabel(family) })),
	];
	const unrecognized = !agent.agentFamily && !isKnownAgentCommand(agent.baseCommand);

	return (
		<div className="space-y-2">
			<Field label={t("settings.agentFamily")} htmlFor={`agent-family-${agent.id}`} hint={t("settings.familyHint")}>
				<Select
					id={`agent-family-${agent.id}`}
					value={agent.agentFamily ?? ""}
					options={options}
					onChange={(next) => onChange({ agentFamily: next ? (next as AgentFamily) : undefined })}
				/>
			</Field>
			{unrecognized ? (
				<div className="p-3 rounded-lg bg-warning/5 border border-warning/20 space-y-1" role="status">
					<p className="text-warning-strong text-xs font-medium">{t("settings.familyMissingTitle")}</p>
					<p className="text-fg-3 text-xs">
						{t("settings.familyMissingBody", { command: agent.baseCommand || "—" })}
					</p>
				</div>
			) : null}
		</div>
	);
}

function AgentPane({
	t,
	agent,
	availability,
	customPath,
	copied,
	saving,
	onCustomPathChange,
	onCopyInstall,
	onSavePath,
	onChange,
	onDelete,
}: {
	t: TFunction;
	agent: CodingAgent;
	availability: AgentCheckResult | undefined;
	customPath: string;
	copied: boolean;
	saving: boolean;
	onCustomPathChange: (path: string) => void;
	onCopyInstall: (command: string) => void;
	onSavePath: () => void;
	onChange: (patch: Partial<CodingAgent>) => void;
	onDelete: () => void;
}) {
	return (
		<div className="space-y-4">
			<div className="flex items-start gap-2">
				<div className="flex-1 min-w-0">
					<p className="text-fg text-sm font-semibold truncate">{agent.name}</p>
					<p className="text-fg-muted text-xs">
						{t.plural("settings.presetCount", agent.configurations.length)}
					</p>
				</div>
			</div>

			{availability ? (
				<div
					className={`p-3 rounded-lg ${
						availability.installed ? "bg-success/5 border border-success/20" : "bg-danger/5 border border-danger/20"
					}`}
				>
					{availability.installed ? (
						<div className="flex items-center gap-2">
							<span className="text-success text-sm">&#10003;</span>
							<span className="text-fg-2 text-xs">{t("settings.agentInstalled")}</span>
							{availability.resolvedPath ? (
								<span className="text-fg-muted text-xs font-mono truncate">{availability.resolvedPath}</span>
							) : null}
						</div>
					) : (
						<div className="space-y-2">
							<div className="flex items-center gap-2">
								<span className="text-danger text-sm">&#10007;</span>
								<span className="text-fg-2 text-xs">{t("settings.agentNotInstalledHint")}</span>
							</div>
							{availability.installCommand ? (
								<div>
									<p className="text-fg-3 text-xs mb-1">{t("settings.agentInstallHint")}</p>
									<div className="flex items-center gap-1.5">
										<code className="text-warning-strong bg-warning/10 px-2 py-1 rounded text-xs font-mono">
											{availability.installCommand}
										</code>
										<button
											type="button"
											onClick={() => onCopyInstall(availability.installCommand as string)}
											className="p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg shrink-0"
											title="Copy"
										>
											{copied ? (
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
								</div>
							) : null}
							<p className="text-fg-muted text-xs">{t("settings.agentLoginReminder")}</p>
							<div className="pt-2 border-t border-edge/50">
								<p className="text-fg-3 text-xs mb-1.5">{t("settings.agentCustomPath")}</p>
								{availability.customPathError ? (
									<p className="text-danger text-xs mb-1.5">{t("settings.agentPathNotFound")}</p>
								) : null}
								<div className="flex items-center gap-1.5">
									<input
										type="text"
										value={customPath}
										onChange={(event) => onCustomPathChange(event.target.value)}
										placeholder={`/path/to/${agent.baseCommand}`}
										className={`flex-1 bg-base border rounded px-2 py-1 text-xs font-mono text-fg placeholder:text-fg-muted focus:border-accent ${
											availability.customPathError ? "border-danger" : "border-edge"
										}`}
									/>
									<button
										type="button"
										onClick={() => {
											void openFilePicker({ initialPath: customPath.trim() || null })
												.then((picked) => { if (picked) onCustomPathChange(picked); });
										}}
										aria-label={t("folderPicker.browseAria", { name: agent.baseCommand })}
										className="px-2.5 py-1 rounded border border-edge text-fg-2 text-xs font-medium hover:bg-elevated hover:text-fg transition-colors shrink-0"
									>
										{t("folderPicker.browse")}
									</button>
									<button
										type="button"
										onClick={onSavePath}
										disabled={!customPath.trim() || saving}
										className="px-2.5 py-1 rounded bg-accent-fill text-white text-xs font-medium hover:bg-accent-fill-hover disabled:opacity-50 transition-colors shrink-0"
									>
										{t("requirements.setPath")}
									</button>
								</div>
							</div>
						</div>
					)}
				</div>
			) : null}

			<div className="grid gap-3 sm:grid-cols-2">
				<Field label={t("settings.agentName")} htmlFor={`agent-name-${agent.id}`}>
					<input
						id={`agent-name-${agent.id}`}
						type="text"
						value={agent.name}
						onChange={(event) => onChange({ name: event.target.value })}
						className="w-full px-3 py-2 bg-elevated border border-edge rounded-lg text-fg text-sm outline-none focus:border-accent/40 transition-colors"
					/>
				</Field>
				<Field label={t("settings.agentBaseCommand")} htmlFor={`agent-base-command-${agent.id}`}>
					<input
						id={`agent-base-command-${agent.id}`}
						type="text"
						value={agent.baseCommand}
						onChange={(event) => onChange({ baseCommand: event.target.value })}
						placeholder="claude"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						className="w-full px-3 py-2 bg-elevated border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
					/>
				</Field>
			</div>

			<AgentFamilyField t={t} agent={agent} onChange={onChange} />

			<ProviderSelector
				t={t}
				baseCommand={agent.baseCommand}
				agentFamily={agent.agentFamily}
				provider={agent.llmProvider ?? "anthropic"}
				providerConfig={agent.providerConfig}
				models={modelsForAgent(agent)}
				onChange={onChange}
			/>

			{agent.isDefault ? (
				<p className="text-fg-muted text-xs italic">{t("settings.cantDeleteDefault")}</p>
			) : (
				<button type="button" onClick={onDelete} className="text-danger text-xs hover:underline">
					{t("settings.deleteAgent")}
				</button>
			)}
		</div>
	);
}

function KeyValueEditor({
	entries,
	onChange,
	addLabel,
}: {
	entries: Record<string, string>;
	onChange: (entries: Record<string, string>) => void;
	addLabel: string;
}) {
	const pairs = Object.entries(entries);

	function updateKey(oldKey: string, newKey: string) {
		const next: Record<string, string> = {};
		for (const [key, value] of pairs) {
			next[key === oldKey ? newKey : key] = value;
		}
		onChange(next);
	}

	function updateValue(key: string, value: string) {
		onChange({ ...entries, [key]: value });
	}

	function remove(key: string) {
		const next = { ...entries };
		delete next[key];
		onChange(next);
	}

	function add() {
		onChange({ ...entries, "": "" });
	}

	return (
		<div className="space-y-1.5">
			{pairs.map(([key, value], index) => (
				<div key={index} className="flex gap-2">
					<input
						type="text"
						value={key}
						onChange={(event) => updateKey(key, event.target.value)}
						placeholder="KEY"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						className="w-1/3 px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
					/>
					<input
						type="text"
						value={value}
						onChange={(event) => updateValue(key, event.target.value)}
						placeholder="value"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						className="flex-1 px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
					/>
					<button
						onClick={() => remove(key)}
						className="text-danger text-xs hover:underline shrink-0 px-2"
					>
						×
					</button>
				</div>
			))}
			<button onClick={add} className="text-accent text-xs hover:underline">
				+ {addLabel}
			</button>
		</div>
	);
}

/** Distinct model aliases across an agent's configs — the rows of the provider
 *  model-override table. */
function modelsForAgent(agent: CodingAgent): string[] {
	const seen = new Set<string>();
	const models: string[] = [];
	for (const config of agent.configurations) {
		if (config.model && !seen.has(config.model)) {
			seen.add(config.model);
			models.push(config.model);
		}
	}
	return models;
}

/**
 * Per-agent LLM-backend selector: the agent's native API (default) or any
 * third-party backend registered for that agent (e.g. Amazon Bedrock for
 * Claude or Codex). Selecting a third-party provider routes the agent's
 * launches at that backend with the mapped model — via env (dropping --model)
 * or via CLI args with the --model alias rewritten, per the registry entry.
 * Credentials/region are NOT set here — the customer owns those in their own
 * agent config. Renders nothing for agents with no registered backend; provider
 * fields appear only for the selected provider, driven by its registry entry.
 */
function ProviderSelector({
	t,
	baseCommand,
	agentFamily,
	provider,
	providerConfig,
	models,
	onChange,
}: {
	t: TFunction;
	baseCommand: string;
	agentFamily?: AgentFamily;
	provider: LlmProvider;
	providerConfig: ProviderConfig | undefined;
	models: string[];
	onChange: (patch: Partial<CodingAgent>) => void;
}) {
	const options = providersForAgent(baseCommand, agentFamily);
	const setProvider = (next: LlmProvider) => onChange({ llmProvider: next });

	// Mirror the launcher: only a backend registered for THIS agent's command
	// applies (same guard as agentProvider in agents.ts); a stale id — e.g. after
	// the base command was edited — renders and behaves as the native default.
	const def = getProviderDefinition(provider);
	const activeDef = def && def.agentCommand === agentKey(baseCommand, agentFamily) ? def : undefined;
	const effectiveProvider = activeDef ? provider : LLM_PROVIDER.Native;
	const settings = activeDef ? providerConfig?.[activeDef.id] : undefined;
	const geo = settings?.geo ?? DEFAULT_BEDROCK_GEO;

	// Preflight: codex is routed at Bedrock via a `-c` override, but the
	// `[model_providers.amazon-bedrock]` section must exist in the user's own
	// ~/.codex/config.toml — warn here instead of failing at launch.
	const [codexConfigMissing, setCodexConfigMissing] = useState(false);
	useEffect(() => {
		if (activeDef?.id !== LLM_PROVIDER.BedrockCodex) {
			setCodexConfigMissing(false);
			return;
		}
		let cancelled = false;
		api.request
			.checkCodexBedrockConfig()
			.then((result) => {
				if (!cancelled) setCodexConfigMissing(!result.configured);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [activeDef?.id]);

	const patchProvider = (patch: Partial<ProviderSettings>) => {
		if (!activeDef) return;
		onChange({
			providerConfig: {
				...providerConfig,
				[activeDef.id]: { ...settings, ...patch },
			},
		});
	};

	// No registered backend for this agent → no toggle at all.
	if (options.length === 0) return null;

	return (
		<div className="mt-2 pt-4 border-t border-edge">
			<p className="block text-fg-2 text-xs font-semibold mb-1">
				{t("settings.llmProvider")}
			</p>
			<p className="text-fg-3 text-xs mb-2">{t("settings.llmProviderDesc")}</p>

			<div className="inline-flex rounded-xl border border-edge bg-base p-1 gap-1">
				{options.map((opt) => {
					const active = effectiveProvider === opt.id;
					return (
						<button
							key={opt.id}
							type="button"
							onClick={() => setProvider(opt.id)}
							className={`px-4 py-2 rounded-lg text-sm transition-colors ${
								active
									? "bg-accent-fill text-white"
									: "text-fg-2 hover:bg-elevated"
							}`}
						>
							{t(opt.labelKey as Parameters<TFunction>[0])}
						</button>
					);
				})}
			</div>

			{activeDef ? (
				<div className="mt-4 space-y-3">
					<p className="text-fg-3 text-xs">
						{t(activeDef.hintKey as Parameters<TFunction>[0])}
					</p>
					{codexConfigMissing ? (
						<p className="text-danger text-xs">
							{t("settings.providerBedrockCodexConfigMissing")}
						</p>
					) : null}
					{activeDef.usesGeo ? (
						<div>
							<span className="block text-fg-2 text-xs mb-1">
								{t("settings.providerBedrockGeo")}
							</span>
							<div className="inline-flex rounded-lg border border-edge bg-base p-0.5 gap-0.5">
								{BEDROCK_GEOS.map((g) => {
									const active = geo === g;
									return (
										<button
											key={g}
											type="button"
											onClick={() => patchProvider({ geo: g })}
											className={`px-3 py-1 rounded-md text-xs font-mono transition-colors ${
												active ? "bg-accent-fill text-white" : "text-fg-2 hover:bg-elevated"
											}`}
										>
											{g}
										</button>
									);
								})}
							</div>
						</div>
					) : null}
					<ModelOverrideTable
						t={t}
						provider={activeDef.id}
						geo={geo}
						models={models}
						overrides={settings?.modelOverrides}
						onOverridesChange={(modelOverrides) => patchProvider({ modelOverrides })}
					/>
				</div>
			) : null}
		</div>
	);
}

/**
 * Pre-populated table of the agent's model aliases → the provider-native id each
 * maps to. Each row's id is inline-editable; an edited row shows a "manual" badge
 * and a revert-to-default control. Editing/reverting updates the per-model
 * overrides map keyed by the dev3 alias.
 */
function ModelOverrideTable({
	t,
	provider,
	geo,
	models,
	overrides,
	onOverridesChange,
}: {
	t: TFunction;
	provider: LlmProvider;
	geo?: BedrockGeo;
	models: string[];
	overrides: Record<string, string> | undefined;
	onOverridesChange: (next: Record<string, string> | undefined) => void;
}) {
	const rows = defaultModelMap(models, provider, geo);

	const setOverride = (model: string, value: string) => {
		onOverridesChange({ ...overrides, [model]: value });
	};
	const revert = (model: string) => {
		if (!overrides || !(model in overrides)) return;
		const next = { ...overrides };
		delete next[model];
		onOverridesChange(Object.keys(next).length > 0 ? next : undefined);
	};

	if (rows.length === 0) return null;

	return (
		<div>
			<div className="flex items-baseline justify-between mb-1">
				<span className="block text-fg-2 text-xs">{t("settings.providerModelTable")}</span>
				<span className="text-fg-muted text-xs">{t("settings.providerModelTableHint")}</span>
			</div>
			<div className="rounded-lg border border-edge overflow-hidden divide-y divide-edge">
				{rows.map(({ model, defaultId }) => {
					const overridden =
						overrides != null && model in overrides && (overrides[model]?.trim() ?? "") !== "";
					const value = overridden ? overrides[model] : defaultId;
					return (
						<div key={model} className="flex items-center gap-2 px-3 py-2 bg-base">
							<span
								className="text-fg text-xs font-mono shrink-0 w-44 truncate"
								title={model}
							>
								{model}
							</span>
							<input
								type="text"
								value={value ?? ""}
								placeholder={defaultId}
								autoCapitalize="off"
								autoCorrect="off"
								spellCheck={false}
								onChange={(event) => setOverride(model, event.target.value)}
								className="flex-1 min-w-0 px-2 py-1 bg-raised border border-edge rounded text-fg text-xs font-mono outline-none focus:border-accent/40 transition-colors"
							/>
							{overridden ? (
								<>
									<span className="text-accent text-dense uppercase tracking-wide shrink-0">
										{t("settings.providerModelManual")}
									</span>
									<button
										type="button"
										onClick={() => revert(model)}
										className="text-fg-3 text-xs hover:text-fg hover:underline shrink-0"
									>
										{t("settings.providerModelRevert")}
									</button>
								</>
							) : (
								<span className="text-fg-muted text-dense uppercase tracking-wide shrink-0">
									{t("settings.providerModelDefault")}
								</span>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
