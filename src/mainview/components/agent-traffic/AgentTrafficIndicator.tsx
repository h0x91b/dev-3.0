import { useCallback, useEffect, useRef, useState } from "react";
import type { Route } from "../../state";
import { markTrafficSeen, type TrafficPair } from "../../agent-traffic";
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
 * The header's agent-traffic readout: is there anything new, and who owes an answer.
 *
 * **Its home is the overflow kebab, not the header bar.** The bar pill is an
 * exception the traffic has to earn: it appears only while messages have landed
 * since the user last looked, and disappears the moment they look. So it is an
 * unread badge, not a counter — a permanent number nobody acts on is the header
 * button creep the UX manifest names as this app's top anti-pattern.
 *
 * **Never on the bar at narrow width.** A phone header has room for a breadcrumb
 * and one kebab (bible §12.6), so the labelled kebab row is the only mobile
 * entry point — and it is labelled precisely because an unnamed glyph in a row of
 * numbers is unfindable.
 */

const POPOVER_WIDTH = 25 * 16;
/** Pairs previewed in the panel before the log takes over. */
const PANEL_PAIR_LIMIT = 6;
/** Above this the badge stops counting: the exact number stops mattering. */
const BADGE_CAP = 9;

interface AgentTrafficIndicatorProps {
	projectId: string | null;
	navigate: (route: Route) => void;
	onOpenLog: () => void;
	/** `bar` is the earned header pill; `menu` is the labelled row in the kebab. */
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
	const flyout = useHeaderFlyout({ variant, isNarrow, repositionKey: traffic.pairs.length });
	const [arrived, setArrived] = useState(false);
	const seenRows = useRef(traffic.rows.length);

	// A one-shot pulse when the count moves, so a message landing is visible even
	// to someone who was reading the board and never saw the toast. One-shot, not a
	// loop: the hover loop is the glyph's personality, this is feedback.
	useEffect(() => {
		if (traffic.rows.length === seenRows.current) return;
		const grew = traffic.rows.length > seenRows.current;
		seenRows.current = traffic.rows.length;
		if (!grew) return;
		setArrived(true);
		const timer = setTimeout(() => setArrived(false), 600);
		return () => clearTimeout(timer);
	}, [traffic.rows.length]);

	// Looking IS reading. The panel opening is the moment the badge has done its
	// job, so it clears here rather than on some later click inside the panel.
	const open = flyout.open;
	useEffect(() => {
		if (open) markTrafficSeen();
	}, [open]);

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

	// The bar pill is earned by unread traffic, and never shown on a phone. It
	// outlives its own badge while the panel is open: opening marks the traffic
	// seen, so without `|| open` the pill — and the panel hanging off it — would
	// vanish under the pointer in the same click that summoned it.
	if (variant === "bar" && (isNarrow || (traffic.unread === 0 && !open))) return null;

	const { pairs, unread } = traffic;
	const accessibleName =
		unread > 0 ? t("traffic.ariaLabelUnread", { count: String(unread) }) : t("traffic.ariaLabel");
	const logShortcut = shortcutById("agent-traffic-log");
	const shortcut = logShortcut ? shortcutKeysFor(logShortcut) : "";

	const panel = (
		<div>
			<div className="px-3 py-2 border-b border-edge text-micro text-fg-3">
				{pairs.length > 0 ? t.plural("traffic.pairCount", pairs.length) : t("traffic.quiet")}
			</div>
			<div className="max-h-72 overflow-y-auto">
				{pairs.slice(0, PANEL_PAIR_LIMIT).map((pair) => (
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
				{/* A key combo is noise on a phone sheet. */}
				{shortcut && !isNarrow && <span className="text-nano tabular-nums text-fg-muted">{shortcut}</span>}
			</button>
		</div>
	);

	// The kebab row: always present, always labelled. This is the control's home,
	// and on a phone it is the only way in.
	if (variant === "menu") {
		return (
			<>
				<button
					ref={flyout.anchorRef}
					type="button"
					role="menuitem"
					aria-label={accessibleName}
					data-testid="agent-traffic-menu-row"
					className={`header-anim w-full px-3 py-2 flex items-center gap-2.5 text-fg-2 hover:bg-elevated hover:text-fg transition-colors ${
						isNarrow ? "min-h-[44px]" : ""
					}`}
					{...flyout.triggerProps}
				>
					<TrafficGlyph muted={unread === 0} />
					<span className="text-sm flex-1 text-left">{t("traffic.label")}</span>
					{unread > 0 && (
						<span
							data-testid="agent-traffic-menu-badge"
							className={`text-micro font-medium tabular-nums ${
								traffic.unreadUnsettled ? "text-warning" : "text-agent"
							}`}
						>
							{unread > BADGE_CAP ? `${BADGE_CAP}+` : unread}
						</span>
					)}
				</button>
				{flyout.open &&
					(isNarrow ? (
						<BottomSheet
							open
							onClose={flyout.close}
							title={t("traffic.label")}
							testId="agent-traffic-sheet"
						>
							{panel}
						</BottomSheet>
					) : (
						<HeaderFlyoutPanel
							flyout={flyout}
							width={POPOVER_WIDTH}
							ariaLabel={t("traffic.label")}
							testId="agent-traffic-popover"
						>
							{panel}
						</HeaderFlyoutPanel>
					))}
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
				className={`header-anim flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 transition-colors hover:bg-elevated ${
					arrived ? "hdr-wire-arrive" : ""
				}`}
				{...flyout.triggerProps}
			>
				<TrafficGlyph />
				{/* No "0" while the panel is open: the pill is only still here because its
				    panel is, and a zero badge reads as a broken counter. */}
				{unread > 0 && (
					<span
						className={`text-micro font-medium leading-none tabular-nums ${
							traffic.unreadUnsettled ? "text-warning" : "text-agent"
						}`}
					>
						{unread > BADGE_CAP ? `${BADGE_CAP}+` : unread}
					</span>
				)}
			</button>

			{flyout.open && (
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
