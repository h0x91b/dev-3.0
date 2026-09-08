/**
 * One recorded `dev3 notify` call, drawn as a thought cloud over the card that
 * sent it.
 *
 * Why a cloud and not the message bubble's shape: a message is one agent speaking
 * to another, and it belongs on the line between two cards. A notification is an
 * agent thinking out loud at the human — it has one end, not two — so it hangs
 * above its own card as a thought, lobed edges and a trail of puffs included. The
 * outline is computed from the measured text in `traffic-cloud.ts`, because the
 * lobes have to be rebuilt whenever the text changes size.
 *
 * WHERE it hangs: over the card the notification was SENT FROM (`origin`) and
 * nowhere else. That is not always the card it is about — `dev3 notify --task
 * <other>` addresses somebody else's card from your worktree — and when the
 * archive recorded no source the cloud is UNANCHORED rather than falling back to
 * the target. Hanging a thought over a card that never sent it would invent a
 * sender out of a missing field.
 *
 * `row.message` is text an agent wrote. It reaches the DOM as a React child and
 * nothing else — no `dangerouslySetInnerHTML` on this path, ever.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { type TranslationKey, useT } from "../../i18n";
import type { NotificationEndpoint, TrafficNotificationEvent } from "./notification-event";
import { CLOUD_TEXT_MAX_WIDTH, cloudGeometry } from "./traffic-cloud";
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

/**
 * The card a cloud hangs over: the SENDER, or nothing.
 *
 * There is deliberately no fallback to the card the notification is *about*. A
 * thought cloud says "this card thought this", so hanging one over a target that
 * never sent it would invent a sender out of a missing field — and a missing
 * source is the archive not recording one, not evidence about who called. An
 * unrecorded source therefore stays unanchored: the cloud belongs to the
 * timeline, and the card it is about is named in words instead, which reads as
 * a different claim because it is one.
 *
 * Exported because the surface that lays the clouds out needs the same answer to
 * pick a node, and two copies of this rule would drift.
 */
export function cloudSenderEndpoint(event: TrafficNotificationEvent): NotificationEndpoint | null {
	return event.origin;
}

export default function TrafficNotificationBubble({ event, anchor, width, height, onKnownTask }: {
	event: TrafficNotificationEvent;
	/** Top-centre of the card to hang over, in canvas coordinates. Omit for flow. */
	anchor?: { x: number; y: number };
	/** Canvas size, used to keep an anchored cloud on screen. */
	width?: number;
	height?: number;
	/** Whether the board being shown has this card. Unknown when not supplied. */
	onKnownTask?: (endpoint: NotificationEndpoint) => boolean;
}) {
	const t = useT();
	const contentRef = useRef<HTMLDivElement>(null);
	const [content, setContent] = useState({ width: 250, height: 78 });
	useLayoutEffect(() => {
		const element = contentRef.current;
		if (!element) return;
		const measure = () => {
			if (element.offsetWidth && element.offsetHeight)
				setContent({ width: element.offsetWidth, height: element.offsetHeight });
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [event.key, width]);

	const { row, target, origin } = event;
	const canvasWidth = width ?? 0;
	const cloud = cloudGeometry(content.width, content.height, { tail: !!anchor });
	// The cloud sits ABOVE the card by default, which is the whole point of it. It
	// flips below only when there is not enough room overhead.
	const below = !!anchor && anchor.y < cloud.height + 16;
	const placement = anchor
		? {
			left: Math.max(cloud.width / 2 + 8, Math.min(canvasWidth - cloud.width / 2 - 8, anchor.x)),
			top: below ? anchor.y + 14 : anchor.y - cloud.height - 6,
		}
		: null;
	const offCanvas = !!anchor && (anchor.x < 0 || anchor.x > canvasWidth || anchor.y < 0 || anchor.y > (height ?? 0));

	const time = new Date(event.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	const sender = cloudSenderEndpoint(event);
	// A card the shown board does not have is still a real anchor: it keeps its
	// place and gets a line saying the board does not have it. Nothing about its
	// status is inferred, and it is never reattached to another card.
	const anchorOffBoard = !!sender && !!onKnownTask && !onKnownTask(sender);

	return (
		<div
			className={`traffic-notification ${anchor ? "is-anchored" : ""} ${below ? "is-below" : ""}`}
			data-level={event.level}
			data-outcome={event.outcome}
			data-testid="traffic-notification"
			style={placement
				? { left: placement.left, top: placement.top, width: cloud.width, visibility: offCanvas ? "hidden" : undefined }
				: { width: cloud.width }}
		>
			<svg className="traffic-cloud" viewBox={`0 0 ${cloud.width} ${cloud.height}`} width={cloud.width} height={cloud.height} aria-hidden="true">
				{/* Rim first, body over it: one grown copy of the same silhouette is what
				    gives a clean outline without stroking every internal arc. */}
				<path className="traffic-cloud-rim" d={cloud.bodyRim} />
				{cloud.tailRim ? <path className="traffic-cloud-rim" d={cloud.tailRim} /> : null}
				<path className="traffic-cloud-body" d={cloud.body} />
				{cloud.tail ? <path className="traffic-cloud-body" d={cloud.tail} /> : null}
			</svg>

			{/* The SVG is mirrored when the cloud hangs below its card, so the body ends
			    up at the bottom of the viewBox; the text follows it, unmirrored. */}
			<div
				className="traffic-notification-content"
				ref={contentRef}
				style={{ top: below ? cloud.height - cloud.inset - content.height : cloud.inset, left: cloud.inset }}
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
				<div className="traffic-notification-body streamer-private" style={{ maxWidth: CLOUD_TEXT_MAX_WIDTH }} title={row.message}>{row.message}</div>

				<div className="traffic-notification-foot" style={{ maxWidth: CLOUD_TEXT_MAX_WIDTH }}>
					{/* Sender, then subject when it differs or when there is no sender to
					    name. "Not recorded" is a fact about the archive, never a claim
					    that the call came from outside a worktree. */}
					{origin
						? <span className="traffic-notification-endpoint">{t("traffic.notification.fromTask", { seq: origin.seq === null ? "—" : String(origin.seq) })}</span>
						: <span>{target ? t("traffic.notification.noSource") : t("traffic.notification.noTask")}</span>}
					{target && (!origin || event.crossAddressed)
						? <span className="traffic-notification-endpoint">{t("traffic.notification.aboutTask", { seq: target.seq === null ? "—" : String(target.seq) })}</span>
						: null}
					{anchorOffBoard ? <span>{t("traffic.notification.offBoard")}</span> : null}
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
			</div>
		</div>
	);
}
