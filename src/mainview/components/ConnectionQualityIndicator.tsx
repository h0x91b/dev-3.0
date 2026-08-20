import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { isRemote } from "../utils/platform";
import { useHeaderFlyout } from "../hooks/useHeaderFlyout";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import BottomSheet from "./BottomSheet";
import HeaderFlyoutPanel from "./HeaderFlyoutPanel";
import {
	CONNECTION_QUALITY_EVENT,
	getConnectionQuality,
	startConnectionQualitySampling,
} from "../connection-quality";
import type { ConnectionVerdict, QualityStats } from "../../shared/connection-quality";
import { describeAccessPath } from "../utils/accessPath";

/**
 * Remote connection-quality readout — the answer to "is the tunnel slow, or are
 * we?" as a number instead of an impression.
 *
 * A healthy link is not news, so the header bar carries nothing while the verdict
 * is good — the readout lives in the overflow menu, always one hover away, and
 * only climbs into the QR icon's slot once the connection stops being fine
 * (median past 150 ms, or jitter/loss bad enough to feel it). Remote mode only:
 * seen from the far end that icon offers to show you a code for the connection
 * you are already using, which is the one place in the app where it has nothing
 * to say. The desktop window keeps it untouched. Net header controls: unchanged.
 *
 * The pill is the glance and the popover is the depth, the same division the
 * memory readout uses. Visible: the median round trip, with a sparkline under it
 * because a spike is what "laggy" usually means and a median hides it. Behind a
 * hover or tap: the spread, the jitter, lost samples, and the split between our
 * own host-side time and everything outside it.
 *
 * Colour is the verdict, and never success-green — green means Completed in this
 * app. A quiet link is neutral `text-fg-3`, exactly like memory with headroom.
 *
 * The open/pin/position behaviour is `useHeaderFlyout`, shared with the memory
 * readout — the two are deliberately identical and there is no reason for that
 * sameness to live twice.
 */

const POPOVER_WIDTH = 22 * 16;
const SPARK_WIDTH = 34;
const SPARK_HEIGHT = 8;

const VERDICT_TEXT_CLASS: Record<ConnectionVerdict, string> = {
	good: "text-fg-3",
	degraded: "text-warning",
	bad: "text-danger",
};

const VERDICT_STROKE_CLASS: Record<ConnectionVerdict, string> = {
	good: "stroke-fg-muted",
	degraded: "stroke-warning",
	bad: "stroke-danger",
};

/**
 * Sparkline over the samples in the window, scaled to its own min/max so the
 * SHAPE is the message. An absolute scale would flatten every healthy link into
 * a straight line at the bottom and lose the only thing this can show at 34 px.
 */
function Sparkline({ values, verdict }: { values: number[]; verdict: ConnectionVerdict }) {
	if (values.length < 2) return <span aria-hidden="true" style={{ width: SPARK_WIDTH, height: SPARK_HEIGHT }} />;
	const min = Math.min(...values);
	const max = Math.max(...values);
	const span = max - min || 1;
	const step = SPARK_WIDTH / (values.length - 1);
	const points = values
		.map((v, i) => `${(i * step).toFixed(1)},${(SPARK_HEIGHT - ((v - min) / span) * SPARK_HEIGHT).toFixed(1)}`)
		.join(" ");
	return (
		<svg
			aria-hidden="true"
			width={SPARK_WIDTH}
			height={SPARK_HEIGHT}
			viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
			className="overflow-visible"
		>
			<polyline
				points={points}
				fill="none"
				strokeWidth="1"
				strokeLinejoin="round"
				className={VERDICT_STROKE_CLASS[verdict]}
			/>
		</svg>
	);
}

function QualityBreakdown({ stats }: { stats: QualityStats }) {
	const t = useT();
	const path = describeAccessPath(typeof window === "undefined" ? "" : window.location.hostname);
	// Nothing answered: every number here would be a zero standing in for a
	// measurement that never happened, so the panel says that instead.
	const rows: { label: string; value: string; hint?: string }[] = stats.count === 0
		? []
		: [
			{ label: t("connQuality.median"), value: `${stats.p50} ms` },
			{ label: t("connQuality.p95"), value: `${stats.p95} ms` },
			{ label: t("connQuality.jitter"), value: `${stats.jitter} ms` },
		];
	if (stats.count > 0 && stats.serverP50 !== null) {
		rows.push({ label: t("connQuality.ours"), value: `${stats.serverP50} ms` });
	}
	if (stats.count > 0 && stats.networkP50 !== null) {
		rows.push({ label: t("connQuality.network"), value: `${stats.networkP50} ms` });
	}

	return (
		<div className="p-3 flex flex-col gap-3">
			<div>
				<div className="text-fg text-sm font-semibold">{t("connQuality.title")}</div>
				<div className="text-fg-3 text-micro mt-0.5">{t("connQuality.definition")}</div>
			</div>

			{stats.count === 0 && (
				<div className="text-danger text-xs leading-snug">{t("connQuality.unreachable")}</div>
			)}

			<div className="flex flex-col gap-1">
				{rows.map((row) => (
					<div key={row.label} className="flex items-baseline justify-between gap-3">
						<span className="text-fg-2 text-xs">{row.label}</span>
						<span className="text-fg text-xs font-medium tabular-nums">{row.value}</span>
					</div>
				))}
			</div>

			<div className="flex flex-col gap-1 border-t border-edge pt-2">
				<div className="flex items-baseline justify-between gap-3">
					<span className="text-fg-2 text-xs">{t("connQuality.path")}</span>
					<span className="text-fg text-xs font-medium">{t(path.labelKey)}</span>
				</div>
				<div className="flex items-baseline justify-between gap-3">
					<span className="text-fg-2 text-xs">{t("connQuality.samples")}</span>
					<span className="text-fg text-xs font-medium tabular-nums">
						{stats.lost > 0 ? t("connQuality.samplesWithLoss", { count: String(stats.count), lost: String(stats.lost) }) : String(stats.count)}
					</span>
				</div>
				<div className="flex items-baseline justify-between gap-3">
					<span className="text-fg-2 text-xs">{t("connQuality.host")}</span>
					<span className="text-fg-3 text-micro font-mono truncate streamer-private" title={path.host}>
						{path.host}
					</span>
				</div>
			</div>

			{/* The one thing the numbers cannot answer on their own: this measures the
			    whole loop, so a slow reading only becomes a verdict against the tunnel
			    once the same widget on the direct-LAN URL reads faster. */}
			<div className="text-fg-muted text-micro leading-snug border-t border-edge pt-2">
				{t("connQuality.compareHint")}
			</div>
		</div>
	);
}

