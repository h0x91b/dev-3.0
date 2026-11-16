import { useCallback, useEffect, useMemo, useState } from "react";
import { getTaskTitle, projectDisplayName, taskSeqLabel, type Project, type ResourceUsage, type Task } from "../../shared/types";
import { useT, type TFunction } from "../i18n";
import { api } from "../rpc";
import { confirm } from "../confirm";
import { toast } from "../toast";
import type { Route } from "../state";
import { useProjectPrivacy } from "../sensitive-projects";
import { offerSettledSignal, pickCompletionOffer, registerWaitingOffersList, useCompletionOffers, type CompletionOffer } from "../completion-offers";
import { askOfferInModal } from "./CompletionOfferDialogHost";
import { completionSkipsGitCheck, unsavedWorkWarning } from "../utils/confirmTaskCompletion";
import { formatBytesCompact } from "../utils/formatBytes";
import { timeAgo } from "../utils/timeAgo";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import Select from "./Select";

/** A merge or agent offer waiting on the user, with the task and project it is about. */
export interface WaitingOffer {
	offer: CompletionOffer;
	task: Task;
	project: Project;
}

export type WaitingSort = "oldest" | "memory";

/**
 * One offer per task, with its task and project. Offers whose task this client has
 * not loaded are left out: the row would have nothing to name.
 */
export function waitingOffers(offers: readonly CompletionOffer[], projects: Project[], tasksByProject: Map<string, Task[]>): WaitingOffer[] {
	const rows: WaitingOffer[] = [];
	for (const taskId of new Set(offers.map((o) => o.taskId))) {
		const offer = pickCompletionOffer(offers, taskId);
		if (!offer) continue;
		const project = projects.find((p) => p.id === offer.projectId);
		const task = tasksByProject.get(offer.projectId)?.find((candidate) => candidate.id === taskId);
		if (project && task) rows.push({ offer, task, project });
	}
	return rows;
}

/** The resource monitor keys usage by the 8-character short task id. */
export function taskRss(usage: Map<string, ResourceUsage>, taskId: string): number | undefined {
	return usage.get(taskId.slice(0, 8))?.rss;
}

/** Total RSS of the tasks with an ask waiting, for the dashboard card and this screen's header. */
export function waitingRss(offers: readonly CompletionOffer[], usage: Map<string, ResourceUsage>): number {
	let total = 0;
	for (const taskId of new Set(offers.map((o) => o.taskId))) total += taskRss(usage, taskId) ?? 0;
	return total;
}

/** What completing would lose, or null when nothing can be lost. A failed check counts as a loss to show. */
async function lossWarning({ task, project, offer }: WaitingOffer, t: TFunction): Promise<string | null> {
	if (completionSkipsGitCheck(task, project)) return null;
	try {
		return unsavedWorkWarning(await api.request.getUnsavedWork({ taskId: offer.taskId, projectId: offer.projectId }), t);
	} catch {
		return t("task.branchStateUnknown");
	}
}

const ALL_PROJECTS = "";

/**
 * Every task waiting for a merge or agent completion answer, across projects, so a
 * user with many tasks can free them in one place. It answers the same offers the
 * task's bar or dialog shows, so an answer here settles the ask everywhere.
 * See `decisions/2026/11/09/ready-to-complete-screen.md`.
 */
