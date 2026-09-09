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
import { CLOUD_TEXT_MAX_WIDTH, COMPACT_LIFT, COMPACT_LOBE_R, COMPACT_PITCH_SCALE, COMPACT_TAIL_SCALE, cloudGeometry } from "./traffic-cloud";
import { type Rect, placeClouds } from "./cloud-placement";
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

export default function TrafficNotificationBubble({ event, anchor, width, height, placement = "auto", density = "full", room, obstacles, at, onKnownTask }: {
	event: TrafficNotificationEvent;
	/**
	 * Top-centre of the card to hang over, in canvas coordinates. Omit for flow.
	 *
	 * `height` is the card's own height, and it only matters when the cloud hangs
	 * BELOW: `y` is the card's top, so without it the cloud starts inside the card
	 * and the thought trail is drawn across the card's own title. Measured, not
	 * reasoned about — that is exactly what the first `below` render did.
	 */
	anchor?: { x: number; y: number; height?: number };
	/** Canvas size, used to keep an anchored cloud on screen. */
	width?: number;
	height?: number;
	/**
	 * Which side of the card to hang on.
	 *
	 * `auto` hangs above and flips below only when the canvas has no room
	 * overhead — the right default, and all this component can decide on its own.
	 * It cannot decide more than that: whether the space above is actually EMPTY
	 * depends on the other cards, and only the surface laying them out knows
	 * where they are. So a stage that finds a cloud drawn across the card above
	 * says `below` for that one rather than having this component guess.
	 */
	placement?: "auto" | "above" | "below";
	/**
	 * How much of the notification the cloud carries.
	 *
	 * `full` is the reading version: type line, the message over up to four lines,
	 * sender, subject and the outcome pill. `compact` is a PREVIEW for a crowded
	 * canvas — the level icon and one line of the message, clipped with an
	 * ellipsis so the cut is visible rather than silent, with the whole text still
	 * on the element's `title`. Measured on the real stage, not chosen for taste:
	 * at `full` size a cloud crossed up to six cards, and picking a side cannot
	 * fix that because both directions collide. The full text lives on in the
	 * list, which is the surface built for reading it.
	 */
	density?: "full" | "compact";
	/**
	 * Clear vertical space in the anchor's own column, in canvas pixels.
	 *
	 * This is the one thing `auto` cannot see and the layout already knows: how
	 * far it is to the nearest card above and below, rather than to the canvas
	 * edge. Given it, `auto` picks the side the cloud actually FITS in — which on
	 * a dense stage is a different answer for almost every card, and measured
	 * there it is what turns six crossed cards into none. Omit it and `auto`
	 * falls back to the canvas edge, exactly as before.
	 */
	room?: { above: number; below: number };
	/**
	 * A position already decided by `placeClouds`, which is how a canvas with
	 * several clouds on it avoids stacking them on each other — a cloud cannot see
	 * its neighbours from in here. Given this, the cloud simply draws where it is
	 * told and ignores `placement` and `room`.
	 */
	at?: { left: number; top: number; side: "above" | "below"; overlap?: number };
	/**
	 * Everything on the canvas the cloud must not cover, in the SAME space the
	 * cloud is positioned in — cards, group frames, the caption, the minimap, the
	 * camera controls. The sender's own card may stay in the list; the cloud is
	 * meant to touch that one and excludes it itself.
	 *
	 * This is what `room` cannot express. Two gap numbers describe the anchor's own
	 * column, and the overlap that survived on the real stage was HORIZONTAL: a
	 * cloud is wider than a card, so it reaches into neighbouring columns whatever
	 * side it takes. With the boxes it can step sideways or up a storey instead.
	 */
	obstacles?: readonly Rect[];
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
	const compact = density === "compact";
	const cloud = cloudGeometry(content.width, content.height, { tail: !!anchor, ...(compact ? { lobe: COMPACT_LOBE_R, lift: COMPACT_LIFT, tailScale: COMPACT_TAIL_SCALE, pitchScale: COMPACT_PITCH_SCALE } : {}) });
	// The cloud sits ABOVE the card by default, which is the whole point of it. It
	// flips below when the canvas has no room overhead, or when the surface that
	// owns the layout says so because something else occupies that space.
	// `auto` prefers ABOVE — a thought belongs over the head that had it — and only
	// gives that up when the cloud does not fit there. "Fit" means the neighbours
	// when the layout reported them, and the canvas edge when it did not.
	const fitsAbove = room ? room.above >= cloud.height + 6 : !!anchor && anchor.y >= cloud.height + 16;
	const fitsBelow = room ? room.below >= cloud.height + 14 : true;
	// When NEITHER side fits — a dense stage has cards where no gap is cloud-sized —
	// take the roomier one rather than staying above out of preference. Measured:
	// the bottom-row card had 35px above and 61px below, and keeping the preference
	// there covered two other cards for nothing.
	const roomier = room ? (room.below > room.above ? "below" : "above") : "above";
	const auto = fitsAbove ? "above" : fitsBelow ? "below" : roomier;
	// One cloud, placed by the shared engine, so the candidate order and the clamp
	// are not written twice. The stage renders exactly one cloud at a time — its
	// own structural rule, measured — so a batch call here would be a single-element
	// batch, and the engine takes exactly that.
	const solved = anchor && obstacles && placement === "auto" && content.width > 0
		? placeClouds({
			canvas: { width: canvasWidth, height: height ?? 0 },
			obstacles,
			clouds: [{ key: event.key, anchor, size: { width: cloud.width, height: cloud.height } }],
		}).get(event.key) ?? null
		: null;
	const below = (at ?? solved)
		? (at ?? solved)!.side === "below"
		: !!anchor && (placement === "below" || (placement === "auto" && auto === "below"));
	// Clamped into the canvas in BOTH axes. An unclamped cloud does not merely sit
	// awkwardly, it leaves the viewport — and a cloud pushed off the bottom looks
	// like zero overlap while actually being gone, which is how a fix for this
	// overlap first appeared to succeed.
	const canvasHeight = height ?? 0;
	const decided = at ?? solved;
	const position = decided
		? { left: decided.left + cloud.width / 2, top: decided.top }
		: anchor
		? {
			left: Math.max(cloud.width / 2 + 8, Math.min(canvasWidth - cloud.width / 2 - 8, anchor.x)),
			top: canvasHeight > cloud.height + 8
				? Math.max(4, Math.min(canvasHeight - cloud.height - 4, below ? anchor.y + (anchor.height ?? 0) + 14 : anchor.y - cloud.height - 6))
				: below ? anchor.y + (anchor.height ?? 0) + 14 : anchor.y - cloud.height - 6,
		}
		: null;
	const offCanvas = !!anchor && (anchor.x < 0 || anchor.x > canvasWidth || anchor.y < 0 || anchor.y > (height ?? 0));

	const time = new Date(event.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	const sender = cloudSenderEndpoint(event);
	// A card the shown board does not have is still a real anchor: it keeps its
	// place and gets a line saying the board does not have it. Nothing about its
	// status is inferred, and it is never reattached to another card.
	const anchorOffBoard = !!sender && !!onKnownTask && !onKnownTask(sender);

	// `data-cloud-*` are diagnostics for an acceptance run on the real stage: what
	// the placement BELIEVES it achieved. A cloud reporting 0 overlap while a card
	// title is visibly covered means the obstacle boxes it was handed are wrong or
	// stale, not that the search failed — the two causes look identical in a
	// screenshot and are fixed in different places.
	return (
		<div
			className={`traffic-notification ${anchor ? "is-anchored" : ""} ${below ? "is-below" : ""} ${compact ? "is-compact" : ""}`}
			data-level={event.level}
			data-outcome={event.outcome}
			data-cloud-side={decided ? decided.side : undefined}
			data-cloud-overlap={decided?.overlap}
			data-testid="traffic-notification"
			style={position
				? { left: position.left, top: position.top, width: cloud.width, visibility: offCanvas ? "hidden" : undefined }
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
					{compact
						? (
							// The level is still named for a screen reader; on screen the icon
							// and the tone carry it, because a preview has one line to spend.
							<>
								{/* The sender in words, not only as a trail of puffs. At the zoom
								    the stage opens on, whether the puffs read as a connection could
								    not be confirmed — so the claim does not rest on them alone. */}
								{origin
									? <span className="traffic-notification-endpoint traffic-notification-sender">#{origin.seq === null ? "—" : origin.seq}</span>
									: null}
								<span className="traffic-notification-preview streamer-private" title={row.message}>
									<span className="sr-only">{t(`traffic.notification.level.${event.level}` as TranslationKey)}: </span>
									{row.message}
								</span>
							</>
						)
						: (
							<>
								<span>
									{t("traffic.notification.kind")} · {t(`traffic.notification.level.${event.level}` as TranslationKey)} · {t(`traffic.notification.mode.${event.mode}` as TranslationKey)}
								</span>
								<time dateTime={row.at}>{time}</time>
							</>
						)}
				</div>

				{/* `title` carries the untruncated text — the clamp is visual only, and the
				    data is never cut. */}
				{compact
					? null
					: <div className="traffic-notification-body streamer-private" style={{ maxWidth: CLOUD_TEXT_MAX_WIDTH }} title={row.message}>{row.message}</div>}

				{compact ? null : (
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
				)}
			</div>
		</div>
	);
}
