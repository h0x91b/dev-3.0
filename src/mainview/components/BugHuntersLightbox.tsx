import { useState, useEffect } from "react";
import type { AgentCheckResult, CodingAgent, GlobalSettings, Project, Task } from "../../shared/types";
import { api } from "../rpc";
import { useT } from "../i18n";
import { trackEvent } from "../analytics";
import Select, { useAgentRenderOption } from "./Select";

interface BugHuntersLightboxProps {
	task: Task;
	project: Project;
	onClose: () => void;
}

const MIN_HUNTERS = 1;
const MAX_HUNTERS = 6;
const DEFAULT_HUNTERS = 3;

function BugHuntersLightbox({ task, project, onClose }: BugHuntersLightboxProps) {
	const t = useT();
	const [agents, setAgents] = useState<CodingAgent[]>([]);
	const [globalSettings, setGlobalSettings] = useState<GlobalSettings | null>(null);
	const [agentId, setAgentId] = useState<string | null>(null);
	const [configId, setConfigId] = useState<string | null>(null);
	const [count, setCount] = useState<number>(DEFAULT_HUNTERS);
	const [launching, setLaunching] = useState(false);
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

			let defaultAgentId: string | null = gs.defaultAgentId ?? null;
			let agent = defaultAgentId ? a.find((ag) => ag.id === defaultAgentId) : null;
			if (!agent && a.length > 0) {
				agent = a[0];
				defaultAgentId = agent.id;
			}
			setAgentId(defaultAgentId);
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
				if (!launching && globalSettings) handleLaunch();
			}
		}
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onClose, launching, globalSettings, agentId, configId, count]);

	function handleAgentChange(newAgentId: string | null) {
		setAgentId(newAgentId);
		const agent = agents.find((a) => a.id === newAgentId);
		setConfigId(agent?.defaultConfigId ?? agent?.configurations[0]?.id ?? null);
	}

	async function handleLaunch() {
		setLaunching(true);
		setError(null);
		try {
			const result = await api.request.spawnBugHuntersInTask({
				taskId: task.id,
				projectId: project.id,
				agentId,
				configId,
				count,
			});
			trackEvent("bug_hunters_spawned", {
				project_id: project.id,
				agent_id: agentId ?? "default",
				count: result.spawned,
			});
			onClose();
		} catch (err) {
			setError(String(err));
		}
		setLaunching(false);
	}

	const renderAgentOption = useAgentRenderOption(agentAvailability, t("settings.agentNotInstalled"));
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
				<div className="px-6 py-4 border-b border-edge flex items-center gap-2">
					<span
						className="text-[1.25rem] leading-none text-danger"
						style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
						aria-hidden
					>
						{""}
					</span>
					<div className="min-w-0">
						<h2 className="text-fg text-lg font-semibold">{t("bugHunters.title")}</h2>
						<p className="text-fg-3 text-xs mt-0.5">{t("bugHunters.subtitle")}</p>
					</div>
				</div>

				{/* Content */}
				{globalSettings ? (
					<div className="px-6 py-4 space-y-4">
						{/* Hunter count */}
						<div>
							<div className="flex items-center justify-between mb-1.5">
								<label htmlFor="bughunt-count" className="text-xs text-fg-3">
									{t("bugHunters.countLabel")}
								</label>
								<span className="text-accent text-sm font-mono font-semibold tabular-nums">
									{count}
								</span>
							</div>
							<input
								id="bughunt-count"
								type="range"
								min={MIN_HUNTERS}
								max={MAX_HUNTERS}
								step={1}
								value={count}
								onChange={(e) => setCount(Number(e.target.value))}
								className="w-full accent-accent"
							/>
							<div className="flex justify-between mt-1 px-0.5">
								{Array.from({ length: MAX_HUNTERS - MIN_HUNTERS + 1 }, (_, i) => MIN_HUNTERS + i).map((n) => (
									<button
										key={n}
										type="button"
										onClick={() => setCount(n)}
										className={`w-6 h-6 rounded text-xs font-mono transition-colors ${
											n === count
												? "bg-accent text-white"
												: "text-fg-muted hover:text-fg hover:bg-elevated"
										}`}
									>
										{n}
									</button>
								))}
							</div>
						</div>

						{/* Agent picker */}
						<div>
							<label htmlFor="bughunt-agent" className="text-xs text-fg-3 block mb-1">
								{t("launch.agent")}
							</label>
							<Select
								id="bughunt-agent"
								value={agentId ?? ""}
								options={agents.map((a) => ({ value: a.id, label: a.name }))}
								onChange={(val) => handleAgentChange(val || null)}
								renderOption={renderAgentOption}
							/>
						</div>

						{/* Config picker */}
						<div>
							<label htmlFor="bughunt-config" className="text-xs text-fg-3 block mb-1">
								{t("launch.config")}
							</label>
							<Select
								id="bughunt-config"
								value={configId ?? ""}
								options={configs.map((c) => ({ value: c.id, label: c.name }))}
								onChange={(val) => setConfigId(val || null)}
							/>
						</div>

						{/* Info note */}
						<div className="p-3 rounded-lg bg-raised border border-edge">
							<p className="text-fg-3 text-xs leading-relaxed">
								{t("bugHunters.explainer")}
							</p>
						</div>

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
						{t("bugHunters.failed", { error })}
					</div>
				)}

				{/* Footer */}
				<div className="px-6 py-4 border-t border-edge flex items-center justify-end gap-3">
					<button
						onClick={onClose}
						className="text-fg-3 hover:text-fg text-sm transition-colors px-3 py-1.5"
						disabled={launching}
					>
						{t("kanban.cancel")}
					</button>
					<button
						onClick={handleLaunch}
						disabled={launching || !globalSettings || agentNotInstalled}
						className="bg-danger hover:bg-danger/85 text-white text-sm font-medium px-5 py-2 rounded-xl transition-colors disabled:opacity-50 flex items-center gap-2"
					>
						<span
							className="text-[0.95rem] leading-none"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							aria-hidden
						>
							{""}
						</span>
						{launching
							? t("bugHunters.launching")
							: t.plural("bugHunters.launch", count, { count })}
					</button>
				</div>
			</div>
		</div>
	);
}

export default BugHuntersLightbox;
