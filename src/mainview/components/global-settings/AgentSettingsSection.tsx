import { useCallback, useEffect, useState, type DragEvent } from "react";
import type {
	AgentCheckResult,
	AgentConfiguration,
	BedrockGeo,
	CodingAgent,
	EffortLevel,
	GlobalSettings,
	LlmProvider,
	PermissionMode,
	ProviderConfig,
	ProviderSettings,
} from "../../../shared/types";
import { randomUUID } from "../../uuid";
import { ListEditor } from "../ListEditor";
import { api } from "../../rpc";
import type { TFunction } from "../../i18n";
import SettingsSection from "./SettingsSection";
import {
	BEDROCK_GEOS,
	DEFAULT_BEDROCK_GEO,
	defaultModelMap,
	getProviderDefinition,
	providersForAgent,
} from "../../../shared/llm-provider";
import {
	buildCommandPreview,
	moveItem,
	reorderToTarget,
	type DropSide,
} from "./utils";

const ARROW_UP_GLYPH = "\uF062";
const ARROW_DOWN_GLYPH = "\uF063";
const GRIP_GLYPH = "\u{F01DB}";

function ReorderControls({
	dragHandleProps,
	canMoveUp,
	canMoveDown,
	onMoveUp,
	onMoveDown,
	dragTitle,
	upTitle,
	downTitle,
	size = "sm",
}: {
	dragHandleProps: {
		draggable: boolean;
		onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
		onDragEnd: () => void;
	};
	canMoveUp: boolean;
	canMoveDown: boolean;
	onMoveUp: () => void;
	onMoveDown: () => void;
	dragTitle: string;
	upTitle: string;
	downTitle: string;
	size?: "sm" | "md";
}) {
	const fontSize = size === "md" ? "text-[0.875rem]" : "text-[0.75rem]";
	const gripSize = size === "md" ? "text-[1rem]" : "text-[0.875rem]";
	const padding = size === "md" ? "p-1.5" : "p-1";
	return (
		<div className="flex items-center gap-0.5 shrink-0">
			<button
				type="button"
				onClick={(event) => event.stopPropagation()}
				draggable={dragHandleProps.draggable}
				onDragStart={dragHandleProps.onDragStart}
				onDragEnd={dragHandleProps.onDragEnd}
				className={`${padding} rounded text-fg-muted hover:text-fg hover:bg-elevated transition-colors cursor-grab active:cursor-grabbing`}
				title={dragTitle}
				aria-label={dragTitle}
			>
				<span
					className={`${gripSize} leading-none`}
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{GRIP_GLYPH}
				</span>
			</button>
			<button
				type="button"
				onClick={(event) => {
					event.stopPropagation();
					onMoveUp();
				}}
				className={`${padding} rounded text-fg-muted hover:text-fg hover:bg-elevated transition-colors disabled:opacity-30 disabled:hover:text-fg-muted disabled:hover:bg-transparent`}
				title={upTitle}
				aria-label={upTitle}
				disabled={!canMoveUp}
			>
				<span
					className={`${fontSize} leading-none`}
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{ARROW_UP_GLYPH}
				</span>
			</button>
			<button
				type="button"
				onClick={(event) => {
					event.stopPropagation();
					onMoveDown();
				}}
				className={`${padding} rounded text-fg-muted hover:text-fg hover:bg-elevated transition-colors disabled:opacity-30 disabled:hover:text-fg-muted disabled:hover:bg-transparent`}
				title={downTitle}
				aria-label={downTitle}
				disabled={!canMoveDown}
			>
				<span
					className={`${fontSize} leading-none`}
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{ARROW_DOWN_GLYPH}
				</span>
			</button>
		</div>
	);
}

interface AgentSettingsSectionProps {
	t: TFunction;
	agents: CodingAgent[];
	globalSettings: GlobalSettings;
	onAgentsChange: (updated: CodingAgent[]) => void | Promise<void>;
	onDefaultAgentChange: (agentId: string) => void;
	onDefaultConfigChange: (configId: string) => void;
}

