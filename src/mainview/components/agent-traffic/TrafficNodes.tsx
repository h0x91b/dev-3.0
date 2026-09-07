import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getTaskOverview } from "../../../shared/types";
import { useT } from "../../i18n";
import { useStatusColors } from "../../hooks/useStatusColors";
import { useReducedMotion } from "../../utils/useReducedMotion";
import {
	CARD_HEIGHT,
	CARD_WIDTH,
	layoutTraffic,
	pointAt,
	wirePath,
	type PlacedNode,
} from "./nodes-layout";
import { fromKey, nodeSeq, toKey, type TrafficNode, type TrafficRecord } from "./traffic-model";

interface Props {
	projects?: { id: string; name: string }[];
	scope?: string;
	nodes: TrafficNode[];
	records: TrafficRecord[];
	/**
	 * What the layout is built from: the time window before search, delivery and
	 * selection filters narrow it. Positions must not move when the user selects a
	 * card or types in the search box — a graph that re-arranges under the pointer
	 * is unreadable, and the bible's "keep positions stable" rule says so.
	 */
	layoutRecords: TrafficRecord[];
	selected: string | null;
	onSelect: (key: string) => void;
	paused: boolean;
	ready: boolean;
}

/** How long a message takes to cross its wire, and how long arrival stays lit. */
const FLIGHT_MS = 1400;
const ARRIVAL_MS = 2200;
/** Below these zoom levels a card sheds its body, then everything but its colour. */
const COMPACT_BELOW = 0.62;
const CELL_BELOW = 0.34;
const MIN_SCALE = 0.14;
const MAX_SCALE = 1.8;
const PADDING = 48;
/** Auto-fit never shrinks past readable cards; the user pans instead. */
const FIT_FLOOR = 0.55;

interface Flight {
	id: string;
	points: { x: number; y: number }[];
	started: number;
	status: string;
	arrival: string;
}

/**
 * Experiment 2: agent traffic as a flat graph of task cards.
 *
 * The same data and the same selection contract as the orbit next to it — this
 * is a second presentation, not a second feature. What it trades is depth for
 * legibility: cards keep their titles and overviews at reading size, wires say
 * who talks to whom, and a message is a dot that visibly crosses one of them.
 *
 * All motion is derived from `records`, so pausing, filtering or scrubbing the
 * timeline in the parent silences it without a second subscription anywhere.
 */
