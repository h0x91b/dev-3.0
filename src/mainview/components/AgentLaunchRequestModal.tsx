import { useEffect, useState } from "react";
import type { AgentCheckResult, AgentLaunchRequest, CodingAgent, GlobalSettings } from "../../shared/types";
import { api } from "../rpc";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useToggleFavorite } from "../hooks/useToggleFavorite";
import { useT } from "../i18n";
import { useFocusTrap } from "../utils/useFocusTrap";
import AgentConfigPicker from "./AgentConfigPicker";
import TaskDialogSubjectCard from "./TaskDialogSubjectCard";

interface AgentLaunchRequestModalProps {
	request: AgentLaunchRequest;
	/** Answers the blocked CLI. `launch` is only set when approved. */
	onRespond: (approved: boolean, launch?: { agentId: string | null; configId: string | null; accountId?: string | null }) => void;
}

/**
 * An agent asked to set another task running. Identity treatment matches every
 * other agent-initiated dialog (accent border, AI badge, Decline autofocused),
 * but the accepting button stays `primary`: a launch creates state and is
 * reversible, unlike the completion request that destroys a worktree
 * (UX_DECISIONS 2026-07-31, bible §6 `agent_request`).
 *
 * Unlike the completion dialog this cannot be a `confirm()` call — the answer
 * carries the agent/config/account the user picked, not just yes/no.
 */
function AgentLaunchRequestModal({ request, onRespond }: AgentLaunchRequestModalProps) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	const [agents, setAgents] = useState<CodingAgent[]>([]);
	const [globalSettings, setGlobalSettings] = useState<GlobalSettings | null>(null);
	const [agentId, setAgentId] = useState<string | null>(null);
	const [configId, setConfigId] = useState<string | null>(null);
	// Per-launch account (undefined → the registry default preselect).
	const [accountId, setAccountId] = useState<string | null | undefined>(undefined);
	const [launching, setLaunching] = useState(false);
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
			// Only honour gs.defaultConfigId when it belongs to the resolved agent.
			const globalConfig = gs.defaultConfigId && agent?.configurations.some((c) => c.id === gs.defaultConfigId)
				? gs.defaultConfigId
				: null;
			setConfigId(globalConfig ?? agent?.defaultConfigId ?? agent?.configurations[0]?.id ?? null);
		}).catch(() => {});
	}, []);

	// Escape declines: the CLI is blocked waiting, so dismissing without an
	// answer would leave the requesting agent hanging for the full timeout.
	useEscapeKey(() => onRespond(false));

	const handleToggleFavorite = useToggleFavorite(setGlobalSettings);

	function handleLaunch() {
		setLaunching(true);
		onRespond(true, { agentId, configId, accountId });
	}

	const selectedAgent = agents.find((a) => a.id === agentId);
	const selectedAvailability = agentAvailability.find((a) => a.agentId === agentId);
	const agentNotInstalled = selectedAvailability ? !selectedAvailability.installed : false;

	return (
		<div
			className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onRespond(false);
			}}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				tabIndex={-1}
				className="bg-overlay rounded-2xl shadow-2xl shadow-black/50 border border-accent/40 w-full max-w-xl mx-4 max-h-[calc(100vh-2rem)] overflow-y-auto outline-none"
			>
				<div className="px-6 py-4 space-y-3">
					<div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent/15 text-accent text-xs font-medium">
						<span className="text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
							{"\u{F06A9}"}
						</span>
						{t("confirmDialog.agentBadge")}
					</div>

					<h2 className="text-fg text-lg font-semibold">
						{request.scratch ? t("agentLaunch.titleScratch") : t("agentLaunch.title")}
					</h2>

					<p className="text-fg-2 text-sm leading-relaxed">
						{t("agentLaunch.requestedBy", {
							seq: String(request.requesterSeq),
							title: request.requesterTitle,
						})}
					</p>

					<TaskDialogSubjectCard
						title={request.taskTitle}
						body={request.scratch ? t("agentLaunch.scratchHasNoPrompt") : (request.subject.overview ?? undefined)}
						seqLabel={request.subject.seqLabel}
						projectName={request.subject.projectName}
						priority={request.subject.priority}
						labels={request.subject.labels}
					/>

					{globalSettings ? (
						<AgentConfigPicker
							idPrefix="agent-launch"
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
					) : (
						<div className="py-6 flex items-center justify-center">
							<div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
						</div>
					)}

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

				<div className="px-6 py-4 border-t border-edge flex items-center justify-end gap-3">
					<button
						type="button"
						autoFocus
						onClick={() => onRespond(false)}
						disabled={launching}
						className="text-fg-3 hover:text-fg text-sm transition-colors px-3 py-1.5 disabled:opacity-50"
					>
						{t("agentLaunch.decline")}
					</button>
					<button
						type="button"
						data-testid="agent-launch-accept"
						onClick={handleLaunch}
						disabled={launching || !globalSettings || agentNotInstalled}
						className="bg-accent hover:bg-accent-hover text-white text-sm font-medium px-5 py-2 rounded-xl transition-colors disabled:opacity-50"
					>
						{launching ? t("agentLaunch.launching") : t("agentLaunch.launch")}
					</button>
				</div>
			</div>
		</div>
	);
}

export default AgentLaunchRequestModal;
