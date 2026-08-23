import { useEffect, useState } from "react";
import type { AgentCheckResult, AgentLaunchRequest, CodingAgent, GlobalSettings, TaskPriority } from "../../shared/types";
import { api } from "../rpc";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useToggleFavorite } from "../hooks/useToggleFavorite";
import { useT } from "../i18n";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useReducedMotion } from "../utils/useReducedMotion";
import AgentConfigPicker from "./AgentConfigPicker";
import AgentPickerSkeleton from "./AgentPickerSkeleton";
import TaskDialogSubjectCard from "./TaskDialogSubjectCard";

const NOT_INSTALLED_ID = "agent-launch-not-installed";

/** What the dialog hands back on approval — the agent pick plus the priority. */
interface LaunchChoice {
	agentId: string | null;
	configId: string | null;
	accountId?: string | null;
	priority?: TaskPriority;
}

/** Whole seconds left until `at`, floored at 0. */
function secondsUntil(at: number): number {
	return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function formatCountdown(totalSeconds: number): string {
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

interface AgentLaunchRequestModalProps {
	request: AgentLaunchRequest;
	/** Answers the blocked CLI. `launch` is only set when approved. */
	onRespond: (approved: boolean, launch?: LaunchChoice) => void;
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
	const reducedMotion = useReducedMotion();
	const [agents, setAgents] = useState<CodingAgent[]>([]);
	const [globalSettings, setGlobalSettings] = useState<GlobalSettings | null>(null);
	const [agentId, setAgentId] = useState<string | null>(null);
	const [configId, setConfigId] = useState<string | null>(null);
	// Per-launch account (undefined → the registry default preselect).
	const [accountId, setAccountId] = useState<string | null | undefined>(undefined);
	// Seeded from the request: the target's own priority, or the requesting task's
	// when it never had one (issue #1496). Editable — this launch is the moment to
	// decide how urgent the new task is.
	const [priority, setPriority] = useState<TaskPriority>(request.defaultPriority);
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

	// Countdown only — the timer that actually approves lives in the bun process
	// and closes this dialog through `agentRequestResolved`. Rendering it from
	// the deadline (not a local tick budget) keeps a backgrounded tab honest.
	const autoApproveAt = request.autoApproveAt;
	const [secondsLeft, setSecondsLeft] = useState(() => (autoApproveAt ? secondsUntil(autoApproveAt) : 0));
	useEffect(() => {
		if (!autoApproveAt) return;
		setSecondsLeft(secondsUntil(autoApproveAt));
		const id = setInterval(() => setSecondsLeft(secondsUntil(autoApproveAt)), 1000);
		return () => clearInterval(id);
	}, [autoApproveAt]);

	// Mirror every pick back to the pending request, so an auto-approval that
	// fires while the user is away launches with what they last selected.
	function reportChoice(next: LaunchChoice) {
		if (!autoApproveAt) return;
		api.request.updateAgentLaunchChoice({ requestId: request.requestId, launch: next }).catch(() => {});
	}

	const handleToggleFavorite = useToggleFavorite(setGlobalSettings);

	const selectedAgent = agents.find((a) => a.id === agentId);
	const selectedAvailability = agentAvailability.find((a) => a.agentId === agentId);
	const agentNotInstalled = selectedAvailability ? !selectedAvailability.installed : false;
	// "Not ready" (missing agent / still loading) must not look like "in flight",
	// which keeps full colour and gets a spinner instead.
	const notReady = agentNotInstalled || !globalSettings;
	const pressFeedback = reducedMotion
		? "transition-colors"
		: "transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.96]";

	function handleLaunch() {
		if (agentNotInstalled) return;
		setLaunching(true);
		onRespond(true, { agentId, configId, accountId, priority });
	}

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
				aria-labelledby="agent-launch-title"
				tabIndex={-1}
				className="bg-overlay rounded-2xl shadow-2xl shadow-black/50 border border-accent/40 w-full max-w-2xl mx-4 max-h-[calc(100vh-2rem)] flex flex-col overflow-hidden outline-none"
			>
				{/* Only the content scrolls — a blocked CLI waits on the footer answer,
				    so Decline/Launch must stay visible on a short viewport. */}
				<div className="px-6 py-4 space-y-3 flex-1 min-h-0 overflow-y-auto">
					<div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent/15 text-accent text-xs font-medium">
						<span className="text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
							{"\u{F06A9}"}
						</span>
						{t("confirmDialog.agentBadge")}
					</div>

					<h2 id="agent-launch-title" className="text-fg text-lg font-semibold">
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
						priority={priority}
						onPriorityChange={(next) => {
							setPriority(next);
							reportChoice({ agentId, configId, accountId, priority: next });
						}}
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
								reportChoice({ ...next, accountId, priority });
							}}
							accountId={accountId}
							onAccountChange={(next) => {
								setAccountId(next);
								reportChoice({ agentId, configId, accountId: next, priority });
							}}
							pxpipeProxyEnabled={globalSettings.pxpipeProxyEnabled ?? false}
							showFavorites
							favorites={globalSettings.favorites ?? []}
							onToggleFavorite={handleToggleFavorite}
						/>
					) : (
						<AgentPickerSkeleton />
					)}

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

				<div className="px-6 py-4 border-t border-edge flex items-center justify-end gap-3 flex-shrink-0">
					{autoApproveAt && !launching && (
						<p
							data-testid="agent-launch-countdown"
							className="text-fg-3 text-xs mr-auto"
							// Polite, not assertive: a per-second tick read out loud would
							// drown everything else in the dialog.
							aria-live="off"
						>
							{t("agentLaunch.autoApproveIn", { time: formatCountdown(secondsLeft) })}
						</p>
					)}
					<button
						type="button"
						autoFocus
						onClick={() => onRespond(false)}
						disabled={launching}
						className={`text-fg-3 hover:text-fg text-sm px-3 py-1.5 disabled:opacity-50 ${pressFeedback}`}
					>
						{t("agentLaunch.decline")}
					</button>
					{/* Not-installed keeps the button focusable (aria-disabled) so its
					    reason is announced; only the in-flight case is natively disabled. */}
					<button
						type="button"
						data-testid="agent-launch-accept"
						onClick={handleLaunch}
						disabled={launching || !globalSettings}
						aria-disabled={agentNotInstalled || undefined}
						aria-describedby={agentNotInstalled && selectedAgent ? NOT_INSTALLED_ID : undefined}
						className={`text-sm font-medium px-5 py-2 rounded-xl inline-flex items-center gap-2 ${pressFeedback} ${
							notReady
								? "bg-elevated text-fg-muted border border-edge cursor-not-allowed"
								: "bg-accent-fill hover:bg-accent-fill-hover text-white"
						}`}
					>
						{launching && (
							<span
								className={`h-3 w-3 rounded-full border-2 border-white/30 border-t-white${reducedMotion ? "" : " animate-spin"}`}
								aria-hidden="true"
							/>
						)}
						{launching ? t("agentLaunch.launching") : t("agentLaunch.launch")}
					</button>
				</div>
			</div>
		</div>
	);
}

export default AgentLaunchRequestModal;
