import { useState, useEffect, useRef } from "react";
import type { AgentCheckResult, CodingAgent, GlobalSettings, Project, Task } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import { launchFailureHintKey } from "../../shared/launch-failure";
import { api } from "../rpc";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useToggleFavorite } from "../hooks/useToggleFavorite";
import { useT } from "../i18n";
import HelpSpot from "./HelpSpot";
import { trackAgentLaunched, trackEvent } from "../analytics";
import AgentConfigPicker from "./AgentConfigPicker";
import AgentPickerSkeleton from "./AgentPickerSkeleton";
import MemoryPressureBanner from "./MemoryPressureBanner";
import { useFocusTrap } from "../utils/useFocusTrap";
import { requestTaskTerminalFocus } from "../terminal-focus-request";
import { useReducedMotion } from "../utils/useReducedMotion";

const NOT_INSTALLED_ID = "spawn-agent-not-installed";

interface SpawnAgentModalProps {
	task: Task;
	project: Project;
	onClose: () => void;
}

function SpawnAgentModal({ task, project, onClose }: SpawnAgentModalProps) {
	const t = useT();
	// A spawned agent owns the keyboard from here on, so the trap must not pull
	// focus back to the "+ Agent" button — that is the extra click this removes.
	const spawnedRef = useRef(false);
	const trapRef = useFocusTrap<HTMLDivElement>({ shouldRestoreFocus: () => !spawnedRef.current });
	const reducedMotion = useReducedMotion();
	const errorRef = useRef<HTMLDivElement>(null);
	const [agents, setAgents] = useState<CodingAgent[]>([]);
	const [globalSettings, setGlobalSettings] = useState<GlobalSettings | null>(null);
	const [agentId, setAgentId] = useState<string | null>(null);
	const [configId, setConfigId] = useState<string | null>(null);
	// Per-launch account (undefined → the registry default preselect).
	const [accountId, setAccountId] = useState<string | null | undefined>(undefined);
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

	const handleToggleFavorite = useToggleFavorite(setGlobalSettings);

	// A failed spawn is otherwise silent for screen readers: role="alert" announces
	// it, and focus lands on it so the reason is reachable without hunting.
	useEffect(() => {
		if (error) errorRef.current?.focus();
	}, [error]);

	async function handleSpawn() {
		if (agentNotInstalled) return;
		setSpawning(true);
		setError(null);
		try {
			await api.request.spawnAgentInTask({
				taskId: task.id,
				projectId: project.id,
				agentId,
				configId,
				accountId,
			});
			trackEvent("spawn_extra_agent", { project_id: project.id, agent_id: agentId ?? "default" });
			trackAgentLaunched(agents, agentId, configId);
			spawnedRef.current = true;
			// The terminal holds this until the new pane is attachable, then types
			// straight into it — the user's next keystroke is the agent's prompt.
			requestTaskTerminalFocus(task.id);
			onClose();
		} catch (err) {
			setError(String(err));
		}
		setSpawning(false);
	}

	const selectedAgent = agents.find((a) => a.id === agentId);
	const selectedAvailability = agentAvailability.find((a) => a.agentId === agentId);
	const agentNotInstalled = selectedAvailability ? !selectedAvailability.installed : false;
	// "Not ready" (missing agent / still loading) must not look like "in flight",
	// which keeps full colour and gets a spinner instead.
	const notReady = agentNotInstalled || !globalSettings;
	const pressFeedback = reducedMotion
		? "transition-colors"
		: "transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.96]";

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onClick={onClose}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="spawn-agent-title"
				tabIndex={-1}
				className="bg-overlay rounded-2xl shadow-2xl shadow-black/50 border border-edge-active w-full max-w-2xl mx-4 overflow-hidden outline-none"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div className="px-6 py-4 border-b border-edge">
					<div className="flex items-center gap-1.5">
						<h2 id="spawn-agent-title" className="text-fg text-lg font-semibold">{t("spawnAgent.title")}</h2>
						<HelpSpot topicId="modal.spawn-agent" />
					</div>
					<p className="text-fg-3 text-sm mt-1 truncate">{getTaskTitle(task)}</p>
				</div>

				{/* Memory notice — this dialog starts exactly one more agent. */}
				<div className="px-6 pt-3 empty:hidden">
					<MemoryPressureBanner launchCount={1} />
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
							accountId={accountId}
							onAccountChange={setAccountId}
							pxpipeProxyEnabled={globalSettings.pxpipeProxyEnabled ?? false}
							showFavorites
							favorites={globalSettings.favorites ?? []}
							onToggleFavorite={handleToggleFavorite}
						/>

						{/* Warning for uninstalled agents */}
						{agentNotInstalled && selectedAgent && (
							<div id={NOT_INSTALLED_ID} className="p-3 rounded-lg bg-warning/10 border border-warning/20">
								<p className="text-warning-strong text-xs font-medium mb-1">
									{t("spawnAgent.notInstalled", { name: selectedAgent.name })}
								</p>
								{selectedAvailability?.installCommand && (
									<code className="text-warning-strong bg-warning/10 px-2 py-0.5 rounded text-xs font-mono">
										{selectedAvailability.installCommand}
									</code>
								)}
							</div>
						)}
					</div>
				) : (
					<div className="px-6 py-4">
						<AgentPickerSkeleton />
					</div>
				)}

				{/* Error */}
				{error && (
					<div ref={errorRef} role="alert" tabIndex={-1} className="px-6 py-2 text-danger text-sm outline-none">
						{t("spawnAgent.failed", { error })}
						<span className="text-fg-3 block">{t(launchFailureHintKey(error))}</span>
					</div>
				)}

				{/* Footer */}
				<div className="px-6 py-4 border-t border-edge flex items-center justify-end gap-3">
					<button
						onClick={onClose}
						className={`text-fg-3 hover:text-fg text-sm px-3 py-1.5 disabled:opacity-50 ${pressFeedback}`}
						disabled={spawning}
					>
						{t("kanban.cancel")}
					</button>
					{/* Not-installed keeps the button focusable (aria-disabled) so its
					    reason is announced; only the in-flight case is natively disabled. */}
					<button
						data-testid="spawn-agent-submit"
						onClick={handleSpawn}
						disabled={spawning || !globalSettings}
						aria-disabled={agentNotInstalled || undefined}
						aria-describedby={agentNotInstalled && selectedAgent ? NOT_INSTALLED_ID : undefined}
						className={`text-sm font-medium px-5 py-2 rounded-xl inline-flex items-center gap-2 ${pressFeedback} ${
							notReady
								? "bg-elevated text-fg-muted border border-edge cursor-not-allowed"
								: "bg-accent-fill hover:bg-accent-fill-hover text-white"
						}`}
					>
						{spawning && (
							<span
								className={`h-3 w-3 rounded-full border-2 border-white/30 border-t-white${reducedMotion ? "" : " animate-spin"}`}
								aria-hidden="true"
							/>
						)}
						{spawning ? t("spawnAgent.spawning") : t("spawnAgent.spawn")}
					</button>
				</div>
			</div>
		</div>
	);
}

export default SpawnAgentModal;
