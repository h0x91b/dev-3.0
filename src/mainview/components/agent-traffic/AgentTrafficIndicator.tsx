import { useEffect, useRef, useState } from "react";
import { markTrafficSeen } from "../../agent-traffic";
import { useT } from "../../i18n";
import { useAgentTraffic } from "../../hooks/useAgentTraffic";
import { useAgentTrafficEnabled } from "../../hooks/useAgentTrafficEnabled";
import { useNarrowViewport } from "../../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "../MobileBoardCarousel";
import { AgentTrafficIcon } from "../HeaderIcons";

interface Props {
	projectId: string | null;
	onOpenLog: () => void;
	variant?: "bar" | "menu" | "sheet";
}

export default function AgentTrafficIndicator({
	projectId,
	onOpenLog,
	variant = "bar",
}: Props) {
	const t = useT();
	const featureOn = useAgentTrafficEnabled();
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const traffic = useAgentTraffic(projectId);
	const seenRows = useRef(traffic.rows.length);
	const [arrived, setArrived] = useState(false);
	useEffect(() => {
		const grew = traffic.rows.length > seenRows.current;
		seenRows.current = traffic.rows.length;
		if (!grew) return;
		setArrived(true);
		const timer = setTimeout(() => setArrived(false), 600);
		return () => clearTimeout(timer);
	}, [traffic.rows.length]);
	if (!featureOn || (variant === "bar" && (narrow || !traffic.pairs.length)))
		return null;
	const label = traffic.unread
		? t.plural("traffic.ariaLabelUnread", traffic.unread)
		: t("traffic.ariaLabel");
	const badge = traffic.unread > 0 && (
		<span
			data-testid={variant === "bar" ? undefined : "agent-traffic-menu-badge"}
			className={`text-micro tabular-nums ${traffic.unreadUnsettled ? "text-warning-strong" : "text-agent"}`}
		>
			{traffic.unread > 9 ? "9+" : traffic.unread}
		</span>
	);
	return (
		<button
			type="button"
			role={variant === "menu" ? "menuitem" : undefined}
			aria-label={label}
			title={t("traffic.openLog")}
			aria-haspopup="dialog"
			data-help-id="header.agent-traffic"
			data-testid={
				variant === "bar"
					? "agent-traffic-indicator"
					: variant === "menu"
						? "agent-traffic-menu-row"
						: "agent-traffic-sheet-row"
			}
			onClick={() => {
				markTrafficSeen();
				onOpenLog();
			}}
			className={
				variant === "sheet"
					? "w-full px-2 py-3 gap-2 rounded-lg text-fg-2 hover:bg-elevated hover:text-fg transition-colors text-sm active:scale-[0.96]"
					: `header-anim flex items-center gap-2 rounded-lg text-agent hover:bg-elevated transition-colors active:scale-[0.96] ${variant === "bar" ? "shrink-0 px-1.5 py-1" : "w-full px-3 py-2.5"} ${arrived ? "hdr-wire-arrive" : ""}`
			}
		>
			{variant !== "sheet" && (
				<AgentTrafficIcon className="w-[1.125rem] h-[1.125rem] shrink-0" />
			)}
			{variant !== "bar" && (
				<span
					className={
						variant === "sheet"
							? undefined
							: "text-sm flex-1 text-left text-fg-2"
					}
				>
					{t("traffic.label")}
				</span>
			)}
			{badge}
		</button>
	);
}
