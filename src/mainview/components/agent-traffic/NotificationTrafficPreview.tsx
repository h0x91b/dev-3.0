/**
 * Standalone readout of the notification archive with its own replay cursor.
 *
 * WHY a second surface exists at all: the shared traffic cursor is owned by the
 * historical-projection work happening in parallel, and this component must not
 * reach into it. So the notification pieces get their own cursor here — same
 * time-based selection the shared one will use (`notificationsAt`) — which makes
 * them drivable and verifiable now instead of after the merge.
 *
 * Reachable only with `?notificationPreview=1`. Not a product surface: it adds
 * no navigation, no control anywhere else in the app, and leaves no trace
 * without the parameter.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import { notificationsAt } from "./notification-event";
import TrafficNotificationBubble from "./TrafficNotificationBubble";
import { useNotificationTraffic } from "./useNotificationTraffic";
import "./traffic-notification.css";

/** Five minutes of recorded time per tick, so a whole day scrubs in ~10 seconds. */
const PLAY_STEP_MS = 5 * 60_000;
const PLAY_INTERVAL_MS = 90;
/** How long a bubble stays after the cursor crosses it, in recorded time. */
const BUBBLE_WINDOW_MS = 90 * 60_000;

export default function NotificationTrafficPreview() {
	const t = useT();
	const { events, oldestDay, newestDay, retentionDays, loading, loaded, error, hasMore } = useNotificationTraffic(null, 1000);
	const [cursor, setCursor] = useState<number | null>(null);
	const [playing, setPlaying] = useState(false);
	const span = useMemo(() => {
		if (!events.length) return null;
		return { from: events[0].at, to: events[events.length - 1].at };
	}, [events]);

	// Live appends must not move a cursor the user placed. A fresh span only
	// adopts the newest position while the cursor has never been set.
	const at = cursor ?? span?.to ?? 0;
	useEffect(() => {
		if (!playing || !span) return;
		const timer = setInterval(() => {
			setCursor(current => {
				const next = (current ?? span.from) + PLAY_STEP_MS;
				if (next >= span.to) {
					setPlaying(false);
					return span.to;
				}
				return next;
			});
		}, PLAY_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [playing, span]);

	const visible = notificationsAt(events, at, { windowMs: BUBBLE_WINDOW_MS, max: 3 });
	// Measured rather than read off the ref during render: a ref is null on the
	// first pass, and a bubble clamped against a guessed width hangs off the edge.
	const canvas = useRef<HTMLDivElement>(null);
	const [canvasSize, setCanvasSize] = useState({ width: 1000, height: 320 });
	useEffect(() => {
		const element = canvas.current;
		if (!element) return;
		const measure = () => setCanvasSize({ width: element.clientWidth, height: element.clientHeight });
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const range = !oldestDay || !newestDay
		? t("traffic.notification.collectionNotStarted")
		: oldestDay === newestDay
			? t("traffic.notification.rangeOneDay", { from: oldestDay })
			: t("traffic.notification.range", { from: oldestDay, to: newestDay });

	return (
		<div className="notification-preview" data-testid="notification-preview">
			<header>
				<strong>{t("traffic.notification.filter")}</strong>
				<span>{t.plural("traffic.notification.count", events.length)}</span>
				<span>{range}</span>
				<span>{retentionDays}d retention{hasMore ? " · older rows still on disk" : ""}</span>
				{loading ? <span>{t("traffic.loading")}</span> : null}
				{error ? <span>read failed</span> : null}
			</header>

			{loaded && !events.length
				? (
					<p>
						{t("traffic.notification.empty")}
						{" "}
						<span>{t("traffic.notification.emptyHint")}</span>
					</p>
				)
				: null}

			<div className="notification-preview-canvas" ref={canvas}>
				{visible.map((event, index) => (
					<TrafficNotificationBubble
						key={event.key}
						event={event}
						anchor={{ x: Math.round(canvasSize.width * (index * 2 + 1) / 6), y: 210 }}
						width={canvasSize.width}
						height={canvasSize.height}
					/>
				))}
			</div>

			{span
				? (
					<div className="notification-preview-controls">
						<button type="button" onClick={() => { setCursor(span.from); setPlaying(true); }}>Restart</button>
						<button type="button" onClick={() => setPlaying(value => !value)}>{playing ? "Pause" : "Play"}</button>
						<button type="button" onClick={() => setCursor(Math.max(span.from, at - PLAY_STEP_MS * 12))}>← Back</button>
						<button type="button" onClick={() => setCursor(null)}>Live</button>
						<input
							type="range"
							aria-label="Notification timeline"
							min={span.from}
							max={span.to}
							step={1000}
							value={at}
							onChange={changeEvent => { setPlaying(false); setCursor(Number(changeEvent.target.value)); }}
						/>
						<time>{new Date(at).toLocaleString()}</time>
					</div>
				)
				: null}

			<ol className="notification-preview-list">
				{[...events].reverse().map(event => (
					<li key={event.key}>
						<TrafficNotificationBubble event={event} />
					</li>
				))}
			</ol>
		</div>
	);
}
