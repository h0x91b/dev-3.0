import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { isRemote } from "../utils/platform";
import { computeAnchoredPosition } from "../utils/popoverPosition";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import BottomSheet from "./BottomSheet";
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
 * It takes over the header slot the QR icon occupies, and only in remote mode:
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
 */

/** Hover-out grace so the pointer can travel from pill to popover. */
const CLOSE_DELAY_MS = 120;
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
	const rows: { label: string; value: string; hint?: string }[] = [
		{ label: t("connQuality.median"), value: `${stats.p50} ms` },
		{ label: t("connQuality.p95"), value: `${stats.p95} ms` },
		{ label: t("connQuality.jitter"), value: `${stats.jitter} ms` },
	];
	if (stats.serverP50 !== null) rows.push({ label: t("connQuality.ours"), value: `${stats.serverP50} ms` });
	if (stats.networkP50 !== null) rows.push({ label: t("connQuality.network"), value: `${stats.networkP50} ms` });

	return (
		<div className="p-3 flex flex-col gap-3">
			<div>
				<div className="text-fg text-sm font-semibold">{t("connQuality.title")}</div>
				<div className="text-fg-3 text-micro mt-0.5">{t("connQuality.definition")}</div>
			</div>

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

export default function ConnectionQualityIndicator() {
	const t = useT();
	const isNarrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [stats, setStats] = useState<QualityStats>(() => getConnectionQuality());
	const [open, setOpen] = useState(false);
	/** Hover opens; a click PINS, so the panel can be clicked into on a pointer device. */
	const [pinned, setPinned] = useState(false);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	const anchorRef = useRef<HTMLButtonElement | null>(null);
	const popRef = useRef<HTMLDivElement | null>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		startConnectionQualitySampling();
		function onStats(e: Event) {
			setStats((e as CustomEvent).detail as QualityStats);
		}
		window.addEventListener(CONNECTION_QUALITY_EVENT, onStats);
		return () => window.removeEventListener(CONNECTION_QUALITY_EVENT, onStats);
	}, []);

	const cancelClose = useCallback(() => {
		if (closeTimer.current !== null) {
			clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
	}, []);

	const close = useCallback(() => {
		cancelClose();
		setOpen(false);
		setPinned(false);
		setPos(null);
	}, [cancelClose]);

	const scheduleClose = useCallback(() => {
		cancelClose();
		closeTimer.current = setTimeout(() => {
			closeTimer.current = null;
			setOpen((wasOpen) => (pinned ? wasOpen : false));
			if (!pinned) setPos(null);
		}, CLOSE_DELAY_MS);
	}, [cancelClose, pinned]);

	useEffect(() => () => cancelClose(), [cancelClose]);

	useLayoutEffect(() => {
		if (isNarrow || !open || !anchorRef.current || !popRef.current) return;
		const rect = popRef.current.getBoundingClientRect();
		const { top, left } = computeAnchoredPosition(
			anchorRef.current.getBoundingClientRect(),
			{ width: rect.width, height: rect.height },
			{ placement: "bottom", align: "end" },
		);
		setPos({ top, left });
	}, [open, isNarrow, stats]);

	useEffect(() => {
		if (!open || isNarrow) return;
		function onKey(e: KeyboardEvent) {
			if (e.key !== "Escape") return;
			close();
			anchorRef.current?.focus();
		}
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open, isNarrow, close]);

	useEffect(() => {
		if (!pinned || isNarrow) return;
		function onMouseDown(e: MouseEvent) {
			const target = e.target as Node;
			if (anchorRef.current?.contains(target) || popRef.current?.contains(target)) return;
			close();
		}
		document.addEventListener("mousedown", onMouseDown);
		return () => document.removeEventListener("mousedown", onMouseDown);
	}, [pinned, isNarrow, close]);

	// Desktop keeps its QR icon; this widget does not exist there.
	if (!isRemote()) return null;
	// Render nothing until the first sample answers: a placeholder would cause the
	// header layout shift the UX manifest warns about, and "0 ms" would be a lie.
	if (stats.count === 0) return null;

	const verdictClass = VERDICT_TEXT_CLASS[stats.verdict];

	const togglePinned = () => {
		if (pinned) {
			close();
			return;
		}
		cancelClose();
		setOpen(true);
		setPinned(true);
	};

	return (
		<>
			<button
				ref={anchorRef}
				type="button"
				onClick={togglePinned}
				onMouseEnter={isNarrow ? undefined : () => { cancelClose(); setOpen(true); }}
				onMouseLeave={isNarrow ? undefined : scheduleClose}
				onFocus={(e) => {
					if (!isNarrow && e.target.matches(":focus-visible")) setOpen(true);
				}}
				aria-label={t("connQuality.ariaLabel", { ms: String(stats.p50) })}
				aria-expanded={open}
				aria-haspopup="dialog"
				data-help-id="header.connectionQuality"
				data-testid="connection-quality-indicator"
				className={`header-anim flex shrink-0 flex-col justify-center gap-[0.1875rem] rounded-lg transition-colors hover:bg-elevated ${
					isNarrow ? "h-11 px-2" : "px-1.5 py-1"
				} ${verdictClass}`}
			>
				<span className="text-micro font-medium leading-none tabular-nums">{stats.p50} ms</span>
				<Sparkline values={stats.recent} verdict={stats.verdict} />
			</button>

			{isNarrow ? (
				<BottomSheet open={open} onClose={close} title={t("connQuality.title")} testId="connection-quality-sheet">
					<QualityBreakdown stats={stats} />
				</BottomSheet>
			) : (
				open &&
				createPortal(
					<div
						ref={popRef}
						role="dialog"
						aria-label={t("connQuality.title")}
						onMouseEnter={cancelClose}
						onMouseLeave={scheduleClose}
						data-testid="connection-quality-popover"
						data-header-flyout="true"
						className="fixed z-[1200] overflow-y-auto overflow-x-hidden rounded-xl border border-edge-active bg-overlay shadow-2xl shadow-black/40"
						style={{
							top: pos?.top ?? 0,
							left: pos?.left ?? 0,
							width: POPOVER_WIDTH,
							maxWidth: "calc(100vw - 2rem)",
							maxHeight: "28rem",
							visibility: pos ? "visible" : "hidden",
						}}
					>
						<QualityBreakdown stats={stats} />
					</div>,
					document.body,
				)
			)}
		</>
	);
}
