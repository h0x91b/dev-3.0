/**
 * One recorded `dev3 notify` call, as a bubble on the traffic timeline.
 *
 * Two placements, one component: `anchor` given → absolutely positioned against
 * a node on the canvas, with a tail, exactly like the message bubble;
 * `anchor` omitted → an ordinary block in document flow, which is what a list or
 * a standalone readout needs. Splitting them would duplicate the level colours
 * and the wording, which is where a divergence would actually hurt.
 *
 * `row.message` is text an agent wrote. It reaches the DOM as a React child and
 * nothing else — no `dangerouslySetInnerHTML` on this path, ever.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { type TranslationKey, useT } from "../../i18n";
import type { NotificationEndpoint, TrafficNotificationEvent } from "./notification-event";
import "./traffic-notification.css";

const LEVEL_ICON = {
	// Circled "i".
	info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 8h.01M11 12h1v5",
	// Circled check.
	success: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M8 12.5l2.5 2.5L16 9.5",
	// Circled exclamation.
	error: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v6M12 16.5h.01",
} as const;

const OUTCOME_KEY = {
	delivered: "traffic.notification.outcome.delivered",
	queued: "traffic.notification.outcome.queued",
	"no-window": "traffic.notification.outcome.noWindow",
} as const satisfies Record<TrafficNotificationEvent["outcome"], TranslationKey>;

const SUPPRESSION_KEY = {
	focusMode: "traffic.notification.suppression.focusMode",
	terminalImmersive: "traffic.notification.suppression.terminalImmersive",
} as const satisfies Record<"focusMode" | "terminalImmersive", TranslationKey>;

function endpointLabel(endpoint: NotificationEndpoint): string {
	return endpoint.seq === null ? "#—" : `#${endpoint.seq}`;
}

export default function TrafficNotificationBubble({ event, anchor, width, height, onKnownTask }: {
	event: TrafficNotificationEvent;
	/** Canvas coordinates to pin to. Omit for an inline bubble. */
	anchor?: { x: number; y: number };
	/** Canvas size, used to keep an anchored bubble on screen. */
	width?: number;
	height?: number;
	/** Whether the board still has this card. Unknown when not supplied. */
	onKnownTask?: (endpoint: NotificationEndpoint) => boolean;
}) {
	const t = useT();
	const ref = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ width: 290, height: 76 });
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element || !anchor) return;
		const measure = () => {
			if (element.offsetWidth && element.offsetHeight)
				setSize({ width: element.offsetWidth, height: element.offsetHeight });
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [event.key, anchor, width]);

	const { row, target, origin } = event;
	const canvasWidth = width ?? 0;
	const below = !!anchor && anchor.y < size.height + 34;
	const placement = anchor
		? {
			left: Math.max(size.width / 2 + 12, Math.min(canvasWidth - size.width / 2 - 12, anchor.x)),
			top: anchor.y + (below ? 22 : -22),
		}
		: null;
	const tailX = anchor && placement ? Math.max(18, Math.min(size.width - 18, anchor.x - placement.left + size.width / 2)) : 0;
	const tipX = anchor && placement ? anchor.x - placement.left + size.width / 2 - tailX + 10 : 0;
	const offCanvas = !!anchor && (anchor.x < 0 || anchor.x > canvasWidth || anchor.y < 0 || anchor.y > (height ?? 0));

	const time = new Date(event.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	// A target the board no longer has is still a target: the anchor is kept and
	// labelled, never reassigned to some other card that happens to be nearby.
	const targetMissing = !!target && !!onKnownTask && !onKnownTask(target);

	return (
		<div
			ref={ref}
			className={`traffic-notification ${anchor ? "is-anchored" : ""} ${below ? "is-below" : ""}`}
			data-level={event.level}
			data-outcome={event.outcome}
			data-testid="traffic-notification"
			style={placement
				// Only ever NARROWER than the stylesheet's cap: an inline maxWidth taken
				// from the canvas would override it and let a long message run wide.
				? { left: placement.left, top: placement.top, maxWidth: Math.min(320, Math.max(120, canvasWidth - 24)), visibility: offCanvas ? "hidden" : undefined }
				: undefined}
		>
			<div className="traffic-notification-head">
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d={LEVEL_ICON[event.level]} /></svg>
				<span>
					{t("traffic.notification.kind")} · {t(`traffic.notification.level.${event.level}` as TranslationKey)} · {t(`traffic.notification.mode.${event.mode}` as TranslationKey)}
				</span>
				<time dateTime={row.at}>{time}</time>
			</div>

			{/* `title` carries the untruncated text — the clamp is visual only, and the
			    data is never cut. */}
			<div className="traffic-notification-body streamer-private" title={row.message}>{row.message}</div>

			<div className="traffic-notification-foot">
				{target
					? <span className="traffic-notification-endpoint">{t("traffic.notification.aboutTask", { seq: endpointLabel(target).slice(1) })}</span>
					: <span>{t("traffic.notification.noTask")}</span>}
				{event.crossAddressed && origin
					? <span className="traffic-notification-endpoint">{t("traffic.notification.fromTask", { seq: endpointLabel(origin).slice(1) })}</span>
					: null}
				{targetMissing ? <span>{t("traffic.notification.unknownTask")}</span> : null}
				{event.outcome !== "delivered"
					? (
						<span className="traffic-notification-outcome">
							{t(OUTCOME_KEY[event.outcome])}
							{event.suppressedBy.length
								? ` · ${event.suppressedBy.map(source => t(SUPPRESSION_KEY[source])).join(", ")}`
								: ""}
						</span>
					)
					: null}
			</div>

			{anchor
				? (
					<svg className="traffic-notification-tail" width="20" height="24" viewBox="0 -2 20 24"
						style={{ left: tailX - 10 }} aria-hidden="true">
						<path d={`M0 -2 C4 2 ${tipX - 5} 14 ${tipX - 1.5} 20 Q${tipX} 24 ${tipX + 1.5} 20 C${tipX + 5} 14 16 2 20 -2`} />
					</svg>
				)
				: null}
		</div>
	);
}
