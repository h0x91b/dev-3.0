import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentMessageLogRow } from "../../../shared/agent-message-log";
import { isUnsettled, type TrafficPair } from "../../agent-traffic";
import { useT } from "../../i18n";
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
				<div className="md:w-64 shrink-0 md:border-r border-edge overflow-y-auto max-h-40 md:max-h-none">
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
						<Ledger rows={rows} onOpenTask={onOpenTask} />
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
}: {
	rows: AgentMessageLogRow[];
	onOpenTask: (taskId: string, projectId: string) => void;
}) {
	let day: string | null = null;
	const out: React.ReactNode[] = [];
	for (const row of rows) {
		const rowDay = row.at.slice(0, 10);
		if (rowDay !== day) {
			day = rowDay;
			out.push(
				<div
					key={`day-${rowDay}`}
					className="sticky top-0 bg-overlay/95 px-3 py-1 text-nano uppercase tracking-wide text-fg-muted"
				>
					{rowDay}
				</div>,
			);
		}
		out.push(
			<button
				key={`${row.at}-${row.toTaskId}-${row.fromSeq ?? "x"}`}
				type="button"
				className="block w-full text-left hover:bg-elevated/60 transition-colors"
				onClick={() => onOpenTask(row.toTaskId, row.toProjectId)}
			>
				<LedgerRow row={row} />
			</button>,
		);
	}
	return <div>{out}</div>;
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onClick}
			className={`px-2 py-1 rounded-md text-micro transition-colors ${
				active ? "bg-accent/20 text-accent" : "text-fg-3 hover:bg-elevated hover:text-fg"
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
						className="text-fg-3 hover:text-fg transition-colors px-2"
					>
						✕
					</button>
				</div>
				{children}
			</div>
		</div>
	);
}
