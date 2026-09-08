import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { getTaskOverview } from "../../../../shared/types";
import { useT } from "../../../i18n";
import { useResolvedTheme } from "../../../hooks/useResolvedTheme";
import { useStatusColors, useStatusColorsInk } from "../../../hooks/useStatusColors";
import { useReducedMotion } from "../../../utils/useReducedMotion";
import { getStatusLabel } from "../../../utils/statusLabel";
import { fromKey, nodeSeq, toKey, type TrafficRecord } from "../traffic-model";
import type { useTrafficPlayback } from "../useTrafficPlayback";
import type { TrafficNode } from "../traffic-model";
import TrafficIcon from "../TrafficIcon";
import {
	advance,
	bindPointer,
	createCamera,
	frame as frameCamera,
	framingDistance,
	home as homeCamera,
	settled,
	zoomBy,
	type StrataCamera,
} from "./strata-camera";
import {
	StrataGL,
	StrataUnsupportedError,
	type StrataDecal,
	type StrataMesh,
} from "./strata-gl";
import { placeLabels, type Rect } from "./strata-labels";
import { MeshBuilder } from "./strata-mesh";
import { rgb, V } from "./strata-math";
import { strataPalette } from "./strata-palette";
import {
	machineIndex,
	strataRoutes,
	strataScene,
	strataSummary,
	type StrataMachine,
	type StrataMode,
	type StrataRoute,
} from "./strata-model";
import {
	buildDistrict,
	buildMachine,
	buildRoutes,
	buildSubstrate,
	machineLook,
	sceneBounds,
	sceneExtent,
	type PlacedRoute,
} from "./strata-scene";
import "./traffic-strata.css";

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

const MODES: StrataMode[] = ["situation", "waiting", "traffic"];
const MODE_LABEL: Record<StrataMode, "traffic.strata.modeSituation" | "traffic.strata.modeWaiting" | "traffic.strata.modeTraffic"> = {
	situation: "traffic.strata.modeSituation",
	waiting: "traffic.strata.modeWaiting",
	traffic: "traffic.strata.modeTraffic",
};
const MODE_HEADING: Record<StrataMode, "traffic.strata.headingSituation" | "traffic.strata.headingWaiting" | "traffic.strata.headingTraffic"> = {
	situation: "traffic.strata.headingSituation",
	waiting: "traffic.strata.headingWaiting",
	traffic: "traffic.strata.headingTraffic",
};
/** Long enough that a manual nudge is not immediately overridden by Follow. */
const FOLLOW_IDLE_MS = 3500;

