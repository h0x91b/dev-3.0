import type { AgentMessageLogRow } from "../../../shared/agent-message-log";
import { isUnsettled, type TrafficPair } from "../../agent-traffic";
import { useT } from "../../i18n";
import { compactAge } from "../../utils/statusAge";

/**
 * The shared vocabulary of both agent-traffic surfaces: a wire that points, and
 * a row that reads `#from → #to`.
 *
 * Kept in one file because the header popover and the traffic log must render a
 * pair identically — the popover is a preview of the log, and two independent
 * implementations of "who is talking" is exactly how they drift apart.
 */

/**
 * Sender → receiver, drawn rather than written.
 *
 * An arrow glyph would do, but the line carries the one thing an arrow cannot:
 * that this is a channel with two ends and a direction, not a label. Violet is
 * identity (`--agent`, same as the toast variant), never severity.
 */
export function Wire({ width = 22, muted = false }: { width?: number; muted?: boolean }) {
	const stroke = muted ? "rgb(var(--fg-muted))" : "rgb(var(--agent))";
	return (
		<svg
			width={width}
			height={8}
			viewBox={`0 0 ${width} 8`}
			className="shrink-0"
			aria-hidden="true"
			focusable="false"
		>
			<line x1={0} y1={4} x2={width} y2={4} stroke={stroke} strokeWidth={1.5} opacity={0.35} />
			<path
				d={`M ${width - 6} 1 L ${width - 1} 4 L ${width - 6} 7`}
				fill="none"
				stroke={stroke}
				strokeWidth={1.5}
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/**
 * A message dev3 could not prove landed.
 *
 * The one honest axis the log has. A sender cannot mark a message important —
 * that field does not exist — but the delivery verdict is recorded per row, and
 * "typed into a pane that may have been dead" is the thing a human actually has
 * to step in about. Warning tokens, never danger: nothing is broken, it is
 * unproven.
 */
export function UnsettledMark({ label }: { label: string }) {
	return (
		<span
			title={label}
			aria-label={label}
			className="shrink-0 text-nano font-medium uppercase tracking-wide text-warning"
		>
			?
		</span>
	);
}

interface PairRowProps {
	pair: TrafficPair;
	/** Highlighted because the log is currently filtered to this pair. */
	selected?: boolean;
	onSelect: (pair: TrafficPair) => void;
	now?: number;
}

/**
 * One live pair. Clicking it goes where the answer is owed.
 *
 * The row leads with the two seqs because that is how the CLI, the toast and the
 * agents themselves name each other; the title is context, so it truncates first.
 */
export function PairRow({ pair, selected = false, onSelect, now = Date.now() }: PairRowProps) {
	const t = useT();
	const age = compactAge(pair.last.at, now);
	return (
		<button
			type="button"
			data-testid="traffic-pair-row"
			aria-pressed={selected}
			onClick={() => onSelect(pair)}
			className={`w-full px-3 py-2 flex items-center gap-2 text-left transition-colors active:scale-[0.96] ${
				selected ? "bg-elevated text-fg" : "text-fg-2 hover:bg-elevated hover:text-fg"
			}`}
		>
			<span className="text-micro font-medium tabular-nums text-agent shrink-0">
				{pair.fromSeq === null ? "—" : `#${pair.fromSeq}`}
			</span>
			<Wire />
			<span className="text-micro font-medium tabular-nums text-fg-3 shrink-0">{`#${pair.toSeq}`}</span>
			<span className="min-w-0 flex-1 truncate text-dense streamer-private">{pair.last.body}</span>
			{pair.unsettled && <UnsettledMark label={t("traffic.unsettled")} />}
			{pair.count > 1 && (
				<span className="shrink-0 text-nano tabular-nums text-fg-muted">{`×${pair.count}`}</span>
			)}
			<span className="shrink-0 text-nano tabular-nums text-fg-muted">{age}</span>
		</button>
	);
}

/**
 * One message in the ledger.
 *
 * Full body, never clamped for looks: the log exists because the toast clamped
 * it. `spill-pointer` rows are the exception — those never had a body to show,
 * so the row says the message was too large to type and names the file it went
 * to instead.
 */
export function LedgerRow({
	row,
	now = Date.now(),
	gone = false,
}: {
	row: AgentMessageLogRow;
	now?: number;
	/** The receiving task no longer exists, so this row goes nowhere. */
	gone?: boolean;
}) {
	const t = useT();
	const spilled = row.bodyKind === "spill-pointer";
	return (
		<div
			data-testid="traffic-ledger-row"
			data-gone={gone ? "true" : undefined}
			className={`px-3 py-2 flex items-start gap-2 border-b border-edge/60 ${gone ? "opacity-60" : ""}`}
		>
			<span className="mt-0.5 text-micro font-medium tabular-nums text-agent shrink-0">
				{row.fromSeq === null ? "—" : `#${row.fromSeq}`}
			</span>
			<span className="mt-1">
				<Wire width={20} />
			</span>
			<span className="mt-0.5 text-micro font-medium tabular-nums text-fg-3 shrink-0">{`#${row.toSeq}`}</span>
			<div className="min-w-0 flex-1">
				<div className="text-dense text-fg whitespace-pre-wrap break-words streamer-private">
					{spilled ? t("traffic.spilled") : row.body}
				</div>
				<div className="mt-0.5 flex items-center gap-1.5 text-nano text-fg-muted">
					<span className="truncate streamer-private">
						{[row.fromTitle, row.toTitle].filter(Boolean).join(" → ")}
					</span>
					{row.kind === "scheduled" && <span className="shrink-0">{t("traffic.scheduled")}</span>}
					{spilled && row.spillPath && (
						<span className="shrink-0 font-mono truncate streamer-private">{row.spillPath}</span>
					)}
				</div>
			</div>
			{isUnsettled(row.status) && (
				<span className="mt-0.5">
					<UnsettledMark
						label={row.status === "unconfirmed" ? t("traffic.status.unconfirmed") : t("traffic.status.notDelivered")}
					/>
				</span>
			)}
			{row.status === "held" && (
				<span className="mt-0.5 shrink-0 text-nano text-fg-muted" title={t("traffic.status.held")}>
					{t("traffic.heldShort")}
				</span>
			)}
			<span className="mt-0.5 shrink-0 text-nano tabular-nums text-fg-muted">{compactAge(row.at, now)}</span>
		</div>
	);
}
