import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useStatusColors } from "../../hooks/useStatusColors";
import { useResolvedTheme } from "../../hooks/useResolvedTheme";
import { useReducedMotion } from "../../utils/useReducedMotion";
import {
	MeshBuilder,
	OrbitGL,
	V,
	bezier,
	curvePoint,
	type Vec3,
	type OrbitMesh,
} from "./orbit-engine";
import {
	fromKey,
	toKey,
	nodeSeq,
	positionSeed,
	routeKey,
	type TrafficNode,
	type TrafficRecord,
} from "./traffic-model";

interface Props {
	projects?: { id: string; name: string }[];
	scope?: string;
	nodes: TrafficNode[];
	records: TrafficRecord[];
	selected: string | null;
	onSelect: (key: string) => void;
	paused: boolean;
	ready: boolean;
}
interface Camera {
	yaw: number;
	pitch: number;
	distance: number;
	target: Vec3;
}
interface SceneNode {
	node: TrafficNode;
	point: Vec3;
	radius: number;
	mesh: OrbitMesh;
	label: HTMLButtonElement;
}
interface Route {
	points: Vec3[];
	record: TrafficRecord;
}

export default function TrafficOrbit(props: Props) {
	const t = useT();
	const canvas = useRef<HTMLCanvasElement>(null);
	const labels = useRef<HTMLDivElement>(null);
	const controls = useRef<{
		zoom: (scale: number) => void;
		home: () => void;
	} | null>(null);
	const latest = useRef(props);
	latest.current = props;
	const [failed, setFailed] = useState(false);
	const colors = useStatusColors();
	const theme = useResolvedTheme();
	const reduced = useReducedMotion();
	const motion = useRef({ paused: props.paused, reduced });
	motion.current = { paused: props.paused, reduced };
	const updateScene = useRef<() => void>(() => {});
	const fittedScope = useRef<string | null>(null);
	const savedCamera = useRef<Camera>({
		yaw: -0.16,
		pitch: 0.52,
		distance: 116,
		target: [0, 0, 0],
	});
	useEffect(() => {
		if (!canvas.current || !labels.current) return;
		const el = canvas.current,
			layer = labels.current;
		const css = getComputedStyle(el);
		const token = (name: string): Vec3 =>
			css
				.getPropertyValue(`--${name}`)
				.trim()
				.split(/\s+/)
				.map(Number)
				.map((value) => value / 255) as Vec3;
		const hex = (value: string): Vec3 =>
			[1, 3, 5].map(
				(start) => parseInt(value.slice(start, start + 2), 16) / 255,
			) as Vec3;
		let gl: OrbitGL;
		try {
			gl = new OrbitGL(el, token("surface-base"));
		} catch {
			setFailed(true);
			return;
		}
		setFailed(false);
		const agent = token("agent"),
			accent = token("accent"),
			border = token("border-active"),
			success = token("success");
		const warning = token("warning"),
			danger = token("danger");
		let nodes: SceneNode[] = [],
			meshes: OrbitMesh[] = [],
			routes = new Map<string, Route>();
		let labelPriority = new Map<string, number>();
		let projectLabels: { point: Vec3; label: HTMLDivElement }[] = [];
		let homeDistance = 116;
		let homeTarget: Vec3 = [0, 0, 0];
		let seen: Set<string> | null = null;
		const arrivalProjects = new Map<string, number>();
		let flights: { route: Route; started: number }[] = [];
		let dirty = true,
			alive = true,
			raf = 0;
		const camera: Camera = {
			...savedCamera.current,
			target: [...savedCamera.current.target],
		};
		const goal: Camera = { ...camera, target: [...camera.target] };
		const keys = new Set<string>();
		const region = el.closest(".traffic-orbit")!;
		let pointerInside = false;
		let hovered: string | null = null;
		const navigationKey = (event: KeyboardEvent) =>
			/^Key[WASD]$/.test(event.code)
				? event.code.slice(3).toLowerCase()
				: event.key.toLowerCase();
		const sig = new AbortController();
		window.addEventListener(
			"rpc:agentMessageLogChanged",
			(event) => {
				arrivalProjects.set(
					(event as CustomEvent<{ projectId: string }>).detail.projectId,
					Date.now(),
				);
			},
			{ signal: sig.signal },
		);
		function clear() {
			meshes.forEach((mesh) => gl.dispose(mesh));
			meshes = [];
			nodes = [];
			projectLabels = [];
			layer.replaceChildren();
		}
		function mesh(builder: MeshBuilder) {
			const result = gl.mesh(builder);
			meshes.push(result);
			return result;
		}
		function rebuild() {
			if (!alive) return;
			const { nodes: input, records, selected, ready } = latest.current;
			clear();
			routes = new Map();
			labelPriority = new Map();
			for (const [index, record] of [...records]
				.sort((a, b) => Date.parse(b.row.at) - Date.parse(a.row.at))
				.entries()) {
				for (const key of [fromKey(record.row), toKey(record.row)]) {
					if (key && !labelPriority.has(key))
						labelPriority.set(key, 1000 + records.length - index);
				}
			}
			const scope = latest.current.scope ?? "all";
			const all = scope === "all";
			const projects = [
				...new Set([
					...input.map((node) => node.projectId),
					...(all ? [] : [scope]),
				]),
			].sort(
				(a, b) =>
					Number(b === scope) - Number(a === scope) || a.localeCompare(b),
			);
			const trafficWeight = (id: string) =>
				records.reduce(
					(count, record) =>
						count +
						Number(
							record.row.toProjectId === id || record.row.fromProjectId === id,
						),
					0,
				);
			const primary = all
				? [...projects].sort(
						(a, b) => trafficWeight(b) - trafficWeight(a) || a.localeCompare(b),
					)[0]
				: scope;
			const ordered = [
				primary,
				...projects.filter((id) => id !== primary),
			].filter((id): id is string => !!id);
			const layouts = ordered.map((id, index) => {
				const scale = index === 0 ? 1 : 0.65;
				const side = index % 2 ? -1 : 1;
				const row = Math.floor((index - 1) / 2);
				const center: Vec3 =
					index === 0
						? [0, 0, 0]
						: [side * (84 + (row % 2) * 18), -4 - row * 2, -56 - row * 72];
				return { id, scale, center };
			});
			homeTarget = [0, 4, -8];
			homeDistance = 125;
			if (ready && fittedScope.current !== scope) {
				fittedScope.current = scope;
				camera.target = [...homeTarget];
				Object.assign(camera, {
					yaw: -0.16,
					pitch: 0.52,
					distance: homeDistance,
				});
				Object.assign(goal, camera, { target: [...homeTarget] });
			}
			const points = new Map<string, Vec3>();
			const ring = new MeshBuilder();
			const ringColor = theme === "light" ? token("text-tertiary") : border;
			for (const { id: projectId, center, scale } of layouts) {
				ring.torus(
					...center,
					43 * scale,
					theme === "light" ? 0.07 : 0.03,
					ringColor,
					0.4,
				);
				ring.torus(
					center[0],
					-0.12,
					center[2],
					42 * scale,
					theme === "light" ? 0.04 : 0.014,
					agent,
					0.3,
				);
				const project = latest.current.projects?.find(
					(project) => project.id === projectId,
				);
				if (project) {
					const label = document.createElement("div");
					label.className = "traffic-project-label streamer-private";

					label.style.pointerEvents = "none";
					label.hidden = true;
					const title = document.createElement("strong");
					title.textContent = project.name;
					label.append(title);
					layer.append(label);
					projectLabels.push({
						label,
						point: V.add(center, [0, 0, 46 * scale]),
					});
				}
				for (let i = 0; i < 64; i++) {
					const a = (i / 64) * Math.PI * 2;
					ring.beam(
						[
							center[0] + Math.cos(a) * (i % 4 ? 42.5 : 41.8) * scale,
							0,
							center[2] + Math.sin(a) * (i % 4 ? 42.5 : 41.8) * scale,
						],
						[
							center[0] + Math.cos(a) * 43 * scale,
							0,
							center[2] + Math.sin(a) * 43 * scale,
						],
						0.018,
						border,
						0.4,
					);
				}
				for (const node of input.filter(
					(node) => node.projectId === projectId,
				)) {
					const seed = positionSeed(node.key),
						coordinator = node.task?.taskType === "coordinator";
					const angle = ((seed % 65536) / 65536) * Math.PI * 2;
					const radius = coordinator
						? 4 + (seed % 400) / 100
						: 13 + ((seed >>> 16) % 2400) / 100;
					const point: Vec3 = V.add(center, [
						Math.cos(angle) * radius * scale,
						(coordinator ? 10 : 3 + (seed % 11) * 0.75) * scale,
						Math.sin(angle) * radius * scale,
					]);
					points.set(node.key, point);
					ring.beam([point[0], center[1], point[2]], point, 0.025, border, 0.2);
					ring.torus(
						point[0],
						center[1],
						point[2],
						coordinator ? 4 : 1.7,
						0.035,
						agent,
						0.45,
					);
					const size =
						Math.max(0.85, scale) *
						(coordinator ? 3.3 : node.task?.status === "todo" ? 1.1 : 1.8);
					const body = new MeshBuilder();
					body.sphere(
						0,
						0,
						0,
						size,
						node.task && colors[node.task.status]
							? hex(colors[node.task.status])
							: border,
						24,
						16,
					);
					if (coordinator)
						for (let k = 0; k < 10; k++)
							body.torus(
								0,
								0,
								0,
								size * 1.6,
								0.035,
								success,
								0.6,
								"xz",
								0.35,
								(k * Math.PI) / 5,
							);
					if (node.key === selected)
						body.torus(0, 0, 0, size * 2, 0.06, accent, 0.8);
					const label = document.createElement("button");
					label.hidden = true;
					label.tabIndex = -1;
					label.type = "button";
					label.className = `traffic-node-label ${coordinator ? "is-coordinator" : ""} ${node.key === selected ? "is-selected" : ""}`;
					const seq = document.createElement("b");
					seq.textContent = nodeSeq(node);
					label.append(seq);
					const title = document.createElement("span");
					title.className = "streamer-private";
					title.textContent = node.title || t("traffic.orbit.historical");
					label.append(title);
					if (coordinator) {
						const role = document.createElement("small");
						role.textContent = t("traffic.orbit.coordinator");
						label.append(role);
					}
					label.onclick = () => latest.current.onSelect(node.key);
					label.onpointerenter = () => {
						hovered = node.key;
						dirty = true;
					};
					label.onpointerleave = () => {
						hovered = null;
						dirty = true;
					};
					layer.append(label);
					nodes.push({ node, point, radius: size, mesh: mesh(body), label });
				}
			}
			mesh(ring);
			const wires = new MeshBuilder();
			const pairs = new Set<string>();
			const directions = new Set<string>();
			for (const record of records) {
				const from = fromKey(record.row),
					to = toKey(record.row);
				const a = from ? points.get(from) : undefined,
					b = points.get(to);
				if (!a || !b) continue;
				const path =
					from === to
						? Array.from(
								{ length: 49 },
								(_, i): Vec3 =>
									V.add(a, [
										Math.sin((i / 48) * Math.PI * 2) * 4,
										Math.sin((i / 48) * Math.PI) * 6,
										(1 - Math.cos((i / 48) * Math.PI * 2)) * 4,
									]),
							)
						: bezier(a, b, 7);
				routes.set(record.key, { points: path, record });
				const pair = routeKey(record.row);
				const active = selected === from || selected === to;
				const color = active ? accent : agent;
				if (!pairs.has(pair)) {
					pairs.add(pair);
					wires.path(
						path,
						theme === "light" ? (active ? 0.11 : 0.07) : active ? 0.065 : 0.025,
						color,
						active ? 0.7 : 0.35,
						record.row.status !== "delivered",
					);
				}
				const direction = JSON.stringify([from, to]);
				if (!directions.has(direction)) {
					directions.add(direction);
					const tip = curvePoint(path, 0.72);
					const tangent = V.norm(V.sub(tip, curvePoint(path, 0.68)));
					const side = V.mul(V.norm(V.cross(tangent, [0, 1, 0])), 0.65);
					const base = V.sub(tip, V.mul(tangent, 1.5));
					wires.beam(V.add(base, side), tip, active ? 0.09 : 0.065, color, 0.7);
					wires.beam(V.sub(base, side), tip, active ? 0.09 : 0.065, color, 0.7);
				}
			}
			mesh(wires);
			flights = flights.flatMap((flight) => {
				const route = routes.get(flight.route.record.key);
				return route ? [{ ...flight, route }] : [];
			});
			if (ready) {
				const now = Date.now();
				for (const [projectId, arrived] of arrivalProjects)
					if (now - arrived > 15000) arrivalProjects.delete(projectId);
				const receivedProjects = new Set<string>();
				if (
					seen &&
					!motion.current.paused &&
					!motion.current.reduced &&
					!document.hidden
				) {
					for (const record of records)
						if (
							!seen.has(record.key) &&
							arrivalProjects.has(record.row.toProjectId) &&
							Date.now() - Date.parse(record.row.at) < 15000
						) {
							const route = routes.get(record.key);
							if (route) flights.push({ route, started: performance.now() });
							receivedProjects.add(record.row.toProjectId);
						}
				}
				for (const projectId of receivedProjects)
					arrivalProjects.delete(projectId);
				seen ??= new Set();
				for (const record of records) seen.add(record.key);
			}
			dirty = true;
		}
		updateScene.current = rebuild;
		const zoom = (scale: number) => {
			goal.distance = Math.min(380, Math.max(35, goal.distance * scale));
			dirty = true;
		};
		controls.current = {
			zoom,
			home: () => {
				camera.target = [...homeTarget];
				Object.assign(goal, {
					yaw: -0.16,
					pitch: 0.52,
					distance: homeDistance,
					target: [...homeTarget],
				});
				dirty = true;
			},
		};
		let drag: {
			x: number;
			y: number;
			moved: boolean;
			startX: number;
			startY: number;
		} | null = null;
		const hitAt = (event: PointerEvent) => {
			const bounds = el.getBoundingClientRect();
			return nodes
				.map((node) => ({ node, p: gl.project(node.point) }))
				.filter(
					({ node, p }) =>
						p.visible &&
						Math.hypot(
							p.x - event.clientX + bounds.left,
							p.y - event.clientY + bounds.top,
						) < Math.max(14, (node.radius * gl.h) / p.depth),
				)
				.sort((a, b) => a.p.depth - b.p.depth)[0]?.node;
		};
		region.addEventListener(
			"pointerenter",
			() => {
				pointerInside = true;
			},
			{ signal: sig.signal },
		);
		region.addEventListener(
			"pointerleave",
			() => {
				pointerInside = false;
				hovered = null;
				keys.clear();
				dirty = true;
			},
			{ signal: sig.signal },
		);
		el.addEventListener(
			"pointerdown",
			(event) => {
				el.focus();
				el.setPointerCapture(event.pointerId);
				drag = {
					x: event.clientX,
					y: event.clientY,
					startX: event.clientX,
					startY: event.clientY,
					moved: false,
				};
			},
			{ signal: sig.signal },
		);
		el.addEventListener(
			"pointermove",
			(event) => {
				if (!drag) {
					const next = hitAt(event)?.node.key ?? null;
					if (hovered !== next) {
						hovered = next;
						dirty = true;
					}
					el.style.cursor = next ? "pointer" : "grab";
					return;
				}
				drag.moved ||=
					Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >
					5;
				goal.yaw -= (event.clientX - drag.x) * 0.005;
				goal.pitch = Math.max(
					0.15,
					Math.min(1.48, goal.pitch + (event.clientY - drag.y) * 0.005),
				);
				drag.x = event.clientX;
				drag.y = event.clientY;
				dirty = true;
			},
			{ signal: sig.signal },
		);
		el.addEventListener(
			"pointerup",
			(event) => {
				if (drag && !drag.moved) {
					const hit = hitAt(event);
					if (hit) latest.current.onSelect(hit.node.key);
				}
				drag = null;
			},
			{ signal: sig.signal },
		);
		el.addEventListener(
			"pointercancel",
			() => {
				drag = null;
			},
			{ signal: sig.signal },
		);
		el.addEventListener(
			"wheel",
			(event) => {
				event.preventDefault();
				zoom(Math.exp(event.deltaY * 0.001));
			},
			{ passive: false, signal: sig.signal },
		);
		window.addEventListener(
			"keydown",
			(event) => {
				if (
					(pointerInside || region.contains(document.activeElement)) &&
					!(
						event.target instanceof Element &&
						event.target.closest(
							'input, textarea, select, [contenteditable="true"], [role="combobox"]',
						)
					) &&
					["w", "a", "s", "d"].includes(navigationKey(event)) &&
					!event.metaKey &&
					!event.ctrlKey
				) {
					keys.add(navigationKey(event));
					event.preventDefault();
					dirty = true;
				}
			},
			{ signal: sig.signal },
		);
		window.addEventListener(
			"keyup",
			(event) => keys.delete(navigationKey(event)),
			{ signal: sig.signal },
		);
		window.addEventListener("blur", () => keys.clear(), { signal: sig.signal });
		el.addEventListener(
			"webglcontextlost",
			(event) => {
				event.preventDefault();
				setFailed(true);
				alive = false;
				layer.replaceChildren();
				controls.current = null;
				el.dataset.activeFlights = "0";
			},
			{ signal: sig.signal },
		);
		const observer = new ResizeObserver(() => {
			gl.resize();
			dirty = true;
		});
		observer.observe(el);
		gl.resize();
		const stars: number[] = [];
		for (let i = 0; i < 220; i++) {
			const seed = positionSeed(String(i));
			stars.push(
				(seed % 500) - 250,
				((seed >>> 8) % 220) - 80,
				((seed >>> 16) % 500) - 250,
				...border,
				0.25,
			);
		}
		let previousFrame = 0;
		function frame(now: number) {
			if (!alive) return;
			raf = requestAnimationFrame(frame);
			const elapsed = Math.min((now - (previousFrame || now)) / 1000, 0.05);
			previousFrame = now;
			const hadFlights = flights.length > 0;
			if (document.hidden) {
				flights = [];
				dirty ||= hadFlights;
				el.dataset.activeFlights = "0";
				return;
			}
			if (motion.current.paused || motion.current.reduced) flights = [];
			flights = flights.filter((flight) => now - flight.started < 3500);
			dirty ||= hadFlights && !flights.length;
			const moving =
				Math.abs(goal.yaw - camera.yaw) +
					Math.abs(goal.pitch - camera.pitch) +
					Math.abs(goal.distance - camera.distance) >
				0.005;
			if (!dirty && !moving && !flights.length && !keys.size) return;
			dirty = false;
			const pan = camera.distance * 0.36 * elapsed;
			const horizontal = Number(keys.has("d")) - Number(keys.has("a"));
			const vertical = Number(keys.has("s")) - Number(keys.has("w"));
			camera.target[0] +=
				(horizontal * Math.cos(camera.yaw) + vertical * Math.sin(camera.yaw)) *
				pan;
			camera.target[2] +=
				(vertical * Math.cos(camera.yaw) - horizontal * Math.sin(camera.yaw)) *
				pan;
			for (const key of ["yaw", "pitch", "distance"] as const)
				camera[key] +=
					(goal[key] - camera[key]) * (motion.current.reduced ? 1 : 0.18);
			const eye = V.add(camera.target, [
				Math.sin(camera.yaw) * Math.cos(camera.pitch) * camera.distance,
				Math.sin(camera.pitch) * camera.distance,
				Math.cos(camera.yaw) * Math.cos(camera.pitch) * camera.distance,
			]);
			el.dataset.cameraTarget = camera.target
				.map((value) => value.toFixed(3))
				.join(",");
			gl.begin(eye, camera.target);
			gl.particles(stars);
			const nodeMeshes = new Set(nodes.map((node) => node.mesh));
			meshes
				.filter((mesh) => !nodeMeshes.has(mesh))
				.forEach((mesh) => gl.draw(mesh));
			const occupied: { x: number; y: number }[] = [];
			for (const { label, point } of projectLabels) {
				const p = gl.project(point),
					x = p.x - 85,
					y = p.y;
				const show =
					p.visible && x > 5 && x < gl.w - 175 && y > 52 && y < gl.h - 60;
				label.hidden = !show;
				if (show) {
					label.style.transform = `translate(${x}px,${y}px)`;
				}
			}
			for (const item of [...nodes].sort(
				(a, b) =>
					Number(b.node.key === hovered) - Number(a.node.key === hovered) ||
					Number(b.node.key === latest.current.selected) -
						Number(a.node.key === latest.current.selected) ||
					Number(b.node.task?.taskType === "coordinator") -
						Number(a.node.task?.taskType === "coordinator") ||
					(labelPriority.get(b.node.key) ?? 0) -
						(labelPriority.get(a.node.key) ?? 0),
			)) {
				gl.draw(item.mesh, { offset: item.point });
				const p = gl.project(item.point),
					x = p.x - 95,
					y = p.y + 18;
				const relevant =
					item.node.key === hovered ||
					item.node.task?.status !== "todo" ||
					item.node.key === latest.current.selected ||
					item.node.task.taskType === "coordinator" ||
					labelPriority.has(item.node.key) ||
					nodes.length < 8;
				const show =
					relevant &&
					p.visible &&
					x > 5 &&
					x < gl.w - 195 &&
					y > 52 &&
					y < gl.h - 85 &&
					(item.node.key === hovered ||
						!occupied.some(
							(rect) => Math.abs(rect.x - x) < 200 && Math.abs(rect.y - y) < 58,
						));
				item.label.classList.toggle("is-hovered", item.node.key === hovered);
				item.label.hidden = !show;
				item.label.tabIndex = show ? 0 : -1;
				if (show) {
					item.label.style.transform = `translate(${x}px,${y}px)`;
					occupied.push({ x, y });
				}
			}
			const particles: number[] = [];
			for (const flight of flights) {
				const progress = (now - flight.started) / 3500;
				const status = flight.route.record.row.status;
				if (status === "delivered") {
					particles.push(
						...curvePoint(flight.route.points, progress),
						...agent,
						2.3,
					);
				} else {
					const source = V.add(flight.route.points[0], [0, 3.8, 0]);
					const color =
						status === "not-delivered"
							? danger
							: status === "unconfirmed"
								? warning
								: agent;
					const pulse =
						Math.sin(progress * Math.PI) *
						(0.65 + 0.35 * Math.cos(progress * Math.PI * 6));
					particles.push(...source, ...V.mul(color, pulse), 5);
				}
			}
			el.dataset.activeFlights = String(flights.length);
			gl.particles(particles);
		}
		rebuild();
		raf = requestAnimationFrame(frame);
		return () => {
			savedCamera.current = { ...camera, target: [...camera.target] };
			alive = false;
			cancelAnimationFrame(raf);
			sig.abort();
			observer.disconnect();
			clear();
			gl.destroy();
			updateScene.current = () => {};
			controls.current = null;
		};
	}, [theme, colors, t]);
	useEffect(
		() => updateScene.current(),
		[
			props.nodes,
			props.records,
			props.selected,
			props.ready,
			props.projects,
			props.scope,
		],
	);
	return (
		<section className="traffic-orbit" aria-label={t("traffic.orbit.map")}>
			<canvas
				ref={canvas}
				tabIndex={0}
				aria-label={t("traffic.orbit.mapHelp")}
			/>
			<div ref={labels} className="traffic-node-labels" />
			<div className="traffic-map-caption">
				<strong>{t("traffic.orbit.map")}</strong>
				<span>{t("traffic.orbit.edgesHelp")}</span>
			</div>
			{failed && (
				<p className="traffic-map-error" role="status">
					{t("traffic.orbit.webglError")}
				</p>
			)}
			<div className="traffic-map-footer">
				<span>{t("traffic.orbit.mapHelp")}</span>
				<div className="traffic-camera-controls">
					<button
						disabled={failed}
						onClick={() => controls.current?.home()}
						aria-label={t("traffic.orbit.resetCamera")}
						title={t("traffic.orbit.resetCamera")}
					>
						⌂
					</button>
					<button
						disabled={failed}
						onClick={() => controls.current?.zoom(1.2)}
						aria-label={t("traffic.orbit.zoomOut")}
					>
						−
					</button>
					<button
						disabled={failed}
						onClick={() => controls.current?.zoom(0.8)}
						aria-label={t("traffic.orbit.zoomIn")}
					>
						+
					</button>
				</div>
			</div>
		</section>
	);
}
