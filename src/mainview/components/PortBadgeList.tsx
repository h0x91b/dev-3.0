import { useEffect, useId, useState } from "react";
import type { PortInfo } from "../../shared/types";
import { useT } from "../i18n";
import Tooltip from "./Tooltip";

/**
 * A list at or under this size renders in full. Past it the list shows
 * `PORT_BADGE_CAP - 1` badges plus the "+N more" toggle, so a collapsed list
 * never exceeds `PORT_BADGE_CAP` chips: two lines at the default 240px sidebar.
 */
export const PORT_BADGE_CAP = 6;

interface PortBadgeListProps {
	ports: PortInfo[];
	testId?: string;
}

/**
 * The sidebar row's listening ports. A test suite can open dozens, and a row
 * that renders them all swallows the sidebar, so the tail folds behind an
 * inline disclosure. Every control stops propagation: the row is a navigator.
 */
export default function PortBadgeList({ ports, testId }: PortBadgeListProps) {
	const t = useT();
	const listId = useId();
	const [expanded, setExpanded] = useState(false);
	const overflowing = ports.length > PORT_BADGE_CAP;

	// Forget the choice once the list fits again, so a later burst of ports
	// starts collapsed instead of reopening a choice made for a different list.
	useEffect(() => {
		if (!overflowing) setExpanded(false);
	}, [overflowing]);

	const visible = overflowing && !expanded ? ports.slice(0, PORT_BADGE_CAP - 1) : ports;
	const hiddenCount = ports.length - visible.length;

	return (
		<div id={listId} className="flex flex-wrap gap-1 mt-1" data-testid={testId}>
			{visible.map((p) => (
				<Tooltip key={p.port} content={`${p.processName} (PID ${p.pid})`}>
					<button
						type="button"
						className="inline-flex items-center gap-1 text-dense font-mono text-accent bg-accent/10 hover:bg-accent/20 px-1.5 py-0.5 rounded transition-[color,background-color,transform] duration-150 ease-out motion-safe:active:scale-[0.96] [@media(hover:none)]:min-h-6"
						aria-label={t("ports.openPort", { port: String(p.port) })}
						onClick={(e) => {
							e.stopPropagation();
							window.open(`http://localhost:${p.port}`, "_blank");
						}}
					>
						<span aria-hidden style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{""}</span>:{p.port}
					</button>
				</Tooltip>
			))}
			{overflowing && (
				<Tooltip content={t.plural("ports.showAllCount", ports.length)} disabled={expanded}>
					<button
						type="button"
						aria-expanded={expanded}
						aria-controls={listId}
						data-testid={testId ? `${testId}-toggle` : undefined}
						className="inline-flex items-center text-dense font-mono text-fg-3 hover:text-fg bg-fg/5 hover:bg-fg/10 px-1.5 py-0.5 rounded transition-[color,background-color,transform] duration-150 ease-out motion-safe:active:scale-[0.96] [@media(hover:none)]:min-h-6"
						onClick={(e) => {
							e.stopPropagation();
							setExpanded((v) => !v);
						}}
					>
						{expanded ? t("ports.showFewer") : t.plural("ports.moreCount", hiddenCount)}
					</button>
				</Tooltip>
			)}
		</div>
	);
}
