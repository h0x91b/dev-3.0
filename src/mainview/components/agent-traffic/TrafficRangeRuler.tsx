import { useEffect, useRef, useState } from "react";
import { useLocale, useT } from "../../i18n";
import {
	moveRange,
	normalizeRange,
	rangeFraction,
	rangeStep,
	resizeRange,
	rulerTicks,
	rulerTickStep,
	timeAtFraction,
	formatRangeLabel,
	type RangeEdge,
	type TimeRange,
} from "./traffic-range";

/**
 * The time axis under the replay transport: what history is loaded, which slice
 * of it the screen is showing, and a grip on that slice.
 *
 * It draws a span WIDER than the window, never the window itself. A ruler that
 * redrew itself to the interval it had just selected would shrink to it on every
 * drag, leaving no way back except the presets — the trap every selector that is
 * its own domain falls into. Drawing context around the band instead means there
 * is always empty ruler to drag the band into, on both sides.
 *
 * The band is the SAME state the period picker writes (`windowSize`), so a preset
 * and a drag are two ways to move one thing rather than two competing ranges.
 * Nothing here touches the replay cursor: the cursor's own instant is drawn as a
 * hairline for orientation, and it is moved by the transport above, never here.
 */
type Props = {
	/** The span of history the ruler draws, always wider than `range`. */
	domain: TimeRange;
	/** The window on screen now, already clipped to the domain. */
	range: TimeRange;
	/**
	 * Whether the window is a rolling preset ("the last hour") rather than a fixed
	 * interval. A rolling window's right edge is now and keeps moving; a dragged
	 * one is frozen where the reader put it.
	 */
	rolling: boolean;
	/** The replay cursor's instant, drawn for orientation only. */
	cursorAt?: number | null;
	onChange: (range: TimeRange) => void;
	disabled?: boolean;
};

type DragMode = "new" | "move" | RangeEdge;

interface Drag {
	mode: DragMode;
	edge: RangeEdge;
	originX: number;
	originAt: number;
	base: TimeRange;
	range: TimeRange;
	moved: boolean;
}

/** A drag this short is a click that missed, not an interval anybody meant to draw. */
const DRAG_SLOP_PX = 3;