export default function ReadyToCompleteScreen({ projects, usage, navigate }: {
	projects: Project[];
	usage: Map<string, ResourceUsage>;
	navigate: (route: Route) => void;
}) {
	const t = useT();
	const privacy = useProjectPrivacy();
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const offers = useCompletionOffers();
	const [tasksByProject, setTasksByProject] = useState<Map<string, Task[]>>(new Map());
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState(ALL_PROJECTS);
	const [sort, setSort] = useState<WaitingSort>("oldest");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [warnings, setWarnings] = useState<Map<string, string>>(new Map());

	useEffect(() => registerWaitingOffersList(), []);

	const loadTasks = useCallback(async () => {
		try {
			const results = await api.request.getAllProjectTasks();
			setTasksByProject(new Map(results.map(({ projectId, tasks }) => [projectId, tasks])));
		} catch (err) {
			console.error("[ReadyToCompleteScreen] getAllProjectTasks failed:", err);
		}
	}, []);
	// An offer for a task this client has not loaded yet triggers one reload.
	const missing = offers.some((o) => !tasksByProject.get(o.projectId)?.some((task) => task.id === o.taskId));
	useEffect(() => { void loadTasks(); }, [loadTasks]);
	useEffect(() => { if (missing) void loadTasks(); }, [missing, loadTasks]);

	const all = useMemo(() => waitingOffers(offers, projects, tasksByProject), [offers, projects, tasksByProject]);
	const rows = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const visible = all.filter((row) => {
			if (scope !== ALL_PROJECTS && row.project.id !== scope) return false;
			if (!needle || privacy.isLocked(row.project)) return !needle;
			return getTaskTitle(row.task).toLowerCase().includes(needle) || row.project.name.toLowerCase().includes(needle);
		});
		return visible.sort((a, b) => sort === "memory"
			? (taskRss(usage, b.task.id) ?? 0) - (taskRss(usage, a.task.id) ?? 0)
			: a.offer.offeredAt - b.offer.offeredAt);
	}, [all, query, scope, sort, usage, privacy]);
	// A locked project's task cannot be read here, so it cannot be answered here either.
	const answerable = rows.filter((row) => !privacy.isLocked(row.project));
	const selectedRows = answerable.filter((row) => selected.has(row.offer.id));
	const allSelected = answerable.length > 0 && selectedRows.length === answerable.length;
	const held = waitingRss(all.map((row) => row.offer), usage);
	const projectOptions = useMemo(() => {
		const ids = new Set(all.map((row) => row.project.id));
		return [
			{ value: ALL_PROJECTS, label: t("completions.allProjects") },
			...projects.filter((p) => ids.has(p.id)).map((p) => ({ value: p.id, label: privacy.isLocked(p) ? "•••" : projectDisplayName(p, t("ops.boardName")) })),
		];
	}, [all, projects, privacy, t]);

	// One row asks in the same modal the Dialog style uses, with its gated unsaved-work check.
	const complete = (row: WaitingOffer) => askOfferInModal(row.offer, { task: row.task, project: row.project }, t, {
		signal: offerSettledSignal(row.offer.id),
		onOpenTask: (taskId, projectId) => navigate({ screen: "project", projectId, activeTaskId: taskId }),
	});

	const completeMany = async (targets: WaitingOffer[]) => {
		const names = targets.slice(0, 12).map((row) => `• #${taskSeqLabel(row.task)} ${getTaskTitle(row.task)}`);
		if (targets.length > names.length) names.push(t.plural("completions.andMore", targets.length - names.length));
		const ok = await confirm({
			title: t.plural("completions.completeManyTitle", targets.length),
			message: `${names.join("\n")}\n\n${t("completions.completeManyMessage")}`,
			confirmLabel: t.plural("completions.completeMany", targets.length),
			danger: true,
		});
		if (!ok) return;
		let kept = 0;
		for (const row of targets) {
			const warning = await lossWarning(row, t);
			if (warning) {
				kept += 1;
				setWarnings((prev) => new Map(prev).set(row.offer.id, warning));
			} else {
				row.offer.answer(true);
			}
		}
		setSelected(new Set());
		if (kept > 0) toast.info(t.plural("completions.kept", kept));
	};

	const toggle = (id: string) => setSelected((prev) => {
		const next = new Set(prev);
		if (next.has(id)) next.delete(id); else next.add(id);
		return next;
	});

	const control = "rounded-lg border border-edge text-fg-2 hover:text-fg hover:bg-raised-hover transition-[color,background-color,transform] active:scale-[0.96]";

	return (
		<div className="h-full overflow-y-auto" data-testid="completions-screen">
			<div className={`mx-auto max-w-5xl space-y-5 ${narrow ? "p-4" : "p-7"}`}>
				<header className="space-y-1">
					<h1 className="text-fg text-2xl font-bold leading-tight">
						{t("completions.title")} <span className="text-fg-3 font-normal tabular-nums">{all.length}</span>
					</h1>
					<p className="text-fg-3 text-sm text-pretty">
						{held > 0 ? t("completions.subtitleHeld", { size: formatBytesCompact(held) }) : t("completions.subtitle")}
					</p>
				</header>

				{all.length === 0 ? (
					<div className="rounded-2xl border border-edge bg-raised px-5 py-10 text-center" data-testid="completions-empty">
						<p className="text-fg-2 text-sm">{t("completions.empty")}</p>
						<button type="button" onClick={() => navigate({ screen: "dashboard" })} className={`mt-4 px-4 py-2 text-sm min-h-[44px] md:min-h-0 ${control}`}>
							{t("completions.backToDashboard")}
						</button>
					</div>
				) : (
					<>
						<div className="flex flex-wrap items-center gap-2">
							<input
								type="search"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder={t("completions.search")}
								aria-label={t("completions.search")}
								className={`${narrow ? "w-full" : "min-w-[12rem] flex-1"} rounded-xl border border-edge bg-elevated px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-muted focus:border-accent/50 transition-colors`}
							/>
							{projectOptions.length > 2 && (
								<div className={narrow ? "min-w-[40%] flex-1" : "w-48"}>
									<Select value={scope} onChange={setScope} options={projectOptions} ariaLabel={t("completions.projectLabel")} />
								</div>
							)}
							<div className={narrow ? "min-w-[40%] flex-1" : "w-44"}>
								<Select
									value={sort}
									onChange={(value) => setSort(value as WaitingSort)}
									options={[
										{ value: "oldest", label: t("completions.sortOldest") },
										{ value: "memory", label: t("completions.sortMemory") },
									]}
									ariaLabel={t("completions.sortLabel")}
								/>
							</div>
						</div>

						<section aria-label={t("completions.title")} className="rounded-2xl border border-edge bg-raised overflow-hidden">
							<div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 md:px-5 py-2.5 border-b border-edge">
								<label className="flex items-center gap-2 text-xs text-fg-3 min-h-[44px] md:min-h-0">
									<input
										type="checkbox"
										checked={allSelected}
										disabled={answerable.length === 0}
										onChange={() => setSelected(allSelected ? new Set() : new Set(answerable.map((row) => row.offer.id)))}
										data-testid="completions-select-all"
									/>
									{selectedRows.length > 0
										? t.plural("completions.selected", selectedRows.length)
										: t.plural("completions.shown", rows.length)}
								</label>
								<div className="ml-auto flex items-center gap-2">
									{selectedRows.length > 0 && (
										<button
											type="button"
											onClick={() => void completeMany(selectedRows)}
											data-testid="completions-complete-selected"
											className="px-3 py-1.5 min-h-[44px] md:min-h-0 text-xs whitespace-nowrap rounded-lg text-white bg-danger-fill hover:bg-danger-fill-hover transition-[background-color,transform] active:scale-[0.96]"
										>
											{t.plural("completions.completeMany", selectedRows.length)}
										</button>
									)}
								</div>
							</div>
							{rows.length === 0 ? (
								<p className="px-5 py-6 text-sm text-fg-3" data-testid="completions-no-match">{t("completions.noMatch")}</p>
							) : (
								<ul>
									{rows.map((row) => {
										const { offer, task, project } = row;
										const rss = taskRss(usage, task.id);
										const warning = warnings.get(offer.id);
										const isAgent = offer.kind === "agent";
										const locked = privacy.isLocked(project);
										return (
											<li key={offer.id} data-testid={`completions-row-${task.id}`} className="border-b border-edge last:border-b-0">
												<div className="flex flex-wrap md:flex-nowrap items-center gap-x-3 gap-y-1.5 px-3 md:px-5 py-2.5">
													<input
														type="checkbox"
														aria-label={getTaskTitle(task)}
														checked={selected.has(offer.id)}
														disabled={locked}
														onChange={() => toggle(offer.id)}
														className={locked ? "invisible" : undefined}
													/>
													<span
														aria-hidden
														className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs ${isAgent ? "bg-accent/15 text-accent" : "bg-success/15 text-success"}`}
														style={isAgent ? { fontFamily: "'JetBrainsMono Nerd Font Mono'" } : undefined}
													>
														{isAgent ? "\u{F06A9}" : "✓"}
													</span>
													<button
														type="button"
														onClick={() => navigate({ screen: "project", projectId: project.id, activeTaskId: task.id })}
														className="min-w-0 flex-1 text-left group"
													>
														<span className="flex min-w-0 items-baseline gap-1.5">
															<span className="shrink-0 font-mono text-xs text-fg-3 tabular-nums">#{taskSeqLabel(task)}</span>
															<span className={`truncate text-fg-2 text-sm group-hover:text-accent ${privacy.maskClass(project)}`} title={locked ? undefined : getTaskTitle(task)}>
																{getTaskTitle(task)}
															</span>
														</span>
														<span className="block truncate text-fg-3 text-xs">
															<span className={privacy.maskClass(project)}>{projectDisplayName(project, t("ops.boardName"))}</span>
															{" · "}
															{t(isAgent ? "completions.agent" : "completions.merged")}
															{" · "}
															{timeAgo(new Date(offer.offeredAt).toISOString(), t)}
															{rss !== undefined && <span className="tabular-nums">{" · "}{formatBytesCompact(rss)}</span>}
														</span>
													</button>
													{!locked && (
														<div className="flex items-center justify-end gap-2 shrink-0 ml-auto max-md:w-full">
															<button
																type="button"
																onClick={() => offer.answer(false)}
																className={`px-3 py-1.5 min-h-[44px] md:min-h-0 text-xs whitespace-nowrap ${control}`}
															>
																{t("completionStrip.keepOpen")}
															</button>
															<button
																type="button"
																onClick={() => void complete(row)}
																data-testid={`completions-complete-${task.id}`}
																className="px-3 py-1.5 min-h-[44px] md:min-h-0 text-xs whitespace-nowrap rounded-lg text-white bg-danger-fill hover:bg-danger-fill-hover transition-[background-color,transform] active:scale-[0.96]"
															>
																{t("app.branchMergedComplete")}
															</button>
														</div>
													)}
												</div>
												{warning && (
													<div className="px-3 md:px-5 pb-2.5 -mt-1 text-xs text-danger whitespace-pre-line" data-testid={`completions-warning-${task.id}`}>
														{warning}
													</div>
												)}
											</li>
										);
									})}
								</ul>
							)}
						</section>
					</>
				)}
			</div>
		</div>
	);
}
