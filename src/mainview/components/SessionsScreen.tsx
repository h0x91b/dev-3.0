import { Fragment, useMemo, useState } from "react";
import {
	defaultSortDirection,
	formatCostUsd,
	sessionAttention,
	sortSessions,
	summarizeSessions,
	type AgentSessionStats,
	type SessionSortKey,
	type SortDirection,
} from "../../shared/session-stats";
import { useAgentRateLimitsReport } from "../hooks/useAgentRateLimitsReport";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { useNow } from "../hooks/useNow";
import { useT, type TranslationKey } from "../i18n";
import { useProjectPrivacy } from "../sensitive-projects";
import { useStreamerMode } from "../streamer-mode";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import { formatAge } from "./rate-limit-ui";
import { SOURCE_NAMES } from "./rate-limit-ui";
import { CachePill, ContextBar, SessionDetails, contextTone, sessionDetailItems, useSessionAccountLabel } from "./session-stats-ui";
import Select, { type SelectOption } from "./Select";

const ALL_PROJECTS = "__all__";
const ALL_ACCOUNTS = "__all__";

/** One login across agents: a source plus its account key. */
const accountKey = (s: AgentSessionStats) => `${s.source}:${s.configDir ?? s.accountId ?? ""}`;

/** Narrow widths have no column headers, so sorting is one of these named orders. */
const SORT_PRESETS: { id: string; key: SessionSortKey; dir: SortDirection; label: TranslationKey }[] = [
	{ id: "attention", key: "attention", dir: "asc", label: "sessions.sort.attention" },
	{ id: "cache", key: "cache", dir: "asc", label: "sessions.sort.cache" },
	{ id: "cost", key: "cost", dir: "desc", label: "sessions.sort.cost" },
	{ id: "context", key: "context", dir: "desc", label: "sessions.sort.context" },
	{ id: "updated", key: "updated", dir: "desc", label: "sessions.sort.updated" },
	{ id: "task", key: "task", dir: "asc", label: "sessions.sort.task" },
];