export default function TrafficStrata({
	nodes,
	records,
	layoutRecords,
	selected,
	onSelect,
	paused,
	ready,
	projects,
	playback,
	focusRequest,
	followRequest,
}: Props) {
	const t = useT();
	const theme = useResolvedTheme();
	const colors = useStatusColors();
	const ink = useStatusColorsInk();
	const reduced = useReducedMotion();
	const frameRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const labelLayerRef = useRef<HTMLDivElement>(null);
	const [mode, setMode] = useState<StrataMode>("situation");
	const [railOpen, setRailOpen] = useState(true);
	const [follow, setFollow] = useState(true);
	const [unsupported, setUnsupported] = useState<string | null>(null);
	const now = Date.now();

	const { palette, materials } = useMemo(() => strataPalette(theme), [theme]);
	const cursorAt = playback?.cursor.at ?? null;

	// The cursor is the only input to the historical projection, exactly as in
	// Experiment 2 — which is what makes scrubbing backwards reverse the stage
	// rather than unwind accumulated state.
	const { districts, machines } = useMemo(
		() =>
			strataScene({
				nodes,
				projects: projects ?? [],
				records: layoutRecords,
				cursorAt,
			}),
		[nodes, projects, layoutRecords, cursorAt],
	);
	const machineMap = useMemo(() => machineIndex(machines), [machines]);
	// Two measurements, not one: the camera frames the decks (`bounds`, centred on
	// their own centroid), the substrate reaches past them from the world origin.
	const bounds = useMemo(() => sceneBounds(districts), [districts]);
	const decorExtent = useMemo(() => sceneExtent(districts), [districts]);
	const routes = useMemo(
		() => strataRoutes(records, mode, now),
		// `now` deliberately excluded: it changes every render and only decides
		// whether a scheduled row is still queued, which the next data push
		// re-evaluates anyway.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[records, mode],
	);
	const summary = useMemo(
		() =>
			strataSummary({
				records,
				machines,
				now,
				windowStart: records.length
					? Math.min(
							...records
								.map(({ row }) => Date.parse(row.at))
								.filter((at) => Number.isFinite(at)),
						)
					: now,
			}),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[records, machines],
	);

	/** Cards the log says are asking for the user, newest evidence first. */
	const attention = useMemo(() => {
		const items: { machine: StrataMachine; reason: "asking" | "undelivered" }[] = [];
		for (const machine of machines) {
			if (machine.undelivered) items.push({ machine, reason: "undelivered" });
			else if (machine.status === "user-questions")
				items.push({ machine, reason: "asking" });
		}
		return items
			.sort(
				(a, b) =>
					Number(b.reason === "undelivered") - Number(a.reason === "undelivered") ||
					(b.machine.node.seq ?? 0) - (a.machine.node.seq ?? 0),
			)
			.slice(0, 6);
	}, [machines]);

	// ---- imperative render state, deliberately outside React ----
	const engineRef = useRef<StrataGL | null>(null);
	const cameraRef = useRef<StrataCamera>(createCamera(bounds));
	const staticRef = useRef<{
		base: StrataMesh | null;
		detail: StrataMesh | null;
		ghost: StrataMesh | null;
		decals: StrataDecal[];
	}>({ base: null, detail: null, ghost: null, decals: [] });
	const machineMeshes = useRef(new Map<string, { key: string; mesh: StrataMesh }>());
	const routeMeshRef = useRef<StrataMesh | null>(null);
	const placedRoutesRef = useRef<PlacedRoute[]>([]);
	const selectionMeshRef = useRef<StrataMesh | null>(null);
	const haloMeshRef = useRef<StrataMesh | null>(null);
	const labelNodes = useRef(new Map<string, HTMLElement>());
	const districtNodes = useRef(new Map<string, HTMLElement>());
	const routeLabelRef = useRef<HTMLButtonElement>(null);
	const machinesRef = useRef(machines);
	const districtsRef = useRef(districts);
	const selectedRef = useRef(selected);
	const followRef = useRef(follow);
	const pausedRef = useRef(paused);
	const reducedRef = useRef(reduced);
	const lastManual = useRef(0);
	const lastFailedRoute = useRef<PlacedRoute | null>(null);
	const boundsRef = useRef(bounds);
	machinesRef.current = machines;
	districtsRef.current = districts;
	selectedRef.current = selected;
	followRef.current = follow;
	pausedRef.current = paused;
	reducedRef.current = reduced;
	boundsRef.current = bounds;

	const statusColor = useCallback(
		(status: Parameters<typeof getStatusLabel>[0]) => colors[status],
		[colors],
	);

	/** Nearest machine to a canvas point, within a forgiving radius. */
	/** Current stage aspect, or the default before the canvas has been measured. */
	const stageAspect = useCallback(() => {
		const engine = engineRef.current;
		return engine && engine.h > 0 ? engine.w / engine.h : undefined;
	}, []);

	const hitTest = useCallback((x: number, y: number): StrataMachine | null => {
		const engine = engineRef.current;
		if (!engine) return null;
		let closest: StrataMachine | null = null;
		let best = 30;
		for (const machine of machinesRef.current) {
			if (machine.unborn) continue;
			const projected = engine.project(V.add(machine.pos, [0, 2, 0]));
			if (!projected.visible) continue;
			const distance = Math.hypot(projected.x - x, projected.y - y);
			if (distance < best) {
				best = distance;
				closest = machine;
			}
		}
		return closest;
	}, []);

	// ---- engine lifecycle ----
	useEffect(() => {
		const canvas = canvasRef.current;
		const host = frameRef.current;
		if (!canvas || !host) return;
		let engine: StrataGL;
		try {
			engine = new StrataGL(canvas, palette);
		} catch (error) {
			// Lists work without WebGL (§5.9). A stage that cannot draw says so and
			// gets out of the way rather than throwing into the screen.
			setUnsupported(
				error instanceof StrataUnsupportedError
					? t("traffic.strata.unsupportedBody")
					: String(error instanceof Error ? error.message : error),
			);
			return;
		}
		engineRef.current = engine;
		setUnsupported(null);
		engine.resize();

		// The selection ring and the activity halo are built once and drawn at an
		// offset per card, rather than rebuilt into every machine mesh.
		const ring = new MeshBuilder();
		ring.torus(0, 0.19, 0, 2.3, 0.065, materials.holdRing, 0.9);
		ring.torus(0, 0.2, 0, 2.54, 0.024, materials.deckFoot, 0.8, "xz", Math.PI * 1.45, 0.35);
		for (let k = 0; k < 4; k++) {
			const a = (k * Math.PI) / 2;
			ring.beam(
				[Math.cos(a) * 2.6, 0.2, Math.sin(a) * 2.6],
				[Math.cos(a) * 2.9, 0.2, Math.sin(a) * 2.9],
				0.05,
				materials.holdRing,
				1,
			);
		}
		selectionMeshRef.current = engine.mesh(ring);
		const halo = new MeshBuilder();
		halo.torus(0, 0, 0, 0.92, 0.023, materials.glass, 0.85);
		haloMeshRef.current = engine.mesh(halo);

		const onContextLost = (event: Event) => {
			event.preventDefault();
			setUnsupported(t("traffic.strata.contextLost"));
		};
		canvas.addEventListener("webglcontextlost", onContextLost);
		const observer = new ResizeObserver(() => {
			engineRef.current?.resize();
			// The aspect just changed, so the fit did too. Re-frame only while
			// Follow owns the camera; a hand-placed view must survive a resize.
			if (followRef.current) homeCamera(cameraRef.current, boundsRef.current, stageAspect());
		});
		observer.observe(host);
		return () => {
			canvas.removeEventListener("webglcontextlost", onContextLost);
			observer.disconnect();
			for (const entry of machineMeshes.current.values()) engine.dispose(entry.mesh);
			machineMeshes.current.clear();
			engine.dispose(routeMeshRef.current);
			engine.dispose(selectionMeshRef.current);
			engine.dispose(haloMeshRef.current);
			engine.dispose(staticRef.current.base);
			engine.dispose(staticRef.current.detail);
			engine.dispose(staticRef.current.ghost);
			for (const decal of staticRef.current.decals) engine.disposeDecal(decal);
			staticRef.current = { base: null, detail: null, ghost: null, decals: [] };
			routeMeshRef.current = null;
			selectionMeshRef.current = null;
			haloMeshRef.current = null;
			engine.destroy();
			engineRef.current = null;
		};
		// `palette`/`materials` are theme-derived: a theme flip rebuilds the whole
		// scene, which is correct — every material changed.
	}, [palette, materials, t, stageAspect]);

	// ---- static geometry: substrate, decks, deck decals ----
	useEffect(() => {
		const engine = engineRef.current;
		if (!engine) return;
		const previous = staticRef.current;
		engine.dispose(previous.base);
		engine.dispose(previous.detail);
		engine.dispose(previous.ghost);
		for (const decal of previous.decals) engine.disposeDecal(decal);
		const { base, detail } = buildSubstrate(materials, decorExtent);
		const ghost = new MeshBuilder();
		const decals: StrataDecal[] = [];
		for (const district of districts) {
			buildDistrict(district, materials, { base, detail, ghost });
			const decal = engine.decal(
				district.center[0],
				district.center[1] + 0.42,
				district.center[2] + district.radius * 0.52,
				district.radius * 0.91,
				district.radius * 0.23,
				district.quiet
					? `${district.plate} / ${t("traffic.strata.quietDistrict").toUpperCase()}`
					: `${district.plate} / ${district.name.toUpperCase()}`,
				district.quiet
					? t("traffic.strata.quietDecal").toUpperCase()
					: t("traffic.strata.districtDecal").toUpperCase(),
			);
			if (decal) decals.push(decal);
		}
		staticRef.current = {
			base: engine.mesh(base),
			detail: engine.mesh(detail),
			ghost: engine.mesh(ghost),
			decals,
		};
	}, [districts, materials, decorExtent, t]);

	// ---- one mesh per card, rebuilt only when its look actually changes ----
	useEffect(() => {
		const engine = engineRef.current;
		if (!engine) return;
		const keep = new Set(machines.map((machine) => machine.key));
		for (const [key, entry] of machineMeshes.current) {
			if (!keep.has(key)) {
				engine.dispose(entry.mesh);
				machineMeshes.current.delete(key);
			}
		}
		const far = cameraRef.current.distance > 125 && machines.length > 24;
		for (const machine of machines) {
			const look = machineLook(machine, statusColor, materials);
			const lookKey = [
				machine.status ?? "unknown",
				machine.role,
				machine.recordedStages,
				machine.undelivered ? "x" : "-",
				look.quiet ? "q" : "-",
				far && machine.key !== selected ? "far" : "near",
			].join(":");
			const existing = machineMeshes.current.get(machine.key);
			if (existing?.key === lookKey) continue;
			if (existing) engine.dispose(existing.mesh);
			machineMeshes.current.set(machine.key, {
				key: lookKey,
				mesh: engine.mesh(
					buildMachine(machine, look, materials, far && machine.key !== selected),
				),
			});
		}
	}, [machines, materials, statusColor, selected]);

	// ---- route beams ----
	useEffect(() => {
		const engine = engineRef.current;
		if (!engine) return;
		engine.dispose(routeMeshRef.current);
		const highlighted = (route: StrataRoute) =>
			!selected || route.from === selected || route.to === selected;
		const { mesh, placed } = buildRoutes(routes, machineMap, materials, highlighted);
		routeMeshRef.current = engine.mesh(mesh);
		placedRoutesRef.current = placed;
		lastFailedRoute.current =
			[...placed].reverse().find((route) => route.kind === "failed") ?? null;
	}, [routes, machineMap, materials, selected]);

	// ---- pointer input ----
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || unsupported) return;
		return bindPointer(canvas, {
			camera: cameraRef.current,
			onTap: (x, y) => {
				const machine = hitTest(x, y);
				if (machine) onSelect(machine.key);
			},
			onFrame: () => {
				const machine = selectedRef.current
					? machineMap.get(selectedRef.current)
					: undefined;
				if (machine) frameCamera(cameraRef.current, machine.pos);
			},
			onManual: () => {
				lastManual.current = performance.now();
				if (followRef.current) setFollow(false);
			},
		});
	}, [hitTest, onSelect, machineMap, unsupported]);

	// ---- stage-local keyboard: F frames, H goes home ----
	useEffect(() => {
		const host = frameRef.current;
		if (!host || unsupported) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const key = event.key.toLowerCase();
			if (key !== "f" && key !== "h") return;
			// Never steal a letter from a text field or a composing IME.
			const active = document.activeElement as HTMLElement | null;
			if (
				event.isComposing ||
				active?.isContentEditable ||
				["INPUT", "TEXTAREA", "SELECT"].includes(active?.tagName ?? "")
			)
				return;
			event.preventDefault();
			lastManual.current = performance.now();
			if (key === "h") {
				homeCamera(cameraRef.current, bounds, stageAspect());
				setFollow(false);
				return;
			}
			const machine = selectedRef.current ? machineMap.get(selectedRef.current) : undefined;
			if (machine) frameCamera(cameraRef.current, machine.pos);
			else homeCamera(cameraRef.current, bounds, stageAspect());
		};
		host.addEventListener("keydown", onKeyDown);
		return () => host.removeEventListener("keydown", onKeyDown);
	}, [bounds, machineMap, unsupported, stageAspect]);

	// ---- Focus / Follow nudges from the screen ----
	useEffect(() => {
		if (!focusRequest) return;
		const machine = selectedRef.current ? machineMap.get(selectedRef.current) : undefined;
		if (machine) {
			frameCamera(cameraRef.current, machine.pos);
			setFollow(false);
		}
	}, [focusRequest, machineMap]);
	useEffect(() => {
		if (!followRequest) return;
		setFollow(true);
		homeCamera(cameraRef.current, bounds, stageAspect());
	}, [followRequest, bounds, stageAspect]);
	// A scene that changed size (a project appeared, the window moved) re-frames
	// only while Follow owns the camera.
	useEffect(() => {
		if (!followRef.current) return;
		cameraRef.current.toDistance = framingDistance(bounds.radius, stageAspect());
	}, [bounds, stageAspect]);

	// ---- the render loop ----
	useEffect(() => {
		if (unsupported) return;
		let raf = 0;
		let last = 0;
		const loop = (ts: number) => {
			raf = requestAnimationFrame(loop);
			const engine = engineRef.current;
			if (!engine || document.hidden) return;
			const dt = Math.min(0.05, (ts - (last || ts)) / 1000);
			last = ts;
			const camera = cameraRef.current;
			const motion = !reducedRef.current && !pausedRef.current;

			// Follow: glide to the exchange the cursor is standing on, and fall back
			// to the whole scene once nothing has happened for a while.
			if (followRef.current && ts - lastManual.current > 400) {
				const record = playback?.currentRecord ?? null;
				const a = record ? machineMap.get(fromKey(record.row) ?? "") : undefined;
				const b = record ? machineMap.get(toKey(record.row)) : undefined;
				if (a && b) {
					const midpoint = V.mul(V.add(a.pos, b.pos), 0.5);
					frameCamera(camera, midpoint, Math.max(30, Math.hypot(...V.sub(a.pos, b.pos)) * 1.5));
				} else if (ts - lastManual.current > FOLLOW_IDLE_MS) {
					homeCamera(camera, bounds, stageAspect());
				}
			}

			const eye = advance(camera, dt, reducedRef.current);
			engine.begin(eye, camera.target);
			const statics = staticRef.current;
			if (statics.base) engine.draw(statics.base);
			if (statics.detail) engine.draw(statics.detail);
			// The strata rings under the decks only mean something while replay is
			// standing somewhere in the past.
			if (statics.ghost && cursorAt !== null) engine.draw(statics.ghost, { opacity: 0.4 });
			for (const decal of statics.decals) engine.drawDecal(decal);

			const particles: number[] = [];
			const seconds = ts / 1000;
			for (const machine of machinesRef.current) {
				const entry = machineMeshes.current.get(machine.key);
				if (!entry) continue;
				// `present === false` keeps the slot and hides the model: filtering it
				// out instead would re-run the layout and move the stage.
				if (machine.unborn) continue;
				const highlighted =
					!selectedRef.current ||
					machine.key === selectedRef.current ||
					placedRoutesRef.current.some(
						(route) =>
							(route.from === selectedRef.current && route.to === machine.key) ||
							(route.to === selectedRef.current && route.from === machine.key),
					);
				// `waiting` mode dims anything that is not itself unlanded.
				const relevantToMode =
					mode !== "waiting" ||
					machine.undelivered ||
					machine.status === "user-questions" ||
					machine.role === "coordinator";
				engine.draw(entry.mesh, {
					offset: machine.pos,
					dim: highlighted ? (relevantToMode ? 1 : 0.5) : 0.32,
				});
				if (machine.key === selectedRef.current && selectionMeshRef.current) {
					engine.draw(selectionMeshRef.current, { offset: machine.pos });
				}
				if (!highlighted) continue;
				const accent = machine.status ? colors[machine.status] : materials.unknown;
				if (machine.status === "in-progress" && motion && haloMeshRef.current) {
					const phase = seconds * 0.3 + (machine.node.seq ?? 0);
					const lift = machine.role === "coordinator" ? 3.9 : 2.4;
					engine.draw(haloMeshRef.current, {
						offset: V.add(machine.pos, [0, lift + Math.sin(phase) * 0.7, 0]),
						opacity: 0.4,
					});
					for (let k = 0; k < 2; k++) {
						const a = phase + k * Math.PI;
						particles.push(
							machine.pos[0] + Math.cos(a) * 1.7,
							machine.pos[1] + 1.1 + k * 0.8,
							machine.pos[2] + Math.sin(a) * 1.7,
							...rgb(accent),
							2.1,
						);
					}
				}
				if (machine.undelivered || machine.status === "user-questions") {
					const pulse = motion ? 2.5 + Math.sin(seconds * 2 + (machine.node.seq ?? 0)) * 0.5 : 2.5;
					particles.push(
						machine.pos[0],
						machine.pos[1] + 4.2,
						machine.pos[2],
						...rgb(accent),
						pulse,
					);
				}
			}
			if (routeMeshRef.current) engine.draw(routeMeshRef.current);
			engine.particles(particles);
			positionLabels(engine);
			// A settled camera with reduced motion on has nothing left to animate;
			// the next data change re-enters through an effect, not a spin.
			if (reducedRef.current && settled(camera) && !motion) {
				// Still keep the frame loop alive — replay and live pushes both need it.
			}
		};

		/**
		 * Project every label and hand the survivors their transform, in the DOM.
		 *
		 * Order is load-bearing: the deck names and the failed-route callout are
		 * placed first and their boxes become reserved space, so a floating card
		 * label is dropped rather than parked on top of either. Doing cards first
		 * — the obvious order, and what the first build did — buried the district
		 * a card was standing on.
		 */
		const positionLabels = (engine: StrataGL) => {
			// The overlay panels come first of all: every floating thing — deck name,
			// route callout, card label — has to keep clear of them, and reading them
			// once per frame is one `getBoundingClientRect` batch rather than three.
			const claimed: Rect[] = [];
			const layer = labelLayerRef.current;
			const panels: Rect[] = [];
			if (layer) {
				const bounds = layer.getBoundingClientRect();
				for (const panel of layer.parentElement?.querySelectorAll<HTMLElement>(
					"[data-strata-reserved]",
				) ?? []) {
					const box = panel.getBoundingClientRect();
					panels.push({
						x: box.left - bounds.left,
						y: box.top - bounds.top,
						w: box.width,
						h: box.height,
					});
				}
			}
			const hits = (rect: Rect, boxes: Rect[]) =>
				boxes.some(
					(box) =>
						rect.x < box.x + box.w &&
						rect.x + rect.w > box.x &&
						rect.y < box.y + box.h &&
						rect.y + rect.h > box.y,
				);
			for (const district of districtsRef.current) {
				const element = districtNodes.current.get(district.id);
				if (!element) continue;
				const projected = engine.project([
					district.center[0],
					district.center[1] + 0.5,
					district.center[2] + district.radius * 0.89,
				]);
				const visible =
					projected.visible &&
					projected.x > 40 &&
					projected.x < engine.w - 40 &&
					projected.y > 8 &&
					projected.y < engine.h - 44;
				element.style.display = visible ? "block" : "none";
				if (!visible) continue;
				element.style.transform = `translate(-50%, 0) translate(${projected.x}px, ${projected.y}px)`;
				claimed.push({
					x: projected.x - element.offsetWidth / 2,
					y: projected.y,
					w: element.offsetWidth,
					h: element.offsetHeight,
				});
			}
			const routeLabel = routeLabelRef.current;
			const failed = lastFailedRoute.current;
			if (routeLabel) {
				const mid = failed?.points[Math.floor(failed.points.length / 2)];
				const projected = mid ? engine.project(mid) : null;
				const rect = projected
					? {
							x: projected.x - routeLabel.offsetWidth / 2,
							y: projected.y + 4,
							w: routeLabel.offsetWidth,
							h: routeLabel.offsetHeight,
						}
					: null;
				// Hidden rather than nudged when it lands under a panel: a moved
				// callout points at a route that is not there.
				const visible =
					!!projected &&
					!!rect &&
					projected.visible &&
					projected.x > 80 &&
					projected.x < engine.w - 80 &&
					projected.y > 12 &&
					projected.y < engine.h - 48 &&
					!hits(rect, panels);
				routeLabel.style.display = visible ? "block" : "none";
				if (visible && projected && rect) {
					routeLabel.style.transform = `translate(-50%, 0) translate(${projected.x}px, ${projected.y + 4}px)`;
					claimed.push(rect);
				}
			}
			const points = new Map<string, { x: number; y: number; visible: boolean }>();
			const sizes = new Map<string, { w: number; h: number }>();
			for (const machine of machinesRef.current) {
				const lift =
					machine.role === "coordinator"
						? 5.7
						: machine.status === "user-questions" || machine.undelivered
							? 4.7
							: 4.1;
				points.set(machine.key, engine.project(V.add(machine.pos, [0, lift, 0])));
				const element = labelNodes.current.get(machine.key);
				sizes.set(machine.key, {
					w: element?.offsetWidth || 150,
					h: element?.offsetHeight || 30,
				});
			}
			const reserved: Rect[] = [...claimed, ...panels];
			const placed = placeLabels({
				machines: machinesRef.current,
				selected: selectedRef.current,
				points,
				sizes,
				width: engine.w,
				height: engine.h,
				reserved,
			});
			const shown = new Set(placed.map((label) => label.key));
			for (const [key, element] of labelNodes.current) {
				if (!shown.has(key)) {
					element.style.display = "none";
					element.setAttribute("aria-hidden", "true");
				}
			}
			for (const label of placed) {
				const element = labelNodes.current.get(label.key);
				if (!element) continue;
				element.style.display = "block";
				element.style.transform = `translate(-50%, -100%) translate(${label.x}px, ${label.y}px)`;
				element.removeAttribute("aria-hidden");
			}
		};

		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [
		unsupported,
		machineMap,
		bounds,
		mode,
		colors,
		materials,
		cursorAt,
		playback?.currentRecord,
	]);

	const failedRecord = useMemo(
		() => [...routes].reverse().find((route) => route.kind === "failed") ?? null,
		[routes],
	);

	const historyNote =
		cursorAt !== null && machines.some((machine) => machine.projection.confidence !== "recorded");

	if (unsupported) {
		return (
			<div className="strata-frame strata-unsupported" role="alert">
				<div>
					<h3>{t("traffic.strata.unsupported")}</h3>
					<p>{unsupported}</p>
					<p className="strata-unsupported-hint">{t("traffic.strata.unsupportedList")}</p>
				</div>
			</div>
		);
	}

	return (
		// tabIndex makes the stage a keyboard target so F/H reach it without a
		// window-level listener that would fire from anywhere on the screen.
		<div className="strata-frame" ref={frameRef} tabIndex={-1}>
			<canvas
				ref={canvasRef}
				className="strata-canvas"
				aria-label={t("traffic.strata.canvasLabel")}
			/>
			<div className="strata-label-layer" ref={labelLayerRef} aria-hidden="true">
				{districts.map((district) => (
					<div
						key={district.id}
						className={`strata-district-label${district.quiet ? " is-quiet" : ""}`}
						ref={(element) => {
							if (element) districtNodes.current.set(district.id, element);
							else districtNodes.current.delete(district.id);
						}}
					>
						<strong className="streamer-private">
							{district.quiet ? t("traffic.strata.quietDistrict") : district.name}
						</strong>
						<span>
							{t.plural("traffic.strata.districtTasks", district.taskCount)} ·{" "}
							{district.plate}
						</span>
					</div>
				))}
			</div>
			{/* One button per card: the label layer is decorative, this list is the
			    keyboard and screen-reader path to the same selection. */}
			<div className="strata-label-layer strata-card-labels">
				{machines.map((machine) => {
					const project = projects?.find((item) => item.id === machine.node.projectId);
					const statusLabel = machine.status
						? getStatusLabel(machine.status, t, project)
						: t("traffic.strata.statusUnknown");
					return (
						<button
							key={machine.key}
							type="button"
							className={`strata-card-label${machine.key === selected ? " is-selected" : ""}${
								machine.hibernated ? " is-parked" : ""
							}`}
							style={{
								display: "none",
								borderColor: machine.status ? `${colors[machine.status]}66` : undefined,
							}}
							ref={(element) => {
								if (element) labelNodes.current.set(machine.key, element);
								else labelNodes.current.delete(machine.key);
							}}
							onClick={() => onSelect(machine.key)}
							data-testid="strata-card-label"
						>
							<span className="strata-card-seq">{nodeSeq(machine.node)}</span>
							<span className="strata-card-title streamer-private">
								{machine.node.title}
							</span>
							<span
								className="strata-card-status"
								style={{ color: machine.status ? ink[machine.status] : undefined }}
							>
								{statusLabel}
								{machine.hibernated ? ` · ${t("task.hibernatedBadge")}` : ""}
							</span>
							{machine.key === selected && machine.node.task && (
								<span className="strata-card-overview streamer-private">
									{getTaskOverview(machine.node.task)}
								</span>
							)}
						</button>
					);
				})}
			</div>

			<nav
				className="strata-modes"
				role="radiogroup"
				aria-label={t("traffic.strata.mode")}
				data-strata-reserved
				onKeyDown={(event) => {
					if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
					event.preventDefault();
					const step = event.key === "ArrowRight" ? 1 : -1;
					const next = MODES[(MODES.indexOf(mode) + step + MODES.length) % MODES.length];
					setMode(next);
					event.currentTarget
						.querySelector<HTMLButtonElement>(`[data-testid="strata-mode-${next}"]`)
						?.focus();
				}}
			>
				{MODES.map((item) => (
					<button
						key={item}
						type="button"
						role="radio"
						aria-checked={mode === item}
						tabIndex={mode === item ? 0 : -1}
						className={mode === item ? "is-active" : ""}
						data-testid={`strata-mode-${item}`}
						onClick={() => setMode(item)}
					>
						{t(MODE_LABEL[item])}
					</button>
				))}
			</nav>

			<div className="strata-topleft" data-strata-reserved>
				<div className="strata-heading">
					<span className="strata-kicker">{t("traffic.strata.kicker")}</span>
					<h3>{t(MODE_HEADING[mode])}</h3>
					<p>
						{t.plural("traffic.strata.districtCount", districts.length)} ·{" "}
						{t.plural(
							"traffic.strata.coordinatorCount",
							machines.filter((machine) => machine.role === "coordinator").length,
						)}{" "}
						· {t("traffic.strata.noHierarchy")}
					</p>
				</div>

				<div className="strata-metrics">
					<div className="strata-metric">
						<strong>{machines.filter((machine) => machine.status === "in-progress").length}</strong>
						<span>{t("traffic.strata.metricWorking")}</span>
					</div>
					<div className="strata-metric">
						<strong>{summary.attention}</strong>
						<span>{t("traffic.strata.metricAsking")}</span>
					</div>
					<div className="strata-metric">
						<strong>{summary.held + summary.queued + summary.undelivered}</strong>
						<span>{t("traffic.strata.metricUnlanded")}</span>
					</div>
				</div>
			</div>

			{railOpen ? (
				<aside
					className="strata-rail"
					aria-label={t("traffic.strata.rail")}
					data-strata-reserved
				>
					<div className="strata-rail-head">
						<span className="strata-kicker">{t("traffic.strata.summaryTitle")}</span>
						<button
							type="button"
							onClick={() => setRailOpen(false)}
							aria-label={t("traffic.strata.railHide")}
							title={t("traffic.strata.railHide")}
						>
							×
						</button>
					</div>
					<p className="strata-rail-summary">
						{summary.events === 0
							? t("traffic.strata.summaryEmpty")
							: t("traffic.strata.summaryBody", {
									events: String(summary.events),
									span: formatSpan(summary.spanMs, t),
								})}
					</p>
					<div className="strata-rail-section">
						<strong>{t("traffic.strata.attention")}</strong>
						<span>{attention.length}</span>
					</div>
					{attention.length === 0 ? (
						<p className="strata-rail-empty">{t("traffic.strata.attentionEmpty")}</p>
					) : (
						<ul className="strata-attention">
							{attention.map(({ machine, reason }) => (
								<li key={machine.key}>
									<button
										type="button"
										onClick={() => onSelect(machine.key)}
										data-testid="strata-attention-row"
									>
										<span className={`strata-attention-dot is-${reason}`} aria-hidden="true" />
										<span className="strata-attention-reason">
											{t(
												reason === "undelivered"
													? "traffic.strata.reasonUndelivered"
													: "traffic.strata.reasonAsking",
											)}
										</span>
										<span className="strata-attention-task streamer-private">
											{nodeSeq(machine.node)} · {machine.node.title}
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
					{historyNote && (
						<p className="strata-rail-note">{t("traffic.nodes.currentOnlyDimensions")}</p>
					)}
				</aside>
			) : (
				<button
					type="button"
					className="strata-rail-open"
					onClick={() => setRailOpen(true)}
					data-strata-reserved
				>
					<TrafficIcon name="follow" />
					{t("traffic.strata.railShow")}
				</button>
			)}

			<button
				type="button"
				className="strata-route-label"
				ref={routeLabelRef}
				style={{ display: "none" }}
				onClick={() => {
					if (failedRecord) onSelect(failedRecord.to);
				}}
				data-testid="strata-route-label"
			>
				{t("traffic.strata.routeFailed")}
			</button>

			<div className="strata-legend" data-strata-reserved>
				<span>
					<i style={{ background: materials.route.delivered }} />
					{t("traffic.strata.legendDelivered")}
				</span>
				<span>
					<i className="is-dashed" style={{ background: materials.route.held }} />
					{t("traffic.strata.legendHeld")}
				</span>
				<span>
					<i className="is-dashed" style={{ background: materials.route.queued }} />
					{t("traffic.strata.legendQueued")}
				</span>
				<span>
					<i className="is-broken" style={{ background: materials.route.failed }} />
					{t("traffic.strata.legendFailed")}
				</span>
			</div>

			<div className="strata-camera" data-strata-reserved>
				<span className="strata-camera-hint">{t("traffic.strata.cameraHint")}</span>
				<button
					type="button"
					onClick={() => {
						homeCamera(cameraRef.current, bounds, stageAspect());
						setFollow(false);
						lastManual.current = performance.now();
					}}
					aria-label={t("traffic.strata.home")}
					title={t("traffic.strata.home")}
				>
					<TrafficIcon name="fit" />
				</button>
				<button
					type="button"
					onClick={() => {
						zoomBy(cameraRef.current, 1.25);
						setFollow(false);
						lastManual.current = performance.now();
					}}
					aria-label={t("traffic.strata.zoomOut")}
					title={t("traffic.strata.zoomOut")}
				>
					<TrafficIcon name="minus" />
				</button>
				<button
					type="button"
					onClick={() => {
						zoomBy(cameraRef.current, 0.8);
						setFollow(false);
						lastManual.current = performance.now();
					}}
					aria-label={t("traffic.strata.zoomIn")}
					title={t("traffic.strata.zoomIn")}
				>
					<TrafficIcon name="plus" />
				</button>
				<button
					type="button"
					aria-pressed={follow}
					className={follow ? "is-active" : ""}
					onClick={() => {
						const next = !follow;
						setFollow(next);
						if (next) lastManual.current = 0;
						else lastManual.current = performance.now();
					}}
					data-testid="strata-follow"
				>
					<TrafficIcon name="follow" />
					{t("traffic.nodes.follow")}
				</button>
			</div>

			{!ready && <div className="strata-loading">{t("traffic.loading")}</div>}
		</div>
	);
}

/** A coarse span in whole minutes or hours — never a fabricated precision. */
function formatSpan(ms: number, t: ReturnType<typeof useT>): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	if (minutes < 60) return t.plural("traffic.strata.spanMinutes", minutes);
	return t.plural("traffic.strata.spanHours", Math.round(minutes / 60));
}
