import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
} from "react";
import { getTaskOverview } from "../../../shared/types";
import { useT } from "../../i18n";
import { getStatusLabel } from "../../utils/statusLabel";
import {
	useStatusColors,
	useStatusColorsInk,
} from "../../hooks/useStatusColors";
import { useReducedMotion } from "../../utils/useReducedMotion";
import PipelineRing from "../PipelineRing";
import {
	layoutTraffic,
	pointAt,
	wirePath,
	type PlacedNode,
} from "./nodes-layout";
import {
	projectTaskAt,
	type TaskProjection,
} from "./task-history";
import {
	burstPieces,
	CAMERA_COOLDOWN_MS,
	CELEBRATION_MS,
	liveCompletions,
	replayCompletion,
	type CompletionCelebration,
} from "./completion-celebration";
import { formatDuration } from "../../utils/productivityStats";
import {
	endpointKey,
	fromKey,
	nodeSeq,
	toKey,
	type TrafficNode,
	type TrafficRecord,
} from "./traffic-model";
import type { TrafficTimelineEvent } from "./traffic-timeline";
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
/** The wave that runs a wire while a message is travelling it: lit length, dark gap,
 *  and speed in on-screen px per second. One speed for every wire — a per-wire speed
 *  reads as noise instead of direction. */
const FLOW_DASH = 15;
const FLOW_GAP = 26;
const FLOW_SPEED = 34;

/** Thicker wire, more messages on that pair. Shared by the wire and its wave. */
function wireWidth(count: number): number {
	if (count >= 8) return 4.2;
	if (count >= 5) return 3.1;
	if (count >= 3) return 2.25;
	return count === 2 ? 1.65 : 1;
}
const DROP_MS = 1200;
const DROP_GAP_MS = 500;
const DROP_FADE_MS = 200;
const FOLLOW_IDLE_MS = 3500;
const MIN_SCALE = 0.14;

