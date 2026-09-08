import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { getTaskOverview } from "../../../shared/types";
import { useT } from "../../i18n";
import { getStatusLabel } from "../../utils/statusLabel";
import {
	useStatusColors,
	useStatusColorsInk,
} from "../../hooks/useStatusColors";
import { useReducedMotion } from "../../utils/useReducedMotion";
import {
	layoutTraffic,
	pointAt,
	wirePath,
	type PlacedNode,
} from "./nodes-layout";
import {
	fromKey,
	nodeSeq,
	toKey,
	type TrafficNode,
	type TrafficRecord,
} from "./traffic-model";
import type { useTrafficPlayback } from "./useTrafficPlayback";
import TrafficIcon from "./TrafficIcon";
import TrafficMinimap from "./TrafficMinimap";
import TrafficMessageBubble from "./TrafficMessageBubble";
import { MAX_SCALE, frameExchange, stageCeiling } from "./traffic-camera";

interface Props {
	projects?: {
		id: string;
		name: string;
		customStatusLabels?: Record<string, string>;
	}[];
	scope?: string;
	nodes: TrafficNode[];
	records: TrafficRecord[];
	layoutRecords: TrafficRecord[];
	selected: string | null;
	onSelect: (key: string) => void;
	paused: boolean;
	ready: boolean;
	playback?: ReturnType<typeof useTrafficPlayback>;
	focusRequest?: number;
	followRequest?: number;
}
interface View {
	x: number;
	y: number;
	scale: number;
}
interface Flight {
	record: TrafficRecord;
	points: { x: number; y: number }[];
	started: number;
	tempo: number;
}
const FLOW_MS = 2400;
const DROP_MS = 1200;
const DROP_GAP_MS = 500;
const DROP_FADE_MS = 200;
const FOLLOW_IDLE_MS = 3500;
const MIN_SCALE = 0.14;

