import { Fragment, useMemo, useState } from "react";
import {
	defaultSortDirection,
	formatCostUsd,
	sortSessions,
	summarizeSessions,
	type ClaudeSessionStats,
	type SessionSortKey,
	type SortDirection,
} from "../../shared/session-stats";
import { useAgentRateLimitsReport } from "../hooks/useAgentRateLimitsReport";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { useNow } from "../hooks/useNow";
import { useT, type TranslationKey } from "../i18n";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import { formatAge } from "./rate-limit-ui";
import { CacheState, ContextBar, SessionDetails, contextTone } from "./session-stats-ui";
import Select from "./Select";

const ALL_PROJECTS = "__all__";

/** Narrow widths have no column headers, so sorting is one of these named orders. */
const SORT_PRESETS: { id: string; key: SessionSortKey; dir: SortDirection; label: TranslationKey }[] = [
	{ id: "attention", key: "attention", dir: "asc", label: "sessions.sort.attention" },
	{ id: "cache", key: "cache", dir: "asc", label: "sessions.sort.cache" },
	{ id: "cost", key: "cost", dir: "desc", label: "sessions.sort.cost" },
	{ id: "context", key: "context", dir: "desc", label: "sessions.sort.context" },
	{ id: "updated", key: "updated", dir: "desc", label: "sessions.sort.updated" },
	{ id: "task", key: "task", dir: "asc", label: "sessions.sort.task" },
];