/** Latest message on the timeline, for the camera and the wire that only speak messages. */
function lastMessageRecord(
	events?: TrafficTimelineEvent[],
): TrafficRecord | undefined {
	for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
		const event = events![i];
		if (event.kind === "message") return event.record;
	}
	return undefined;
}

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
	// The cursor is the ONLY input to the historical projection, and the projection
	// is a pure function of it — which is what makes scrubbing backwards reverse the
	// stage exactly, with no accumulated state to unwind. Deliberately NOT folded
	// into `nodes` upstream: the layout must stay frozen while cards appear, so
	// `scene` keeps depending on the full node set and only Card props move.
	const cursorAt = playback?.cursor.at ?? null;
	const projections = useMemo(() => {
		const result = new Map<string, TaskProjection>();
		for (const node of nodes)
			result.set(node.key, projectTaskAt(node.task, cursorAt));
		return result;
	}, [nodes, cursorAt]);
	// Every card the timeline touches, whichever kind of event touched it: a task
	// event names its own card, a message names both ends, a notification names
	// whichever ends the archive actually recorded — and nothing at all when it
	// recorded neither, because an unanchored notification belongs to no card.
	const replayKeys = new Set(
		replaying
			? playback.events.flatMap((event) => {
					if (event.kind === "message")
						return [fromKey(event.record.row), toKey(event.record.row)];
					if (event.kind === "task") return [event.nodeKey];
					return [event.notification.target, event.notification.origin].flatMap(
						(end) => (end ? [endpointKey(end.projectId, end.taskId)] : []),
					);
				})
			: [],
	);
	const followedRecord = follow
		? (playback?.currentRecord ?? lastMessageRecord(playback?.events))
		: undefined;
	const followedTaskKey =
		follow && playback?.current?.kind === "task"
			? playback.current.nodeKey
			: undefined;
	const replayParked = nodes.some(
		(node) =>
			node.task?.hibernated &&
			(replayKeys.has(node.key) ||
				node.key === followedTaskKey ||
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

	/**
	 * Frame one card, for a timeline step that names a card rather than a pair — a
	 * recorded board movement. Same camera helper as `exchange`, so a task step and
	 * a message step move the view in the same way rather than two ways.
	 */
	const frameCard = useCallback(
		(nodeKey: string) => {
			const viewport = { width: frame.current?.clientWidth ?? 0, height: frame.current?.clientHeight ?? 0 };
			const node = nodeByKey.get(nodeKey);
			if (!viewport.width || !viewport.height || !node) return;
			overviewMode.current = false;
			move(
				frameExchange(viewport, [node], [], sceneBounds),
				reduced,
				playback?.playing ? Math.min(500, playback.intervalMs * 0.9) : 500,
			);
		},
		[nodeByKey, move, reduced, sceneBounds, playback?.playing, playback?.intervalMs],
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
	const frameCardRef = useRef(frameCard);
	frameCardRef.current = frameCard;

	/**
	 * A task reaching `completed` gets one bounded celebration on its card.
	 *
	 * One slot, not a queue: a second completion arriving mid-burst replaces the
	 * card being celebrated. The camera obeys a cooldown on top of that, so five
	 * completions inside a second produce one move rather than five — a queue
	 * would instead walk the camera across five cards long after the moment.
	 */
	const [celebration, setCelebration] = useState<CompletionCelebration | null>(
		null,
	);
	const celebratedMovements = useRef<Set<string>>(new Set());
	const seededCompletions = useRef(false);
	const lastCameraMove = useRef(0);
	const lastReplayIndex = useRef(-1);
	const nodeByKeyRef = useRef(nodeByKey);
	nodeByKeyRef.current = nodeByKey;
	const followRef = useRef(follow);
	followRef.current = follow;
	const celebrate = useCallback(
		(next: CompletionCelebration, moveCamera: boolean) => {
			// Visible scope only. A completion on a card the current filters keep off
			// the stage is silent — nothing is force-shown and no filter is opened.
			if (!nodeByKeyRef.current.has(next.nodeKey)) return;
			setCelebration(next);
			const now = Date.now();
			if (
				moveCamera &&
				followRef.current &&
				now - lastCameraMove.current >= CAMERA_COOLDOWN_MS
			) {
				lastCameraMove.current = now;
				frameCardRef.current(next.nodeKey);
			}
		},
		[],
	);
	useEffect(() => {
		if (!celebration) return;
		const timer = setTimeout(() => setCelebration(null), CELEBRATION_MS);
		return () => clearTimeout(timer);
	}, [celebration]);
	// Live. The first pass only seeds the seen-set, so opening the screen on a
	// board full of finished tasks is silent and a remount replays nothing. It
	// keeps seeding while replaying or paused: the set must stay current, or
	// returning to live would fire every completion that happened meanwhile.
	useEffect(() => {
		if (!ready) return;
		const seeding = !seededCompletions.current || replaying || paused;
		seededCompletions.current = true;
		const found = liveCompletions(
			nodes,
			celebratedMovements.current,
			Date.now(),
			seeding,
		);
		const newest = found[found.length - 1];
		if (newest) celebrate(newest, true);
	}, [nodes, ready, replaying, paused, celebrate]);
	// Replay. Forward crossings only: scrubbing backwards over a completion is
	// silent, and standing still on one does not re-fire. Re-crossing it forward
	// does celebrate again — a re-watch is a new crossing.
	useEffect(() => {
		if (!replaying || !playback) {
			lastReplayIndex.current = -1;
			return;
		}
		const previous = lastReplayIndex.current;
		lastReplayIndex.current = playback.index;
		if (playback.index <= previous) return;
		const found = replayCompletion(playback.current, nodes);
		// No camera here: the follow effect below already frames the card of every
		// recorded task step. Two owners of one camera is exactly how it thrashes.
		if (found) celebrate(found, false);
	}, [playback?.revision, replaying, nodes, celebrate]);
	resizeFollow.current = follow && ready ? () => {
		if (overviewMode.current || !followedRecord) fitRef.current(true);
		else exchange(followedRecord);
	} : null;
	useEffect(() => {
		setFlights([]);
		// Only a message flies. A task step legitimately launches nothing, and must
		// not re-fly the previous message.
		if (playback?.current?.kind !== "message") return;
		launchRef.current(playback.current.record);
	}, [playback?.revision, replaying]);
	useEffect(() => {
		if (!follow) return;
		if (!ready) return;
		const current = playback?.current;
		if (current?.kind === "task") {
			frameCardRef.current(current.nodeKey);
			return;
		}
		const event = current ?? playback?.events[playback.events.length - 1];
		const record =
			event?.kind === "message" ? event.record : lastMessageRecord(playback?.events);
		if (event && record && (replaying || Date.now() - event.at < FOLLOW_IDLE_MS)) {
			exchangeRef.current(record);
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
			Math.max(0, FOLLOW_IDLE_MS - (Date.now() - latest.at));
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
	// The lit wire and its subject bubble are message-only. On a task step the wire
	// that was lit stays lit rather than blanking, and no new one lights up.
	const active = playback?.ended
		? undefined
		: playback?.current?.kind === "message"
			? playback.current.record
			: (playback?.currentRecord ?? flights[flights.length - 1]?.record);
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
								style={{ "--wire": `var(--wire-${edge.colorIndex})` } as CSSProperties}
								className={`traffic-wire verdict-${visiblePair?.status ?? edge.status} ${!visiblePair ? "is-dim" : ""} ${activeEdge?.key === edge.key ? "is-active" : ""}`}
								strokeWidth={wireWidth(count) / view.scale}
							/>
						);
					})}
					{/* The wave belongs to a message in transit, not to the wire: an idle
					    wire stands still. It rides `flight.points`, which already run
					    sender → recipient even when the reply goes back up the graph. */}
					{flights.flatMap((flight) => {
						if (reduced || !flight.points.length) return [];
						const status = flight.record.row.status;
						if (status === "not-delivered") return [];
						const key = [fromKey(flight.record.row), toKey(flight.record.row)].sort().join("|");
						const edge = edgeByKey.get(key);
						if (!edge) return [];
						// Lengths divide by the scene scale so the wave keeps one on-screen
						// size and speed at every zoom, like strokeWidth above.
						return [
							<path
								key={`${flight.record.key}:${flight.started}:flow`}
								d={wirePath(flight.points)}
								className="traffic-wire-flow"
								strokeWidth={wireWidth(visiblePairs.get(key)?.count ?? 0) / view.scale}
								style={{
									"--wire": `var(--wire-${edge.colorIndex})`,
									strokeDasharray: `${FLOW_DASH / view.scale} ${FLOW_GAP / view.scale}`,
									"--flow-cycle": `${(FLOW_DASH + FLOW_GAP) / view.scale}px`,
									"--flow-duration": `${((FLOW_DASH + FLOW_GAP) / FLOW_SPEED).toFixed(2)}s`,
								} as CSSProperties}
							/>,
						];
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
					{scene.placed.map((placed) => {
						// The user marker never reaches `Card`: it has no task to project.
						if (placed.node.user)
							return (
								<UserCard
									key={placed.node.key}
									placed={placed}
									messageCount={messageCounts.get(placed.node.key) ?? 0}
									selected={selected === placed.node.key}
									dim={selected !== null && selected !== placed.node.key}
									active={
										activeFrom === placed.node.key ||
										activeTo === placed.node.key
									}
									scale={view.scale}
									onSelect={(key) => {
										manual();
										onSelect(key);
									}}
									onFocus={focus}
								/>
							);
						const projection =
							projections.get(placed.node.key) ??
							projectTaskAt(placed.node.task, cursorAt);
						return (
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
									activeFrom === placed.node.key ||
									activeTo === placed.node.key
								}
								scale={view.scale}
								projection={projection}
								replaying={replaying}
								// A null status leaves both undefined, so the card falls back
								// to the neutral tertiary ink. An unknown past must never be
								// painted in a status colour.
								statusColor={
									projection.status ? colors[projection.status] : undefined
								}
								inkColor={
									projection.status ? ink[projection.status] : undefined
								}
								project={projectById.get(placed.node.projectId)}
								latest={latest.get(placed.node.key)}
								celebrating={celebration?.nodeKey === placed.node.key}
								onSelect={(key) => {
									manual();
									onSelect(key);
								}}
								onFocus={focus}
							/>
						);
					})}
					{/* Outside the card, because the card clips its overflow and a
					    burst that stays inside it is not a burst. */}
					{celebration && nodeByKey.has(celebration.nodeKey) && (
						<CompletionBurst
							key={celebration.key}
							placed={nodeByKey.get(celebration.nodeKey)!}
							celebration={celebration}
							reduced={reduced}
						/>
					)}
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
			<p className="traffic-map-caption">
				{t("traffic.nodes.legend")}
				{/* The movement log records creation, status and custom-column moves and
				    nothing else, so these three dimensions are the CURRENT ones on a
				    replayed card. Said once on the stage rather than as a per-card badge
				    the log has nothing per-card to justify. */}
				{replaying && ` · ${t("traffic.nodes.currentOnlyDimensions")}`}
			</p>
		</div>
	);
}

/**
 * The celebration itself: a bounded burst plus a badge naming what happened and,
 * when the movement log can prove one, how long it took.
 *
 * Reduced motion drops every particle and keeps the badge. Motion is never the
 * only channel here — the badge carries the icon, the word and the number on its
 * own, so the static treatment loses decoration and no information.
 */
function CompletionBurst({
	placed,
	celebration,
	reduced,
}: {
	placed: PlacedNode;
	celebration: CompletionCelebration;
	reduced: boolean;
}) {
	const t = useT();
	const pieces = useMemo(
		() => (reduced ? [] : burstPieces(celebration.key)),
		[celebration.key, reduced],
	);
	const duration = celebration.duration;
	const elapsed = duration
		? duration.ms < 60_000
			? t("traffic.celebration.underMinute")
			: formatDuration(duration.ms)
		: null;
	const line = !duration
		? t("traffic.celebration.completed")
		: duration.basis === "work-start"
			? t("traffic.celebration.worked", { duration: elapsed! })
			: t("traffic.celebration.age", { duration: elapsed! });
	return (
		<div
			className="traffic-celebration"
			data-testid="traffic-celebration"
			data-basis={duration?.basis ?? "unknown"}
			data-reduced={reduced ? "true" : undefined}
			style={{
				left: placed.x,
				top: placed.y,
				width: placed.width,
				height: placed.height,
			}}
		>
			{pieces.map((piece, index) => (
				<i
					key={index}
					aria-hidden="true"
					className="traffic-celebration-piece"
					style={{
						["--piece-angle" as string]: `${piece.angle}deg`,
						["--piece-distance" as string]: `${piece.distance}px`,
						["--piece-spin" as string]: `${piece.spin}deg`,
						["--piece-delay" as string]: `${piece.delay}ms`,
					}}
				/>
			))}
			<span className="traffic-celebration-badge" role="status">
				<TrafficIcon name="check" />
				{line}
			</span>
		</div>
	);
}

/**
 * The person using the app, drawn as its own thing rather than through {@link Card}.
 *
 * Deliberately not a branch inside `Card`: it shares none of the task grammar
 * there — no status, no overview, no seq, no replay projection, all of which
 * would print something false about a human ("status not recorded", "#—"). It
 * also keeps this feature out of a function another task owns.
 */
function UserCard({
	placed,
	messageCount,
	selected,
	dim,
	active,
	scale,
	onSelect,
	onFocus,
}: {
	placed: PlacedNode;
	messageCount: number;
	selected: boolean;
	dim: boolean;
	active: boolean;
	scale: number;
	onSelect: (key: string) => void;
	onFocus: (key: string) => void;
}) {
	const t = useT();
	return (
		<button
			type="button"
			data-testid="traffic-user-card"
			className={`traffic-node-card traffic-user-card ${selected ? "is-selected" : ""} ${dim ? "is-dim" : ""} ${active ? "is-lit" : ""}`}
			style={{
				left: placed.x,
				top: placed.y,
				width: placed.width,
				height: placed.height,
				["--node-inverse" as string]: 1 / scale,
			}}
			aria-label={`${t("traffic.node.you")} · ${t.plural("traffic.orbit.messageCount", messageCount)}`}
			aria-pressed={selected}
			onClick={() => onSelect(placed.node.key)}
			onDoubleClick={() => onFocus(placed.node.key)}
		>
			<TrafficIcon name="user" />
			<strong>{t("traffic.node.you")}</strong>
			<span className="traffic-node-count">{messageCount}</span>
		</button>
	);
}

function Card({
	placed,
	messageCount,
	selected,
	dim,
	active,
	scale,
	projection,
	replaying,
	statusColor,
	inkColor,
	project,
	latest,
	celebrating,
	onSelect,
	onFocus,
}: {
	placed: PlacedNode;
	messageCount: number;
	selected: boolean;
	dim: boolean;
	active: boolean;
	scale: number;
	projection: TaskProjection;
	replaying: boolean;
	statusColor?: string;
	inkColor?: string;
	project?: {
		id: string;
		name: string;
		customStatusLabels?: Record<string, string>;
	};
	latest?: TrafficRecord;
	celebrating: boolean;
	onSelect: (key: string) => void;
	onFocus: (key: string) => void;
}) {
	const t = useT();
	const { node } = placed;
	// Every status the card shows comes from the projection, never from
	// `node.task.status` — reading the live status here is exactly the bug.
	const finished =
		projection.status === "completed" || projection.status === "cancelled"
			? projection.status
			: null;
	const state = placed.parked
		? t("task.hibernatedBadge")
		: projection.status
			? getStatusLabel(projection.status, t, project)
			: node.task
				? // Known to be a task, unknown what state it was in. Said plainly
					// instead of borrowing today's status for the past.
					t("traffic.node.statusUnrecorded")
				: t("traffic.orbit.historical");
	// Kept in the DOM at its frozen position so cards appear without the layout
	// reflowing around them; hidden from the accessibility tree and untabbable
	// while it has not happened yet.
	const unborn = !projection.present;
	// Kept as an attribute for styling and tests: the card itself no longer spends
	// a line on it, the state line already says what is and is not known.
	const limited = replaying && node.task && projection.confidence !== "recorded"
		? projection.confidence
		: null;
	// The lifecycle rail the rest of the app draws down the left edge of a task
	// card. It carries the projected status, so a parked card and a card with no
	// recorded state get the bare strip — a ring would claim a stage neither has.
	const railStatus = placed.parked ? null : (projection.status ?? null);
	return (
		<button
			type="button"
			data-testid="traffic-node-card"
			data-history={limited ?? undefined}
			data-unborn={unborn ? "true" : undefined}
			className={`traffic-node-card ${node.task?.taskType === "coordinator" ? "is-coordinator" : ""} ${selected ? "is-selected" : ""} ${dim ? "is-dim" : ""} ${active ? "is-lit" : ""} ${placed.parked ? "is-parked" : ""} ${finished ? `is-${finished}` : ""} ${unborn ? "is-unborn" : ""} ${celebrating ? "is-celebrating" : ""}`}
			style={{
				left: placed.x,
				top: placed.y,
				width: placed.width,
				height: placed.height,
				["--node-status" as string]: statusColor ?? "rgb(var(--text-tertiary))",
				["--node-ink" as string]: inkColor ?? "rgb(var(--text-tertiary))",
				["--node-inverse" as string]: 1 / scale,
			}}
			aria-hidden={unborn || undefined}
			tabIndex={unborn ? -1 : undefined}
			aria-label={`${nodeSeq(node)} ${node.title || t("traffic.orbit.historical")} · ${state}`}
			aria-pressed={selected}
			onClick={() => !unborn && onSelect(node.key)}
			onDoubleClick={() => !unborn && onFocus(node.key)}
		>
			{/* Hidden from assistive tech: the card's own aria-label already says the
			    status, and the ring would only repeat the stage as a second voice. */}
			<span className="traffic-node-rail" aria-hidden="true">
				{railStatus && (
					<PipelineRing status={railStatus} size="compact" tooltip={false} />
				)}
			</span>
			<span className="traffic-node-full">
				<span className="traffic-node-head">
					<b>{nodeSeq(node)}</b>
					{node.task?.taskType === "coordinator" && (
						<em>{t("traffic.orbit.coordinator")}</em>
					)}
					<span className="traffic-node-count">{messageCount}</span>
				</span>
				<strong className="streamer-private">
					{node.title || t("traffic.orbit.historical")}
				</strong>
				{finished ? (
					<span className={`traffic-node-stamp is-${finished}`}>
						<TrafficIcon name={finished === "completed" ? "check" : "cross"} />
						{state}
					</span>
				) : (
					<span className="traffic-node-state">{state}</span>
				)}
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
				{finished ? (
					<span className={`traffic-node-stamp is-${finished}`}>
						<TrafficIcon name={finished === "completed" ? "check" : "cross"} />
						{state}
					</span>
				) : (
					<span className="traffic-node-state">{state}</span>
				)}
			</span>
		</button>
	);
}
