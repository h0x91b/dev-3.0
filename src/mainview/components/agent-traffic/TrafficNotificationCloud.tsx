import { useLayoutEffect, useRef, useState } from "react";
import type { NotificationLogLevel } from "../../../shared/notification-log";
import { useT } from "../../i18n";
import { notificationCloud } from "./notification-cloud";

/**
 * What `dev3 notify` said, previewed over the card that sent it.
 *
 * Deliberately not the message bubble: a notification is not an exchange between
 * two cards, so it gets its own silhouette and its own tone. The level is carried
 * by a word as well as by colour — the three levels are the whole point of the
 * preview, and colour alone does not survive a colour-blind reader or a
 * screenshot.
 *
 * The full text stays in the inspector list. This is a preview: two lines, then
 * an ellipsis.
 */
export default function TrafficNotificationCloud({
	message,
	level,
	anchor,
	width,
	height,
	compact,
}: {
	message: string;
	level: NotificationLogLevel;
	/** Top centre of the sending card, in frame coordinates. */
	anchor: { x: number; y: number };
	/** The frame's own size, for clamping and for hiding an off-frame sender. */
	width: number;
	height: number;
	/** Zoomed far enough out that a full-size cloud would swamp its card. */
	compact: boolean;
}) {
	const t = useT();
	const ref = useRef<HTMLDivElement>(null);
	// A first guess, replaced on the first layout pass. It only has to be close
	// enough that the very first paint is not wildly mis-clamped.
	const [box, setBox] = useState({ width: 180, height: 34 });
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const measure = () => {
			if (element.offsetWidth && element.offsetHeight)
				setBox({ width: element.offsetWidth, height: element.offsetHeight });
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [message, compact]);
	const cloud = notificationCloud(box.width, box.height, compact);
	// Above the card by default, below it when the card sits too close to the top
	// edge for the cloud to fit — the same rule the message bubble follows.
	const below = anchor.y < cloud.height + 16;
	const left = Math.max(
		cloud.width / 2 + 8,
		Math.min(width - cloud.width / 2 - 8, anchor.x),
	);
	const top = anchor.y + (below ? 14 : -10);
	// An off-frame sender gets no preview at all rather than a cloud pinned to the
	// edge pointing at nothing: the stage never moves on its own to bring it back.
	const offFrame =
		anchor.x < 0 || anchor.x > width || anchor.y < 0 || anchor.y > height;
	return (
		<div
			className={`traffic-notification-cloud level-${level} ${compact ? "is-compact" : ""} ${below ? "is-below" : ""}`}
			data-testid="traffic-notification-cloud"
			data-level={level}
			style={{
				left,
				top,
				width: cloud.width,
				height: cloud.height,
				visibility: offFrame ? "hidden" : undefined,
			}}
		>
			<svg
				className="traffic-notification-cloud-outline"
				width={cloud.width}
				height={cloud.height}
				viewBox={`0 0 ${cloud.width} ${cloud.height}`}
				aria-hidden="true"
			>
				<path d={cloud.path} />
			</svg>
			<div
				ref={ref}
				className="traffic-notification-cloud-body"
				style={{ left: cloud.content.x, top: cloud.content.y }}
			>
				<span className="traffic-notification-cloud-level">
					{t(`traffic.notification.level.${level}`)}
				</span>
				<strong className="streamer-private">{message}</strong>
			</div>
		</div>
	);
}
