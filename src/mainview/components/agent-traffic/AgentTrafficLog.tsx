import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentMessageLogRow } from "../../../shared/agent-message-log";
import { isUnsettled, type TrafficPair } from "../../agent-traffic";
import { useT } from "../../i18n";
import { api } from "../../rpc";
import { useAgentTraffic } from "../../hooks/useAgentTraffic";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { useNarrowViewport } from "../../hooks/useNarrowViewport";
import { useFocusTrap } from "../../utils/useFocusTrap";
import { CAROUSEL_MAX_WIDTH } from "../MobileBoardCarousel";
import BottomSheet from "../BottomSheet";
import { LedgerRow, PairRow } from "./TrafficRow";

/**
 * Every message the project's agents typed into each other, newest first.
 *
 * **An overlay, not a destination.** The global-nav budget is eight and fully
 * spent (bible §4), and this is a log a user opens to answer one question and
 * then leaves — the same shape as the task-notes log: dialog on wide, the
 * mandated BottomSheet on narrow.
 *
 * Filters are only the two that real data supports: one pair, or only the
 * messages dev3 could not prove landed. There is deliberately no importance
 * filter — no sender can mark a message important, so a chatter/blocker split
 * would be the UI inventing a fact.
 */

type Filter = "all" | "unsettled";

interface AgentTrafficLogProps {
	projectId: string | null;
	onClose: () => void;
	onOpenTask: (taskId: string, projectId: string) => void;
}

export default function AgentTrafficLog({ projectId, onClose, onOpenTask }: AgentTrafficLogProps) {
	const t = useT();
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const traffic = useAgentTraffic(projectId);
	const [filter, setFilter] = useState<Filter>("all");
	const [pairKey, setPairKey] = useState<string | null>(null);
	// Which receivers still exist. History outlives tasks: 30 days of rows will name
	// tasks the user has since deleted, and a row that navigates nowhere — closing
	// the log and leaving the board unchanged — reads as the app being broken.
	const [knownTasks, setKnownTasks] = useState<Set<string> | null>(null);

	useEffect(() => {
		if (!projectId) return;
		let cancelled = false;
		api.request
			.getTasks({ projectId })
			.then((tasks) => {
				if (!cancelled) setKnownTasks(new Set(tasks.map((task) => task.id)));
			})
			.catch(() => {
				// Unresolved: leave every row inert rather than promising navigation.
				if (!cancelled) setKnownTasks(new Set());
			});
		return () => {
			cancelled = true;
		};
	}, [projectId]);

	const selectedPair = traffic.pairs.find((pair) => pair.key === pairKey) ?? null;
	const rows = useMemo(() => {
		const pairIds = selectedPair ? new Set([selectedPair.toTaskId, selectedPair.last.fromTaskId]) : null;
		return traffic.rows.filter((row) => {
			if (filter === "unsettled" && !isUnsettled(row.status)) return false;
			if (!pairIds) return true;
			return pairIds.has(row.toTaskId) && pairIds.has(row.fromTaskId);
		});
	}, [traffic.rows, filter, selectedPair]);

	function togglePair(pair: TrafficPair) {
		setPairKey((current) => (current === pair.key ? null : pair.key));
	}

	const title = selectedPair
		? `#${selectedPair.fromSeq ?? "—"} ↔ #${selectedPair.toSeq}`
		: t("traffic.logTitle");

	const body = (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center gap-1.5 px-3 py-2 border-b border-edge">
				<FilterChip active={filter === "all"} onClick={() => setFilter("all")} label={t("traffic.filter.all")} />
				<FilterChip
					active={filter === "unsettled"}
					onClick={() => setFilter("unsettled")}
					label={t("traffic.filter.unsettled")}
				/>
				<span className="ml-auto text-nano tabular-nums text-fg-muted">
					{t("traffic.shownCount", { shown: String(rows.length), total: String(traffic.rows.length) })}
				</span>
			</div>

			<div className="flex min-h-0 flex-1 flex-col md:flex-row">
				{/* The pair index is a filter over the ledger beside it, not a second list
				    of messages: one place owns the text. */}
				{/* Stacked on narrow, the index and the ledger read as one list of
				    near-duplicate rows without a rule between them. */}
				<div className="md:w-64 shrink-0 border-b md:border-b-0 md:border-r border-edge bg-raised/40 md:bg-transparent overflow-y-auto max-h-40 md:max-h-none">
					{traffic.pairs.map((pair) => (
						<PairRow
							key={pair.key}
							pair={pair}
							selected={pair.key === pairKey}
							onSelect={togglePair}
						/>
					))}
					{traffic.pairs.length === 0 && (
						<div className="px-3 py-3 text-dense text-fg-muted">{t("traffic.empty")}</div>
					)}
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto">
					{rows.length === 0 ? (
						<div className="px-3 py-6 text-center text-dense text-fg-muted">
							{traffic.loading ? t("traffic.loading") : t("traffic.noneMatch")}
						</div>
					) : (
						<Ledger rows={rows} onOpenTask={onOpenTask} knownTasks={knownTasks} />
					)}
				</div>
			</div>

			{/* Trimmed history must read as trimmed, never as silence. */}
			<div className="px-3 py-2 border-t border-edge text-nano text-fg-muted">
				{traffic.oldestDay
					? t("traffic.retention", { days: String(traffic.retentionDays), oldest: traffic.oldestDay })
					: t("traffic.retentionEmpty", { days: String(traffic.retentionDays) })}
			</div>
		</div>
	);

	if (narrow) {
		return (
			<BottomSheet open onClose={onClose} title={title} testId="agent-traffic-log-sheet">
				<div className="flex h-[70dvh] flex-col">{body}</div>
			</BottomSheet>
		);
	}

	return createPortal(
		<LogDialog title={title} onClose={onClose}>
			{body}
		</LogDialog>,
		document.body,
	);
}

