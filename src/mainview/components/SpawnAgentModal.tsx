import { useState, useEffect } from "react";
import type { AgentCheckResult, CodingAgent, GlobalSettings, Project, Task } from "../../shared/types";
import { api } from "../rpc";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useT } from "../i18n";
import { trackAgentLaunched, trackEvent } from "../analytics";
import AgentConfigPicker from "./AgentConfigPicker";
import { useFocusTrap } from "../utils/useFocusTrap";

interface SpawnAgentModalProps {
	task: Task;
	project: Project;
	onClose: () => void;
}

function SpawnAgentModal({ task, project, onClose }: SpawnAgentModalProps) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
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

	useEscapeKey(onClose);
	useEffect(() => {
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
				// Only an "implicit" Enter (nothing interactive focused) should spawn.
				// The agent/config pickers render as <button> (Select.tsx), so a
				// keyboard user tab-focusing one and pressing Enter must open that
				// control, not spawn an agent.
				const el = document.activeElement as HTMLElement | null;
				const tag = el?.tagName;
				if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON" || tag === "SELECT" || tag === "A" || el?.isContentEditable) return;
				if (!spawning && globalSettings) handleSpawn();
			}
		}
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [spawning, globalSettings, agentId, configId]);

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
			trackAgentLaunched(agents, agentId, configId);
			onClose();
		} catch (err) {
			setError(String(err));
		}
		setSpawning(false);
	}

	const selectedAgent = agents.find((a) => a.id === agentId);
	const selectedAvailability = agentAvailability.find((a) => a.agentId === agentId);
	const agentNotInstalled = selectedAvailability ? !selectedAvailability.installed : false;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onClick={onClose}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				tabIndex={-1}
				className="bg-overlay rounded-2xl shadow-2xl shadow-black/50 border border-edge-active w-full max-w-xl mx-4 overflow-hidden outline-none"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div className="px-6 py-4 border-b border-edge">
					<h2 className="text-fg text-lg font-semibold">{t("spawnAgent.title")}</h2>
				</div>

				{/* Content */}
				{globalSettings ? (
					<div className="px-6 py-4 space-y-3">
						<AgentConfigPicker
							idPrefix="spawn"
							agents={agents}
							agentId={agentId}
							configId={configId}
							agentAvailability={agentAvailability}
							onChange={(next) => {
								setAgentId(next.agentId);
								setConfigId(next.configId);
							}}
						/>

						{/* Warning for uninstalled agents */}
						{agentNotInstalled && selectedAgent && (
							<div className="p-3 rounded-lg bg-warning/10 border border-warning/20">
								<p className="text-warning text-xs font-medium mb-1">
									{t("spawnAgent.notInstalled", { name: selectedAgent.name })}
								</p>
								{selectedAvailability?.installCommand && (
									<code className="text-warning/80 bg-warning/5 px-2 py-0.5 rounded text-xs font-mono">
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
