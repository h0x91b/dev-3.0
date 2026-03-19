import { useState, useEffect, type Dispatch } from "react";
import type { AgentCheckResult, CodingAgent, GlobalSettings, Project, Task, TaskStatus } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import type { AppAction } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { trackEvent } from "../analytics";
import Select, { useAgentRenderOption } from "./Select";

interface VariantRow {
	agentId: string | null;
	configId: string | null;
}

type LaunchMode = "spawn" | "addAttempts";

interface LaunchVariantsModalProps {
	task: Task;
	project: Project;
	targetStatus: TaskStatus;
	agents: CodingAgent[];
	globalSettings: GlobalSettings;
	dispatch: Dispatch<AppAction>;
	onClose: () => void;
	mode?: LaunchMode;
}

function LaunchVariantsModal({
	task,
	project,
	targetStatus,
	agents,
	globalSettings,
	dispatch,
	onClose,
	mode = "spawn",
}: LaunchVariantsModalProps) {
	const t = useT();

	function makeDefaultVariant(): VariantRow {
		// Try global default agent, fall back to first available
		let agentId: string | null = globalSettings.defaultAgentId ?? null;
		let agent = agentId ? agents.find((a) => a.id === agentId) : null;

		// If agent not found (null, undefined, or removed), use first available
		if (!agent && agents.length > 0) {
			agent = agents[0];
			agentId = agent.id;
		}

		const configId =
			globalSettings.defaultConfigId ??
			agent?.defaultConfigId ??
			agent?.configurations[0]?.id ??
			null;
		return { agentId, configId };
	}

	const [variants, setVariants] = useState<VariantRow[]>(() => [makeDefaultVariant()]);
	const [launching, setLaunching] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [agentAvailability, setAgentAvailability] = useState<AgentCheckResult[]>([]);

	useEffect(() => {
		api.request.checkAgentAvailability().then(setAgentAvailability).catch(() => {});
	}, []);

	const renderAgentOption = useAgentRenderOption(agentAvailability, t("settings.agentNotInstalled"));

	// Escape → close; Enter → launch (when no text input is focused)
	useEffect(() => {
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				onClose();
			} else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
				const tag = (document.activeElement as HTMLElement | null)?.tagName;
				if (tag === "INPUT" || tag === "TEXTAREA") return;
				if (!launching && variants.length > 0) handleLaunch();
			}
		}
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onClose, launching, variants]);

	function addVariant() {
		setVariants((prev) => [...prev, makeDefaultVariant()]);
	}

	function removeVariant(index: number) {
		setVariants((prev) => prev.filter((_, i) => i !== index));
	}

	function updateVariant(index: number, updates: Partial<VariantRow>) {
		setVariants((prev) =>
			prev.map((v, i) => (i === index ? { ...v, ...updates } : v)),
		);
	}

	function handleAgentChange(index: number, agentId: string | null) {
		// When agent changes, reset config to that agent's default
		const agent = agents.find((a) => a.id === agentId);
		const configId = agent?.defaultConfigId ?? agent?.configurations[0]?.id ?? null;
		updateVariant(index, { agentId, configId });
	}

	async function handleLaunch() {
		setLaunching(true);
		setError(null);
		try {
			if (mode === "addAttempts") {
				const result = await api.request.addAttempts({
					taskId: task.id,
					projectId: project.id,
					variants,
				});
				// First element is the updated source task, rest are new attempts
				const [updatedSource, ...newAttempts] = result;
				dispatch({ type: "addAttempts", sourceTaskId: task.id, newAttempts, updatedSource });
				trackEvent("task_add_attempts", { project_id: project.id, attempt_count: newAttempts.length });
			} else {
				const resultTasks = await api.request.spawnVariants({
					taskId: task.id,
					projectId: project.id,
					targetStatus,
					variants,
				});
				dispatch({ type: "spawnVariants", sourceTaskId: task.id, variants: resultTasks });
				trackEvent("task_spawned", { project_id: project.id, variant_count: resultTasks.length });
			}
			onClose();
		} catch (err) {
			setError(String(err));
		}
		setLaunching(false);
	}

	const isAddVariant = mode === "addAttempts";
	const title = isAddVariant ? t("launch.retryTitle") : t("launch.title");
	const launchLabel = isAddVariant
		? (launching ? t("launch.launching") : t("launch.launchVariant"))
		: (launching ? t("launch.launching") : t("launch.launch"));

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onClick={onClose}
		>
			<div
				className="bg-overlay rounded-2xl shadow-2xl shadow-black/50 border border-edge-active w-full max-w-lg mx-4 overflow-hidden"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div className="px-6 py-4 border-b border-edge">
					<div className="flex items-center justify-between gap-3">
						<div className="min-w-0">
							<h2 className="text-fg text-lg font-semibold">{title}</h2>
							<p className="text-fg-3 text-sm mt-1 truncate">{getTaskTitle(task)}</p>
						</div>
						<button
							onClick={async () => {
								try {
									const updated = await api.request.toggleTaskWatch({
										taskId: task.id,
										projectId: project.id,
										watched: !task.watched,
									});
									dispatch({ type: "updateTask", task: updated });
								} catch {
									// Toggle failed silently — secondary action
								}
							}}
							className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors flex-shrink-0 ${
								task.watched
									? "text-accent bg-accent/10 border border-accent/25"
									: "text-fg-3 hover:text-fg hover:bg-elevated border border-edge"
							}`}
							title={task.watched ? t("task.unwatchTooltip") : t("task.watchTooltip")}
						>
							<span className="text-[0.875rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
								{task.watched ? "\u{F009A}" : "\u{F0F1C}"}
							</span>
							<span className="text-xs font-medium">
								{task.watched ? t("task.watching") : t("task.watch")}
							</span>
						</button>
					</div>
				</div>

				{/* Variant rows */}
				<div className="px-6 py-4 space-y-3 max-h-[50vh] overflow-y-auto">
					{variants.map((variant, index) => {
						const selectedAgent = agents.find((a) => a.id === variant.agentId);
						const configs = selectedAgent?.configurations ?? [];

						return (
							<div
								key={index}
								className="flex items-center gap-3 p-3 bg-raised rounded-xl border border-edge"
							>
								{/* Variant number */}
								<span className="text-accent font-bold text-sm w-7 flex-shrink-0">
									#{index + 1}
								</span>

								{/* Agent select */}
								<div className="flex-1 min-w-0">
									<label htmlFor={`variant-agent-${index}`} className="text-xs text-fg-3 block mb-1">
										{t("launch.agent")}
									</label>
									<Select
										id={`variant-agent-${index}`}
										value={variant.agentId ?? ""}
										options={agents.map((a) => ({ value: a.id, label: a.name }))}
										onChange={(val) => handleAgentChange(index, val || null)}
										renderOption={renderAgentOption}
									/>
								</div>

								{/* Config select */}
								<div className="flex-1 min-w-0">
									<label htmlFor={`variant-config-${index}`} className="text-xs text-fg-3 block mb-1">
										{t("launch.config")}
									</label>
									<Select
										id={`variant-config-${index}`}
										value={variant.configId ?? ""}
										options={configs.map((c) => ({ value: c.id, label: c.name }))}
										onChange={(val) => updateVariant(index, { configId: val || null })}
									/>
								</div>

								{/* Remove button */}
								{variants.length > 1 && (
									<button
										onClick={() => removeVariant(index)}
										className="text-fg-muted hover:text-danger transition-colors p-1 mt-4 flex-shrink-0"
										title={t("launch.removeVariant")}
									>
										<svg
											className="w-4 h-4"
											fill="none"
											stroke="currentColor"
											viewBox="0 0 24 24"
										>
											<path
												strokeLinecap="round"
												strokeLinejoin="round"
												strokeWidth={2}
												d="M6 18L18 6M6 6l12 12"
											/>
										</svg>
									</button>
								)}
							</div>
						);
					})}
				</div>

				{/* Error */}
				{error && (
					<div className="px-6 py-2 text-danger text-sm">
						{t("launch.failedLaunch", { error })}
					</div>
				)}

				{/* Footer */}
				<div className="px-6 py-4 border-t border-edge flex items-center justify-between">
					<button
						onClick={addVariant}
						className="text-accent hover:text-accent-hover text-sm font-medium transition-colors"
					>
						{t("launch.addVariant")}
					</button>

					<div className="flex items-center gap-3">
						<button
							onClick={onClose}
							className="text-fg-3 hover:text-fg text-sm transition-colors px-3 py-1.5"
							disabled={launching}
						>
							{t("kanban.cancel")}
						</button>
						<button
							onClick={handleLaunch}
							disabled={launching || variants.length === 0}
							className="bg-accent hover:bg-accent-hover text-white text-sm font-medium px-5 py-2 rounded-xl transition-colors disabled:opacity-50"
						>
							{launchLabel}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

export default LaunchVariantsModal;
