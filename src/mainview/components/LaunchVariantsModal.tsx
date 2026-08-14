import { useState, useEffect, useRef, type Dispatch } from "react";
import type { AgentCheckResult, CodingAgent, GlobalSettings, Project, Task, TaskStatus } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import type { ScheduleMode } from "../../shared/schedule";
import { launchFailureHintKey } from "../../shared/launch-failure";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useToggleFavorite } from "../hooks/useToggleFavorite";
import type { AppAction } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { trackAgentLaunched, trackEvent } from "../analytics";
import posthog from "../posthog";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useReducedMotion } from "../utils/useReducedMotion";
import HelpSpot from "./HelpSpot";
import Tooltip from "./Tooltip";
import AgentConfigPicker, {
	PICKER_HEADER_CONTAINER_CLASS,
	pickerLabelsHeaderClass,
} from "./AgentConfigPicker";
import SchedulePicker from "./SchedulePicker";
import MemoryPressureBanner from "./MemoryPressureBanner";

interface VariantRow {
	agentId: string | null;
	configId: string | null;
	/** Per-launch managed account: `undefined` → default; `null` → system login;
	 *  string → that account. Seeded from the source task on retry. */
	accountId?: string | null;
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
	/**
	 * Called when a launch-picker action changes global settings, such as
	 * adding or removing a favorite agent configuration.
	 */
	onGlobalSettingsChange?: (settings: GlobalSettings) => void;
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
	onGlobalSettingsChange,
}: LaunchVariantsModalProps) {
	const t = useT();

	// Virtual ("Operations") boards run a single agent per operation — there is
	// no git diff to compare parallel attempts against, and a shared fixed
	// folder would have multiple agents clobbering each other. Hide the
	// add-variant affordance so an operation is always one agent + one folder.
	const isVirtual = project.kind === "virtual";

	function makeDefaultVariant(): VariantRow {
		// Try global default agent, fall back to first available
		let agentId: string | null = globalSettings.defaultAgentId ?? null;
		let agent = agentId ? agents.find((a) => a.id === agentId) : null;

		// If agent not found (null, undefined, or removed), use first available
		if (!agent && agents.length > 0) {
			agent = agents[0];
			agentId = agent.id;
		}

		// Settings resolution can pair defaultAgentId with a defaultConfigId from a
		// *different* provider (stale builtin id reset to the Claude default); using
		// it verbatim renders an empty Mode. Guard it like Spawn/Bug Hunters.
		const globalConfigMatchesAgent =
			!!globalSettings.defaultConfigId &&
			!!agent?.configurations.some((c) => c.id === globalSettings.defaultConfigId);
		const configId =
			(globalConfigMatchesAgent ? globalSettings.defaultConfigId : null) ??
			agent?.defaultConfigId ??
			agent?.configurations[0]?.id ??
			null;
		// On retry (addAttempts) seed the source task's account so the attempt
		// re-runs under the same one; a fresh todo has none → the default preselect.
		return { agentId, configId, accountId: task.accountId };
	}

	const [variants, setVariants] = useState<VariantRow[]>(() => [makeDefaultVariant()]);
	const [launching, setLaunching] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [agentAvailability, setAgentAvailability] = useState<AgentCheckResult[]>([]);
	// A freshly created task has no explicit `watched` flag → fall back to the
	// remembered preference; an existing task with an explicit value keeps it.
	const [watched, setWatched] = useState(task.watched ?? globalSettings.watchByDefault ?? false);
	// "Start in…" — a deferred launch instead of spawning now (see handleSchedule).
	const [scheduleOpen, setScheduleOpen] = useState(false);
	const [scheduleTarget, setScheduleTarget] = useState<Date | null>(null);
	const [scheduleMode, setScheduleMode] = useState<ScheduleMode>("in");
	const reducedMotion = useReducedMotion();
	const errorRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		api.request.checkAgentAvailability().then(setAgentAvailability).catch(() => {});
	}, []);

	// Keep Tab/Shift+Tab inside the dialog — otherwise focus escapes to the
	// Kanban board behind the modal (labels, task cards), letting the user
	// operate hidden UI.
	const trapRef = useFocusTrap<HTMLDivElement>();

	useEscapeKey(onClose);
	// Enter → the dialog's CURRENT default action. With the Schedule panel open the
	// primary button says "Schedule", so Enter must schedule, never spawn — and it
	// does nothing until a time is set.
	useEffect(() => {
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
				// Only an "implicit" Enter (nothing interactive focused) should launch.
				// If the user tab-focused a control, Enter must trigger that control's
				// own action — the agent/config pickers render as <button> (Select.tsx),
				// as do Watch/Cancel/Add/Remove — otherwise keyboard navigation causes
				// accidental, costly agent spawns.
				const el = document.activeElement as HTMLElement | null;
				const tag = el?.tagName;
				if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON" || tag === "SELECT" || tag === "A" || el?.isContentEditable) return;
				if (launching || variants.length === 0) return;
				if (scheduleOpen) {
					if (scheduleTarget) handleSchedule();
					return;
				}
				handleLaunch();
			}
		}
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [launching, variants, scheduleOpen, scheduleTarget]);

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

	// Star / unstar the given combo; bubbles fresh settings up so every variant
	// picker's favorites trigger + menu reflect the change.
	const handleToggleFavorite = useToggleFavorite(onGlobalSettingsChange);

	// Apply the (possibly preference-derived) Watch choice to the source task
	// before spawning/scheduling, so the toggle actually watches/unwatches it —
	// even when the user never clicked it. Variants inherit `watched` from the
	// source, so this must run first. Best-effort; never blocks the launch.
	async function applyWatchPreference() {
		if (watched === !!task.watched) return;
		try {
			const updated = await api.request.toggleTaskWatch({
				taskId: task.id,
				projectId: project.id,
				watched,
			});
			dispatch({ type: "updateTask", task: updated });
		} catch {
			// Watch is best-effort; never block the launch on it.
		}
	}

	async function handleLaunch() {
		setLaunching(true);
		setError(null);
		try {
			await applyWatchPreference();
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
				posthog.capture("task_add_attempts", { attempt_count: newAttempts.length });
				for (const variant of variants) {
					trackAgentLaunched(agents, variant.agentId, variant.configId);
				}
			} else {
				const resultTasks = await api.request.spawnVariants({
					taskId: task.id,
					projectId: project.id,
					targetStatus,
					variants,
				});
				dispatch({ type: "spawnVariants", sourceTaskId: task.id, variants: resultTasks });
				trackEvent("task_spawned", { project_id: project.id, variant_count: resultTasks.length });
				posthog.capture("task_spawned", { variant_count: resultTasks.length, target_status: targetStatus });
				for (const variant of variants) {
					trackAgentLaunched(agents, variant.agentId, variant.configId);
				}
			}
			onClose();
		} catch (err) {
			setError(String(err));
		}
		setLaunching(false);
	}

	// "Start in…" — persist a deferred launch instead of spawning now. The task
	// stays in To Do with a countdown badge; the bun scheduler fires the exact
	// variants captured here when the moment arrives. The in/at picker + its pure
	// time resolution live in the shared SchedulePicker (also used by "Send later").
	async function handleSchedule() {
		if (!scheduleTarget) return;
		const delayMs = scheduleTarget.getTime() - Date.now();
		setLaunching(true);
		setError(null);
		try {
			await applyWatchPreference();
			const updated = await api.request.scheduleTaskLaunch({
				taskId: task.id,
				projectId: project.id,
				at: scheduleTarget.toISOString(),
				targetStatus,
				variants,
			});
			dispatch({ type: "updateTask", task: updated });
			trackEvent("task_launch_scheduled", {
				project_id: project.id,
				variant_count: variants.length,
				delay_ms: delayMs,
				schedule_mode: scheduleMode,
			});
			posthog.capture("task_launch_scheduled", {
				variant_count: variants.length,
				delay_ms: delayMs,
				schedule_mode: scheduleMode,
				target_status: targetStatus,
			});
			onClose();
		} catch (err) {
			setError(String(err));
		}
		setLaunching(false);
	}

	// A failed launch must not be silent for screen readers: role="alert" announces
	// it, and focus moves to the message so keyboard users land on the reason.
	useEffect(() => {
		if (error) errorRef.current?.focus();
	}, [error]);

	const isAddVariant = mode === "addAttempts";
	const title = isAddVariant ? t("launch.retryTitle") : t("launch.title");
	const launchLabel = isAddVariant
		? (launching ? t("launch.launching") : t("launch.launchVariant"))
		: (launching ? t("launch.launching") : t("launch.launch"));

	// Press feedback on the most consequential click in the app.
	const pressClass = reducedMotion ? "transition-colors" : "transition active:scale-[0.96]";
	// The two disabled meanings must not look the same: "nothing to launch yet"
	// greys the button out, while an in-flight launch keeps full colour + spinner.
	const notReady = scheduleOpen ? !scheduleTarget || variants.length === 0 : variants.length === 0;
	const primaryClass = `text-sm font-medium px-5 py-2 rounded-xl flex items-center gap-2 border ${pressClass} ${
		notReady
			? "bg-elevated text-fg-muted border-edge cursor-not-allowed"
			: "bg-accent-fill hover:bg-accent-fill-hover text-white border-transparent"
	}`;
	const spinner = launching && (
		<span
			className={`h-3 w-3 rounded-full border-2 border-white/30 border-t-white${reducedMotion ? "" : " animate-spin"}`}
			aria-hidden="true"
		/>
	);

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onClick={onClose}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="launch-variants-title"
				tabIndex={-1}
				className="bg-overlay rounded-2xl shadow-2xl shadow-black/50 border border-edge-active w-full max-w-3xl mx-4 overflow-hidden outline-none"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div className="px-6 py-4 border-b border-edge">
					<div className="flex items-center justify-between gap-3">
						<div className="min-w-0">
							<div className="flex items-center gap-1.5">
								<h2 id="launch-variants-title" className="text-fg text-lg font-semibold">{title}</h2>
								<HelpSpot topicId="modal.launch-variants" />
							</div>
							<p className="text-fg-3 text-sm mt-1 truncate">{getTaskTitle(task)}</p>
						</div>
						<Tooltip
							content={watched ? t("task.unwatchTooltip") : t("task.watchTooltip")}
							detail={t("ttip.task.watch")}
						>
							<button
								onClick={() => setWatched(!watched)}
								className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors flex-shrink-0 ${
									watched
										? "text-accent bg-accent/10 border border-accent/25"
										: "text-fg-3 hover:text-fg hover:bg-elevated border border-edge"
								}`}
								aria-label={watched ? t("task.unwatchTooltip") : t("task.watchTooltip")}
							>
								<span className="text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
									{watched ? "\u{F009A}" : "\u{F0F1C}"}
								</span>
								<span className="text-xs font-medium">
									{watched ? t("task.watching") : t("task.watch")}
								</span>
							</button>
						</Tooltip>
					</div>
				</div>

				{/* Memory notice, outside the scrolling variant list so it cannot be
				    scrolled out of sight. The forecast scales with the variant count. */}
				<div className="px-6 pt-3 empty:hidden">
					<MemoryPressureBanner launchCount={variants.length} />
				</div>

				{/* Variant rows. Every row shares one set of rails —
				    #N | picker | remove — so the index and the × line up with the
				    fields structurally, and the labels header below tracks the same
				    columns instead of being nudged with margins. */}
				<fieldset className="px-6 py-4 max-h-[50vh] overflow-y-auto">
					<legend className="sr-only">{t("launch.fieldsetLegend")}</legend>

					{/* Labels once for the whole list, not once per variant. The
					    transparent border + px-3 match a row card's own box, so the
					    columns align; the middle cell is the picker's width, so the
					    header appears exactly when the fields sit in a row. */}
					<div className="grid grid-cols-[1.75rem_minmax(0,1fr)_1.5rem] gap-3 px-3 border border-transparent">
						<span />
						<div className={PICKER_HEADER_CONTAINER_CLASS}>
							<div className={`${pickerLabelsHeaderClass(true)} text-xs text-fg-3 mb-1`}>
								<span>{t("launch.favorites")}</span>
								<span>{t("launch.provider")}</span>
								<span>{t("launch.model")}</span>
								<span>{t("launch.mode")}</span>
							</div>
						</div>
						<span />
					</div>

					<div className="space-y-3">
						{variants.map((variant, index) => (
							<div
								key={index}
								role="group"
								aria-label={t("launch.variantGroup", { n: String(index + 1) })}
								className="grid grid-cols-[1.75rem_minmax(0,1fr)_1.5rem] items-start gap-3 p-3 bg-raised rounded-[1.25rem] border border-edge"
							>
								{/* Variant number. A control-height box, so the index reads as
								    centred against the fields beside it instead of riding
								    their top edge. */}
								<span className="flex h-[34px] items-center text-accent font-bold text-sm">
									#{index + 1}
								</span>

								{/* Provider → Model → Mode (stacks in a narrow dialog) */}
								<AgentConfigPicker
									idPrefix={`variant-${index}`}
									agents={agents}
									agentId={variant.agentId}
									configId={variant.configId}
									agentAvailability={agentAvailability}
									onChange={(next) => updateVariant(index, next)}
									accountId={variant.accountId}
									onAccountChange={(accountId) => updateVariant(index, { accountId })}
									showLabels={false}
									pxpipeProxyEnabled={globalSettings.pxpipeProxyEnabled ?? false}
									showFavorites
									favorites={globalSettings.favorites ?? []}
									onToggleFavorite={handleToggleFavorite}
								/>

								{/* Remove button — the rail stays reserved with one variant
								    so the rows and the header never shift. */}
								{variants.length > 1 && (
									<button
										onClick={() => removeVariant(index)}
										className={`flex h-[34px] w-6 items-center justify-center text-fg-muted hover:text-danger ${pressClass}`}
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
						))}
					</div>
				</fieldset>

				{/* Error */}
				{error && (
					<div
						ref={errorRef}
						role="alert"
						tabIndex={-1}
						className="px-6 py-2 text-danger text-sm outline-none"
					>
						{t("launch.failedLaunch", { error })}
						<span className="text-fg-3 block">{t(launchFailureHintKey(error))}</span>
					</div>
				)}

				{/* Schedule picker — roomy panel instead of a cramped footer row */}
				{!isAddVariant && scheduleOpen && (
					<div className="px-6 py-3 border-t border-edge bg-raised/40">
						<SchedulePicker
							disabled={launching}
							onSubmit={() => { if (scheduleTarget && !launching) handleSchedule(); }}
							onTargetChange={(target, m) => { setScheduleTarget(target); setScheduleMode(m); }}
						/>
					</div>
				)}

				{/* Footer — wraps on a phone-width viewport instead of squeezing the
				    labels into one-word-per-line columns. */}
				<div className="px-6 py-4 border-t border-edge flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
					{isVirtual ? (
						<div />
					) : (
						<button
							onClick={addVariant}
							className={`text-accent hover:text-accent-emphasis text-sm font-medium whitespace-nowrap ${pressClass}`}
						>
							{t("launch.addVariant")}
						</button>
					)}

					<div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
						<button
							onClick={onClose}
							className={`text-fg-3 hover:text-fg text-sm px-3 py-1.5 whitespace-nowrap ${pressClass}`}
							disabled={launching}
						>
							{t("kanban.cancel")}
						</button>
						{!isAddVariant && (
							<button
								onClick={() => setScheduleOpen((v) => !v)}
								disabled={launching}
								className={`text-sm px-3 py-1.5 rounded-lg flex items-center gap-1.5 border whitespace-nowrap ${pressClass} ${
									scheduleOpen
										? "text-accent border-accent/40 bg-accent/10"
										: "text-fg-3 hover:text-fg border-transparent"
								}`}
								title={t("launch.startInHint")}
							>
								<svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
									<circle cx="12" cy="12" r="9" />
									<path d="M12 7v5l3 2" />
								</svg>
								{t("launch.startIn")}
							</button>
						)}
						{scheduleOpen ? (
							<button
								onClick={handleSchedule}
								disabled={launching || notReady}
								className={primaryClass}
							>
								{spinner}
								{t("launch.schedule")}
							</button>
						) : (
							<button
								onClick={handleLaunch}
								disabled={launching || notReady}
								className={primaryClass}
							>
								{spinner}
								{launchLabel}
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

export default LaunchVariantsModal;
