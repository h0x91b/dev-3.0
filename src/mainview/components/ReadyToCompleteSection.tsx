import { useEffect, useState } from "react";
import { getTaskTitle, projectDisplayName, type Project, type ResourceUsage, type Task } from "../../shared/types";
import { useT, type TFunction } from "../i18n";
import { api } from "../rpc";
import { confirm } from "../confirm";
import { toast } from "../toast";
import { useProjectPrivacy } from "../sensitive-projects";
import { pickCompletionOffer, registerWaitingOffersList, useCompletionOffers, type CompletionOffer } from "../completion-offers";
import { completionSkipsGitCheck, unsavedWorkWarning } from "../utils/confirmTaskCompletion";
import { formatBytesCompact } from "../utils/formatBytes";
import { timeAgo } from "../utils/timeAgo";

/** A merge or agent offer waiting on the user, with the task and project it is about. */
export interface WaitingOffer {
	offer: CompletionOffer;
	task: Task;
	project: Project;
}

/**
 * One unsolicited offer per task, oldest first. Offers whose task this client has
 * not loaded are left out: the row would have nothing to name.
 */
export function waitingOffers(offers: readonly CompletionOffer[], projects: Project[], tasksByProject: Map<string, Task[]>): WaitingOffer[] {
	const rows: WaitingOffer[] = [];
	for (const taskId of new Set(offers.map((o) => o.taskId))) {
		const offer = pickCompletionOffer(offers, taskId, true);
		if (!offer) continue;
		const project = projects.find((p) => p.id === offer.projectId);
		const task = tasksByProject.get(offer.projectId)?.find((candidate) => candidate.id === taskId);
		if (project && task) rows.push({ offer, task, project });
	}
	return rows.sort((a, b) => a.offer.offeredAt - b.offer.offeredAt);
}

/** What completing would lose, or null when nothing can be lost or the check failed open. */
async function lossWarning({ task, project, offer }: WaitingOffer, t: TFunction): Promise<string | null> {
	if (completionSkipsGitCheck(task, project)) return null;
	try {
		return unsavedWorkWarning(await api.request.getUnsavedWork({ taskId: offer.taskId, projectId: offer.projectId }), t);
	} catch {
		return t("task.branchStateUnknown");
	}
}

/**
 * The dashboard's list of tasks waiting for a completion answer, across projects,
 * so a user with many tasks can free them in one place. Each answer goes to the
 * same offer the task's bar or dialog shows. Hidden when nothing waits.
 * See `decisions/2026/11/09/ready-to-complete-dashboard-section.md`.
 */
