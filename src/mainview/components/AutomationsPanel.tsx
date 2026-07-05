import { useCallback, useEffect, useState } from "react";
import type { Automation, AutomationRun, Project } from "../../shared/types";
import { api } from "../rpc";
import { useLocale, useT } from "../i18n";
import { confirm } from "../confirm";
import { toast } from "../toast";
import { compactAge } from "../utils/statusAge";
import AutomationEditModal from "./AutomationEditModal";

interface AutomationsPanelProps {
	project: Project;
}

function formatNextRun(iso: string | null, locale: string): string | null {
	if (!iso) return null;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	return d.toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function runStatusChip(run: AutomationRun, t: ReturnType<typeof useT>): { label: string; className: string } {
	if (run.status === "created") return { label: t("automations.runCreated"), className: "text-success bg-success/10" };
	if (run.status === "failed") return { label: t("automations.runFailed"), className: "text-danger bg-danger/10" };
	return { label: t("automations.runMissed"), className: "text-warning bg-warning/10" };
}

function AutomationsPanel({ project }: AutomationsPanelProps) {
	const t = useT();
	const [locale] = useLocale();
	const [automations, setAutomations] = useState<Automation[]>([]);
	const [loading, setLoading] = useState(true);
	const [editing, setEditing] = useState<Automation | null>(null);
	const [creating, setCreating] = useState(false);
	const [expandedId, setExpandedId] = useState<string | null>(null);

	const reload = useCallback(() => {
		api.request.listAutomations({ projectId: project.id })
			.then(setAutomations)
			.catch((err) => toast.error(String(err)))
			.finally(() => setLoading(false));
	}, [project.id]);

	useEffect(() => {
		reload();
	}, [reload]);

	useEffect(() => {
		function onUpdated(e: Event) {
			const detail = (e as CustomEvent<{ projectId: string }>).detail;
			if (detail?.projectId === project.id) reload();
		}
		window.addEventListener("rpc:automationsUpdated", onUpdated);
		return () => window.removeEventListener("rpc:automationsUpdated", onUpdated);
	}, [project.id, reload]);

	async function toggleEnabled(automation: Automation) {
		try {
			await api.request.updateAutomation({
				projectId: project.id,
				automationId: automation.id,
				enabled: !automation.enabled,
			});
			reload();
		} catch (err) {
			toast.error(String(err));
		}
	}

	async function runNow(automation: Automation) {
		try {
			await api.request.runAutomationNow({ projectId: project.id, automationId: automation.id });
			toast.success(t("automations.runNowStarted", { name: automation.name }));
		} catch (err) {
			toast.error(String(err));
		}
	}

	async function remove(automation: Automation) {
		const ok = await confirm({
			title: t("automations.deleteConfirmTitle"),
			message: t("automations.deleteConfirmMessage", { name: automation.name }),
			danger: true,
		});
		if (!ok) return;
		try {
			await api.request.deleteAutomation({ projectId: project.id, automationId: automation.id });
			reload();
		} catch (err) {
			toast.error(String(err));
		}
	}

	const ghostButtonClass = "px-2.5 py-1 rounded-lg text-xs font-medium text-fg-3 hover:text-fg-2 hover:bg-raised-hover transition-colors";

	return (
		<div>
			<div className="flex items-center justify-between mb-2">
				<label className="block text-fg text-sm font-semibold">{t("automations.title")}</label>
				<button
					type="button"
					onClick={() => setCreating(true)}
					className="px-3 py-1.5 rounded-lg text-xs font-medium text-accent bg-accent/10 hover:bg-accent/20 transition-colors"
				>
					{t("automations.new")}
				</button>
			</div>
			<p className="text-fg-3 text-sm mb-3">{t("automations.description")}</p>

			{loading ? (
				<div className="py-6 flex justify-center">
					<div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
				</div>
			) : automations.length === 0 ? (
				<div className="rounded-xl border border-edge bg-raised/40 px-4 py-6 text-center">
					<p className="text-fg-3 text-sm mb-1">{t("automations.empty")}</p>
					<p className="text-fg-muted text-xs">{t("automations.emptyHint")}</p>
				</div>
			) : (
				<div className="space-y-2">
					{automations.map((automation) => {
						const nextRun = formatNextRun(automation.nextRunAt, locale);
						const lastRun = automation.runs[0];
						const expanded = expandedId === automation.id;
						return (
							<div key={automation.id} className="rounded-xl border border-edge bg-raised/40 px-4 py-3">
								<div className="flex items-center gap-3">
									{/* Enabled toggle */}
									<button
										type="button"
										role="switch"
										aria-checked={automation.enabled}
										aria-label={t(automation.enabled ? "automations.disable" : "automations.enable")}
										onClick={() => toggleEnabled(automation)}
										className={`relative w-8 h-[18px] rounded-full transition-colors shrink-0 ${automation.enabled ? "bg-accent" : "bg-elevated"}`}
									>
										<span className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-all ${automation.enabled ? "left-[18px]" : "left-[2px]"}`} />
									</button>

									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className={`text-sm font-medium truncate ${automation.enabled ? "text-fg" : "text-fg-muted"}`}>{automation.name}</span>
											{lastRun?.status === "failed" && (
												<span className="text-[10px] px-1.5 py-0.5 rounded font-medium text-danger bg-danger/10">{t("automations.runFailed")}</span>
											)}
										</div>
										<div className="text-xs text-fg-muted truncate font-mono">{automation.rrule} · {automation.timezone}</div>
									</div>

									<div className="text-right shrink-0 hidden sm:block">
										<div className="text-xs text-fg-3">
											{automation.enabled && nextRun
												? t("automations.nextRun", { when: nextRun })
												: t("automations.paused")}
										</div>
										<button
											type="button"
											onClick={() => setExpandedId(expanded ? null : automation.id)}
											className="text-xs text-fg-muted hover:text-fg-3 transition-colors"
										>
											{lastRun
												? t("automations.lastRun", { age: compactAge(lastRun.firedAt ?? lastRun.scheduledFor) })
												: t("automations.neverRan")}
											{automation.runs.length > 0 && <span> ({automation.runs.length})</span>}
										</button>
									</div>

									<div className="flex items-center gap-1 shrink-0">
										<button type="button" onClick={() => runNow(automation)} className={ghostButtonClass} title={t("automations.runNow")}>
											{t("automations.runNow")}
										</button>
										<button type="button" onClick={() => setEditing(automation)} className={ghostButtonClass}>
											{t("automations.edit")}
										</button>
										<button
											type="button"
											onClick={() => remove(automation)}
											className="px-2.5 py-1 rounded-lg text-xs font-medium text-danger hover:bg-danger/10 transition-colors"
										>
											{t("automations.delete")}
										</button>
									</div>
								</div>

								{expanded && automation.runs.length > 0 && (
									<div className="mt-3 pt-3 border-t border-edge/60 space-y-1">
										{automation.runs.map((run) => {
											const chip = runStatusChip(run, t);
											return (
												<div key={run.id} className="flex items-center gap-2 text-xs">
													<span className={`px-1.5 py-0.5 rounded font-medium ${chip.className}`}>{chip.label}</span>
													<span className="text-fg-muted">
														{new Date(run.firedAt ?? run.scheduledFor).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
													</span>
													{run.manual && <span className="text-fg-muted">· {t("automations.manualRun")}</span>}
													{run.taskId && <span className="text-fg-muted font-mono">· {run.taskId.slice(0, 8)}</span>}
													{run.error && <span className="text-danger truncate">· {run.error}</span>}
												</div>
											);
										})}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}

			{(creating || editing) && (
				<AutomationEditModal
					project={project}
					automation={editing}
					onClose={() => {
						setCreating(false);
						setEditing(null);
					}}
					onSaved={reload}
				/>
			)}
		</div>
	);
}

export default AutomationsPanel;
