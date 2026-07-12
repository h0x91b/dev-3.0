import { useState, useEffect, type Dispatch } from "react";
import type { AgentCheckResult, CodingAgent, GlobalSettings, Project, Task, TaskStatus } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import { formatCountdown } from "../../shared/duration";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useToggleFavorite } from "../hooks/useToggleFavorite";
import type { AppAction } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { trackAgentLaunched, trackEvent } from "../analytics";
import { useFocusTrap } from "../utils/useFocusTrap";
import HelpSpot from "./HelpSpot";
import AgentConfigPicker from "./AgentConfigPicker";

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
	/**
	 * Called when the Watch toggle changes the remembered `watchByDefault`
	 * preference, so the parent can keep its in-memory GlobalSettings in sync
	 * (the next modal open then reflects the new default).
	 */
	onGlobalSettingsChange?: (settings: GlobalSettings) => void;
}

/** Format a Date as the `HH:MM` value expected by `<input type="time">`. */
function toTimeInputValue(d: Date): string {
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * `− [ n ] +` stepper for the "in X" schedule mode. Buttons step by `step`
 * (minutes wrap around, hours clamp); typing accepts any value in range and
 * ArrowUp/ArrowDown mirror the buttons.
 */
function NumberStepper({
	label,
	value,
	max,
	step,
	wrap = false,
	disabled = false,
	onChange,
}: {
	label: string;
	value: number;
	max: number;
	step: number;
	wrap?: boolean;
	disabled?: boolean;
	onChange: (v: number) => void;
}) {
	const bump = (dir: 1 | -1) => {
		const next = value + dir * step;
		if (wrap) {
			const range = max + 1;
			onChange(((next % range) + range) % range);
		} else {
			onChange(Math.min(max, Math.max(0, next)));
		}
	};
	return (
		<div className="flex items-center gap-2">
			<span className="text-fg-3 text-xs">{label}</span>
			<div className="flex items-center gap-1">
				<button
					onClick={() => bump(-1)}
					disabled={disabled}
					aria-label={`${label} −`}
					className="w-8 h-8 rounded-lg border border-edge text-fg-3 hover:text-fg hover:border-edge-active transition-colors text-base leading-none disabled:opacity-50"
				>
					−
				</button>
				<input
					value={String(value)}
					disabled={disabled}
					inputMode="numeric"
					aria-label={label}
					onChange={(e) => {
						const digits = e.target.value.replace(/\D/g, "");
						onChange(Math.min(max, digits ? Number.parseInt(digits, 10) : 0));
					}}
					onKeyDown={(e) => {
						if (e.key === "ArrowUp") { e.preventDefault(); bump(1); }
						if (e.key === "ArrowDown") { e.preventDefault(); bump(-1); }
					}}
					className="w-12 h-8 bg-transparent border border-edge rounded-lg text-center text-fg text-base outline-none focus:border-accent"
				/>
				<button
					onClick={() => bump(1)}
					disabled={disabled}
					aria-label={`${label} +`}
					className="w-8 h-8 rounded-lg border border-edge text-fg-3 hover:text-fg hover:border-edge-active transition-colors text-base leading-none disabled:opacity-50"
				>
					+
				</button>
			</div>
		</div>
	);
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
	// A freshly created task has no explicit `watched` flag → fall back to the
	// remembered preference; an existing task with an explicit value keeps it.
	const [watched, setWatched] = useState(task.watched ?? globalSettings.watchByDefault ?? false);

	useEffect(() => {
		api.request.checkAgentAvailability().then(setAgentAvailability).catch(() => {});
	}, []);

	// Keep Tab/Shift+Tab inside the dialog — otherwise focus escapes to the
	// Kanban board behind the modal (labels, task cards), letting the user
	// operate hidden UI.
	const trapRef = useFocusTrap<HTMLDivElement>();

	useEscapeKey(onClose);
	// Enter → launch (when no text input is focused)
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
				if (!launching && variants.length > 0) handleLaunch();
			}
		}
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [launching, variants]);

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
	// variants captured here when the moment arrives. Two modes:
	//   "in" — relative delay via hour/minute steppers (e.g. 3h 45m);
	//   "at" — absolute local wall-clock time; next occurrence (today if still
	//          ahead, otherwise tomorrow).
	const [scheduleOpen, setScheduleOpen] = useState(false);
	const [scheduleMode, setScheduleMode] = useState<"in" | "at">("in");
	const [delayHours, setDelayHours] = useState(1);
	const [delayMinutes, setDelayMinutes] = useState(0);
	const [atTime, setAtTime] = useState(() => toTimeInputValue(new Date(Date.now() + 3_600_000)));
	// Re-render every 30s while the picker is open so the today/tomorrow hint
	// and countdown stay honest (the actual target is resolved at submit time).
	const [nowTick, setNowTick] = useState(() => Date.now());
	useEffect(() => {
		if (!scheduleOpen) return;
		setNowTick(Date.now());
		const timer = setInterval(() => setNowTick(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, [scheduleOpen]);

	/** Resolve the picker state to a concrete launch Date (null = invalid/zero). */
	function resolveScheduleTarget(nowMs: number): Date | null {
		if (scheduleMode === "in") {
			const ms = delayHours * 3_600_000 + delayMinutes * 60_000;
			return ms > 0 ? new Date(nowMs + ms) : null;
		}
		const m = /^(\d{1,2}):(\d{2})$/.exec(atTime);
		if (!m) return null;
		const d = new Date(nowMs);
		d.setHours(Number(m[1]), Number(m[2]), 0, 0);
		if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1); // already passed → tomorrow
		return d;
	}

	async function handleSchedule() {
		const target = resolveScheduleTarget(Date.now());
		if (!target) return;
		const delayMs = target.getTime() - Date.now();
		setLaunching(true);
		setError(null);
		try {
			await applyWatchPreference();
			const updated = await api.request.scheduleTaskLaunch({
				taskId: task.id,
				projectId: project.id,
				at: target.toISOString(),
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
			onClose();
		} catch (err) {
			setError(String(err));
		}
		setLaunching(false);
	}

	const scheduleTarget = scheduleOpen ? resolveScheduleTarget(nowTick) : null;
	const scheduleHint = (() => {
		if (!scheduleOpen) return null;
		if (!scheduleTarget) return t("launch.scheduleInvalid");
		const now = new Date(nowTick);
		const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
		const dayDiff = Math.round((startOfDay(scheduleTarget) - startOfDay(now)) / 86_400_000);
		const day = dayDiff === 0 ? t("launch.today") : dayDiff === 1 ? t("launch.tomorrow") : scheduleTarget.toLocaleDateString();
		const time = scheduleTarget.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		return t("launch.scheduleHint", { day, time, rel: formatCountdown(scheduleTarget.getTime() - nowTick) });
	})();

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
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				tabIndex={-1}
				className="bg-overlay rounded-2xl shadow-2xl shadow-black/50 border border-edge-active w-full max-w-3xl mx-4 overflow-hidden outline-none"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div className="px-6 py-4 border-b border-edge">
					<div className="flex items-center justify-between gap-3">
						<div className="min-w-0">
							<div className="flex items-center gap-1.5">
								<h2 className="text-fg text-lg font-semibold">{title}</h2>
								<HelpSpot topicId="modal.launch-variants" />
							</div>
							<p className="text-fg-3 text-sm mt-1 truncate">{getTaskTitle(task)}</p>
						</div>
						<button
							onClick={() => {
								const newVal = !watched;
								setWatched(newVal);
								// Remember this choice as the default for future launches.
								// The task itself is (un)watched at launch time (handleLaunch).
								if (globalSettings.watchByDefault !== newVal) {
									const next = { ...globalSettings, watchByDefault: newVal };
									onGlobalSettingsChange?.(next);
									api.request.saveGlobalSettings(next).catch(() => {});
								}
							}}
							className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors flex-shrink-0 ${
								watched
									? "text-accent bg-accent/10 border border-accent/25"
									: "text-fg-3 hover:text-fg hover:bg-elevated border border-edge"
							}`}
							title={watched ? t("task.unwatchTooltip") : t("task.watchTooltip")}
						>
							<span className="text-[0.875rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
								{watched ? "\u{F009A}" : "\u{F0F1C}"}
							</span>
							<span className="text-xs font-medium">
								{watched ? t("task.watching") : t("task.watch")}
							</span>
						</button>
					</div>
				</div>

				{/* Variant rows */}
				<div className="px-6 py-4 space-y-3 max-h-[50vh] overflow-y-auto">
					{variants.map((variant, index) => {
						return (
							<div
								key={index}
								className="flex items-start gap-3 p-3 bg-raised rounded-xl border border-edge"
							>
								{/* Variant number */}
								<span className="text-accent font-bold text-sm w-7 flex-shrink-0 mt-5">
									#{index + 1}
								</span>

								{/* Provider → Model → Mode (stacks on narrow) */}
								<AgentConfigPicker
									idPrefix={`variant-${index}`}
									agents={agents}
									agentId={variant.agentId}
									configId={variant.configId}
									agentAvailability={agentAvailability}
									onChange={(next) => updateVariant(index, next)}
									className="flex-1 min-w-0 flex flex-col sm:flex-row gap-3"
									pxpipeProxyEnabled={globalSettings.pxpipeProxyEnabled ?? false}
									showFavorites
									favorites={globalSettings.favorites ?? []}
									onToggleFavorite={handleToggleFavorite}
								/>

								{/* Remove button */}
								{variants.length > 1 && (
									<button
										onClick={() => removeVariant(index)}
										className="text-fg-muted hover:text-danger transition-colors p-1 mt-6 flex-shrink-0"
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

				{/* Schedule picker — roomy panel instead of a cramped footer row */}
				{!isAddVariant && scheduleOpen && (
					<div className="px-6 py-3 border-t border-edge bg-raised/40">
						{/* Single compact row: mode switch + inputs, no labels above */}
						<div className="flex items-center gap-4">
							<div className="inline-flex h-8 items-center rounded-lg border border-edge p-0.5">
								{(["in", "at"] as const).map((m) => (
									<button
										key={m}
										onClick={() => setScheduleMode(m)}
										className={`text-sm px-2.5 py-1 rounded-md transition-colors ${
											scheduleMode === m
												? "bg-elevated text-fg font-medium"
												: "text-fg-3 hover:text-fg"
										}`}
									>
										{m === "in" ? t("launch.modeIn") : t("launch.modeAt")}
									</button>
								))}
							</div>

							{scheduleMode === "in" ? (
								<div className="flex items-center gap-4">
									<NumberStepper
										label={t("launch.hours")}
										value={delayHours}
										max={99}
										step={1}
										disabled={launching}
										onChange={setDelayHours}
									/>
									<NumberStepper
										label={t("launch.minutes")}
										value={delayMinutes}
										max={59}
										step={5}
										wrap
										disabled={launching}
										onChange={setDelayMinutes}
									/>
								</div>
							) : (
								<input
									type="time"
									value={atTime}
									disabled={launching}
									aria-label={t("launch.atTimeLabel")}
									onChange={(e) => setAtTime(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter" && scheduleTarget && !launching) handleSchedule();
									}}
									className="bg-transparent border border-edge rounded-lg px-2.5 h-8 text-fg text-base outline-none focus:border-accent"
								/>
							)}
						</div>

						<p className={`text-sm mt-2 ${scheduleTarget ? "text-fg-3" : "text-danger"}`}>
							{scheduleHint}
							{scheduleMode === "at" && scheduleTarget && (
								<span className="text-fg-3"> · {t("launch.atTimeLabel").toLowerCase()}</span>
							)}
						</p>
					</div>
				)}

				{/* Footer */}
				<div className="px-6 py-4 border-t border-edge flex items-center justify-between">
					{isVirtual ? (
						<div />
					) : (
						<button
							onClick={addVariant}
							className="text-accent hover:text-accent-hover text-sm font-medium transition-colors"
						>
							{t("launch.addVariant")}
						</button>
					)}

					<div className="flex items-center gap-3">
						<button
							onClick={onClose}
							className="text-fg-3 hover:text-fg text-sm transition-colors px-3 py-1.5"
							disabled={launching}
						>
							{t("kanban.cancel")}
						</button>
						{!isAddVariant && (
							<button
								onClick={() => setScheduleOpen((v) => !v)}
								disabled={launching}
								className={`text-sm transition-colors px-3 py-1.5 rounded-lg flex items-center gap-1.5 border ${
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
								disabled={launching || !scheduleTarget || variants.length === 0}
								className="bg-accent hover:bg-accent-hover text-white text-sm font-medium px-5 py-2 rounded-xl transition-colors disabled:opacity-50"
							>
								{t("launch.schedule")}
							</button>
						) : (
							<button
								onClick={handleLaunch}
								disabled={launching || variants.length === 0}
								className="bg-accent hover:bg-accent-hover text-white text-sm font-medium px-5 py-2 rounded-xl transition-colors disabled:opacity-50"
							>
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
