import { useLocale, useT, type TranslationKey } from "../../i18n";
import type { ReactNode } from "react";
import type { useTrafficPlayback } from "./useTrafficPlayback";
import type { TrafficTimelineEvent } from "./traffic-timeline";
import TrafficIcon from "./TrafficIcon";
import { senderLabel } from "./traffic-model";

type Props = {
	playback: ReturnType<typeof useTrafficPlayback>;
	windowControl: ReactNode;
	/**
	 * The time ruler under the track, when the screen has a history span to draw.
	 * Absent it falls back to the two plain clocks — the transport keeps working
	 * with nothing loaded, which is exactly when a ruler has nothing to say.
	 */
	range?: ReactNode;
	historical?: boolean;
	loading?: boolean;
	/**
	 * What an empty transport means. A filter that matches nothing and a window
	 * that simply holds nothing are different facts, and the entry window is the
	 * trailing hour — which on a quiet morning is legitimately empty.
	 */
	emptyKey: TranslationKey;
	onLive?: () => void;
	onInspect: (key: string) => void;
};
export default function TrafficPlayback({
	playback: p,
	windowControl,
	range,
	historical = false,
	loading = false,
	emptyKey,
	onLive,
	onInspect,
}: Props) {
	const t = useT();
	const [locale] = useLocale();
	const event = p.current ?? p.events[p.events.length - 1];
	const clock = (at: number) =>
		new Date(at).toLocaleTimeString(locale, {
			hour: "2-digit",
			minute: "2-digit",
		});
	// The readout describes whichever kind of event the cursor stands on. A board
	// movement is a step of its own now, so it gets its own line rather than
	// borrowing the last message's subject and pretending a message happened.
	const readout = describeEvent(event, t, loading, emptyKey);
	return (
		<section
			className="traffic-playback"
			aria-label={t("traffic.replay.label")}
		>
			<div className="traffic-event-readout">
				<time>{event ? clock(event.at) : "—"}</time>
				<TrafficIcon name={readout.icon} />
				<button
					disabled={!event || event.kind !== "message"}
					onClick={() =>
						event?.kind === "message" && onInspect(event.record.key)
					}
					className="traffic-event-subject"
				>
					{readout.lead && <b>{readout.lead}</b>}
					{/* Only agent-authored text is private. A localized "Board move" is
					    the app's own label and blurring it just hides the readout. */}
					<span className={readout.private ? "streamer-private" : undefined}>
						{readout.text}
					</span>
				</button>
				<span className="traffic-event-counter">
					{p.index < 0 ? p.events.length : p.index + 1} / {p.events.length}
				</span>
			</div>
			<div className="traffic-transport">
				<button
					type="button"
					disabled={!p.events.length || p.index === 0}
					onClick={() => p.step(-1)}
					title={t("traffic.replay.previous")}
					aria-label={t("traffic.replay.previous")}
				>
					<TrafficIcon name="previous" />
				</button>
				<button
					type="button"
					className="traffic-play-button"
					data-testid="traffic-play"
					disabled={!p.events.length}
					onClick={p.playPause}
					aria-label={t(
						p.playing ? "traffic.replay.pause" : "traffic.replay.play",
					)}
				>
					<span
						className={`traffic-play-icons ${p.playing ? "is-playing" : ""}`}
					>
						<TrafficIcon name="play" />
						<TrafficIcon name="pause" />
					</span>
				</button>
				<button
					type="button"
					disabled={!p.events.length || p.index === p.events.length - 1}
					onClick={() => p.step(1)}
					title={t("traffic.replay.next")}
					aria-label={t("traffic.replay.next")}
				>
					<TrafficIcon name="next" />
				</button>
				<select
					aria-label={t("traffic.replay.speed")}
					value={p.speed}
					onChange={(e) => p.setSpeed(Number(e.target.value))}
				>
					{[0.25, 0.5, 1, 2, 4, 8].map((speed) => (
						<option key={speed} value={speed}>
							{speed}×
						</option>
					))}
				</select>
				<div className="traffic-replay-track">
					<div className="traffic-replay-dots" aria-hidden="true">
						{p.events.map((e, i) => (
							<i
								key={e.key}
								className={i === p.index ? "is-current" : ""}
								style={{
									left: `${(i / Math.max(1, p.events.length - 1)) * 100}%`,
								}}
							/>
						))}
					</div>
					<input
						type="range"
						min={0}
						max={Math.max(0, p.events.length - 1)}
						value={p.index < 0 ? Math.max(0, p.events.length - 1) : p.index}
						disabled={!p.events.length}
						onChange={(e) => p.seek(Number(e.target.value))}
						aria-label={t("traffic.orbit.messageTimeline")}
						aria-valuetext={
							event
								? `${clock(event.at)} · ${readout.lead ? `${readout.lead} · ` : ""}${readout.text}`
								: t(emptyKey)
						}
					/>
					{range ?? (
						<div className="traffic-replay-times">
							<span>{p.events[0] && clock(p.events[0].at)}</span>
							<span>{event && clock(event.at)}</span>
						</div>
					)}
				</div>
				<div className="traffic-replay-window">{windowControl}</div>
				<button
					type="button"
					className={p.index < 0 && !historical ? "is-active" : ""}
					onClick={onLive ?? p.live}
				>
					{t("traffic.orbit.live")}
				</button>
			</div>
			<p className="traffic-replay-note">{t("traffic.replay.currentStates")}</p>
		</section>
	);
}

/**
 * One readout line per event kind. A board movement names the card and what it
 * did; a message keeps the sender → recipient pair and its subject; a
 * notification keeps its own text and both endpoints as the archive recorded
 * them — an unrecorded sender says so rather than borrowing the target's name.
 */
function describeEvent(
	event: TrafficTimelineEvent | undefined,
	t: ReturnType<typeof useT>,
	loading: boolean,
	emptyKey: TranslationKey,
): { icon: "message" | "replay" | "bell"; lead: string | null; text: string; private: boolean } {
	if (!event) {
		return {
			icon: "message",
			lead: null,
			text: t(loading ? "traffic.loading" : emptyKey),
			private: false,
		};
	}
	if (event.kind === "message") {
		const { row } = event.record;
		return {
			icon: "message",
			lead: `${senderLabel(row, t("traffic.node.you"))} → #${row.toSeq}`,
			text: row.subject || row.body.slice(0, 120),
			private: true,
		};
	}
	if (event.kind === "notification") {
		const { notification } = event;
		const seq = (end: typeof notification.target) =>
			end ? (end.seq === null ? "#?" : `#${end.seq}`) : null;
		const from = seq(notification.origin);
		const to = seq(notification.target);
		return {
			icon: "bell",
			lead: `${from ?? t("traffic.notification.unrecordedSender")}${to ? ` → ${to}` : ""}`,
			text: notification.row.message,
			private: true,
		};
	}
	return {
		icon: "replay",
		lead: `#${event.seq ?? "—"}`,
		text:
			event.movement.kind === "created"
				? t("traffic.replay.taskCreated")
				: t("traffic.replay.taskMoved"),
		private: false,
	};
}
