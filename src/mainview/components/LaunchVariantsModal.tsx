import { useState, useEffect, type Dispatch } from "react";
import type { CodingAgent, Project, Task, TaskStatus } from "../../shared/types";
import type { AppAction } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";

interface VariantRow {
	agentId: string | null;
	configId: string | null;
}

interface LaunchVariantsModalProps {
	task: Task;
	project: Project;
	targetStatus: TaskStatus;
	dispatch: Dispatch<AppAction>;
	onClose: () => void;
}

function LaunchVariantsModal({
	task,
	project,
	targetStatus,
	dispatch,
	onClose,
}: LaunchVariantsModalProps) {
	const t = useT();
	const [agents, setAgents] = useState<CodingAgent[]>([]);
	const [variants, setVariants] = useState<VariantRow[]>([
		{ agentId: project.defaultAgentId, configId: project.defaultConfigId },
	]);
	const [launching, setLaunching] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		api.request.getAgents().then(setAgents).catch(() => {});
	}, []);

	function addVariant() {
		setVariants((prev) => [
			...prev,
			{ agentId: project.defaultAgentId, configId: project.defaultConfigId },
		]);
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
			const resultTasks = await api.request.spawnVariants({
				taskId: task.id,
				projectId: project.id,
				targetStatus,
				variants,
			});
			dispatch({ type: "spawnVariants", sourceTaskId: task.id, variants: resultTasks });
			onClose();
		} catch (err) {
			setError(String(err));
		}
		setLaunching(false);
	}

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
					<h2 className="text-fg text-lg font-semibold">{t("launch.title")}</h2>
					<p className="text-fg-3 text-sm mt-1 truncate">{task.title}</p>
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
									<label className="text-xs text-fg-3 block mb-1">
										{t("launch.agent")}
									</label>
									<select
										value={variant.agentId ?? ""}
										onChange={(e) =>
											handleAgentChange(
												index,
												e.target.value || null,
											)
										}
										className="w-full bg-elevated text-fg text-sm rounded-lg px-2.5 py-1.5 border border-edge focus:border-accent outline-none"
									>
										{agents.map((agent) => (
											<option key={agent.id} value={agent.id}>
												{agent.name}
											</option>
										))}
									</select>
								</div>

								{/* Config select */}
								<div className="flex-1 min-w-0">
									<label className="text-xs text-fg-3 block mb-1">
										{t("launch.config")}
									</label>
									<select
										value={variant.configId ?? ""}
										onChange={(e) =>
											updateVariant(index, {
												configId: e.target.value || null,
											})
										}
										className="w-full bg-elevated text-fg text-sm rounded-lg px-2.5 py-1.5 border border-edge focus:border-accent outline-none"
									>
										{configs.map((config) => (
											<option key={config.id} value={config.id}>
												{config.name}
											</option>
										))}
									</select>
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
							{launching ? t("launch.launching") : t("launch.launch")}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

export default LaunchVariantsModal;