function matches(session: ClaudeSessionStats, query: string): boolean {
	const q = query.trim().toLocaleLowerCase().replace(/^#/, "");
	if (!q) return true;
	return (
		(session.taskTitle?.toLocaleLowerCase().includes(q) ?? false) ||
		(session.taskSeq != null && String(session.taskSeq).startsWith(q))
	);
}

interface SessionsScreenProps {
	/** The project the user came from; the initial scope. Null starts on all projects. */
	projectId: string | null;
	projectName: string | null;
	onOpenTask: (taskId: string, projectId: string) => void;
}

/**
 * Every live Claude task session, sortable and searchable. The usage panel's
 * strip shows only what needs attention; this screen is where the full list lives.
 * Read-only: the one thing a row does is open its task.
 */
export default function SessionsScreen({ projectId, projectName, onOpenTask }: SessionsScreenProps) {
	const t = useT();
	const report = useAgentRateLimitsReport();
	const now = useNow();
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [scope, setScope] = useState<string>(projectId ?? ALL_PROJECTS);
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<{ key: SessionSortKey; dir: SortDirection }>({ key: "attention", dir: "asc" });
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

	const scoped = useMemo(
		() => (report?.sessions ?? []).filter((s) => scope === ALL_PROJECTS || s.projectId === scope),
		[report, scope],
	);
	const rows = sortSessions(
		scoped.filter((s) => matches(s, query)),
		sort.key,
		sort.dir,
		now,
	);
	const summary = summarizeSessions(scoped, now);
	const showProject = scope === ALL_PROJECTS;

	const toggleExpanded = (taskId: string) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(taskId)) next.delete(taskId);
			else next.add(taskId);
			return next;
		});

	const sortBy = (key: SessionSortKey) =>
		setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: defaultSortDirection(key) }));

	const summaryParts = [t.plural("rateLimits.sessionsCount", summary.count)];
	if (summary.warm > 0) summaryParts.push(t.plural("rateLimits.sessionsWarm", summary.warm));
	if (summary.costUsd != null) summaryParts.push(formatCostUsd(summary.costUsd));

	const taskLink = (s: ClaudeSessionStats) => (
		<button
			type="button"
			onClick={() => s.projectId && onOpenTask(s.taskId, s.projectId)}
			className="flex min-w-0 max-w-full items-baseline gap-1.5 text-left hover:text-accent-emphasis focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent rounded"
			title={s.taskTitle ?? undefined}
		>
			{s.taskSeq != null && <span className="shrink-0 tabular-nums text-fg-muted">#{s.taskSeq}</span>}
			<span className="min-w-0 truncate text-fg">{s.taskTitle}</span>
		</button>
	);

	const contextCell = (s: ClaudeSessionStats) => {
		if (s.contextPercent == null) return <span className="text-fg-muted">-</span>;
		const percent = Math.round(s.contextPercent);
		return (
			<span className={`inline-flex items-center gap-1.5 tabular-nums ${contextTone(percent)}`}>
				<ContextBar percent={percent} />
				{percent}%
			</span>
		);
	};

	const detailsToggle = (s: ClaudeSessionStats) => (
		<button
			type="button"
			onClick={() => toggleExpanded(s.taskId)}
			aria-expanded={expanded.has(s.taskId)}
			aria-label={`${t("sessions.details")}: ${s.taskTitle ?? ""}`}
			className="rounded px-1.5 py-0.5 text-fg-3 hover:bg-elevated hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
		>
			<span aria-hidden="true" className={`inline-block transition-transform ${expanded.has(s.taskId) ? "rotate-90" : ""}`}>
				›
			</span>
		</button>
	);

	const columns: { key: SessionSortKey; label: TranslationKey; align?: "right" }[] = [
		{ key: "task", label: "sessions.col.task" },
		...(showProject ? [{ key: "project" as const, label: "sessions.col.project" as const }] : []),
		{ key: "context", label: "sessions.col.context" },
		{ key: "cache", label: "sessions.col.cache" },
		{ key: "cost", label: "sessions.col.cost", align: "right" },
		{ key: "model", label: "sessions.col.model" },
		{ key: "updated", label: "sessions.col.updated", align: "right" },
	];

	const empty = scoped.length === 0;

	return (
		<div className="h-full overflow-y-auto">
			<div className={`mx-auto max-w-6xl space-y-4 ${narrow ? "p-4" : "p-7"}`}>
				<header className="space-y-1">
					<h1 className="text-fg text-2xl font-bold leading-tight">{t("sessions.title")}</h1>
					<p className="text-fg-3 text-sm">
						{t("sessions.subtitle")}
						{!empty && <span className="tabular-nums"> · {summaryParts.join(" · ")}</span>}
					</p>
				</header>

				<div className="flex flex-wrap items-center gap-2">
					<input
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t("sessions.search")}
						aria-label={t("sessions.search")}
						className={`${narrow ? "w-full" : "min-w-[12rem] flex-1"} rounded-xl border border-edge bg-base px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-muted focus:border-accent/60 focus:ring-2 focus:ring-accent/20`}
					/>
					{projectId && (
						<div className={narrow ? "min-w-0 flex-1" : "w-48"}>
							<Select
								value={scope}
								onChange={setScope}
								options={[
									{ value: projectId, label: projectName ?? projectId },
									{ value: ALL_PROJECTS, label: t("sessions.scopeAll") },
								]}
								ariaLabel={t("sessions.scopeLabel")}
							/>
						</div>
					)}
					{narrow && (
						<div className="min-w-0 flex-1">
							<Select
								value={SORT_PRESETS.find((p) => p.key === sort.key && p.dir === sort.dir)?.id ?? ""}
								onChange={(id) => {
									const preset = SORT_PRESETS.find((p) => p.id === id);
									if (preset) setSort({ key: preset.key, dir: preset.dir });
								}}
								options={SORT_PRESETS.map((p) => ({ value: p.id, label: t(p.label) }))}
								ariaLabel={t("sessions.sortLabel")}
								placeholder={t("sessions.sortLabel")}
							/>
						</div>
					)}
				</div>

				{empty ? (
					<div className="rounded-2xl border border-edge border-dashed bg-raised px-4 py-8 text-center">
						<p className="text-fg-2 text-sm font-semibold">{t("sessions.empty")}</p>
						<p className="mt-1 text-fg-muted text-xs">{t("sessions.emptyHint")}</p>
					</div>
				) : rows.length === 0 ? (
					<p className="px-1 text-fg-muted text-sm">{t("sessions.noMatch")}</p>
				) : narrow ? (
					<ul className="space-y-2">
						{rows.map((s) => (
							<li key={s.taskId} className="space-y-1 rounded-xl bg-raised px-3 py-2 text-sm">
								<div className="flex items-baseline gap-2">
									<div className="min-w-0 flex-1">{taskLink(s)}</div>
									{s.costUsd != null && (
										<span className="shrink-0 font-semibold tabular-nums text-fg-2">{formatCostUsd(s.costUsd)}</span>
									)}
									{detailsToggle(s)}
								</div>
								<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-fg-3">
									{showProject && s.projectName && <span>{s.projectName}</span>}
									{contextCell(s)}
									<CacheState session={s} now={now} />
									{s.model && <span>{s.model}</span>}
								</div>
								{expanded.has(s.taskId) && (
									<div className="text-xs">
										<SessionDetails session={s} />
									</div>
								)}
							</li>
						))}
					</ul>
				) : (
					<div className="overflow-x-auto rounded-2xl border border-edge bg-raised">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-edge text-left text-xs text-fg-muted">
									{columns.map((col) => (
										<th
											key={col.key}
											scope="col"
											aria-sort={
												sort.key === col.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined
											}
											className={`px-3 py-2 font-medium ${col.align === "right" ? "text-right" : ""}`}
										>
											<button
												type="button"
												onClick={() => sortBy(col.key)}
												className={`rounded hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
													sort.key === col.key ? "text-fg-2" : ""
												}`}
											>
												{t(col.label)}
												{sort.key === col.key && <span aria-hidden="true">{sort.dir === "asc" ? " ↑" : " ↓"}</span>}
											</button>
										</th>
									))}
									<th scope="col" className="w-8 px-2 py-2">
										<span className="sr-only">{t("sessions.details")}</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((s) => (
									<Fragment key={s.taskId}>
										<tr className="border-b border-edge/60 last:border-b-0 hover:bg-raised-hover">
											<td className="max-w-[18rem] px-3 py-2">{taskLink(s)}</td>
											{showProject && (
												<td className="max-w-[9rem] truncate whitespace-nowrap px-3 py-2 text-fg-3" title={s.projectName ?? undefined}>
													{s.projectName}
												</td>
											)}
											<td className="px-3 py-2">{contextCell(s)}</td>
											<td className="whitespace-nowrap px-3 py-2">
												<CacheState session={s} now={now} />
											</td>
											<td className="px-3 py-2 text-right font-semibold tabular-nums text-fg-2">
												{s.costUsd != null ? formatCostUsd(s.costUsd) : "-"}
											</td>
											<td className="max-w-[11rem] truncate whitespace-nowrap px-3 py-2 text-fg-3" title={s.model ?? undefined}>
												{s.model ?? "-"}
											</td>
											<td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-fg-3">
												{now - s.capturedAt < 60_000 ? t("rateLimits.capturedAgeNow") : formatAge(now - s.capturedAt)}
											</td>
											<td className="px-2 py-2 text-right">{detailsToggle(s)}</td>
										</tr>
										{expanded.has(s.taskId) && (
											<tr className="border-b border-edge/60 last:border-b-0">
												<td colSpan={columns.length + 1} className="px-3 pb-2 text-xs">
													<SessionDetails session={s} />
												</td>
											</tr>
										)}
									</Fragment>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>
		</div>
	);
}