export default function TrafficNodes({
	nodes,
	records,
	layoutRecords,
	selected,
	onSelect,
	paused,
	ready,
	scope,
}: Props) {
	const t = useT();
	const statusColors = useStatusColors();
	const reduced = useReducedMotion();
	const frame = useRef<HTMLDivElement>(null);
	const scene = useMemo(() => layoutTraffic(nodes, layoutRecords), [nodes, layoutRecords]);
	const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
	const [flights, setFlights] = useState<Flight[]>([]);
	const [arrivals, setArrivals] = useState<Record<string, number>>({});
	const [, setTick] = useState(0);
	const fitted = useRef<string | null>(null);
	const known = useRef<Set<string> | null>(null);
	const edgeByKey = useMemo(
		() => new Map(scene.edges.map((edge) => [edge.key, edge])),
		[scene.edges],
	);

	const fit = useCallback(() => {
		const box = frame.current?.getBoundingClientRect();
		if (!box || !box.width || !box.height) return;
		const scale = Math.max(
			FIT_FLOOR,
			Math.min(
				1,
				(box.width - PADDING) / scene.width,
				(box.height - PADDING) / scene.height,
			),
		);
		setView({
			scale,
			x: (box.width - scene.width * scale) / 2,
			y: (box.height - scene.height * scale) / 2,
		});
	}, [scene.width, scene.height]);

	// Refit when the surface first has content, and whenever the scope changes the
	// scene wholesale — never on every new message, which would yank the view.
	useLayoutEffect(() => {
		const key = `${scope ?? "all"}:${scene.placed.length}`;
		if (!ready || !scene.placed.length || fitted.current === key) return;
		fitted.current = key;
		fit();
	}, [fit, ready, scope, scene.placed.length]);

	// Messages that appeared since the last render take off; the very first render
	// only records what already exists, so opening the view is not a fireworks show.
	useEffect(() => {
		const current = new Set(records.map((record) => record.key));
		if (known.current === null) {
			known.current = current;
			return;
		}
		if (paused || reduced) {
			known.current = current;
			return;
		}
		const started = Date.now();
		const fresh: Flight[] = [];
		const landed: Record<string, number> = {};
		for (const record of records) {
			if (known.current.has(record.key)) continue;
			const from = fromKey(record.row);
			const to = toKey(record.row);
			if (!from) continue;
			const edge = edgeByKey.get([from, to].sort().join("|"));
			if (!edge) continue;
			const forward = edge.from === from;
			fresh.push({
				id: `${record.key}:${started}`,
				points: forward ? edge.points : [...edge.points].reverse(),
				started,
				status: record.row.status,
				arrival: to,
			});
			landed[to] = started + FLIGHT_MS;
		}
		known.current = current;
		if (!fresh.length) return;
		setFlights((current) => [...current, ...fresh]);
		setArrivals((current) => ({ ...current, ...landed }));
	}, [records, edgeByKey, paused, reduced]);

	// One loop for every dot in the air; it stops itself the moment none is left.
	useEffect(() => {
		if (!flights.length) return;
		let raf = 0;
		const run = () => {
			const now = Date.now();
			setFlights((current) =>
				current.filter((flight) => now - flight.started < FLIGHT_MS),
			);
			setArrivals((current) => {
				const next = Object.fromEntries(
					Object.entries(current).filter(([, at]) => now - at < ARRIVAL_MS),
				);
				return Object.keys(next).length === Object.keys(current).length
					? current
					: next;
			});
			setTick((value) => value + 1);
			raf = requestAnimationFrame(run);
		};
		raf = requestAnimationFrame(run);
		return () => cancelAnimationFrame(raf);
	}, [flights.length]);

	const zoom = useCallback((factor: number, anchor?: { x: number; y: number }) => {
		setView((current) => {
			const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, current.scale * factor));
			const box = frame.current?.getBoundingClientRect();
			const point = anchor ?? {
				x: (box?.width ?? 0) / 2,
				y: (box?.height ?? 0) / 2,
			};
			const ratio = scale / current.scale;
			return {
				scale,
				x: point.x - (point.x - current.x) * ratio,
				y: point.y - (point.y - current.y) * ratio,
			};
		});
	}, []);

	// Which pairs survive the parent's filters right now: everything else stays in
	// place and fades, so the shape of the conversation is never redrawn.
	const live = useMemo(() => {
		const keys = new Set<string>();
		for (const { row } of records) {
			const from = fromKey(row);
			if (from) keys.add([from, toKey(row)].sort().join("|"));
		}
		return keys;
	}, [records]);
	const drag = useRef<{ id: number; x: number; y: number } | null>(null);
	const detail = view.scale < CELL_BELOW ? "cell" : view.scale < COMPACT_BELOW ? "compact" : "full";
	const now = Date.now();

	return (
		<div
			className="traffic-nodes"
			ref={frame}
			data-detail={detail}
			onWheel={(event) => {
				event.preventDefault();
				const box = frame.current?.getBoundingClientRect();
				zoom(Math.exp(-event.deltaY / 420), {
					x: event.clientX - (box?.left ?? 0),
					y: event.clientY - (box?.top ?? 0),
				});
			}}
			onPointerDown={(event) => {
				if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
				drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={(event) => {
				const active = drag.current;
				if (!active || active.id !== event.pointerId) return;
				const dx = event.clientX - active.x;
				const dy = event.clientY - active.y;
				drag.current = { ...active, x: event.clientX, y: event.clientY };
				setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
			}}
			onPointerUp={() => {
				drag.current = null;
			}}
			onPointerCancel={() => {
				drag.current = null;
			}}
		>
			<div
				className="traffic-nodes-scene"
				style={{
					transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
				}}
			>
				<svg
					className="traffic-nodes-wires"
					width={scene.width}
					height={scene.height}
					viewBox={`0 0 ${scene.width} ${scene.height}`}
					aria-hidden="true"
				>
					{scene.edges.map((edge) => {
						const dim =
							(selected !== null && edge.from !== selected && edge.to !== selected) ||
							!live.has(edge.key);
						return (
							<path
								key={edge.key}
								d={wirePath(edge.points)}
								className={`traffic-wire verdict-${edge.status} ${dim ? "is-dim" : ""}`}
								strokeWidth={Math.min(4.5, 1 + Math.log2(edge.messages + 1))}
							/>
						);
					})}
					{flights.map((flight) => {
						const progress = (now - flight.started) / FLIGHT_MS;
						const point = pointAt(flight.points, progress);
						return (
							<circle
								key={flight.id}
								className={`traffic-flight verdict-${flight.status}`}
								cx={point.x}
								cy={point.y}
								r={5}
							/>
						);
					})}
				</svg>
				<div className="traffic-nodes-cards">
					{scene.placed.map((placed) => (
						<Card
							key={placed.node.key}
							placed={placed}
							selected={selected === placed.node.key}
							dim={selected !== null && selected !== placed.node.key}
							lit={arrivals[placed.node.key] !== undefined}
							statusColor={
								placed.node.task ? statusColors[placed.node.task.status] : undefined
							}
							onSelect={onSelect}
						/>
					))}
				</div>
			</div>
			{!scene.placed.length && (
				<p className="traffic-nodes-empty">
					{ready ? t("traffic.noneMatch") : t("traffic.loading")}
				</p>
			)}
			<div className="traffic-camera-controls">
				<button onClick={() => zoom(1 / 1.25)} aria-label={t("traffic.nodes.zoomOut")}>
					−
				</button>
				<span aria-hidden="true">{Math.round(view.scale * 100)}%</span>
				<button onClick={() => zoom(1.25)} aria-label={t("traffic.nodes.zoomIn")}>
					+
				</button>
				<button onClick={fit} aria-label={t("traffic.nodes.fit")}>
					⤢
				</button>
			</div>
			<p className="traffic-map-caption">
				<span>{t("traffic.nodes.legend")}</span>
			</p>
		</div>
	);
}

function Card({
	placed,
	selected,
	dim,
	lit,
	statusColor,
	onSelect,
}: {
	placed: PlacedNode;
	selected: boolean;
	dim: boolean;
	lit: boolean;
	statusColor?: string;
	onSelect: (key: string) => void;
}) {
	const t = useT();
	const { node } = placed;
	const coordinator = node.task?.taskType === "coordinator";
	const overview = node.task ? getTaskOverview(node.task) : "";
	return (
		<button
			type="button"
			data-testid="traffic-node-card"
			className={`traffic-node-card ${coordinator ? "is-coordinator" : ""} ${
				selected ? "is-selected" : ""
			} ${dim ? "is-dim" : ""} ${lit ? "is-lit" : ""}`}
			style={{
				left: placed.x,
				top: placed.y,
				width: CARD_WIDTH,
				height: CARD_HEIGHT,
				["--node-status" as string]: statusColor ?? "rgb(var(--text-tertiary))",
			}}
			aria-pressed={selected}
			onClick={() => onSelect(node.key)}
		>
			<span className="traffic-node-head">
				<b>{nodeSeq(node)}</b>
				{coordinator && <i>{t("traffic.orbit.coordinator")}</i>}
				<em aria-hidden="true" />
			</span>
			<strong className="streamer-private">
				{node.title || t("traffic.orbit.historical")}
			</strong>
			<span className="traffic-node-overview streamer-private">
				{overview || t("traffic.orbit.noOverview")}
			</span>
			<span className="traffic-node-foot">
				{placed.messages
					? t.plural("traffic.orbit.messageCount", placed.messages)
					: t("traffic.nodes.quiet")}
			</span>
		</button>
	);
}