function Ledger({
	rows,
	onOpenTask,
	knownTasks,
}: {
	rows: AgentMessageLogRow[];
	onOpenTask: (taskId: string, projectId: string) => void;
	/** Null until the project's tasks have been resolved. */
	knownTasks: Set<string> | null;
}) {
	const t = useT();
	let day: string | null = null;
	const out: React.ReactNode[] = [];
	for (const row of rows) {
		const rowDay = localDay(row.at);
		if (rowDay !== day) {
			day = rowDay;
			out.push(
				<div
					key={`day-${rowDay}`}
					className="sticky top-0 bg-overlay/95 px-3 py-1 text-nano uppercase tracking-wide text-fg-muted"
				>
					{dayLabel(rowDay, t)}
				</div>,
			);
		}
		const key = `${row.at}-${row.toTaskId}-${row.fromSeq ?? "x"}`;
		const openable = knownTasks?.has(row.toTaskId) ?? false;
		out.push(
			openable ? (
				<button
					key={key}
					type="button"
					className="block w-full text-left hover:bg-elevated/60 transition-colors active:scale-[0.96]"
					onClick={() => onOpenTask(row.toTaskId, row.toProjectId)}
				>
					<LedgerRow row={row} />
				</button>
			) : (
				// The message stays readable; only the promise of navigation is withdrawn.
				<div key={key} title={knownTasks ? t("traffic.taskGone") : undefined}>
					<LedgerRow row={row} gone={Boolean(knownTasks)} />
				</div>
			),
		);
	}
	return <div>{out}</div>;
}

/** The row's LOCAL day. The on-disk day-files are local days too, so an ISO slice
 *  (which is UTC) would split one evening across two headings. */
function localDay(at: string): string {
	const date = new Date(at);
	if (Number.isNaN(date.getTime())) return at.slice(0, 10);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Today and yesterday by name; anything older keeps its ISO day. */
function dayLabel(day: string, t: ReturnType<typeof useT>): string {
	const now = new Date();
	const iso = (date: Date) =>
		`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
	if (day === iso(now)) return t("traffic.today");
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (day === iso(yesterday)) return t("traffic.yesterday");
	return day;
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onClick}
			className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors active:scale-[0.96] ${
				active ? "bg-accent/15 text-accent" : "text-fg-3 hover:text-fg-2 hover:bg-raised-hover"
			}`}
		>
			{label}
		</button>
	);
}

function LogDialog({
	title,
	onClose,
	children,
}: {
	title: string;
	onClose: () => void;
	children: React.ReactNode;
}) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	useEscapeKey(onClose);

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="agent-traffic-log-title"
				tabIndex={-1}
				data-testid="agent-traffic-log-dialog"
				data-help-id="traffic.log"
				className="bg-overlay rounded-2xl shadow-2xl shadow-black/50 border border-edge-active w-full max-w-4xl max-h-[calc(100dvh-4rem)] mx-4 flex flex-col overflow-hidden outline-none"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="px-5 py-3 border-b border-edge flex items-center justify-between gap-3">
					<h2 id="agent-traffic-log-title" className="text-fg text-base font-semibold">
						{title}
					</h2>
					<button
						type="button"
						onClick={onClose}
						aria-label={t("common.close")}
						className="-mr-1.5 flex h-9 w-9 items-center justify-center rounded-lg text-fg-muted hover:bg-elevated hover:text-fg transition-colors active:scale-[0.96]"
					>
						<span className="text-base leading-none">×</span>
					</button>
				</div>
				{children}
			</div>
		</div>
	);
}