export default function ReadyToCompleteSection({ projects, tasksByProject, usage, onOpenTask }: {
	projects: Project[];
	tasksByProject: Map<string, Task[]>;
	usage: Map<string, ResourceUsage>;
	onOpenTask: (task: Task, project: Project) => void;
}) {
	const t = useT();
	const privacy = useProjectPrivacy();
	const rows = waitingOffers(useCompletionOffers(), projects, tasksByProject);
	// A locked project's task cannot be read here, so it cannot be answered here either.
	const answerable = rows.filter((row) => !privacy.isLocked(row.project));
	const [warnings, setWarnings] = useState<Map<string, string>>(new Map());
	const [busy, setBusy] = useState<Set<string>>(new Set());
	// Registered even while empty: the next ask appears here, so it needs no toast.
	useEffect(() => registerWaitingOffersList(), []);
	if (rows.length === 0) return null;

	const setRowBusy = (offerId: string, on: boolean) => setBusy((prev) => {
		const next = new Set(prev);
		if (on) next.add(offerId); else next.delete(offerId);
		return next;
	});

	// A loss that was not on screen when the user clicked shows first and needs a second click.
	const complete = async (row: WaitingOffer) => {
		const id = row.offer.id;
		setRowBusy(id, true);
		const warning = await lossWarning(row, t);
		setRowBusy(id, false);
		if (warning && warnings.get(id) !== warning) {
			setWarnings((prev) => new Map(prev).set(id, warning));
			return;
		}
		row.offer.answer(true);
	};

	const completeAll = async () => {
		const names = answerable.map((row) => `• ${getTaskTitle(row.task)}`).join("\n");
		const ok = await confirm({
			title: t.plural("dashboard.readyToComplete.completeAllTitle", answerable.length),
			message: `${names}\n\n${t("dashboard.readyToComplete.completeAllMessage")}`,
			confirmLabel: t.plural("dashboard.readyToComplete.completeAll", answerable.length),
			danger: true,
		});
		if (!ok) return;
		const kept: string[] = [];
		for (const row of answerable) {
			const warning = await lossWarning(row, t);
			if (warning) {
				kept.push(getTaskTitle(row.task));
				setWarnings((prev) => new Map(prev).set(row.offer.id, warning));
			} else {
				row.offer.answer(true);
			}
		}
		if (kept.length > 0) toast.info(t.plural("dashboard.readyToComplete.kept", kept.length));
	};

	return (
		<section
			aria-labelledby="ready-to-complete-title"
			data-testid="ready-to-complete"
			className="rounded-2xl border border-success/30 bg-raised overflow-hidden"
		>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 md:px-5 py-3 border-b border-edge">
				<div className="min-w-0 flex-1">
					<h2 id="ready-to-complete-title" className="text-fg text-sm font-semibold">
						{t("dashboard.readyToComplete.title")} <span className="text-fg-3 font-normal tabular-nums">{rows.length}</span>
					</h2>
					<p className="text-fg-3 text-xs mt-0.5 text-pretty">{t("dashboard.readyToComplete.hint")}</p>
				</div>
				{answerable.length > 1 && (
					<button
						type="button"
						onClick={() => void completeAll()}
						data-testid="ready-to-complete-all"
						className="px-3 py-1.5 min-h-[44px] md:min-h-0 text-xs whitespace-nowrap rounded-lg text-fg-2 hover:text-fg hover:bg-raised-hover transition-[color,background-color,transform] active:scale-[0.96]"
					>
						{t.plural("dashboard.readyToComplete.completeAll", answerable.length)}
					</button>
				)}
			</div>
			<ul>
				{rows.map((row) => {
					const { offer, task, project } = row;
					// The resource monitor keys usage by the 8-character short task id.
					const rss = usage.get(task.id.slice(0, 8))?.rss;
					const warning = warnings.get(offer.id);
					const checking = busy.has(offer.id);
					const isAgent = offer.kind === "agent";
					const locked = privacy.isLocked(project);
					return (
						<li key={offer.id} data-testid={`ready-to-complete-row-${task.id}`} className="border-b border-edge last:border-b-0">
							<div className="flex flex-wrap md:flex-nowrap items-center gap-x-3 gap-y-1.5 px-3 md:px-5 py-2.5">
								<span
									aria-hidden
									className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs ${isAgent ? "bg-accent/15 text-accent" : "bg-success/15 text-success"}`}
									style={isAgent ? { fontFamily: "'JetBrainsMono Nerd Font Mono'" } : undefined}
								>
									{isAgent ? "\u{F06A9}" : "✓"}
								</span>
								<button
									type="button"
									onClick={() => onOpenTask(task, project)}
									className="min-w-0 flex-1 text-left group"
								>
									<span className={`block truncate text-fg-2 text-sm group-hover:text-accent ${privacy.maskClass(project)}`} title={getTaskTitle(task)}>
										{getTaskTitle(task)}
									</span>
									<span className="block truncate text-fg-3 text-xs">
										<span className={privacy.maskClass(project)}>{projectDisplayName(project, t("ops.boardName"))}</span>
										{" · "}
										{t(isAgent ? "dashboard.readyToComplete.agent" : "dashboard.readyToComplete.merged")}
										{" · "}
										{timeAgo(new Date(offer.offeredAt).toISOString(), t)}
										{rss !== undefined && <span className="tabular-nums">{" · "}{formatBytesCompact(rss)}</span>}
									</span>
								</button>
								{!locked && <div className="flex items-center gap-2 shrink-0 ml-auto">
									<button
										type="button"
										onClick={() => offer.answer(false)}
										className="px-3 py-1.5 min-h-[44px] md:min-h-0 text-xs whitespace-nowrap rounded-lg border border-edge text-fg-2 hover:text-fg hover:bg-raised-hover transition-[color,background-color,transform] active:scale-[0.96]"
									>
										{t("completionStrip.keepOpen")}
									</button>
									<button
										type="button"
										disabled={checking}
										onClick={() => void complete(row)}
										data-testid={`ready-to-complete-complete-${task.id}`}
										className={`px-3 py-1.5 min-h-[44px] md:min-h-0 text-xs whitespace-nowrap rounded-lg text-white transition-[background-color,transform] active:scale-[0.96] ${checking ? "bg-fg-muted/40 cursor-not-allowed" : "bg-danger hover:bg-danger/80"}`}
									>
										{t("app.branchMergedComplete")}
									</button>
								</div>}
							</div>
							{warning && (
								<div className="px-3 md:px-5 pb-2.5 -mt-1 text-xs text-danger whitespace-pre-line" data-testid={`ready-to-complete-warning-${task.id}`}>
									{warning}
								</div>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}
