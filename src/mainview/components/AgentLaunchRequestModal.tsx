import { useEffect, useState } from "react";
import type { AgentCheckResult, AgentLaunchChoice, AgentLaunchRequest, CodingAgent, GlobalSettings, LaunchVariant, TaskPriority } from "../../shared/types";
import { api } from "../rpc";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useToggleFavorite } from "../hooks/useToggleFavorite";
import { useT } from "../i18n";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useReducedMotion } from "../utils/useReducedMotion";
import AgentConfigPicker from "./AgentConfigPicker";
import AgentPickerSkeleton from "./AgentPickerSkeleton";
import MemoryPressureBanner from "./MemoryPressureBanner";
import TaskDialogSubjectCard from "./TaskDialogSubjectCard";

const NOT_INSTALLED_ID = "agent-launch-not-installed";

/**
 * The agent/config a fresh variant row starts on: the global default, falling
 * back to the first installed harness. The config is only honoured when it
 * belongs to the resolved agent — settings can pair `defaultAgentId` with a
 * `defaultConfigId` from a different harness, which renders an empty Mode.
 */
function defaultVariant(agents: CodingAgent[], settings: GlobalSettings): LaunchVariant {
	let agentId: string | null = settings.defaultAgentId ?? null;
	let agent = agentId ? agents.find((a) => a.id === agentId) : null;
	if (!agent && agents.length > 0) {
		agent = agents[0];
		agentId = agent.id;
	}
	const globalConfig = settings.defaultConfigId && agent?.configurations.some((c) => c.id === settings.defaultConfigId)
		? settings.defaultConfigId
		: null;
	return {
		agentId,
		configId: globalConfig ?? agent?.defaultConfigId ?? agent?.configurations[0]?.id ?? null,
	};
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
	onRespond: (approved: boolean, launch?: AgentLaunchChoice) => void;
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
	// One row per variant the launch will start. Exactly one until the user adds
	// more — approving without touching anything must never mint a group.
	const [variants, setVariants] = useState<LaunchVariant[]>([{ agentId: null, configId: null }]);
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
			// Nothing is interactive until settings land (the picker is a skeleton and
			// there is no add affordance), so this can seed the list outright.
			setVariants([defaultVariant(a, gs)]);
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
	function reportChoice(next: AgentLaunchChoice) {
		if (!autoApproveAt) return;
		api.request.updateAgentLaunchChoice({ requestId: request.requestId, launch: next }).catch(() => {});
	}

	function updateVariants(next: LaunchVariant[]) {
		setVariants(next);
		reportChoice({ variants: next, priority });
	}

	const handleToggleFavorite = useToggleFavorite(setGlobalSettings);

	// Variants may run different harnesses, so "not installed" is a property of the
	// list: the first offending row names itself in the warning, and any of them
	// blocks the launch — a group that starts three worktrees and two agents is
	// worse than a launch that refuses.
	const missing = variants
		.map((variant, index) => ({ index, agent: agents.find((a) => a.id === variant.agentId) }))
		.find(({ agent }) => agent && agentAvailability.some((a) => a.agentId === agent.id && !a.installed));
	const selectedAgent = missing?.agent;
	const selectedAvailability = agentAvailability.find((a) => a.agentId === selectedAgent?.id);
	const agentNotInstalled = selectedAgent != null;
	// "Not ready" (missing agent / still loading) must not look like "in flight",
	// which keeps full colour and gets a spinner instead.
	const notReady = agentNotInstalled || !globalSettings;
	const canAddVariants = request.canAddVariants && globalSettings != null;
	const pressFeedback = reducedMotion
		? "transition-colors"
		: "transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.96]";

	function handleLaunch() {
		if (agentNotInstalled) return;
		setLaunching(true);
		onRespond(true, { variants, priority });
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
							reportChoice({ variants, priority: next });
						}}
						labels={request.subject.labels}
					/>

					{/* Only speaks up under real pressure, and the forecast scales with
					    the variant count — same banner the Launch modal shows. */}
					<div className="empty:hidden">
						<MemoryPressureBanner launchCount={variants.length} />
					</div>

					{globalSettings ? (
						<div className="space-y-2">
							{variants.map((variant, index) => (
								<div
									key={index}
									// A single launch is not a group and gets no rails: the row
									// chrome (#N, remove) appears only once there is a second
									// variant to tell apart.
									{...(variants.length > 1
										? { role: "group", "aria-label": t("launch.variantGroup", { n: String(index + 1) }) }
										: {})}
									className={variants.length > 1
										? "grid grid-cols-[1.75rem_minmax(0,1fr)_1.5rem] items-start gap-3"
										: undefined}
								>
									{variants.length > 1 && (
										<span className="flex h-[34px] items-center text-accent font-bold text-sm">
											#{index + 1}
										</span>
									)}
									<AgentConfigPicker
										idPrefix={`agent-launch-${index}`}
										agents={agents}
										agentId={variant.agentId}
										configId={variant.configId}
										agentAvailability={agentAvailability}
										onChange={(next) => updateVariants(
											variants.map((v, i) => (i === index ? { ...v, ...next } : v)),
										)}
										accountId={variant.accountId}
										onAccountChange={(accountId) => updateVariants(
											variants.map((v, i) => (i === index ? { ...v, accountId } : v)),
										)}
										// Labels once, above the first row only — repeating them per
										// variant is the vertical bloat the Launch modal already rejected.
										showLabels={index === 0}
										pxpipeProxyEnabled={globalSettings.pxpipeProxyEnabled ?? false}
										showFavorites
										favorites={globalSettings.favorites ?? []}
										onToggleFavorite={handleToggleFavorite}
									/>
									{variants.length > 1 && (
										<button
											type="button"
											onClick={() => updateVariants(variants.filter((_, i) => i !== index))}
											disabled={launching}
											className={`flex h-[34px] w-6 items-center justify-center text-fg-muted hover:text-danger disabled:opacity-50 ${pressFeedback}`}
											title={t("launch.removeVariant")}
											aria-label={t("launch.removeVariant")}
										>
											<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
											</svg>
										</button>
									)}
								</div>
							))}

							{/* Beside the list it grows, never in the footer: the footer's left
							    slot is the countdown, and it must stay visible on a short
							    viewport with only Decline and Launch beside it. */}
							{canAddVariants && (
								<button
									type="button"
									data-testid="agent-launch-add-variant"
									onClick={() => updateVariants([...variants, defaultVariant(agents, globalSettings)])}
									disabled={launching}
									className={`text-accent hover:text-accent-emphasis text-sm font-medium disabled:opacity-50 ${pressFeedback}`}
								>
									{t("launch.addVariant")}
								</button>
							)}
						</div>
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
						{/* The button must say how many tasks the click starts — approving a
						    three-variant group under a bare "Launch" is a surprise the user
						    pays for in worktrees. */}
						{launching
							? t("agentLaunch.launching")
							: variants.length > 1
								? t.plural("agentLaunch.launchVariants", variants.length)
								: t("agentLaunch.launch")}
					</button>
				</div>
			</div>
		</div>
	);
}

export default AgentLaunchRequestModal;