interface ConnectionQualityIndicatorProps {
	/**
	 * `bar` is the header pill — it renders ONLY while the verdict says the link is
	 * not fine, so a healthy connection carries no readout at all. `menu` is the
	 * labelled row in the header's overflow menu, where the number is always
	 * available on demand.
	 */
	variant?: "bar" | "menu";
}

export default function ConnectionQualityIndicator({ variant = "bar" }: ConnectionQualityIndicatorProps) {
	const t = useT();
	const isNarrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [stats, setStats] = useState<QualityStats>(() => getConnectionQuality());
	const flyout = useHeaderFlyout({ variant, isNarrow, repositionKey: stats });

	useEffect(() => {
		startConnectionQualitySampling();
		function onStats(e: Event) {
			setStats((e as CustomEvent).detail as QualityStats);
		}
		window.addEventListener(CONNECTION_QUALITY_EVENT, onStats);
		return () => window.removeEventListener(CONNECTION_QUALITY_EVENT, onStats);
	}, []);


	// Desktop keeps its QR icon; this widget does not exist there.
	if (!isRemote()) return null;
	// Nothing has been ATTEMPTED yet: a placeholder would cause the header layout
	// shift the UX manifest warns about, and "0 ms" would be a lie. A window where
	// everything timed out is a different thing entirely — that one is the worst
	// news this widget has, so it renders.
	if (stats.count === 0 && stats.lost === 0) return null;

	// A link that behaves is not news. The header bar earns the readout only once
	// the verdict stops being good — median past 150 ms, or jitter/loss bad enough
	// to feel; until then it lives in the overflow menu. Narrow is exempt: there
	// the same `bar` markup IS the sheet row, and a sheet the user opened should
	// not be empty (same rule as the memory readout).
	if (variant === "bar" && !isNarrow && stats.verdict === "good") return null;

	const verdictClass = VERDICT_TEXT_CLASS[stats.verdict];
	// Socket open, nothing answering: there is no median to print, so the headline
	// is a dash. The verdict is already `bad` in that window, so it arrives in red.
	const answered = stats.count > 0;
	const headline = answered ? `${stats.p50} ms` : "—";
	const ariaLabel = answered
		? t("connQuality.ariaLabel", { ms: String(stats.p50) })
		: t("connQuality.ariaLabelUnreachable");

	const breakdown = <QualityBreakdown stats={stats} />;
	const spark = <Sparkline values={stats.recent} verdict={stats.verdict} />;

	// Menu row: hover opens the flyout after a dwell, a click pins it — same
	// affordance as the memory row it sits next to.
	if (variant === "menu") {
		return (
			<>
				<button
					ref={flyout.anchorRef}
					type="button"
					role="menuitem"
					aria-label={ariaLabel}
					data-testid="connection-quality-indicator"
					className="header-anim w-full px-3 py-2 flex items-center gap-2.5 text-fg-2 hover:bg-elevated hover:text-fg transition-colors"
					{...flyout.triggerProps}
				>
					<span className="flex w-[1.125rem] items-center justify-center">{spark}</span>
					<span className="text-sm flex-1 text-left">{t("connQuality.label")}</span>
					<span className={`text-micro font-medium tabular-nums ${verdictClass}`}>{headline}</span>
				</button>
				{flyout.open && !isNarrow && (
					<HeaderFlyoutPanel
						flyout={flyout}
						width={POPOVER_WIDTH}
						ariaLabel={t("connQuality.title")}
						testId="connection-quality-popover"
					>
						{breakdown}
					</HeaderFlyoutPanel>
				)}
			</>
		);
	}

	return (
		<>
			<button
				ref={flyout.anchorRef}
				type="button"
				aria-label={ariaLabel}
				data-help-id="header.connectionQuality"
				data-testid="connection-quality-indicator"
				className={`header-anim flex shrink-0 flex-col justify-center gap-[0.1875rem] rounded-lg transition-colors hover:bg-elevated ${
					isNarrow ? "h-11 px-2" : "px-1.5 py-1"
				} ${verdictClass}`}
				{...flyout.triggerProps}
			>
				<span className="text-micro font-medium leading-none tabular-nums">{headline}</span>
				{spark}
			</button>

			{isNarrow ? (
				<BottomSheet
					open={flyout.open}
					onClose={flyout.close}
					title={t("connQuality.title")}
					testId="connection-quality-sheet"
				>
					{breakdown}
				</BottomSheet>
			) : (
				flyout.open && (
					<HeaderFlyoutPanel
						flyout={flyout}
						width={POPOVER_WIDTH}
						ariaLabel={t("connQuality.title")}
						testId="connection-quality-popover"
					>
						{breakdown}
					</HeaderFlyoutPanel>
				)
			)}
		</>
	);
}
