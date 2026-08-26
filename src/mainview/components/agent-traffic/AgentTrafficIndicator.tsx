import { useCallback, useEffect, useRef, useState } from "react";
import type { Route } from "../../state";
import { markTrafficSeen, type TrafficPair } from "../../agent-traffic";
import { OPEN_AGENT_TRAFFIC_LOG_EVENT } from "../../agent-traffic-events";
import { useT } from "../../i18n";
import { useAgentTraffic } from "../../hooks/useAgentTraffic";
import { useAgentTrafficEnabled } from "../../hooks/useAgentTrafficEnabled";
import { useHeaderFlyout } from "../../hooks/useHeaderFlyout";
import { useNarrowViewport } from "../../hooks/useNarrowViewport";
import { shortcutById, shortcutKeysFor } from "../../keymap";
import { CAROUSEL_MAX_WIDTH } from "../MobileBoardCarousel";
import BottomSheet from "../BottomSheet";
import HeaderFlyoutPanel from "../HeaderFlyoutPanel";
import { AgentTrafficIcon } from "../HeaderIcons";
import { PairRow } from "./TrafficRow";

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
 *
 * Each variant borrows the shape of the surface it lands on rather than inventing
 * one: `bar` is a header pill, `menu` is a kebab row (glyph + label, like the
 * memory and tmux rows), `sheet` is a phone action row (label first, no glyph,
 * same padding and radius as every other row in that sheet). The glyph itself is
 * a member of `HeaderIcons`, so it inherits the family's 24×24 stroke body,
 * `currentColor`, and hover animation instead of being a bespoke badge.
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
	/**
	 * `bar` — the earned header pill. `menu` — the desktop kebab row. `sheet` — the
	 * phone action-sheet row, shaped like its neighbours.
	 */
	variant?: "bar" | "menu" | "sheet";
}

export default function AgentTrafficIndicator({
	projectId,
	navigate,
	onOpenLog,
	variant = "bar",
}: AgentTrafficIndicatorProps) {
	const t = useT();
	const featureOn = useAgentTrafficEnabled();
	const isNarrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const traffic = useAgentTraffic(projectId);
	// The sheet row lives inside a menu, so it opens like one (hover intent on a
	// pointer, tap on touch) rather than like a bar pill.
	const flyout = useHeaderFlyout({
		variant: variant === "bar" ? "bar" : "menu",
		isNarrow,
		repositionKey: traffic.pairs.length,
	});
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

	// The log can also be opened by ⇧⌘M, the View menu or the palette, none of
	// which route through the panel — and the panel is portaled above the dialog,
	// so it would hang over the log it just handed off to.
	useEffect(() => {
		function onLogOpened() {
			flyout.close();
		}
		window.addEventListener(OPEN_AGENT_TRAFFIC_LOG_EVENT, onLogOpened);
		return () => window.removeEventListener(OPEN_AGENT_TRAFFIC_LOG_EVENT, onLogOpened);
	}, [flyout]);

	// Beta, off by default: every variant disappears with the flag, so the kebab
	// and the phone sheet lose the row entirely rather than gaining a dead one.
	// After the hooks, never before — an early return would reorder them.
	if (!featureOn) return null;

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

	const panelSurface = isNarrow ? (
		<BottomSheet open onClose={flyout.close} title={t("traffic.label")} testId="agent-traffic-sheet">
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
	);

	// The phone action sheet: every row there is a plain full-width text button, so
	// this one is too. Only the unread count is added, pushed to the far end.
	if (variant === "sheet") {
		return (
			<>
				<button
					ref={flyout.anchorRef}
					type="button"
					aria-label={accessibleName}
					data-testid="agent-traffic-sheet-row"
					// No `flex` and no `flex-1`: `.touch-actions` already makes every row in
					// this sheet an inline-flex box that centres its content, and the peers
					// rely on exactly that. Laying the row out by hand is what made it the
					// one left-aligned item in a column of centred ones.
					className="w-full px-2 py-3 gap-2 rounded-lg text-fg-2 hover:bg-elevated hover:text-fg transition-colors text-sm active:scale-[0.96]"
					{...flyout.triggerProps}
				>
					<span>{t("traffic.label")}</span>
					{unread > 0 && (
						<span
							data-testid="agent-traffic-menu-badge"
							className={`text-micro font-medium tabular-nums ${
								traffic.unreadUnsettled ? "text-warning" : "text-accent"
							}`}
						>
							{unread > BADGE_CAP ? `${BADGE_CAP}+` : unread}
						</span>
					)}
				</button>
				{flyout.open && panelSurface}
			</>
		);
	}

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
					className="header-anim w-full px-3 py-2 flex items-center gap-2.5 text-fg-2 hover:bg-elevated hover:text-fg transition-colors active:scale-[0.96]"
					{...flyout.triggerProps}
				>
					<AgentTrafficIcon className="w-[1.125rem] h-[1.125rem] flex-shrink-0" />
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
				{flyout.open && panelSurface}
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
				className={`header-anim flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-agent transition-colors hover:bg-elevated active:scale-[0.96] ${
					arrived ? "hdr-wire-arrive" : ""
				}`}
				{...flyout.triggerProps}
			>
				<AgentTrafficIcon className="w-[1.125rem] h-[1.125rem]" />
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

			{flyout.open && panelSurface}
		</>
	);
}