export default function AgentSettingsSection({
	t,
	agents,
	globalSettings,
	onAgentsChange,
	onDefaultAgentChange,
	onDefaultConfigChange,
}: AgentSettingsSectionProps) {
	const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
	const [expandedConfigId, setExpandedConfigId] = useState<string | null>(null);
	const [agentAvailability, setAgentAvailability] = useState<AgentCheckResult[]>(
		[],
	);
	const [agentCheckLoading, setAgentCheckLoading] = useState(false);
	const [agentCustomPaths, setAgentCustomPaths] = useState<Record<string, string>>(
		{},
	);
	const [agentSavingId, setAgentSavingId] = useState<string | null>(null);
	const [agentCopiedId, setAgentCopiedId] = useState<string | null>(null);
	const [draggedAgentId, setDraggedAgentId] = useState<string | null>(null);
	const [agentDropTarget, setAgentDropTarget] = useState<{
		id: string;
		side: DropSide;
	} | null>(null);
	const [draggedConfig, setDraggedConfig] = useState<{
		agentId: string;
		configId: string;
	} | null>(null);
	const [configDropTarget, setConfigDropTarget] = useState<{
		agentId: string;
		configId: string;
		side: DropSide;
	} | null>(null);

	const selectedDefaultAgent = agents.find(
		(agent) => agent.id === globalSettings.defaultAgentId,
	);
	const defaultAgentConfigs = selectedDefaultAgent?.configurations || [];

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

	function persistAgents(updated: CodingAgent[]) {
		onAgentsChange(updated);
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

	function addConfig(agentId: string) {
		const newConfig: AgentConfiguration = {
			id: randomUUID(),
			name: "New Config",
		};
		const updated = agents.map((agent) => {
			if (agent.id !== agentId) return agent;
			return {
				...agent,
				configurations: [...agent.configurations, newConfig],
			};
		});
		persistAgents(updated);
		setExpandedConfigId(newConfig.id);
	}

	function deleteConfig(agentId: string, configId: string) {
		const updated = agents.map((agent) => {
			if (agent.id !== agentId) return agent;
			const filtered = agent.configurations.filter(
				(config) => config.id !== configId,
			);
			const newDefault =
				agent.defaultConfigId === configId
					? filtered[0]?.id
					: agent.defaultConfigId;
			return {
				...agent,
				configurations: filtered,
				defaultConfigId: newDefault,
			};
		});
		persistAgents(updated);
		if (expandedConfigId === configId) {
			setExpandedConfigId(null);
		}
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
		setExpandedAgentId(agentId);
		setExpandedConfigId(null);
	}

	function deleteAgent(agentId: string) {
		persistAgents(agents.filter((agent) => agent.id !== agentId));
		if (expandedAgentId === agentId) {
			setExpandedAgentId(null);
			setExpandedConfigId(null);
		}
	}

	function moveAgent(agentId: string, direction: -1 | 1) {
		const fromIndex = agents.findIndex((agent) => agent.id === agentId);
		if (fromIndex === -1) return;
		const toIndex = fromIndex + direction;
		if (toIndex < 0 || toIndex >= agents.length) return;
		persistAgents(moveItem(agents, fromIndex, toIndex));
	}

	function moveConfig(agentId: string, configId: string, direction: -1 | 1) {
		const updated = agents.map((agent) => {
			if (agent.id !== agentId) return agent;
			const fromIndex = agent.configurations.findIndex(
				(config) => config.id === configId,
			);
			if (fromIndex === -1) return agent;
			const toIndex = fromIndex + direction;
			if (toIndex < 0 || toIndex >= agent.configurations.length) return agent;
			return {
				...agent,
				configurations: moveItem(agent.configurations, fromIndex, toIndex),
			};
		});
		persistAgents(updated);
	}

	function handleAgentDragOver(
		event: DragEvent<HTMLDivElement>,
		agentId: string,
	) {
		if (!draggedAgentId || draggedAgentId === agentId) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		const rect = event.currentTarget.getBoundingClientRect();
		const side: DropSide =
			event.clientY > rect.top + rect.height / 2 ? "after" : "before";
		setAgentDropTarget({ id: agentId, side });
	}

	function handleAgentDrop(agentId: string) {
		const sourceId = draggedAgentId;
		const side = agentDropTarget?.id === agentId ? agentDropTarget.side : "before";
		setDraggedAgentId(null);
		setAgentDropTarget(null);
		if (!sourceId || sourceId === agentId) return;
		persistAgents(
			reorderToTarget(agents, sourceId, agentId, side, (a) => a.id),
		);
	}

	function handleConfigDragOver(
		event: DragEvent<HTMLDivElement>,
		agentId: string,
		configId: string,
	) {
		if (!draggedConfig) return;
		if (draggedConfig.agentId !== agentId) return;
		if (draggedConfig.configId === configId) return;
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = "move";
		const rect = event.currentTarget.getBoundingClientRect();
		const side: DropSide =
			event.clientY > rect.top + rect.height / 2 ? "after" : "before";
		setConfigDropTarget({ agentId, configId, side });
	}

	function handleConfigDrop(agentId: string, configId: string) {
		const source = draggedConfig;
		const side =
			configDropTarget?.agentId === agentId &&
			configDropTarget?.configId === configId
				? configDropTarget.side
				: "before";
		setDraggedConfig(null);
		setConfigDropTarget(null);
		if (!source || source.agentId !== agentId) return;
		if (source.configId === configId) return;
		const updated = agents.map((agent) => {
			if (agent.id !== agentId) return agent;
			return {
				...agent,
				configurations: reorderToTarget(
					agent.configurations,
					source.configId,
					configId,
					side,
					(c) => c.id,
				),
			};
		});
		persistAgents(updated);
	}

	return (
		<SettingsSection title={t("settings.agents")}>
			<div>
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("settings.defaultAgent")}
				</label>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.defaultAgentDesc")}
				</p>
				<select
					value={globalSettings.defaultAgentId}
					onChange={(event) => onDefaultAgentChange(event.target.value)}
					className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm outline-none focus:border-accent/40 transition-colors appearance-none cursor-pointer"
				>
					{agents.map((agent) => (
						<option key={agent.id} value={agent.id}>
							{agent.name}
						</option>
					))}
				</select>

				{defaultAgentConfigs.length > 0 ? (
					<div className="mt-4">
						<label className="block text-fg text-sm font-semibold mb-2">
							{t("settings.defaultConfig")}
						</label>
						<p className="text-fg-3 text-sm mb-3">
							{t("settings.defaultConfigDesc")}
						</p>
						<select
							value={globalSettings.defaultConfigId}
							onChange={(event) => onDefaultConfigChange(event.target.value)}
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
							const selectedConfig =
								defaultAgentConfigs.find(
									(config) => config.id === globalSettings.defaultConfigId,
								) ?? defaultAgentConfigs[0];
							if (!selectedConfig) return null;
							return (
								<ConfigPreviewCard
									config={selectedConfig}
									agentBaseCommand={selectedDefaultAgent?.baseCommand ?? ""}
									t={t}
									llmProvider={selectedDefaultAgent?.llmProvider}
								/>
							);
						})()}
					</div>
				) : null}
			</div>

			<div>
				<div className="space-y-2 mb-3">
					{agents.map((agent, agentIndex) => {
						const isExpanded = expandedAgentId === agent.id;
						const availability = agentAvailability.find(
							(item) => item.agentId === agent.id,
						);
						const toggle = () => {
							setExpandedAgentId(isExpanded ? null : agent.id);
							setExpandedConfigId(null);
						};
						const isDragged = draggedAgentId === agent.id;
						const showDropBefore =
							agentDropTarget?.id === agent.id &&
							agentDropTarget.side === "before";
						const showDropAfter =
							agentDropTarget?.id === agent.id &&
							agentDropTarget.side === "after";
						return (
							<div
								key={agent.id}
								className={`relative bg-raised border border-edge rounded-xl overflow-hidden transition-opacity ${isDragged ? "opacity-60" : ""}`}
								onDragOver={(event) => handleAgentDragOver(event, agent.id)}
								onDragLeave={(event) => {
									if (!event.currentTarget.contains(event.relatedTarget as Node)) {
										setAgentDropTarget((current) =>
											current?.id === agent.id ? null : current,
										);
									}
								}}
								onDrop={(event) => {
									event.preventDefault();
									handleAgentDrop(agent.id);
								}}
							>
								{showDropBefore ? (
									<div className="absolute top-0 left-3 right-3 h-0.5 bg-accent rounded-full z-10" />
								) : null}
								{showDropAfter ? (
									<div className="absolute bottom-0 left-3 right-3 h-0.5 bg-accent rounded-full z-10" />
								) : null}
								<div
									role="button"
									tabIndex={0}
									onClick={toggle}
									onKeyDown={(event) => {
										if (event.key === "Enter" || event.key === " ") {
											event.preventDefault();
											toggle();
										}
									}}
									className="w-full flex items-center gap-3 px-4 py-3 hover:bg-raised-hover transition-colors text-left cursor-pointer"
								>
									<ReorderControls
										dragHandleProps={{
											draggable: true,
											onDragStart: (event) => {
												setDraggedAgentId(agent.id);
												event.dataTransfer.setData(
													"text/plain",
													`agent:${agent.id}`,
												);
												event.dataTransfer.effectAllowed = "move";
											},
											onDragEnd: () => {
												setDraggedAgentId(null);
												setAgentDropTarget(null);
											},
										}}
										canMoveUp={agentIndex > 0}
										canMoveDown={agentIndex < agents.length - 1}
										onMoveUp={() => moveAgent(agent.id, -1)}
										onMoveDown={() => moveAgent(agent.id, 1)}
										dragTitle={t("settings.dragAgent")}
										upTitle={t("settings.moveAgentUp")}
										downTitle={t("settings.moveAgentDown")}
										size="md"
									/>
									<span className="text-fg-3 text-xs">
										{isExpanded ? "▼" : "▶"}
									</span>
									<span className="text-fg text-sm font-medium flex-1">
										{agent.name}
									</span>
									<span className="text-fg-3 text-xs font-mono">
										{agent.baseCommand}
									</span>
									{availability ? (
										<span
											className={`text-xs px-1.5 py-0.5 rounded ${
												availability.installed
													? "bg-success/15 text-success"
													: "bg-danger/15 text-danger"
											}`}
										>
											{availability.installed
												? t("settings.agentInstalled")
												: t("settings.agentNotInstalled")}
										</span>
									) : null}
									<span className="text-fg-muted text-xs">
										{agent.configurations.length} config
										{agent.configurations.length !== 1 ? "s" : ""}
									</span>
									{agent.isDefault ? (
										<span className="text-fg-muted text-xs px-2 py-0.5 bg-elevated rounded-md">
											{t("settings.defaultBadge")}
										</span>
									) : null}
								</div>

								{isExpanded ? (
									<div className="border-t border-edge px-4 py-4 space-y-4">
										{availability ? (
											<div
												className={`p-3 rounded-lg ${
													availability.installed
														? "bg-success/5 border border-success/20"
														: "bg-danger/5 border border-danger/20"
												}`}
											>
												{availability.installed ? (
													<div className="flex items-center gap-2">
														<span className="text-success text-sm">
															&#10003;
														</span>
														<span className="text-fg-2 text-xs">
															{t("settings.agentInstalled")}
														</span>
														{availability.resolvedPath ? (
															<span className="text-fg-muted text-xs font-mono truncate">
																{availability.resolvedPath}
															</span>
														) : null}
													</div>
												) : (
													<div className="space-y-2">
														<div className="flex items-center gap-2">
															<span className="text-danger text-sm">
																&#10007;
															</span>
															<span className="text-fg-2 text-xs">
																{t("settings.agentNotInstalledHint")}
															</span>
														</div>
														{availability.installCommand ? (
															<div>
																<p className="text-fg-3 text-xs mb-1">
																	{t("settings.agentInstallHint")}
																</p>
																<div className="flex items-center gap-1.5">
																	<code className="text-warning bg-warning/10 px-2 py-1 rounded text-xs font-mono">
																		{availability.installCommand}
																	</code>
																	<button
																		type="button"
																		onClick={(event) => {
																			event.stopPropagation();
																			navigator.clipboard.writeText(
																				availability.installCommand!,
																			);
																			setAgentCopiedId(agent.id);
																			setTimeout(() => {
																				setAgentCopiedId((current) =>
																					current === agent.id ? null : current,
																				);
																			}, 2000);
																		}}
																		className="p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg shrink-0"
																		title="Copy"
																	>
																		{agentCopiedId === agent.id ? (
																			<svg
																				width="14"
																				height="14"
																				viewBox="0 0 24 24"
																				fill="none"
																				stroke="currentColor"
																				strokeWidth="2"
																				strokeLinecap="round"
																				strokeLinejoin="round"
																			>
																				<polyline points="20 6 9 17 4 12" />
																			</svg>
																		) : (
																			<svg
																				width="14"
																				height="14"
																				viewBox="0 0 24 24"
																				fill="none"
																				stroke="currentColor"
																				strokeWidth="2"
																				strokeLinecap="round"
																				strokeLinejoin="round"
																			>
																				<rect
																					x="9"
																					y="9"
																					width="13"
																					height="13"
																					rx="2"
																					ry="2"
																				/>
																				<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
																			</svg>
																		)}
																	</button>
																</div>
															</div>
														) : null}
														<p className="text-fg-muted text-xs">
															{t("settings.agentLoginReminder")}
														</p>
														<div className="pt-2 border-t border-edge/50">
															<p className="text-fg-3 text-xs mb-1.5">
																{t("settings.agentCustomPath")}
															</p>
															{availability.customPathError ? (
																<p className="text-danger text-xs mb-1.5">
																	{t("settings.agentPathNotFound")}
																</p>
															) : null}
															<div className="flex items-center gap-1.5">
																<input
																	type="text"
																	value={agentCustomPaths[agent.id] ?? ""}
																	onChange={(event) =>
																		setAgentCustomPaths((current) => ({
																			...current,
																			[agent.id]: event.target.value,
																		}))
																	}
																	onClick={(event) => event.stopPropagation()}
																	placeholder={`/path/to/${agent.baseCommand}`}
																	className={`flex-1 bg-base border rounded px-2 py-1 text-xs font-mono text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none ${
																		availability.customPathError
																			? "border-danger"
																			: "border-edge"
																	}`}
																/>
																<button
																	type="button"
																	onClick={async (event) => {
																		event.stopPropagation();
																		const path =
																			agentCustomPaths[agent.id]?.trim();
																		if (!path) return;
																		setAgentSavingId(agent.id);
																		try {
																			await api.request.setAgentBinaryPath({
																				agentId: agent.id,
																				path,
																			});
																			loadAgentAvailability();
																		} catch (error) {
																			console.error(
																				"Failed to save agent binary path:",
																				error,
																			);
																		}
																		setAgentSavingId(null);
																	}}
																	disabled={
																		!agentCustomPaths[agent.id]?.trim() ||
																		agentSavingId === agent.id
																	}
																	className="px-2.5 py-1 rounded bg-accent text-white text-xs font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors shrink-0"
																>
																	{t("requirements.setPath")}
																</button>
															</div>
														</div>
													</div>
												)}
											</div>
										) : null}

										<div>
											<label className="block text-fg-2 text-xs mb-1">
												{t("settings.agentName")}
											</label>
											<input
												type="text"
												value={agent.name}
												onChange={(event) =>
													updateAgent(agent.id, {
														name: event.target.value,
													})
												}
												className="w-full px-3 py-2 bg-elevated border border-edge rounded-lg text-fg text-sm outline-none focus:border-accent/40 transition-colors"
											/>
										</div>

										<div>
											<label className="block text-fg-2 text-xs mb-1">
												{t("settings.agentBaseCommand")}
											</label>
											<input
												type="text"
												value={agent.baseCommand}
												onChange={(event) =>
													updateAgent(agent.id, {
														baseCommand: event.target.value,
													})
												}
												placeholder="claude"
												autoCapitalize="off"
												autoCorrect="off"
												spellCheck={false}
												className="w-full px-3 py-2 bg-elevated border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
											/>
										</div>

										<ProviderSelector
											t={t}
											baseCommand={agent.baseCommand}
											provider={agent.llmProvider ?? "anthropic"}
											providerConfig={agent.providerConfig}
											models={modelsForAgent(agent)}
											onChange={(patch) => updateAgent(agent.id, patch)}
										/>

										<div>
											<label className="block text-fg-2 text-xs font-semibold mb-2">
												{t("settings.configurations")}
											</label>
											<div className="space-y-2">
												{agent.configurations.map((config, configIndex) => {
													const isConfigExpanded =
														expandedConfigId === config.id;
													const isConfigDragged =
														draggedConfig?.agentId === agent.id &&
														draggedConfig?.configId === config.id;
													const showConfigDropBefore =
														configDropTarget?.agentId === agent.id &&
														configDropTarget?.configId === config.id &&
														configDropTarget.side === "before";
													const showConfigDropAfter =
														configDropTarget?.agentId === agent.id &&
														configDropTarget?.configId === config.id &&
														configDropTarget.side === "after";
													return (
														<ConfigEditor
															key={config.id}
															config={config}
															agentBaseCommand={agent.baseCommand}
															isExpanded={isConfigExpanded}
															canDelete={agent.configurations.length > 1}
															canMoveUp={configIndex > 0}
															canMoveDown={
																configIndex <
																agent.configurations.length - 1
															}
															isDragged={isConfigDragged}
															showDropBefore={showConfigDropBefore}
															showDropAfter={showConfigDropAfter}
															onDragStart={(event) => {
																setDraggedConfig({
																	agentId: agent.id,
																	configId: config.id,
																});
																event.dataTransfer.setData(
																	"text/plain",
																	`config:${config.id}`,
																);
																event.dataTransfer.effectAllowed = "move";
															}}
															onDragEnd={() => {
																setDraggedConfig(null);
																setConfigDropTarget(null);
															}}
															onDragOver={(event) =>
																handleConfigDragOver(
																	event,
																	agent.id,
																	config.id,
																)
															}
															onDragLeave={(event) => {
																if (!event.currentTarget.contains(event.relatedTarget as Node)) {
																	setConfigDropTarget((current) =>
																		current?.agentId === agent.id &&
																		current?.configId === config.id
																			? null
																			: current,
																	);
																}
															}}
															onDrop={(event) => {
																event.preventDefault();
																event.stopPropagation();
																handleConfigDrop(agent.id, config.id);
															}}
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
															onMoveUp={() =>
																moveConfig(agent.id, config.id, -1)
															}
															onMoveDown={() =>
																moveConfig(agent.id, config.id, 1)
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
								) : null}
							</div>
						);
					})}
				</div>

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
		</SettingsSection>
	);
}

function ConfigPreviewCard({
	config,
	agentBaseCommand,
	t,
	llmProvider,
}: {
	config: AgentConfiguration;
	agentBaseCommand: string;
	t: TFunction;
	llmProvider?: LlmProvider;
}) {
	const tags: { label: string; value: string }[] = [];
	const cmdName = (
		config.baseCommandOverride ||
		agentBaseCommand ||
		""
	).split("/").pop() ?? "";
	const isCodex = cmdName === "codex";

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

	const { command, envLine } = buildCommandPreview(agentBaseCommand, config, llmProvider);

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

function ConfigEditor({
	config,
	agentBaseCommand,
	isExpanded,
	canDelete,
	canMoveUp,
	canMoveDown,
	isDragged,
	showDropBefore,
	showDropAfter,
	onDragStart,
	onDragEnd,
	onDragOver,
	onDragLeave,
	onDrop,
	onToggle,
	onChange,
	onDelete,
	onMoveUp,
	onMoveDown,
	t,
}: {
	config: AgentConfiguration;
	agentBaseCommand: string;
	isExpanded: boolean;
	canDelete: boolean;
	canMoveUp: boolean;
	canMoveDown: boolean;
	isDragged: boolean;
	showDropBefore: boolean;
	showDropAfter: boolean;
	onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
	onDragEnd: () => void;
	onDragOver: (event: DragEvent<HTMLDivElement>) => void;
	onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
	onDrop: (event: DragEvent<HTMLDivElement>) => void;
	onToggle: () => void;
	onChange: (patch: Partial<AgentConfiguration>) => void;
	onDelete: () => void;
	onMoveUp: () => void;
	onMoveDown: () => void;
	t: TFunction;
}) {
	const preview = buildCommandPreview(agentBaseCommand, config);
	const baseCommandName = agentBaseCommand.split("/").pop() ?? agentBaseCommand;

	return (
		<div
			className={`relative bg-elevated border border-edge rounded-lg overflow-hidden transition-opacity ${isDragged ? "opacity-60" : ""}`}
			onDragOver={onDragOver}
			onDragLeave={onDragLeave}
			onDrop={onDrop}
		>
			{showDropBefore ? (
				<div className="absolute top-0 left-2 right-2 h-0.5 bg-accent rounded-full z-10" />
			) : null}
			{showDropAfter ? (
				<div className="absolute bottom-0 left-2 right-2 h-0.5 bg-accent rounded-full z-10" />
			) : null}
			<div
				role="button"
				tabIndex={0}
				onClick={onToggle}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onToggle();
					}
				}}
				className="w-full flex items-center gap-2 px-3 py-2 hover:bg-elevated-hover transition-colors text-left cursor-pointer"
			>
				<ReorderControls
					dragHandleProps={{
						draggable: true,
						onDragStart,
						onDragEnd,
					}}
					canMoveUp={canMoveUp}
					canMoveDown={canMoveDown}
					onMoveUp={onMoveUp}
					onMoveDown={onMoveDown}
					dragTitle={t("settings.dragConfig")}
					upTitle={t("settings.moveConfigUp")}
					downTitle={t("settings.moveConfigDown")}
				/>
				<span className="text-fg-3 text-xs">{isExpanded ? "▼" : "▶"}</span>
				<span className="text-fg text-sm flex-1">{config.name}</span>
				{config.model ? (
					<span className="text-accent text-xs font-mono px-1.5 py-0.5 bg-accent/10 rounded">
						{config.model}
					</span>
				) : null}
			</div>

			{isExpanded ? (
				<div className="border-t border-edge px-3 py-3 space-y-3">
					<div>
						<label className="block text-fg-2 text-xs font-semibold mb-1.5">
							{t("settings.commandPreview")}
						</label>
						<CommandPreview
							command={preview.command}
							envLine={preview.envLine}
						/>
					</div>

					<div>
						<label className="block text-fg-2 text-xs mb-1">
							{t("settings.configName")}
						</label>
						<input
							type="text"
							value={config.name}
							onChange={(event) => onChange({ name: event.target.value })}
							className="w-full px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm outline-none focus:border-accent/40 transition-colors"
						/>
					</div>

					<div>
						<label className="block text-fg-2 text-xs mb-1">
							{t("settings.configModel")}
						</label>
						<input
							type="text"
							value={config.model || ""}
							onChange={(event) =>
								onChange({ model: event.target.value || undefined })
							}
							placeholder={
								baseCommandName === "codex"
									? "gpt-5.5, o3, etc."
									: baseCommandName === "gemini"
										? "gemini-2.5-pro, etc."
										: "opus, sonnet, etc."
							}
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
							className="w-full px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
						/>
					</div>

					<div>
						<label className="block text-fg-2 text-xs mb-1">
							{t("settings.configPermissionMode")}
						</label>
						<select
							value={config.permissionMode || "default"}
							onChange={(event) =>
								onChange({
									permissionMode:
										(event.target.value as PermissionMode) === "default"
											? undefined
											: (event.target.value as PermissionMode),
								})
							}
							className="w-full px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm outline-none focus:border-accent/40 transition-colors appearance-none cursor-pointer"
						>
							<option value="default">{t("settings.permDefault")}</option>
							<option value="plan">{t("settings.permPlan")}</option>
							<option value="auto">{t("settings.permAuto")}</option>
							<option value="acceptEdits">
								{t("settings.permAcceptEdits")}
							</option>
							<option value="dontAsk">{t("settings.permDontAsk")}</option>
							<option value="bypassPermissions">
								{t("settings.permBypass")}
							</option>
						</select>
					</div>

					<div>
						<label className="block text-fg-2 text-xs mb-1">
							{t("settings.configEffort")}
						</label>
						<select
							value={config.effort || ""}
							onChange={(event) =>
								onChange({
									effort: (event.target.value as EffortLevel) || undefined,
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

					<div>
						<label className="block text-fg-2 text-xs mb-1">
							{t("settings.configMaxBudget")}
						</label>
						<input
							type="number"
							min={0}
							step={0.5}
							value={config.maxBudgetUsd ?? ""}
							onChange={(event) =>
								onChange({
									maxBudgetUsd: event.target.value
										? Number(event.target.value)
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

					<div>
						<label className="block text-fg-2 text-xs mb-1">
							{t("settings.configAppendPrompt")}
						</label>
						<textarea
							value={config.appendPrompt || ""}
							onChange={(event) =>
								onChange({ appendPrompt: event.target.value || undefined })
							}
							rows={3}
							className="w-full px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
						/>
						<p className="text-fg-muted text-xs mt-1">
							{t("settings.configAppendPromptHint")}
						</p>
					</div>

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

					<div>
						<label className="block text-fg-2 text-xs mb-1">
							{t("settings.configBaseCommandOverride")}
						</label>
						<input
							type="text"
							value={config.baseCommandOverride || ""}
							onChange={(event) =>
								onChange({
									baseCommandOverride:
										event.target.value || undefined,
								})
							}
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
							className="w-full px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
						/>
					</div>

					{canDelete ? (
						<button
							onClick={onDelete}
							className="text-danger text-xs hover:underline"
						>
							{t("settings.deleteConfig")}
						</button>
					) : null}
				</div>
			) : null}
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
 * Claude). Selecting a third-party provider injects its enable flag + the mapped
 * model into the agent's launches and drops dev3's --model alias.
 * Credentials/region are NOT set here — the customer owns those in their own
 * agent config. Renders nothing for agents with no registered backend; provider
 * fields appear only for the selected provider, driven by its registry entry.
 */
function ProviderSelector({
	t,
	baseCommand,
	provider,
	providerConfig,
	models,
	onChange,
}: {
	t: TFunction;
	baseCommand: string;
	provider: LlmProvider;
	providerConfig: ProviderConfig | undefined;
	models: string[];
	onChange: (patch: Partial<CodingAgent>) => void;
}) {
	const options = providersForAgent(baseCommand);
	const setProvider = (next: LlmProvider) => onChange({ llmProvider: next });

	const activeDef = getProviderDefinition(provider);
	const settings = activeDef ? providerConfig?.[activeDef.id] : undefined;
	const geo = settings?.geo ?? DEFAULT_BEDROCK_GEO;

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
			<label className="block text-fg-2 text-xs font-semibold mb-1">
				{t("settings.llmProvider")}
			</label>
			<p className="text-fg-3 text-xs mb-2">{t("settings.llmProviderDesc")}</p>

			<div className="inline-flex rounded-xl border border-edge bg-base p-1 gap-1">
				{options.map((opt) => {
					const active = provider === opt.id;
					return (
						<button
							key={opt.id}
							type="button"
							onClick={() => setProvider(opt.id)}
							className={`px-4 py-2 rounded-lg text-sm transition-colors ${
								active
									? "bg-accent text-white"
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
												active ? "bg-accent text-white" : "text-fg-2 hover:bg-elevated"
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
									<span className="text-accent text-[10px] uppercase tracking-wide shrink-0">
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
								<span className="text-fg-muted text-[10px] uppercase tracking-wide shrink-0">
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