export default function TrafficNodes({
	nodes,
	records,
	layoutRecords,
	selected,
	onSelect,
	paused,
	ready,
	scope,
	projects,
	playback,
	focusRequest,
	followRequest,
}: Props) {
	const t = useT();
	const colors = useStatusColors();
	const ink = useStatusColorsInk();
	const reduced = useReducedMotion();
	const frame = useRef<HTMLDivElement>(null);
	const [showQuiet, setShowQuiet] = useState(false);
	const [showParked, setShowParked] = useState(false);
	const [follow, setFollow] = useState(true);
	const [pendingFocus, setPendingFocus] = useState<string | null>(null);
	const replaying = !!playback && playback.index >= 0;
	const replayKeys = new Set(
		replaying
			? playback.events.flatMap((record) => [
					fromKey(record.row),
					toKey(record.row),
				])
			: [],
	);
	const followedRecord = follow
		? (playback?.current ?? playback?.events[playback.events.length - 1])
		: undefined;
	const replayParked = nodes.some(
		(node) =>
			node.task?.hibernated &&
			(replayKeys.has(node.key) ||
				(followedRecord &&
					[fromKey(followedRecord.row), toKey(followedRecord.row)].includes(
						node.key,
					))),
	);
	const scene = useMemo(
		() =>
			layoutTraffic(nodes, layoutRecords, {
				showQuiet,
				showParked: showParked || replayParked,
			}),
		[nodes, layoutRecords, showQuiet, showParked, replayParked],
	);
	const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
	const viewRef = useRef(view);
	viewRef.current = view;
	useEffect(() => {
		if (followRequest) setFollow(true);
	}, [followRequest]);
	const [flights, setFlights] = useState<Flight[]>([]);
	const [now, setNow] = useState(Date.now());
	const camera = useRef<number>(0);
	const overviewMode = useRef(true);
	const known = useRef<Set<string> | null>(null);
	const edgeByKey = useMemo(
		() => new Map(scene.edges.map((edge) => [edge.key, edge])),
		[scene.edges],
	);
	const nodeByKey = useMemo(
		() => new Map(scene.placed.map((node) => [node.node.key, node])),
		[scene.placed],
	);
	const projectById = useMemo(
		() => new Map((projects ?? []).map((project) => [project.id, project])),
		[projects],
	);
	const latest = useMemo(() => {
		const result = new Map<string, TrafficRecord>();
		for (const record of records)
			for (const key of [fromKey(record.row), toKey(record.row)]) {
				if (
					key &&
					(!result.has(key) ||
						Date.parse(result.get(key)!.row.at) < Date.parse(record.row.at))
				)
					result.set(key, record);
			}
		return result;
	}, [records]);
	const move = useCallback(
		(target: View, instant = false, duration = 500) => {
			cancelAnimationFrame(camera.current);
			if (instant || reduced) {
				viewRef.current = target;
				setView(target);
				return;
			}
			const start = performance.now();
			const from = viewRef.current;
			const tick = (at: number) => {
				const progress = Math.min(1, (at - start) / duration);
				const ease = progress * progress * (3 - 2 * progress);
				setView({
					x: from.x + (target.x - from.x) * ease,
					y: from.y + (target.y - from.y) * ease,
					scale: from.scale + (target.scale - from.scale) * ease,
				});
				if (progress < 1) camera.current = requestAnimationFrame(tick);
			};
			camera.current = requestAnimationFrame(tick);
		},
		[reduced],
	);
	useEffect(() => () => cancelAnimationFrame(camera.current), []);
	const fitNodes = useCallback(
		(targets: Pick<PlacedNode, "x" | "y" | "width" | "height">[], maximum: number, instant = false) => {
			const box = { width: frame.current?.clientWidth ?? 0, height: frame.current?.clientHeight ?? 0 };
			if (!box.width || !box.height || !targets.length) return;
			const left = Math.min(...targets.map((p) => p.x)) - 70;
			const top = Math.min(...targets.map((p) => p.y)) - 86;
			const width = Math.max(...targets.map((p) => p.x + p.width)) + 70 - left;
			const height = Math.max(...targets.map((p) => p.y + p.height)) + 86 - top;
			const scale = Math.min(stageCeiling(box, maximum), (box.width - 52) / width, (box.height - 80) / height);
			move(
				{
					scale,
					x: box.width / 2 - (left + width / 2) * scale,
					y: box.height / 2 - (top + height / 2) * scale,
				},
				instant,
			);
		},
		[move],
	);
	const fit = useCallback(
		(instant = false) => fitNodes(scene.groups.length ? scene.groups : scene.placed, 0.85, instant),
		[fitNodes, scene.placed, scene.groups],
	);
	/** The scene's outer edge with the same padding `fitNodes` leaves around it. */
	const sceneBounds = useMemo(() => {
		const targets: { x: number; y: number; width: number; height: number }[] =
			scene.groups.length ? scene.groups : scene.placed;
		if (!targets.length) return undefined;
		return {
			left: Math.min(...targets.map((p) => p.x)) - 70,
			top: Math.min(...targets.map((p) => p.y)) - 86,
			right: Math.max(...targets.map((p) => p.x + p.width)) + 70,
			bottom: Math.max(...targets.map((p) => p.y + p.height)) + 86,
		};
	}, [scene.groups, scene.placed]);
	const resizeFollow = useRef<(() => void) | null>(null);
	const fitRef = useRef(fit);
	fitRef.current = fit;
	const previousScope = useRef(scope);
	useLayoutEffect(() => {
		if (scope !== previousScope.current) {
			previousScope.current = scope;
			overviewMode.current = true;
		}
		if (ready && overviewMode.current) fitRef.current(true);
	}, [ready, scope, scene.placed, showQuiet, showParked]);
	useLayoutEffect(() => {
		if (!frame.current) return;
		const observer = new ResizeObserver(() => {
			if (resizeFollow.current) resizeFollow.current();
			else if (overviewMode.current) fitRef.current(true);
		});
		observer.observe(frame.current);
		return () => observer.disconnect();
	}, []);
	const focus = useCallback(
		(key: string) => {
			cancelAnimationFrame(camera.current);
			setFollow(false);
			overviewMode.current = false;
			const node = nodeByKey.get(key);
			if (node) {
				const box = frame.current?.getBoundingClientRect();
				if (box) {
					const scale = Math.max(
						MIN_SCALE,
						Math.min(
							1.12,
							(box.width - 52) / node.width,
							(box.height - 96) / node.height,
						),
					);
					move({
						scale,
						x: box.width / 2 - (node.x + node.width / 2) * scale,
						y: box.height / 2 - (node.y + node.height / 2) * scale,
					});
				}
				setPendingFocus(null);
			} else {
				setPendingFocus(key);
				setShowQuiet(true);
				setShowParked(true);
			}
		},
		[nodeByKey, move],
	);
	const focusRef = useRef(focus);
	focusRef.current = focus;
	const handledFocus = useRef(focusRequest);
	useEffect(() => {
		if (focusRequest !== handledFocus.current) {
			handledFocus.current = focusRequest;
			if (selected) focusRef.current(selected);
		}
	}, [focusRequest, selected]);
	useEffect(() => {
		if (pendingFocus && nodeByKey.has(pendingFocus))
			focusRef.current(pendingFocus);
	}, [pendingFocus, nodeByKey]);
	const exchange = useCallback(
		(record: TrafficRecord) => {
			const viewport = { width: frame.current?.clientWidth ?? 0, height: frame.current?.clientHeight ?? 0 };
			const recipient = nodeByKey.get(toKey(record.row));
			const sender = nodeByKey.get(fromKey(record.row) ?? "");
			if (!viewport?.width || !viewport.height || !recipient) return;
			overviewMode.current = false;
			const edge = sender && edgeByKey.get(
				[sender.node.key, recipient.node.key].sort().join("|"),
			);
			move(
				frameExchange(viewport, sender ? [sender, recipient] : [recipient], edge?.points ?? [], sceneBounds),
				reduced,
				playback?.playing ? Math.min(500, playback.intervalMs * 0.9) : 500,
			);
		},
		[nodeByKey, edgeByKey, move, reduced, sceneBounds, playback?.playing, playback?.intervalMs],
	);

	const launch = useCallback(
		(record: TrafficRecord) => {
			const from = fromKey(record.row),
				to = toKey(record.row);
			if (paused) return;
			const edge = from && edgeByKey.get([from, to].sort().join("|"));
			const points = edge ? (edge.from === from ? edge.points : [...edge.points].reverse()) : [];
			setFlights((current) => [
				...current.slice(-19),
				{ record, points, started: Date.now(), tempo: playback?.playing ? Math.min(1, playback.intervalMs / FLOW_MS) : 1 },
			]);
		},
		[edgeByKey, paused, playback?.playing, playback?.intervalMs],
	);
	const launchRef = useRef(launch);
	launchRef.current = launch;
	const exchangeRef = useRef(exchange);
	exchangeRef.current = exchange;
	resizeFollow.current = follow && ready ? () => {
		if (overviewMode.current || !followedRecord) fitRef.current(true);
		else exchange(followedRecord);
	} : null;
	useEffect(() => {
		setFlights([]);
		if (!playback?.current) return;
		launchRef.current(playback.current);
	}, [playback?.revision, replaying]);
	useEffect(() => {
		if (!follow) return;
		if (!ready) return;
		const event =
			playback?.current ?? playback?.events[playback.events.length - 1];
		if (event && (replaying || Date.now() - Date.parse(event.row.at) < FOLLOW_IDLE_MS)) {
			exchangeRef.current(event);
		} else {
			overviewMode.current = true;
			fitRef.current();
		}
	}, [
		playback?.revision,
		playback?.events[playback.events.length - 1]?.key,
		replaying,
		follow,
		ready,
		followRequest,
		reduced,
		scene,
	]);
	const previousPlayback = useRef({ playing: false, revision: 0 });
	useEffect(() => {
		const previous = previousPlayback.current;
		if (
			paused ||
			reduced ||
			(previous.playing &&
				!playback?.playing &&
				previous.revision === playback?.revision)
		) {
			setFlights([]);
			cancelAnimationFrame(camera.current);
		}
		previousPlayback.current = {
			playing: !!playback?.playing,
			revision: playback?.revision ?? 0,
		};
	}, [paused, reduced, playback?.playing, playback?.revision]);
	useEffect(() => {
		if (!follow || !ready || (replaying && !playback?.playing && !playback?.ended)) return;
		const latest = playback?.events[playback.events.length - 1];
		const delay = playback?.ended || !latest ? 0 : replaying ? FOLLOW_IDLE_MS :
			Math.max(0, FOLLOW_IDLE_MS - (Date.now() - Date.parse(latest.row.at)));
		const timer = setTimeout(() => {
			overviewMode.current = true;
			fitRef.current();
		}, delay);
		return () => clearTimeout(timer);
	}, [follow, ready, replaying, playback?.playing, playback?.ended, playback?.revision,
		playback?.events[playback.events.length - 1]?.key, followRequest]);

	useEffect(() => {
		if (!ready) return;
		const current = new Set(layoutRecords.map((record) => record.key));
		if (known.current && !replaying && !paused) {
			let newest: TrafficRecord | undefined;
			for (const record of layoutRecords)
				if (
					!known.current.has(record.key) &&
					Date.now() - Date.parse(record.row.at) < 10000
				) {
					launchRef.current(record);
					if (!newest || Date.parse(record.row.at) > Date.parse(newest.row.at))
						newest = record;
				}
			if (follow && newest) exchangeRef.current(newest);
		}
		known.current = current;
	}, [layoutRecords, ready, paused, replaying, follow]);
	useEffect(() => {
		if (!flights.length) return;
		let raf = 0;
		const tick = () => {
			const at = Date.now();
			setNow(at);
			setFlights((current) =>
				current.filter((flight) => at - flight.started < FLOW_MS * flight.tempo),
			);
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [flights.length]);
	const manual = () => {
		cancelAnimationFrame(camera.current);
		overviewMode.current = false;
		setFollow(false);
	};
	const zoom = (factor: number, anchor?: { x: number; y: number }) => {
		manual();
		const box = frame.current?.getBoundingClientRect();
		setView((current) => {
			const scale = Math.max(
				MIN_SCALE,
				Math.min(MAX_SCALE, current.scale * factor),
			);
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
	};
	const drag = useRef<{ id: number; x: number; y: number } | null>(null);
	const active = playback?.ended ? undefined : playback?.current ?? flights[flights.length - 1]?.record;
	const activeFrom = active && fromKey(active.row),
		activeTo = active && toKey(active.row);
	const activeEdge =
		activeFrom && activeTo
			? edgeByKey.get([activeFrom, activeTo].sort().join("|"))
			: undefined;
	const activeRecipient = activeTo ? nodeByKey.get(activeTo) : undefined;
	const labelPoint = activeEdge ? pointAt(activeEdge.points, 0.5) : activeRecipient ?
		{ x: activeRecipient.x + activeRecipient.width / 2, y: activeRecipient.y } : undefined;
	const detail =
		view.scale < 0.36 ? "cell" : view.scale < 0.7 ? "compact" : "full";
	const visiblePairs = new Map<
		string,
		{ count: number; status: string; at: number }
	>();
	const messageCounts = new Map<string, number>();
	for (const { row } of records) {
		const from = fromKey(row),
			to = toKey(row),
			at = Date.parse(row.at);
		for (const key of new Set([from, to]))
			if (key) messageCounts.set(key, (messageCounts.get(key) ?? 0) + 1);
		const key = [from, to].sort().join("|");
		const previous = visiblePairs.get(key);
		visiblePairs.set(key, {
			count: (previous?.count ?? 0) + 1,
			status: !previous || at >= previous.at ? row.status : previous.status,
			at: Math.max(at, previous?.at ?? 0),
		});
	}
	return (
		<div
			className="traffic-nodes"
			ref={frame}
			data-detail={detail}
			data-follow={follow}
			onWheel={(event) => {
				const box = frame.current?.getBoundingClientRect();
				zoom(Math.exp(-event.deltaY / 420), {
					x: event.clientX - (box?.left ?? 0),
					y: event.clientY - (box?.top ?? 0),
				});
			}}
			onPointerDown={(event) => {
				if (
					event.button !== 0 ||
					(event.target as HTMLElement).closest("button,input,select")
				)
					return;
				manual();
				drag.current = {
					id: event.pointerId,
					x: event.clientX,
					y: event.clientY,
				};
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={(event) => {
				const previous = drag.current;
				if (!previous || previous.id !== event.pointerId) return;
				const dx = event.clientX - previous.x,
					dy = event.clientY - previous.y;
				drag.current = {
					id: event.pointerId,
					x: event.clientX,
					y: event.clientY,
				};
				setView((current) => ({
					...current,
					x: current.x + dx,
					y: current.y + dy,
				}));
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
				data-testid="traffic-node-scene"
				style={{
					transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
				}}
			>
				{scene.groups.map(group => (
					<div key={group.projectId} className="traffic-project-group" style={{ left: group.x, top: group.y, width: group.width, height: group.height }}>
						<div className="traffic-project-heading" style={{ transform: `scale(${1 / view.scale})`, width: Math.max(40, (group.width - 48) * view.scale) }}>
							{projectById.get(group.projectId)?.name ?? t("traffic.orbit.project")}
						</div>
					</div>
				))}
				<svg
					className="traffic-nodes-wires"
					width={scene.width}
					height={scene.height}
					viewBox={`0 0 ${scene.width} ${scene.height}`}
					aria-hidden="true"
				>
					{scene.edges.map((edge) => {
						const visiblePair = visiblePairs.get(edge.key);
						if (replaying && !visiblePair) return null;
						const count = visiblePair?.count ?? 0;
						return (
							<path
								key={edge.key}
								d={wirePath(edge.points)}
								className={`traffic-wire verdict-${visiblePair?.status ?? edge.status} ${!visiblePair ? "is-dim" : ""} ${activeEdge?.key === edge.key ? "is-active" : ""}`}
								strokeWidth={
									(count >= 8
										? 4.2
										: count >= 5
											? 3.1
											: count >= 3
												? 2.25
												: count === 2
													? 1.65
													: 1) / view.scale
								}
							/>
						);
					})}
					{flights.flatMap((flight) => {
						if (reduced || !flight.points.length) return [];
						const status = flight.record.row.status;
						const stop = status === "not-delivered" ? 0.7 : 1;
						const age = (now - flight.started) / flight.tempo;
						return [0, 1, 2].map((drop) => {
							const elapsed = age - drop * DROP_GAP_MS;
							if (elapsed < 0 || elapsed >= DROP_MS + DROP_FADE_MS) return null;
							const progress = Math.min(stop, elapsed / DROP_MS);
							const point = pointAt(flight.points, progress);
							return (
								<circle key={`${flight.record.key}:${flight.started}:${drop}`}
									className={`traffic-flight verdict-${status}`}
									r={3 / view.scale}
									opacity={1 - Math.max(0, elapsed - DROP_MS) / DROP_FADE_MS}
									transform={`translate(${point.x},${point.y})`} />
							);
						});
					})}
				</svg>
				<div className="traffic-nodes-cards">
					{scene.placed.map((placed) => (
						<Card
							key={placed.node.key}
							placed={placed}
							messageCount={messageCounts.get(placed.node.key) ?? 0}
							selected={selected === placed.node.key}
							dim={
								selected !== null &&
								selected !== placed.node.key &&
								!scene.edges.some(
									(e) =>
										(e.from === selected && e.to === placed.node.key) ||
										(e.to === selected && e.from === placed.node.key),
								)
							}
							active={
								activeFrom === placed.node.key || activeTo === placed.node.key
							}
							scale={view.scale}
							statusColor={
								placed.node.task ? colors[placed.node.task.status] : undefined
							}
							inkColor={
								placed.node.task ? ink[placed.node.task.status] : undefined
							}
							project={projectById.get(placed.node.projectId)}
							latest={latest.get(placed.node.key)}
							onSelect={(key) => {
								manual();
								onSelect(key);
							}}
							onFocus={focus}
						/>
					))}
				</div>
			</div>
			{active && labelPoint && (
				<TrafficMessageBubble
					subject={active.row.subject || active.row.body.slice(0, 120)}
					anchor={{ x: view.x + labelPoint.x * view.scale, y: view.y + labelPoint.y * view.scale }}
					width={frame.current?.clientWidth ?? 1000}
					height={frame.current?.clientHeight ?? 500}
					failed={active.row.status === "not-delivered"}
				/>
			)}
			{!scene.placed.length && (
				<p className="traffic-nodes-empty">
					{ready ? t("traffic.nodes.noTraffic") : t("traffic.loading")}
				</p>
			)}
			<div className="traffic-nodes-bands">
				{scene.quietCount > 0 && (
					<button
						type="button"
						aria-pressed={showQuiet}
						data-testid="traffic-nodes-quiet-toggle"
						onClick={() => setShowQuiet((value) => !value)}
					>
						{t.plural("traffic.nodes.quietCount", scene.quietCount)}
					</button>
				)}
				{scene.parkedCount > 0 && (
					<button
						type="button"
						aria-pressed={showParked || replayParked}
						data-testid="traffic-nodes-parked-toggle"
						onClick={() => setShowParked((value) => !value)}
					>
						{t.plural("traffic.nodes.parkedCount", scene.parkedCount)}
					</button>
				)}
			</div>
			{!!scene.placed.length && (
				<TrafficMinimap
					scene={scene}
					selected={selected}
					view={view}
					width={frame.current?.clientWidth ?? 0}
					height={frame.current?.clientHeight ?? 0}
					onNavigate={(target) => { manual(); move(target, true); }}
					onFit={() => { manual(); overviewMode.current = true; fit(); }}
				/>
			)}
			<div className="traffic-camera-controls">
				<button
					onClick={() => zoom(1 / 1.25)}
					aria-label={t("traffic.nodes.zoomOut")}
				>
					<TrafficIcon name="minus" />
				</button>
				<span>{Math.round(view.scale * 100)}%</span>
				<button
					onClick={() => zoom(1.25)}
					aria-label={t("traffic.nodes.zoomIn")}
				>
					<TrafficIcon name="plus" />
				</button>
				<button
					onClick={() => {
						manual();
						overviewMode.current = true;
						fit();
					}}
					aria-label={t("traffic.nodes.fit")}
				>
					<TrafficIcon name="fit" />
				</button>
				<button
					className={follow ? "is-active" : ""}
					aria-pressed={follow}
					onClick={() => follow ? manual() : setFollow(true)}
				>
					<TrafficIcon name="follow" />
					{t("traffic.nodes.follow")}
				</button>
			</div>
			<p className="traffic-map-caption">{t("traffic.nodes.legend")}</p>
		</div>
	);
}

function Card({
	placed,
	messageCount,
	selected,
	dim,
	active,
	scale,
	statusColor,
	inkColor,
	project,
	latest,
	onSelect,
	onFocus,
}: {
	placed: PlacedNode;
	messageCount: number;
	selected: boolean;
	dim: boolean;
	active: boolean;
	scale: number;
	statusColor?: string;
	inkColor?: string;
	project?: {
		id: string;
		name: string;
		customStatusLabels?: Record<string, string>;
	};
	latest?: TrafficRecord;
	onSelect: (key: string) => void;
	onFocus: (key: string) => void;
}) {
	const t = useT();
	const { node } = placed;
	const finished =
		node.task?.status === "completed" || node.task?.status === "cancelled"
			? node.task.status
			: null;
	const state = placed.parked
		? t("task.hibernatedBadge")
		: node.task
			? getStatusLabel(node.task.status, t, project)
			: t("traffic.orbit.historical");
	return (
		<button
			type="button"
			data-testid="traffic-node-card"
			className={`traffic-node-card ${node.task?.taskType === "coordinator" ? "is-coordinator" : ""} ${selected ? "is-selected" : ""} ${dim ? "is-dim" : ""} ${active ? "is-lit" : ""} ${placed.parked ? "is-parked" : ""} ${finished ? `is-${finished}` : ""}`}
			style={{
				left: placed.x,
				top: placed.y,
				width: placed.width,
				height: placed.height,
				["--node-status" as string]: statusColor ?? "rgb(var(--text-tertiary))",
				["--node-ink" as string]: inkColor ?? "rgb(var(--text-tertiary))",
				["--node-inverse" as string]: 1 / scale,
			}}
			aria-label={`${nodeSeq(node)} ${node.title || t("traffic.orbit.historical")} · ${state}`}
			aria-pressed={selected}
			onClick={() => onSelect(node.key)}
			onDoubleClick={() => onFocus(node.key)}
		>
			<span className="traffic-node-full">
				<span className="traffic-node-head">
					<i className="traffic-node-dot" aria-hidden="true" />
					<b>{nodeSeq(node)}</b>
					{node.task?.taskType === "coordinator" && (
						<em>{t("traffic.orbit.coordinator")}</em>
					)}
					<span className="traffic-node-count">{messageCount}</span>
				</span>
				<strong className="streamer-private">
					{node.title || t("traffic.orbit.historical")}
				</strong>
				<span className="traffic-node-state">
					{finished === "completed"
						? "✓ "
						: finished === "cancelled"
							? "× "
							: ""}
					{state}
				</span>
				<span className="traffic-node-overview streamer-private">
					{(node.task && getTaskOverview(node.task)) ||
						t("traffic.orbit.noOverview")}
				</span>
				{latest && (
					<span className="traffic-node-message streamer-private">
						{latest.row.subject || latest.row.body.slice(0, 100)}
					</span>
				)}
			</span>
			<span className="traffic-node-compact">
				<span className="traffic-node-head">
					<i className="traffic-node-dot" aria-hidden="true" />
					<b>{nodeSeq(node)}</b>
				</span>
				<strong className="streamer-private">
					{node.title || t("traffic.orbit.historical")}
				</strong>
				<span className="traffic-node-state">
					{finished === "completed" ? "✓ " : ""}
					{state}
				</span>
			</span>
		</button>
	);
}
