import { useState, useEffect } from "react";
import { useT, useLocale, ALL_LOCALES, LOCALE_LABELS } from "../i18n";
import type { Locale } from "../i18n";
import type { CodingAgent, AgentConfiguration, GlobalSettings as GlobalSettingsType, PermissionMode, EffortLevel } from "../../shared/types";
import { api } from "../rpc";
import { getZoom, adjustZoom, applyZoom, ZOOM_STEP, DEFAULT_ZOOM, MIN_ZOOM, MAX_ZOOM, ZOOM_CHANGED_EVENT } from "../zoom";
import { ListEditor } from "./ListEditor";

type Theme = "dark" | "light" | "system";

function GlobalSettings() {
	const t = useT();
	const [locale, setLocale] = useLocale();

	const [theme, setTheme] = useState<Theme>(
		() => (localStorage.getItem("dev3-theme") as Theme) || "dark",
	);

	const [zoomLevel, setZoomLevel] = useState(() => getZoom());

	useEffect(() => {
		function onZoomChanged(e: Event) {
			setZoomLevel((e as CustomEvent).detail);
		}
		window.addEventListener(ZOOM_CHANGED_EVENT, onZoomChanged);
		return () => window.removeEventListener(ZOOM_CHANGED_EVENT, onZoomChanged);
	}, []);

	const [agents, setAgents] = useState<CodingAgent[]>([]);
	const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
	const [expandedConfigId, setExpandedConfigId] = useState<string | null>(null);

	const [globalSettings, setGlobalSettings] = useState<GlobalSettingsType>({
		defaultAgentId: "builtin-claude",
		defaultConfigId: "claude-default",
		taskDropPosition: "top",
		updateChannel: "stable",
	});

	useEffect(() => {
		api.request.getAgents().then(setAgents);
		api.request.getGlobalSettings().then(setGlobalSettings);
	}, []);

	const selectedDefaultAgent = agents.find((a) => a.id === globalSettings.defaultAgentId);
	const defaultAgentConfigs: AgentConfiguration[] = selectedDefaultAgent?.configurations || [];

	function resolveTheme(th: Theme): "dark" | "light" {
		if (th === "system") {
			return window.matchMedia("(prefers-color-scheme: dark)").matches
				? "dark"
				: "light";
		}
		return th;
	}

	function applyTheme(th: Theme) {
		setTheme(th);
		document.documentElement.dataset.theme = resolveTheme(th);
		localStorage.setItem("dev3-theme", th);
	}

	function handleDropPositionChange(pos: "top" | "bottom") {
		const updated = { ...globalSettings, taskDropPosition: pos };
		setGlobalSettings(updated);
		api.request.saveGlobalSettings(updated);
	}

	function handleUpdateChannelChange(channel: "stable" | "canary") {
		const updated = { ...globalSettings, updateChannel: channel };
		setGlobalSettings(updated);
		api.request.saveGlobalSettings(updated);
	}

	function handleDefaultAgentChange(agentId: string) {
		const agent = agents.find((a) => a.id === agentId);
		const configId = agent?.defaultConfigId ?? agent?.configurations[0]?.id ?? "";
		const updated = { ...globalSettings, defaultAgentId: agentId, defaultConfigId: configId };
		setGlobalSettings(updated);
		api.request.saveGlobalSettings(updated);
	}

	function handleDefaultConfigChange(configId: string) {
		const updated = { ...globalSettings, defaultConfigId: configId };
		setGlobalSettings(updated);
		api.request.saveGlobalSettings(updated);
	}

	async function persistAgents(updated: CodingAgent[]) {
		setAgents(updated);
		await api.request.saveAgents({ agents: updated });
	}

	function updateAgent(agentId: string, patch: Partial<CodingAgent>) {
		const updated = agents.map((a) =>
			a.id === agentId ? { ...a, ...patch } : a,
		);
		persistAgents(updated);
	}

	function updateConfig(
		agentId: string,
		configId: string,
		patch: Partial<AgentConfiguration>,
	) {
		const updated = agents.map((a) => {
			if (a.id !== agentId) return a;
			return {
				...a,
				configurations: a.configurations.map((c) =>
					c.id === configId ? { ...c, ...patch } : c,
				),
			};
		});
		persistAgents(updated);
	}

	function addConfig(agentId: string) {
		const newConfig: AgentConfiguration = {
			id: crypto.randomUUID(),
			name: "New Config",
		};
		const updated = agents.map((a) => {
			if (a.id !== agentId) return a;
			return { ...a, configurations: [...a.configurations, newConfig] };
		});
		persistAgents(updated);
		setExpandedConfigId(newConfig.id);
	}

	function deleteConfig(agentId: string, configId: string) {
		const updated = agents.map((a) => {
			if (a.id !== agentId) return a;
			const filtered = a.configurations.filter((c) => c.id !== configId);
			const newDefault =
				a.defaultConfigId === configId
					? filtered[0]?.id
					: a.defaultConfigId;
			return { ...a, configurations: filtered, defaultConfigId: newDefault };
		});
		persistAgents(updated);
		if (expandedConfigId === configId) setExpandedConfigId(null);
	}

	function addAgent() {
		const id = crypto.randomUUID();
		const configId = crypto.randomUUID();
		const agent: CodingAgent = {
			id,
			name: "New Agent",
			baseCommand: "",
			configurations: [{ id: configId, name: "Default" }],
			defaultConfigId: configId,
		};
		const updated = [...agents, agent];
		persistAgents(updated);
		setExpandedAgentId(id);
		setExpandedConfigId(null);
	}

	function deleteAgent(agentId: string) {
		const updated = agents.filter((a) => a.id !== agentId);
		persistAgents(updated);
		if (expandedAgentId === agentId) {
			setExpandedAgentId(null);
			setExpandedConfigId(null);
		}
	}

	return (
		<div className="h-full w-full flex flex-col">
			<div className="flex-1 overflow-y-auto p-7">
				<div className="max-w-xl mx-auto bg-raised/80 backdrop-blur-sm border border-edge/50 rounded-2xl p-6 space-y-8">
					{/* Theme */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-3">
							{t("settings.theme")}
						</label>
						<div className="flex gap-3">
							<ThemeCard
								name={t("settings.themeDark")}
								description={t("settings.themeDarkDesc")}
								active={theme === "dark"}
								onClick={() => applyTheme("dark")}
								preview={{
									bg: "#171924",
									raised: "#1e2133",
									text: "#eceef8",
									accent: "#5e9eff",
								}}
							/>
							<ThemeCard
								name={t("settings.themeLight")}
								description={t("settings.themeLightDesc")}
								active={theme === "light"}
								onClick={() => applyTheme("light")}
								preview={{
									bg: "#f5f6fa",
									raised: "#ffffff",
									text: "#1a1d2e",
									accent: "#5e9eff",
								}}
							/>
							<ThemeCard
								name={t("settings.themeSystem")}
								description={t("settings.themeSystemDesc")}
								active={theme === "system"}
								onClick={() => applyTheme("system")}
								preview={{
									bg: "linear-gradient(135deg, #171924 50%, #f5f6fa 50%)",
									raised: "#1e2133",
									text: "#eceef8",
									accent: "#5e9eff",
								}}
							/>
						</div>
					</div>

					{/* Zoom */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-2">
							{t("settings.zoom")}
						</label>
						<p className="text-fg-3 text-sm mb-3">
							{t("settings.zoomDesc")}
						</p>
						<div className="flex items-center gap-3">
							<button
								onClick={() => adjustZoom(-ZOOM_STEP)}
								disabled={zoomLevel <= MIN_ZOOM}
								className="w-10 h-10 flex items-center justify-center rounded-lg bg-raised border border-edge text-fg text-lg font-bold hover:border-edge-active transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
							>
								−
							</button>
							<div className="flex-1 text-center">
								<span className="text-fg text-lg font-semibold tabular-nums">
									{Math.round(zoomLevel * 100)}%
								</span>
							</div>
							<button
								onClick={() => adjustZoom(ZOOM_STEP)}
								disabled={zoomLevel >= MAX_ZOOM}
								className="w-10 h-10 flex items-center justify-center rounded-lg bg-raised border border-edge text-fg text-lg font-bold hover:border-edge-active transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
							>
								+
							</button>
							<button
								onClick={() => applyZoom(DEFAULT_ZOOM)}
								disabled={zoomLevel === DEFAULT_ZOOM}
								className="px-3 h-10 rounded-lg bg-raised border border-edge text-fg-2 text-sm hover:border-edge-active transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
							>
								{t("settings.zoomReset")}
							</button>
						</div>
					</div>

					{/* Task Drop Position */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-2">
							{t("settings.taskDropPosition")}
						</label>
						<p className="text-fg-3 text-sm mb-3">
							{t("settings.taskDropPositionDesc")}
						</p>
						<div className="flex gap-3">
							<DropPositionCard
								label={t("settings.dropToTop")}
								description={t("settings.dropToTopDesc")}
								active={globalSettings.taskDropPosition === "top"}
								onClick={() => handleDropPositionChange("top")}
								icon="↑"
							/>
							<DropPositionCard
								label={t("settings.dropToBottom")}
								description={t("settings.dropToBottomDesc")}
								active={globalSettings.taskDropPosition === "bottom"}
								onClick={() => handleDropPositionChange("bottom")}
								icon="↓"
							/>
						</div>
					</div>

					{/* Update Channel */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-2">
							{t("settings.updateChannel")}
						</label>
						<p className="text-fg-3 text-sm mb-3">
							{t("settings.updateChannelDesc")}
						</p>
						<select
							value={globalSettings.updateChannel}
							onChange={(e) => handleUpdateChannelChange(e.target.value as "stable" | "canary")}
							disabled
							className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm outline-none appearance-none cursor-not-allowed opacity-50"
						>
							<option value="stable">Stable</option>
							<option value="canary">Canary</option>
						</select>
					</div>

					{/* Clone Base Directory */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-2">
							{t("settings.cloneBaseDir")}
						</label>
						<p className="text-fg-3 text-sm mb-3">
							{t("settings.cloneBaseDirDesc")}
						</p>
						<div className="flex gap-2">
							<div className="flex-1 px-4 py-3 bg-raised border border-edge rounded-xl text-sm font-mono truncate">
								{globalSettings.cloneBaseDirectory ? (
									<span className="text-fg">{globalSettings.cloneBaseDirectory}</span>
								) : (
									<span className="text-fg-muted">{t("settings.cloneBaseDirNotSet")}</span>
								)}
							</div>
							<button
								onClick={async () => {
									const folder = await api.request.pickFolder();
									if (!folder) return;
									const updated = { ...globalSettings, cloneBaseDirectory: folder };
									setGlobalSettings(updated);
									api.request.saveGlobalSettings(updated);
								}}
								className="px-4 py-3 bg-raised border border-edge rounded-xl text-fg-2 text-sm hover:border-edge-active transition-colors flex-shrink-0"
							>
								{t("settings.browse")}
							</button>
						</div>
					</div>

					{/* Default Agent */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-2">
							{t("settings.defaultAgent")}
						</label>
						<p className="text-fg-3 text-sm mb-3">
							{t("settings.defaultAgentDesc")}
						</p>
						<select
							value={globalSettings.defaultAgentId}
							onChange={(e) => handleDefaultAgentChange(e.target.value)}
							className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm outline-none focus:border-accent/40 transition-colors appearance-none cursor-pointer"
						>
							{agents.map((agent) => (
								<option key={agent.id} value={agent.id}>
									{agent.name}
								</option>
							))}
						</select>

						{defaultAgentConfigs.length > 0 && (
							<div className="mt-4">
								<label className="block text-fg text-sm font-semibold mb-2">
									{t("settings.defaultConfig")}
								</label>
								<p className="text-fg-3 text-sm mb-3">
									{t("settings.defaultConfigDesc")}
								</p>
								<select
									value={globalSettings.defaultConfigId}
									onChange={(e) => handleDefaultConfigChange(e.target.value)}
									className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm outline-none focus:border-accent/40 transition-colors appearance-none cursor-pointer"
								>
									{defaultAgentConfigs.map((config) => (
										<option key={config.id} value={config.id}>
											{config.name}
											{config.model ? ` (${config.model})` : ""}
										</option>
									))}
								</select>
								{(() => {
									const selectedConfig = defaultAgentConfigs.find(
										(c) => c.id === globalSettings.defaultConfigId,
									) ?? defaultAgentConfigs[0];
									if (!selectedConfig) return null;
									return (
										<ConfigPreviewCard
											config={selectedConfig}
											agentBaseCommand={selectedDefaultAgent?.baseCommand ?? ""}
											t={t}
										/>
									);
								})()}
							</div>
						)}
					</div>

					{/* Coding Agents */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-3">
							{t("settings.agents")}
						</label>

						<div className="space-y-2 mb-3">
							{agents.map((agent) => {
								const isExpanded = expandedAgentId === agent.id;
								return (
									<div
										key={agent.id}
										className="bg-raised border border-edge rounded-xl overflow-hidden"
									>
										{/* Agent header */}
										<button
											onClick={() => {
												setExpandedAgentId(isExpanded ? null : agent.id);
												setExpandedConfigId(null);
											}}
											className="w-full flex items-center gap-3 px-4 py-3 hover:bg-raised-hover transition-colors text-left"
										>
											<span className="text-fg-3 text-xs">
												{isExpanded ? "▼" : "▶"}
											</span>
											<span className="text-fg text-sm font-medium flex-1">
												{agent.name}
											</span>
											<span className="text-fg-3 text-xs font-mono">
												{agent.baseCommand}
											</span>
											<span className="text-fg-muted text-xs">
												{agent.configurations.length} config{agent.configurations.length !== 1 ? "s" : ""}
											</span>
											{agent.isDefault && (
												<span className="text-fg-muted text-xs px-2 py-0.5 bg-elevated rounded-md">
													{t("settings.defaultBadge")}
												</span>
											)}
										</button>

										{/* Expanded agent editor */}
										{isExpanded && (
											<div className="border-t border-edge px-4 py-4 space-y-4">
												{/* Agent name */}
												<div>
													<label className="block text-fg-2 text-xs mb-1">
														{t("settings.agentName")}
													</label>
													<input
														type="text"
														value={agent.name}
														onChange={(e) =>
															updateAgent(agent.id, { name: e.target.value })
														}
														className="w-full px-3 py-2 bg-elevated border border-edge rounded-lg text-fg text-sm outline-none focus:border-accent/40 transition-colors"
													/>
												</div>

												{/* Base command */}
												<div>
													<label className="block text-fg-2 text-xs mb-1">
														{t("settings.agentBaseCommand")}
													</label>
													<input
														type="text"
														value={agent.baseCommand}
														onChange={(e) =>
															updateAgent(agent.id, {
																baseCommand: e.target.value,
															})
														}
														placeholder="claude"
														autoCapitalize="off"
														autoCorrect="off"
														spellCheck={false}
														className="w-full px-3 py-2 bg-elevated border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
													/>
												</div>

												{/* Configurations */}
												<div>
													<label className="block text-fg-2 text-xs font-semibold mb-2">
														{t("settings.configurations")}
													</label>
													<div className="space-y-2">
														{agent.configurations.map((config) => {
															const isConfigExpanded =
																expandedConfigId === config.id;
															return (
																<ConfigEditor
																	key={config.id}
																	config={config}
																	agentBaseCommand={agent.baseCommand}
																	isExpanded={isConfigExpanded}
																	canDelete={agent.configurations.length > 1}
																	onToggle={() =>
																		setExpandedConfigId(
																			isConfigExpanded ? null : config.id,
																		)
																	}
																	onChange={(patch) =>
																		updateConfig(agent.id, config.id, patch)
																	}
																	onDelete={() =>
																		deleteConfig(agent.id, config.id)
																	}
																	t={t}
																/>
															);
														})}
													</div>
													<button
														onClick={() => addConfig(agent.id)}
														className="mt-2 px-3 py-1.5 text-accent text-xs font-semibold hover:bg-accent/10 rounded-lg transition-colors"
													>
														+ {t("settings.addConfig")}
													</button>
												</div>

												{/* Delete agent */}
												{agent.isDefault ? (
													<p className="text-fg-muted text-xs italic">
														{t("settings.cantDeleteDefault")}
													</p>
												) : (
													<button
														onClick={() => deleteAgent(agent.id)}
														className="text-danger text-xs hover:underline"
													>
														{t("settings.deleteAgent")}
													</button>
												)}
											</div>
										)}
									</div>
								);
							})}
						</div>

						<button
							onClick={addAgent}
							className="px-4 py-2 text-accent text-sm font-semibold hover:bg-accent/10 rounded-lg transition-colors"
						>
							+ {t("settings.addAgent")}
						</button>
					</div>

					{/* Language */}
					<div>
						<label className="block text-fg text-sm font-semibold mb-3">
							{t("settings.language")}
						</label>
						<div className="flex gap-3">
							{ALL_LOCALES.map((loc) => (
								<LanguageCard
									key={loc}
									locale={loc}
									label={LOCALE_LABELS[loc]}
									active={locale === loc}
									onClick={() => setLocale(loc)}
								/>
							))}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

// ---- Config Preview Card (shown below Default Configuration dropdown) ----

function ConfigPreviewCard({
	config,
	agentBaseCommand,
	t,
}: {
	config: AgentConfiguration;
	agentBaseCommand: string;
	t: ReturnType<typeof useT>;
}) {
	const tags: { label: string; value: string }[] = [];

	if (config.model) {
		tags.push({ label: t("settings.configModel"), value: config.model });
	}
	if (config.permissionMode && config.permissionMode !== "default") {
		const modeLabels: Record<string, string> = {
			plan: t("settings.permPlan"),
			acceptEdits: t("settings.permAcceptEdits"),
			dontAsk: t("settings.permDontAsk"),
			bypassPermissions: t("settings.permBypass"),
		};
		tags.push({
			label: t("settings.configPermissionMode"),
			value: modeLabels[config.permissionMode] ?? config.permissionMode,
		});
	}
	if (config.effort) {
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
	if (config.maxBudgetUsd != null && config.maxBudgetUsd > 0) {
		tags.push({
			label: t("settings.configMaxBudget"),
			value: `$${config.maxBudgetUsd}`,
		});
	}

	const { command, envLine } = buildCommandPreview(agentBaseCommand, config);

	return (
		<div className="mt-3 bg-base border border-edge rounded-xl p-3 space-y-2">
			{tags.length > 0 && (
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
			)}
			<CommandPreview command={command} envLine={envLine} />
		</div>
	);
}

// ---- Config Editor ----

function buildCommandPreview(
	agentBaseCommand: string,
	config: AgentConfiguration,
): { command: string; envLine: string | null } {
	const baseCmd = config.baseCommandOverride || agentBaseCommand || "???";
	const parts: string[] = [baseCmd];

	if (config.model) {
		parts.push("--model", config.model);
	}

	const cmdName = baseCmd.split("/").pop() ?? "";
	const isCursor = cmdName === "agent";

	if (config.permissionMode && config.permissionMode !== "default") {
		if (isCursor) {
			if (config.permissionMode === "plan") {
				parts.push("--mode", "plan");
			} else if (config.permissionMode === "bypassPermissions") {
				parts.push("--force");
			}
		} else {
			parts.push("--permission-mode", config.permissionMode);
		}
	}

	if (config.effort && !isCursor) {
		parts.push("--effort", config.effort);
	}

	if (config.maxBudgetUsd != null && config.maxBudgetUsd > 0 && !isCursor) {
		parts.push("--max-budget-usd", String(config.maxBudgetUsd));
	}

	// Mirror --append-system-prompt injection for Claude-based agents
	if (cmdName === "claude") {
		parts.push("--append-system-prompt", "'…dev3 prompt…'");
	}

	if (config.additionalArgs) {
		for (const arg of config.additionalArgs) {
			if (arg) parts.push(arg);
		}
	}

	// Build prompt placeholder
	let prompt = "{{TASK_DESCRIPTION}}";
	if (config.appendPrompt) {
		prompt += "\\n\\n" + config.appendPrompt;
	}
	if (isCursor) {
		prompt += "\\n\\n…dev3 prompt…";
	}
	parts.push(`'${prompt}'`);

	// Env vars line
	const envPairs = Object.entries(config.envVars || {}).filter(
		([k]) => k,
	);
	const envLine =
		envPairs.length > 0
			? envPairs.map(([k, v]) => `${k}=${v}`).join(" ")
			: null;

	return { command: parts.join(" "), envLine };
}

function CommandPreview({
	command,
	envLine,
}: {
	command: string;
	envLine: string | null;
}) {
	// Highlight {{VAR}} patterns
	const parts = command.split(/(\{\{\w+\}\})/g);

	return (
		<div className="bg-base border border-edge rounded-lg p-3 font-mono text-xs leading-relaxed overflow-x-auto">
			{envLine && (
				<div className="text-fg-3 mb-1">
					<span className="text-fg-muted">env: </span>
					{envLine}
				</div>
			)}
			<div className="text-fg-2">
				<span className="text-fg-muted">$ </span>
				{parts.map((part, i) =>
					/^\{\{\w+\}\}$/.test(part) ? (
						<span key={i} className="text-accent font-semibold">
							{part}
						</span>
					) : (
						<span key={i}>{part}</span>
					),
				)}
			</div>
		</div>
	);
}

function ConfigEditor({
	config,
	agentBaseCommand,
	isExpanded,
	canDelete,
	onToggle,
	onChange,
	onDelete,
	t,
}: {
	config: AgentConfiguration;
	agentBaseCommand: string;
	isExpanded: boolean;
	canDelete: boolean;
	onToggle: () => void;
	onChange: (patch: Partial<AgentConfiguration>) => void;
	onDelete: () => void;
	t: (key: any, vars?: Record<string, string>) => string;
}) {
	const preview = buildCommandPreview(agentBaseCommand, config);

	return (
		<div className="bg-elevated border border-edge rounded-lg overflow-hidden">
			<button
				onClick={onToggle}
				className="w-full flex items-center gap-2 px-3 py-2 hover:bg-elevated-hover transition-colors text-left"
			>
				<span className="text-fg-3 text-xs">{isExpanded ? "▼" : "▶"}</span>
				<span className="text-fg text-sm flex-1">{config.name}</span>
				{config.model && (
					<span className="text-accent text-xs font-mono px-1.5 py-0.5 bg-accent/10 rounded">
						{config.model}
					</span>
				)}
			</button>

			{isExpanded && (
				<div className="border-t border-edge px-3 py-3 space-y-3">
					{/* Command Preview — top of config */}
					<div>
						<label className="block text-fg-2 text-xs font-semibold mb-1.5">
							{t("settings.commandPreview")}
						</label>
						<CommandPreview
							command={preview.command}
							envLine={preview.envLine}
						/>
					</div>

					{/* Config name */}
					<div>
						<label className="block text-fg-2 text-xs mb-1">
							{t("settings.configName")}
						</label>
						<input
							type="text"
							value={config.name}
							onChange={(e) => onChange({ name: e.target.value })}
							className="w-full px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm outline-none focus:border-accent/40 transition-colors"
						/>
					</div>

					{/* Model */}
					<div>
						<label className="block text-fg-2 text-xs mb-1">
							{t("settings.configModel")}
						</label>
						<input
							type="text"
							value={config.model || ""}
							onChange={(e) =>
								onChange({ model: e.target.value || undefined })
							}
							placeholder="opus, sonnet, etc."
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
							className="w-full px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
						/>
					</div>

					{/* Permission mode */}
					<div>
						<label className="block text-fg-2 text-xs mb-1">
							{t("settings.configPermissionMode")}
						</label>
						<select
							value={config.permissionMode || "default"}
							onChange={(e) =>
								onChange({
									permissionMode:
										(e.target.value as PermissionMode) === "default"
											? undefined
											: (e.target.value as PermissionMode),
								})
							}
							className="w-full px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm outline-none focus:border-accent/40 transition-colors appearance-none cursor-pointer"
						>
							<option value="default">{t("settings.permDefault")}</option>
							<option value="plan">{t("settings.permPlan")}</option>
							<option value="acceptEdits">{t("settings.permAcceptEdits")}</option>
							<option value="dontAsk">{t("settings.permDontAsk")}</option>
							<option value="bypassPermissions">{t("settings.permBypass")}</option>
						</select>
					</div>

					{/* Effort level */}
					<div>
						<label className="block text-fg-2 text-xs mb-1">
							{t("settings.configEffort")}
						</label>
						<select
							value={config.effort || ""}
							onChange={(e) =>
								onChange({
									effort: (e.target.value as EffortLevel) || undefined,
								})
							}
							className="w-full px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm outline-none focus:border-accent/40 transition-colors appearance-none cursor-pointer"
						>
							<option value="">{t("settings.effortDefault")}</option>
							<option value="low">{t("settings.effortLow")}</option>
							<option value="medium">{t("settings.effortMedium")}</option>
							<option value="high">{t("settings.effortHigh")}</option>
						</select>
					</div>

					{/* Max budget */}
					<div>
						<label className="block text-fg-2 text-xs mb-1">
							{t("settings.configMaxBudget")}
						</label>
						<input
							type="number"
							min={0}
							step={0.5}
							value={config.maxBudgetUsd ?? ""}
							onChange={(e) =>
								onChange({
									maxBudgetUsd: e.target.value
										? Number(e.target.value)
										: undefined,
								})
							}
							placeholder="0"
							className="w-full px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
						/>
						<p className="text-fg-muted text-xs mt-1">
							{t("settings.configMaxBudgetHint")}
						</p>
					</div>

					{/* Append prompt */}
					<div>
						<label className="block text-fg-2 text-xs mb-1">
							{t("settings.configAppendPrompt")}
						</label>
						<textarea
							value={config.appendPrompt || ""}
							onChange={(e) =>
								onChange({ appendPrompt: e.target.value || undefined })
							}
							rows={3}
							className="w-full px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
						/>
						<p className="text-fg-muted text-xs mt-1">
							{t("settings.configAppendPromptHint")}
						</p>
					</div>

					{/* Additional args */}
					<div>
						<label className="block text-fg-2 text-xs mb-1">
							{t("settings.configAdditionalArgs")}
						</label>
						<ListEditor
							items={config.additionalArgs || []}
							onChange={(items) =>
								onChange({
									additionalArgs: items.length > 0 ? items : undefined,
								})
							}
							placeholder="--flag"
							addLabel={t("settings.configAddArg")}
						/>
					</div>

					{/* Env vars */}
					<div>
						<label className="block text-fg-2 text-xs mb-1">
							{t("settings.configEnvVars")}
						</label>
						<KeyValueEditor
							entries={config.envVars || {}}
							onChange={(entries) =>
								onChange({
									envVars:
										Object.keys(entries).length > 0 ? entries : undefined,
								})
							}
							addLabel={t("settings.configAddEnvVar")}
						/>
					</div>

					{/* Base command override */}
					<div>
						<label className="block text-fg-2 text-xs mb-1">
							{t("settings.configBaseCommandOverride")}
						</label>
						<input
							type="text"
							value={config.baseCommandOverride || ""}
							onChange={(e) =>
								onChange({
									baseCommandOverride: e.target.value || undefined,
								})
							}
							placeholder=""
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
							className="w-full px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
						/>
					</div>

					{/* Delete config */}
					{canDelete && (
						<button
							onClick={onDelete}
							className="text-danger text-xs hover:underline"
						>
							{t("settings.deleteConfig")}
						</button>
					)}
				</div>
			)}
		</div>
	);
}

// ---- Key-Value Editor (for envVars) ----

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
		const result: Record<string, string> = {};
		for (const [k, v] of pairs) {
			result[k === oldKey ? newKey : k] = v;
		}
		onChange(result);
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
			{pairs.map(([key, value], i) => (
				<div key={i} className="flex gap-2">
					<input
						type="text"
						value={key}
						onChange={(e) => updateKey(key, e.target.value)}
						placeholder="KEY"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						className="w-1/3 px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
					/>
					<input
						type="text"
						value={value}
						onChange={(e) => updateValue(key, e.target.value)}
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

// ---- Drop Position Card ----

function DropPositionCard({
	label,
	description,
	active,
	onClick,
	icon,
}: {
	label: string;
	description: string;
	active: boolean;
	onClick: () => void;
	icon: string;
}) {
	return (
		<button
			onClick={onClick}
			className={`flex-1 p-4 rounded-xl border-2 transition-all text-left ${
				active
					? "border-accent shadow-lg shadow-accent/10"
					: "border-edge hover:border-edge-active"
			}`}
		>
			<div className="text-2xl mb-2 font-mono text-fg-2 font-bold">{icon}</div>
			<div className="text-fg text-sm font-semibold">{label}</div>
			<div className="text-fg-3 text-xs mt-0.5">{description}</div>
		</button>
	);
}

// ---- Theme & Language Cards ----

function ThemeCard({
	name,
	description,
	active,
	onClick,
	preview,
}: {
	name: string;
	description: string;
	active: boolean;
	onClick: () => void;
	preview: { bg: string; raised: string; text: string; accent: string };
}) {
	return (
		<button
			onClick={onClick}
			className={`flex-1 p-4 rounded-xl border-2 transition-all text-left ${
				active
					? "border-accent shadow-lg shadow-accent/10"
					: "border-edge hover:border-edge-active"
			}`}
		>
			{/* Mini preview */}
			<div
				className="w-full h-20 rounded-lg mb-3 p-3 flex flex-col justify-between"
				style={{ background: preview.bg }}
			>
				<div className="flex items-center gap-2">
					<div
						className="w-2 h-2 rounded-full"
						style={{ background: preview.accent }}
					/>
					<div
						className="h-1.5 w-12 rounded-full opacity-60"
						style={{ background: preview.text }}
					/>
				</div>
				<div className="flex gap-1.5">
					<div
						className="h-6 flex-1 rounded"
						style={{ background: preview.raised }}
					/>
					<div
						className="h-6 flex-1 rounded"
						style={{ background: preview.raised }}
					/>
				</div>
			</div>

			<div className="text-fg text-sm font-semibold">{name}</div>
			<div className="text-fg-3 text-xs mt-0.5">{description}</div>
		</button>
	);
}

function LanguageCard({
	locale,
	label,
	active,
	onClick,
}: {
	locale: Locale;
	label: string;
	active: boolean;
	onClick: () => void;
}) {
	const flags: Record<Locale, string> = {
		en: "EN",
		ru: "RU",
		es: "ES",
	};

	return (
		<button
			onClick={onClick}
			className={`flex-1 p-4 rounded-xl border-2 transition-all text-left ${
				active
					? "border-accent shadow-lg shadow-accent/10"
					: "border-edge hover:border-edge-active"
			}`}
		>
			<div className="text-2xl mb-2 font-mono text-fg-2 font-bold">
				{flags[locale]}
			</div>
			<div className="text-fg text-sm font-semibold">{label}</div>
		</button>
	);
}

export default GlobalSettings;