export default function TrafficRangeRuler({
	domain,
	range,
	rolling,
	cursorAt,
	onChange,
	disabled = false,
}: Props) {
	const t = useT();
	const [locale] = useLocale();
	const track = useRef<HTMLDivElement>(null);
	const [drag, setDrag] = useState<Drag | null>(null);
	// The domain is frozen for the length of a drag: it ends at `now`, which moves
	// under a rolling window, and a domain that shifted mid-gesture would slide the
	// interval out from under the pointer.
	const frozen = useRef<TimeRange>(domain);
	const live = drag ? frozen.current : domain;
	// A press that has not travelled yet shows the window it landed on, not the
	// hairline under the pointer — otherwise a missed grab flickers the band.
	const shown = drag && (drag.mode !== "new" || drag.moved) ? drag.range : range;
	const usable = live.end > live.start && !disabled;

	const clock = (at: number) =>
		new Date(at).toLocaleTimeString(locale, {
			hour: "2-digit",
			minute: "2-digit",
		});
	const stamp = (at: number) =>
		new Date(at).toLocaleString(locale, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	// A ruler that fits inside a day says times; one that spans days has to say
	// which day, or the two ends read as the same clock hour twice.
	const withinDay = live.end - live.start <= 86400000;
	const edge = (at: number) => (withinDay ? clock(at) : stamp(at));
	// Ticks a day apart all land on midnight, so a clock would print the same
	// label three times over. Once the step reaches a day, the tick IS the date.
	const daily = rulerTickStep(live) >= 86400000;
	const tickLabel = (at: number) =>
		daily
			? new Date(at).toLocaleDateString(locale, {
					month: "short",
					day: "numeric",
				})
			: clock(at);
	const intervalText = formatRangeLabel(shown, locale);

	/**
	 * The gesture's listeners go on in the pointerdown handler itself, not from an
	 * effect keyed on the drag state.
	 *
	 * An effect runs a render later, and a pointerup that lands inside that gap —
	 * a fast tap, a synthetic event, a test — is heard by nobody: the drag then
	 * never ends and the band follows the cursor with no button held. Registering
	 * at the source removes the gap entirely.
	 */
	const release = useRef<(() => void) | null>(null);
	useEffect(() => () => release.current?.(), []);

	function begin(event: React.PointerEvent<HTMLElement>, mode: DragMode) {
		if (!usable || event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		release.current?.();
		frozen.current = domain;
		const box = track.current?.getBoundingClientRect();
		const width = box && box.width > 0 ? box.width : 0;
		const atX = (clientX: number) =>
			width && box
				? timeAtFraction((clientX - box.left) / width, domain)
				: domain.start;
		const at = atX(event.clientX);
		const started: Drag = {
			mode,
			edge: mode === "end" ? "end" : "start",
			originX: event.clientX,
			originAt: at,
			base: range,
			range: mode === "new" ? normalizeRange(at, at, domain, at) : range,
			moved: false,
		};
		setDrag(started);
		const move = (moveEvent: PointerEvent) => {
			const pointerAt = atX(moveEvent.clientX);
			setDrag((current) => {
				if (!current) return current;
				const moved =
					current.moved ||
					Math.abs(moveEvent.clientX - current.originX) > DRAG_SLOP_PX;
				if (current.mode === "move")
					return {
						...current,
						moved,
						range: moveRange(current.base, pointerAt - current.originAt, domain),
					};
				if (current.mode === "new")
					return {
						...current,
						moved,
						range: normalizeRange(
							current.originAt,
							pointerAt,
							domain,
							current.originAt,
						),
					};
				const next = resizeRange(current.range, current.edge, pointerAt, domain);
				return { ...current, moved, edge: next.edge, range: next.range };
			});
		};
		const finish = () => {
			release.current?.();
			setDrag((current) => {
				if (!current) return null;
				// A press that never travelled is not an interval. It deliberately does
				// nothing at all rather than seeking: the cursor belongs to the
				// transport, and a ruler that moved it would make every missed grab a
				// jump in the replay.
				if (current.mode !== "new" || current.moved) onChange(current.range);
				return null;
			});
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", finish);
		window.addEventListener("pointercancel", finish);
		release.current = () => {
			release.current = null;
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", finish);
			window.removeEventListener("pointercancel", finish);
		};
	}

	function keyStep(event: React.KeyboardEvent, part: "move" | RangeEdge) {
		if (!usable) return;
		const step = rangeStep(live) * (event.shiftKey ? 10 : 1);
		const big = rangeStep(live) * 10;
		let next: TimeRange | null = null;
		const shift = (delta: number) =>
			part === "move"
				? moveRange(range, delta, live)
				: resizeRange(
						range,
						part,
						(part === "start" ? range.start : range.end) + delta,
						live,
					).range;
		switch (event.key) {
			case "ArrowLeft":
			case "ArrowDown":
				next = shift(-step);
				break;
			case "ArrowRight":
			case "ArrowUp":
				next = shift(step);
				break;
			case "PageDown":
				next = shift(-big);
				break;
			case "PageUp":
				next = shift(big);
				break;
			case "Home":
				next =
					part === "move"
						? moveRange(range, live.start - range.start, live)
						: resizeRange(range, part, live.start, live).range;
				break;
			case "End":
				next =
					part === "move"
						? moveRange(range, live.end - range.end, live)
						: resizeRange(range, part, live.end, live).range;
				break;
			default:
				return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (next) onChange(next);
	}

	const left = rangeFraction(shown.start, live) * 100;
	const right = rangeFraction(shown.end, live) * 100;
	const centre = (left + right) / 2;
	const handle = (part: RangeEdge) => ({
		role: "slider",
		tabIndex: disabled ? -1 : 0,
		"aria-label": t(
			part === "start" ? "traffic.range.start" : "traffic.range.end",
		),
		"aria-orientation": "horizontal" as const,
		"aria-valuemin": live.start,
		"aria-valuemax": live.end,
		"aria-valuenow": part === "start" ? shown.start : shown.end,
		"aria-valuetext": stamp(part === "start" ? shown.start : shown.end),
		"aria-disabled": disabled || undefined,
		onPointerDown: (event: React.PointerEvent<HTMLElement>) =>
			begin(event, part),
		onKeyDown: (event: React.KeyboardEvent) => keyStep(event, part),
	});

	return (
		<div
			className={`traffic-range ${drag ? "is-dragging" : ""} ${rolling ? "is-rolling" : ""}`}
			role="group"
			aria-label={t("traffic.range.label")}
			data-testid="traffic-range"
		>
			<div
				ref={track}
				className="traffic-range-track"
				onPointerDown={(event) => begin(event, "new")}
				title={usable ? t("traffic.range.hint") : undefined}
			>
				<div className="traffic-range-ticks" aria-hidden="true">
					{rulerTicks(live).map((at) => (
						<span key={at} style={{ left: `${rangeFraction(at, live) * 100}%` }}>
							{tickLabel(at)}
						</span>
					))}
				</div>
				{cursorAt !== null && cursorAt !== undefined && (
					<i
						className="traffic-range-cursor"
						aria-hidden="true"
						style={{ left: `${rangeFraction(cursorAt, live) * 100}%` }}
					/>
				)}
				<div
					className="traffic-range-band"
					style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }}
					data-testid="traffic-range-band"
				>
					<span
						className="traffic-range-grip"
						role="slider"
						tabIndex={disabled ? -1 : 0}
						aria-label={t("traffic.range.interval")}
						aria-orientation="horizontal"
						aria-valuemin={live.start}
						aria-valuemax={live.end}
						aria-valuenow={shown.start}
						aria-valuetext={intervalText}
						aria-disabled={disabled || undefined}
						onPointerDown={(event) => begin(event, "move")}
						onKeyDown={(event) => keyStep(event, "move")}
					/>
					<span
						className="traffic-range-handle is-start"
						data-testid="traffic-range-start"
						{...handle("start")}
					/>
					<span
						className="traffic-range-handle is-end"
						data-testid="traffic-range-end"
						{...handle("end")}
					/>
				</div>
			</div>
			{/* What is on screen, written under the band rather than under the ruler:
			    the ends being named are the BAND's, and a label pinned to the ruler's
			    own corners claims the window starts where history does. It says `Live`
			    for the open end of a rolling preset — that end is not an instant
			    anybody chose. */}
			<div className="traffic-range-readout">
				<span
					style={
						centre < 20
							? { left: 0 }
							: centre > 80
								? { right: 0 }
								: { left: `${centre}%`, transform: "translateX(-50%)" }
					}
				>
					{edge(shown.start)} –{" "}
					{rolling && !drag ? t("traffic.orbit.live") : edge(shown.end)}
				</span>
			</div>
		</div>
	);
}