function matches(session: AgentSessionStats, query: string): boolean {
	const q = query.trim().toLocaleLowerCase().replace(/^#/, "");
	if (!q) return true;
	return (
		(session.taskTitle?.toLocaleLowerCase().includes(q) ?? false) ||
		(session.taskSeq != null && String(session.taskSeq).startsWith(q))
	);
}

export interface SessionsScreenProps {
	/** The project the user came from; the initial scope. Null starts on all projects. */
	projectId: string | null;
	projectName: string | null;
	onOpenTask: (taskId: string, projectId: string) => void;
}

/**
 * Every live agent task session (Claude today), sortable and searchable. The usage panel's
 * strip shows only what needs attention; this screen is where the full list lives.
 * Read-only: the one thing a row does is open its task.
 */
export default function SessionsScreen({ projectId, projectName, onOpenTask }: SessionsScreenProps) {
	const t = useT();
	const report = useAgentRateLimitsReport();
	const now = useNow();
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [scope, setScope] = useState<string>(projectId ?? ALL_PROJECTS);
	const [account, setAccount] = useState<string>(ALL_ACCOUNTS);
	const accountLabel = useSessionAccountLabel();
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<{ key: SessionSortKey; dir: SortDirection }>({ key: "attention", dir: "asc" });
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const privacy = useProjectPrivacy();
	const streamer = useStreamerMode();

	const sessions = useMemo(() => report?.sessions ?? [], [report]);
	const scoped = useMemo(
		() =>
			sessions.filter(
				(s) => (scope === ALL_PROJECTS || s.projectId === scope) && (account === ALL_ACCOUNTS || accountKey(s) === account),
			),
		[sessions, scope, account],
	);
	// Offered only when sessions bill more than one login; one option is no choice.
	const accountLogins = useMemo(() => {
		const logins = new Map<string, { source: string; name: string }>();
		for (const s of sessions) {
			const key = accountKey(s);
			if (!logins.has(key)) logins.set(key, { source: SOURCE_NAMES[s.source] ?? s.source, name: accountLabel(s) });
		}
		return logins;
	}, [sessions, accountLabel]);
	const accountOptions = useMemo(() => {
		if (accountLogins.size < 2) return [];
		const options = [...accountLogins]
			.map(([value, { source, name }]) => ({ value, label: `${source} · ${name}` }))
			.sort((a, b) => a.label.localeCompare(b.label));
		return [{ value: ALL_ACCOUNTS, label: t("sessions.accountsAll") }, ...options];
	}, [accountLogins, t]);
	// A login is an email: blur it in streamer mode, in the list and on the trigger alike.
	const renderAccountOption = (option: SelectOption) => {
		const login = accountLogins.get(option.value);
		if (!login) return option.label;
		return (
			<>
				{login.source} · <span className="streamer-private">{login.name}</span>
			</>
		);
	};
	const projectOptions = useMemo(() => {
		const names = new Map<string, string>();
		if (projectId) names.set(projectId, projectName ?? projectId);
		for (const s of sessions) {
			if (s.projectId && !names.has(s.projectId)) names.set(s.projectId, s.projectName ?? s.projectId);
		}
		const projects = [...names]
			.map(([id, name]) => ({ value: id, label: privacy.isLocked(id) ? t("streamer.privateTitle") : name }))
			.sort((a, b) => a.label.localeCompare(b.label));
		return [{ value: ALL_PROJECTS, label: t("sessions.scopeAll") }, ...projects];
	}, [sessions, projectId, projectName, privacy, t]);
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

	const attentionCount = scoped.filter((s) => sessionAttention(s, now) != null).length;
	const expiringCount = scoped.filter((s) => sessionAttention(s, now) === "cacheExpiring").length;
	const projectCount = new Set(scoped.map((s) => s.projectId)).size;

	// A native tooltip is not blurred, so a masked cell carries none.
	const unlessLocked = (s: AgentSessionStats, text: string | null) =>
		privacy.isLocked(s.projectId) ? undefined : (text ?? undefined);

	/** A small mark before the title: the row is in the attention set, and why. */
	const attentionMark = (s: AgentSessionStats) => {
		const reason = sessionAttention(s, now);
		return (
			<span
				aria-hidden="true"
				className={`h-1.5 w-1.5 shrink-0 self-center rounded-full ${
					reason === "cacheExpiring" ? "bg-warning" : reason === "context" ? "bg-danger" : "bg-transparent"
				}`}
			/>
		);
	};

	const taskLink = (s: AgentSessionStats) => (
		<button
			type="button"
			onClick={() => s.projectId && onOpenTask(s.taskId, s.projectId)}
			className="group flex min-w-0 max-w-full items-baseline gap-1.5 rounded text-left outline-none"
			title={unlessLocked(s, s.taskTitle)}
		>
			{s.taskSeq != null && <span className="shrink-0 tabular-nums text-fg-muted">#{s.taskSeq}</span>}
			<span className={`min-w-0 truncate font-medium text-fg group-hover:text-accent-emphasis ${privacy.maskClass(s.projectId)}`}>
				{s.taskTitle}
			</span>
		</button>
	);

	/** Which agent, which model, and the login it bills — one cell, two lines. */
	const agentCell = (s: AgentSessionStats) => (
		<span className="flex min-w-0 flex-col gap-0.5">
			<span className="flex min-w-0 items-center gap-1.5">
				<span className="shrink-0 rounded-md bg-elevated px-1.5 py-0.5 text-micro font-semibold uppercase tracking-wider text-fg-2">
					{SOURCE_NAMES[s.source] ?? s.source}
				</span>
				{s.model && (
					<span className="min-w-0 truncate text-fg-2" title={s.model}>
						{s.model}
					</span>
				)}
			</span>
			<span className="min-w-0 truncate text-xs text-fg-muted streamer-private" title={streamer ? undefined : accountLabel(s)}>
				{accountLabel(s)}
			</span>
		</span>
	);

	const contextCell = (s: AgentSessionStats) => {
		if (s.contextPercent == null) return <span className="text-fg-muted">-</span>;
		const percent = Math.round(s.contextPercent);
		return (
			<span className={`inline-flex items-center gap-2 tabular-nums ${contextTone(percent)}`}>
				<ContextBar percent={percent} wide />
				{percent}%
			</span>
		);
	};

	const detailsToggle = (s: AgentSessionStats) =>
		sessionDetailItems(s, t).length > 0 && (
			<button
				type="button"
				onClick={() => toggleExpanded(s.taskId)}
				aria-expanded={expanded.has(s.taskId)}
				aria-label={`${t("sessions.details")}: ${privacy.isLocked(s.projectId) ? "" : (s.taskTitle ?? "")}`}
				className="grid h-7 w-7 place-items-center rounded-lg text-fg-3 hover:bg-elevated hover:text-fg active:scale-[0.96] transition-[background-color,color,scale]"
			>
				<span
					aria-hidden="true"
					className={`inline-block transition-transform duration-150 ${expanded.has(s.taskId) ? "rotate-90" : ""}`}
				>
					›
				</span>
			</button>
		);

	const updatedLabel = (s: AgentSessionStats) =>
		now - s.capturedAt < 60_000 ? t("rateLimits.capturedAgeNow") : formatAge(now - s.capturedAt);

	const columns: { key: SessionSortKey | null; label: TranslationKey; align?: "right" }[] = [
		{ key: "task", label: "sessions.col.task" },
		{ key: null, label: "sessions.col.account" },
		{ key: "context", label: "sessions.col.context" },
		{ key: "cache", label: "sessions.col.cache" },
		{ key: "cost", label: "sessions.col.cost", align: "right" },
		{ key: "updated", label: "sessions.col.updated", align: "right" },
	];

	const empty = scoped.length === 0;
	const kpis: { label: string; value: string; hint: string; tone?: string }[] = [
		{ label: t("sessions.kpi.sessions"), value: String(summary.count), hint: t.plural("sessions.kpi.projects", projectCount) },
		{ label: t("sessions.kpi.warm"), value: String(summary.warm), hint: t.plural("sessions.kpi.warmOf", summary.count) },
		{
			label: t("sessions.kpi.attention"),
			value: String(attentionCount),
			hint: t("sessions.kpi.attentionHint"),
			tone: attentionCount > 0 ? (expiringCount > 0 ? "text-warning-strong" : "text-danger") : undefined,
		},
		{
			label: t("sessions.kpi.cost"),
			value: summary.costUsd != null ? formatCostUsd(summary.costUsd) : "-",
			hint: t("sessions.kpi.costHint"),
		},
	];

	return (
		<div className="h-full overflow-y-auto">
			<div className={`mx-auto max-w-6xl space-y-5 ${narrow ? "p-4" : "p-7"}`}>
				<header className="space-y-1">
					<h1 className="text-fg text-2xl font-bold leading-tight">{t("sessions.title")}</h1>
					<p className="text-fg-3 text-sm">{t("sessions.subtitle")}</p>
				</header>

				{!empty && (
					<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
						{kpis.map((kpi) => (
							<div key={kpi.label} className="rounded-2xl border border-edge bg-raised px-4 py-3">
								<div className="text-xs text-fg-3">{kpi.label}</div>
								<div className={`mt-1 text-2xl font-semibold leading-tight tabular-nums ${kpi.tone ?? "text-fg"}`}>{kpi.value}</div>
								<div className={`mt-0.5 text-xs text-fg-muted ${narrow ? "text-pretty" : "truncate"}`}>{kpi.hint}</div>
							</div>
						))}
					</div>
				)}

				<div className="flex flex-wrap items-center gap-2">
					<input
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t("sessions.search")}
						aria-label={t("sessions.search")}
						className={`${narrow ? "w-full" : "min-w-[12rem] flex-1"} rounded-xl border border-edge bg-elevated px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-muted focus:border-accent/50 transition-colors`}
					/>
					{projectOptions.length > 1 && (
						<div className={narrow ? "min-w-[40%] flex-1" : "w-48"}>
							<Select value={scope} onChange={setScope} options={projectOptions} ariaLabel={t("sessions.scopeLabel")} />
						</div>
					)}
					{accountOptions.length > 0 && (
						<div className={narrow ? "min-w-[40%] flex-1" : "w-56"}>
							<Select value={account} onChange={setAccount} options={accountOptions}
								renderOption={renderAccountOption}
								ariaLabel={t("sessions.accountLabel")}
							/>
						</div>
					)}
					{narrow && (
						<div className="min-w-[40%] flex-1">
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

				{empty && (scope !== ALL_PROJECTS || account !== ALL_ACCOUNTS) && sessions.length > 0 ? (
					<div className="rounded-2xl border border-edge border-dashed bg-raised px-4 py-8 text-center">
						<p className="text-fg-2 text-sm font-semibold">{t("sessions.emptyScope")}</p>
						<button
							type="button"
							onClick={() => {
								setScope(ALL_PROJECTS);
								setAccount(ALL_ACCOUNTS);
							}}
							className="mt-1 rounded text-accent text-xs hover:text-accent-emphasis hover:underline"
						>
							{t("sessions.showAllProjects")}
						</button>
					</div>
				) : empty ? (
					<div className="rounded-2xl border border-edge border-dashed bg-raised px-4 py-8 text-center">
						<p className="text-fg-2 text-sm font-semibold">{t("sessions.empty")}</p>
						<p className="mt-1 text-fg-muted text-xs">{t("sessions.emptyHint")}</p>
					</div>
				) : rows.length === 0 ? (
					<p className="px-1 text-fg-muted text-sm">{t("sessions.noMatch")}</p>
				) : narrow ? (
					<ul className="space-y-2">
						{rows.map((s) => (
							<li key={s.taskId} className="space-y-2 rounded-2xl border border-edge bg-raised px-3 py-2.5 text-sm">
								<div className="flex items-center gap-2">
									{attentionMark(s)}
									<div className="min-w-0 flex-1">{taskLink(s)}</div>
									{s.costUsd != null && (
										<span className="shrink-0 font-semibold tabular-nums text-fg-2">{formatCostUsd(s.costUsd)}</span>
									)}
									{detailsToggle(s)}
								</div>
								<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-fg-3">
									{contextCell(s)}
									<CachePill session={s} now={now} />
								</div>
								<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-3">
									{agentCell(s)}
									{showProject && s.projectName && <span className={privacy.maskClass(s.projectId)}>{s.projectName}</span>}
								</div>
								{expanded.has(s.taskId) && (
									<div className="rounded-lg bg-base/40 px-2.5 py-2 text-xs">
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
											key={col.label}
											scope="col"
											aria-sort={
												col.key && sort.key === col.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined
											}
											className={`px-3 py-2.5 font-medium whitespace-nowrap ${col.align === "right" ? "text-right" : ""} ${
												col.key === "task" ? "pl-5" : ""
											}`}
										>
											{col.key ? (
												<button
													type="button"
													onClick={() => sortBy(col.key!)}
													className={`rounded hover:text-fg ${sort.key === col.key ? "text-fg-2" : ""}`}
												>
													{t(col.label)}
													{sort.key === col.key && <span aria-hidden="true">{sort.dir === "asc" ? " ↑" : " ↓"}</span>}
												</button>
											) : (
												t(col.label)
											)}
										</th>
									))}
									<th scope="col" className="w-10 px-2 py-2.5">
										<span className="sr-only">{t("sessions.details")}</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((s) => (
									<Fragment key={s.taskId}>
										<tr className="border-b border-edge/60 last:border-b-0 hover:bg-raised-hover transition-colors">
											<td className="max-w-[22rem] py-2.5 pl-2 pr-3">
												<div className="flex items-center gap-1.5">
													{attentionMark(s)}
													<div className="min-w-0">
														{taskLink(s)}
														{showProject && s.projectName && (
															<div
																className={`truncate text-xs text-fg-muted ${privacy.maskClass(s.projectId)}`}
																title={unlessLocked(s, s.projectName)}
															>
																{s.projectName}
															</div>
														)}
													</div>
												</div>
											</td>
											<td className="max-w-[16rem] px-3 py-2.5">{agentCell(s)}</td>
											<td className="px-3 py-2.5">{contextCell(s)}</td>
											<td className="px-3 py-2.5">
												<CachePill session={s} now={now} />
											</td>
											<td className="px-3 py-2.5 text-right font-semibold tabular-nums text-fg-2">
												{s.costUsd != null ? formatCostUsd(s.costUsd) : "-"}
											</td>
											<td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-fg-3">{updatedLabel(s)}</td>
											<td className="px-2 py-2.5 text-right">{detailsToggle(s)}</td>
										</tr>
										{expanded.has(s.taskId) && (
											<tr className="border-b border-edge/60 last:border-b-0">
												<td colSpan={columns.length + 1} className="px-5 pb-3 pt-0 text-xs">
													<div className="rounded-lg bg-base/40 px-3 py-2">
														<SessionDetails session={s} />
													</div>
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
