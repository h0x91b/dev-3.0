import { useCallback, useEffect, useRef, useState } from "react";
import type { Route } from "../../state";
import type { TrafficPair } from "../../agent-traffic";
import { useT } from "../../i18n";
import { useAgentTraffic } from "../../hooks/useAgentTraffic";
import { useHeaderFlyout } from "../../hooks/useHeaderFlyout";
import { useNarrowViewport } from "../../hooks/useNarrowViewport";
import { shortcutById, shortcutKeysFor } from "../../keymap";
import { CAROUSEL_MAX_WIDTH } from "../MobileBoardCarousel";
import BottomSheet from "../BottomSheet";
import HeaderFlyoutPanel from "../HeaderFlyoutPanel";
import { PairRow, TrafficGlyph } from "./TrafficRow";

/**
 * The header's agent-traffic readout: are my agents talking, and who owes an answer.
 *
 * **Conditional, not permanent chrome.** The header's one permanent ambient slot
 * is spent on memory headroom (bible §5, §12.6), and unlike memory, silence here
 * is the normal state and needs no readout — most boards have no agent-to-agent
 * traffic at all. So the pill exists only while a pair has spoken inside
 * `LIVE_WINDOW_MS`, which makes the glyph's mere presence the signal. Narrow is
 * exempt for the same reason as the memory pill: there this markup IS the kebab
 * sheet row, and a sheet the user opened should not be empty.
 *
 * The panel is a preview, not the archive: the newest pairs, then one link into
 * the traffic log, which is the surface that owns history.
 */

const POPOVER_WIDTH = 25 * 16;
/** Pairs previewed in the panel before the log takes over. */
const PANEL_PAIR_LIMIT = 6;

interface AgentTrafficIndicatorProps {
	projectId: string | null;
	navigate: (route: Route) => void;
	onOpenLog: () => void;
	/** `bar` is the header pill; `menu` is the labelled row in the header kebab. */
	variant?: "bar" | "menu";
}

export default function AgentTrafficIndicator({
	projectId,
	navigate,
	onOpenLog,
	variant = "bar",
}: AgentTrafficIndicatorProps) {
	const t = useT();
	const isNarrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const traffic = useAgentTraffic(projectId);
	const flyout = useHeaderFlyout({ variant, isNarrow, repositionKey: traffic.live.length });
	const [arrived, setArrived] = useState(false);
	const seen = useRef(traffic.rows.length);

	// A one-shot pulse when the count moves, so a message landing is visible even
	// to someone who was reading the board and never saw the toast. One-shot, not a
	// loop: the hover loop is the glyph's personality, this is feedback.
	useEffect(() => {
		if (traffic.rows.length === seen.current) return;
		const grew = traffic.rows.length > seen.current;
		seen.current = traffic.rows.length;
		if (!grew) return;
		setArrived(true);
		const timer = setTimeout(() => setArrived(false), 600);
		return () => clearTimeout(timer);
	}, [traffic.rows.length]);

	const openReceiver = useCallback(
		(pair: TrafficPair) => {
			flyout.close();
			navigate({ screen: "project", projectId: pair.toProjectId, activeTaskId: pair.toTaskId });
		},
		[flyout, navigate],
	);

	const openLog = useCallback(() => {
		flyout.close();
		onOpenLog();
	}, [flyout, onOpenLog]);

	const live = traffic.live;
	// Nothing to say: no live pair means no pill at all (see the header note above).
	if (variant === "bar" && !isNarrow && live.length === 0) return null;

	const unsettled = live.some((pair) => pair.unsettled);
	const accessibleName = t("traffic.ariaLabel", { pairs: String(live.length) });
	const logShortcut = shortcutById("agent-traffic-log");
	const shortcut = logShortcut ? shortcutKeysFor(logShortcut) : "";

	const panel = (
		<div>
			<div className="px-3 py-2 border-b border-edge text-micro text-fg-3">
				{live.length > 0
					? t.plural("traffic.pairCount", live.length)
					: t("traffic.quiet")}
			</div>
			<div className="max-h-72 overflow-y-auto" role="list">
				{live.slice(0, PANEL_PAIR_LIMIT).map((pair) => (
					<PairRow key={pair.key} pair={pair} onSelect={openReceiver} />
				))}
			</div>
			<button
				type="button"
				onClick={openLog}
				data-testid="traffic-open-log"
				className="w-full px-3 py-2 border-t border-edge flex items-center justify-between gap-2 text-dense text-fg-2 hover:bg-elevated hover:text-fg transition-colors"
			>
				<span>{t("traffic.openLog")}</span>
				{shortcut && <span className="text-nano tabular-nums text-fg-muted">{shortcut}</span>}
			</button>
		</div>
	);

	if (variant === "menu") {
		return (
			<>
				<button
					ref={flyout.anchorRef}
					type="button"
					role="menuitem"
					aria-label={accessibleName}
					data-testid="agent-traffic-indicator"
					className="header-anim w-full px-3 py-2 flex items-center gap-2.5 text-fg-2 hover:bg-elevated hover:text-fg transition-colors"
					{...flyout.triggerProps}
				>
					<TrafficGlyph muted={live.length === 0} />
					<span className="text-sm flex-1 text-left">{t("traffic.label")}</span>
					<span className="text-micro font-medium tabular-nums text-fg-3">{live.length}</span>
				</button>
				{flyout.open && !isNarrow && (
					<HeaderFlyoutPanel
						flyout={flyout}
						width={POPOVER_WIDTH}
						ariaLabel={t("traffic.label")}
						testId="agent-traffic-popover"
					>
						{panel}
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
				aria-label={accessibleName}
				data-help-id="header.agent-traffic"
				data-testid="agent-traffic-indicator"
				className={`header-anim flex shrink-0 items-center gap-1 rounded-lg transition-colors hover:bg-elevated ${
					isNarrow ? "h-11 px-2" : "px-1.5 py-1"
				} ${arrived ? "hdr-wire-arrive" : ""}`}
				{...flyout.triggerProps}
			>
				<TrafficGlyph muted={live.length === 0} />
				<span
					className={`text-micro font-medium leading-none tabular-nums ${
						unsettled ? "text-warning" : "text-agent"
					}`}
				>
					{live.length}
				</span>
			</button>

			{isNarrow ? (
				<BottomSheet
					open={flyout.open}
					onClose={flyout.close}
					title={t("traffic.label")}
					testId="agent-traffic-sheet"
				>
					{panel}
				</BottomSheet>
			) : (
				flyout.open && (
					<HeaderFlyoutPanel
						flyout={flyout}
						width={POPOVER_WIDTH}
						ariaLabel={t("traffic.label")}
						testId="agent-traffic-popover"
					>
						{panel}
					</HeaderFlyoutPanel>
				)
			)}
		</>
	);
}
