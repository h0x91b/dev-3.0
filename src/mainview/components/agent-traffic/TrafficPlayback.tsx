import { useLocale, useT } from "../../i18n";
import type { ReactNode } from "react";
import type { useTrafficPlayback } from "./useTrafficPlayback";
import TrafficIcon from "./TrafficIcon";

type Props = {
	playback: ReturnType<typeof useTrafficPlayback>;
	windowControl: ReactNode;
	historical?: boolean;
	loading?: boolean;
	onLive?: () => void;
	onInspect: (key: string) => void;
};
export default function TrafficPlayback({
	playback: p,
	windowControl,
	historical = false,
	loading = false,
	onLive,
	onInspect,
}: Props) {
	const t = useT();
	const [locale] = useLocale();
	const event = p.current ?? p.events[p.events.length - 1];
	const clock = (at: string) =>
		new Date(at).toLocaleTimeString(locale, {
			hour: "2-digit",
			minute: "2-digit",
		});
	return (
		<section
			className="traffic-playback"
			aria-label={t("traffic.replay.label")}
		>
			<div className="traffic-event-readout">
				<time>{event ? clock(event.row.at) : "—"}</time>
				<TrafficIcon name="message" />
				<button
					disabled={!event}
					onClick={() => event && onInspect(event.key)}
					className="traffic-event-subject"
				>
					{event && (
						<b>
							{event.row.fromSeq == null ? "—" : `#${event.row.fromSeq}`} → #
							{event.row.toSeq}
						</b>
					)}
					<span className="streamer-private">
						{event?.row.subject ||
							event?.row.body.slice(0, 120) ||
							t(loading ? "traffic.loading" : "traffic.noneMatch")}
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
								? `${clock(event.row.at)} · ${event.row.subject || t("traffic.orbit.noSubject")}`
								: t("traffic.noneMatch")
						}
					/>
					<div className="traffic-replay-times">
						<span>{p.events[0] && clock(p.events[0].row.at)}</span>
						<span>{event && clock(event.row.at)}</span>
					</div>
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
