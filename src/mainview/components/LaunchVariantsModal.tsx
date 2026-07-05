import { useState, useEffect, type Dispatch } from "react";
import type { AgentCheckResult, CodingAgent, GlobalSettings, Project, Task, TaskStatus } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import { useEscapeKey } from "../hooks/useEscapeKey";
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

	async function handleLaunch() {
		setLaunching(true);
		setError(null);
		try {
			// Apply the (possibly preference-derived) Watch choice to the source
			// task before spawning, so launching with the toggle on/off actually
			// watches/unwatches it — even when the user never clicked the toggle.
			// Variants inherit `watched` from the source, so this must run first.
			if (watched !== !!task.watched) {
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
				className="bg-overlay rounded-2xl shadow-2xl shadow-black/50 border border-edge-active w-full max-w-xl mx-4 overflow-hidden outline-none"
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
						<button
							onClick={handleLaunch}
							disabled={launching || variants.length === 0}
							className="bg-accent hover:bg-accent-hover text-white text-sm font-medium px-5 py-2 rounded-xl transition-colors disabled:opacity-50"
						>
							{launchLabel}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

export default LaunchVariantsModal;
