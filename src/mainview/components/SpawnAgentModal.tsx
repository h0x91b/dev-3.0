import { useState, useEffect } from "react";
import type { AgentCheckResult, CodingAgent, GlobalSettings, Project, Task } from "../../shared/types";
import { api } from "../rpc";
import { useT } from "../i18n";
import { trackEvent } from "../analytics";
import Select from "./Select";

interface SpawnAgentModalProps {
	task: Task;
	project: Project;
	onClose: () => void;
}

function SpawnAgentModal({ task, project, onClose }: SpawnAgentModalProps) {
	const t = useT();
	const [agents, setAgents] = useState<CodingAgent[]>([]);
	const [globalSettings, setGlobalSettings] = useState<GlobalSettings | null>(null);
	const [agentId, setAgentId] = useState<string | null>(null);
	const [configId, setConfigId] = useState<string | null>(null);
	const [spawning, setSpawning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [agentAvailability, setAgentAvailability] = useState<AgentCheckResult[]>([]);

	useEffect(() => {
		api.request.checkAgentAvailability().then(setAgentAvailability).catch(() => {});
		Promise.all([
			api.request.getAgents(),
			api.request.getGlobalSettings(),
		]).then(([a, gs]) => {
			setAgents(a);
			setGlobalSettings(gs);

			// Set defaults
			let defaultAgentId: string | null = gs.defaultAgentId ?? null;
			let agent = defaultAgentId ? a.find((ag) => ag.id === defaultAgentId) : null;
			if (!agent && a.length > 0) {
				agent = a[0];
				defaultAgentId = agent.id;
			}
			setAgentId(defaultAgentId);
			// Only use gs.defaultConfigId if it belongs to the resolved agent
			const globalConfig = gs.defaultConfigId && agent?.configurations.some((c) => c.id === gs.defaultConfigId)
				? gs.defaultConfigId
				: null;
			setConfigId(
				globalConfig ??
				agent?.defaultConfigId ??
				agent?.configurations[0]?.id ??
				null,
			);
		}).catch(() => {});
	}, []);

	useEffect(() => {
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				onClose();
			} else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
				const tag = (document.activeElement as HTMLElement | null)?.tagName;
				if (tag === "INPUT" || tag === "TEXTAREA") return;
				if (!spawning && globalSettings) handleSpawn();
			}
		}
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onClose, spawning, globalSettings, agentId, configId]);

	function handleAgentChange(newAgentId: string | null) {
		setAgentId(newAgentId);
		const agent = agents.find((a) => a.id === newAgentId);
		setConfigId(agent?.defaultConfigId ?? agent?.configurations[0]?.id ?? null);
	}

	async function handleSpawn() {
		setSpawning(true);
		setError(null);
		try {
			await api.request.spawnAgentInTask({
				taskId: task.id,
				projectId: project.id,
				agentId,
				configId,
			});
			trackEvent("spawn_extra_agent", { project_id: project.id, agent_id: agentId ?? "default" });
			onClose();
		} catch (err) {
			setError(String(err));
		}
		setSpawning(false);
	}

	const selectedAgent = agents.find((a) => a.id === agentId);
	const configs = selectedAgent?.configurations ?? [];
	const selectedAvailability = agentAvailability.find((a) => a.agentId === agentId);
	const agentNotInstalled = selectedAvailability ? !selectedAvailability.installed : false;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onClick={onClose}
		>
			<div
				className="bg-overlay rounded-2xl shadow-2xl shadow-black/50 border border-edge-active w-full max-w-md mx-4 overflow-hidden"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div className="px-6 py-4 border-b border-edge">
					<h2 className="text-fg text-lg font-semibold">{t("spawnAgent.title")}</h2>
				</div>

				{/* Content */}
				{globalSettings ? (
					<div className="px-6 py-4 space-y-3">
						<div>
							<label htmlFor="spawn-agent" className="text-xs text-fg-3 block mb-1">
								{t("launch.agent")}
							</label>
							<Select
								id="spawn-agent"
								value={agentId ?? ""}
								options={agents.map((a) => ({ value: a.id, label: a.name }))}
								onChange={(val) => handleAgentChange(val || null)}
								renderOption={(opt) => {
									const avail = agentAvailability.find((a) => a.agentId === opt.value);
									const notInstalled = avail && !avail.installed;
									return (
										<span className="flex items-center gap-2">
											{opt.label}
											{notInstalled && (
												<span className="text-danger text-[0.65rem] font-medium opacity-80">
													Not Installed
												</span>
											)}
										</span>
									);
								}}
							/>
						</div>
						<div>
							<label htmlFor="spawn-config" className="text-xs text-fg-3 block mb-1">
								{t("launch.config")}
							</label>
							<Select
								id="spawn-config"
								value={configId ?? ""}
								options={configs.map((c) => ({ value: c.id, label: c.name }))}
								onChange={(val) => setConfigId(val || null)}
							/>
						</div>

						{/* Warning for uninstalled agents */}
						{agentNotInstalled && selectedAgent && (
							<div className="p-3 rounded-lg bg-yellow-400/10 border border-yellow-400/20">
								<p className="text-yellow-400 text-xs font-medium mb-1">
									{t("spawnAgent.notInstalled", { name: selectedAgent.name })}
								</p>
								{selectedAvailability?.installCommand && (
									<code className="text-yellow-400/80 bg-yellow-400/5 px-2 py-0.5 rounded text-xs font-mono">
										{selectedAvailability.installCommand}
									</code>
								)}
							</div>
						)}
					</div>
				) : (
					<div className="px-6 py-8 flex items-center justify-center">
						<div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
					</div>
				)}

				{/* Error */}
				{error && (
					<div className="px-6 py-2 text-danger text-sm">
						{t("spawnAgent.failed", { error })}
					</div>
				)}

				{/* Footer */}
				<div className="px-6 py-4 border-t border-edge flex items-center justify-end gap-3">
					<button
						onClick={onClose}
						className="text-fg-3 hover:text-fg text-sm transition-colors px-3 py-1.5"
						disabled={spawning}
					>
						{t("kanban.cancel")}
					</button>
					<button
						onClick={handleSpawn}
						disabled={spawning || !globalSettings || agentNotInstalled}
						className="bg-accent hover:bg-accent-hover text-white text-sm font-medium px-5 py-2 rounded-xl transition-colors disabled:opacity-50"
					>
						{spawning ? t("spawnAgent.spawning") : t("spawnAgent.spawn")}
					</button>
				</div>
			</div>
		</div>
	);
}

export default SpawnAgentModal;
