/**
 * The geometry: substrate, district platforms, one machine per card, and the
 * route beams between them.
 *
 * Ported shape-for-shape from the STRATA reference so the stage looks like the
 * thing it was designed as — hex decks in three poured layers, a coordinator
 * mast, a reviewer gantry, a worker shed with ribs and shelves. What changed is
 * every colour: the reference hardcoded a dark palette, and here each material
 * arrives from the app's design tokens so light theme is a real theme rather
 * than a dark scene on a pale page.
 *
 * Pure geometry — no WebGL calls, no React, no DOM. `MeshBuilder` output goes to
 * `StrataGL.mesh` by the caller, which is what lets a scene be built in a test.
 */

import type { TaskStatus } from "../../../../shared/types";
import { MeshBuilder } from "./strata-mesh";
import { noise, V, type Vec3 } from "./strata-math";
import type {
	StrataDistrict,
	StrataMachine,
	StrataRoute,
	StrataRouteKind,
} from "./strata-model";

/**
 * Every non-status colour the scene draws with.
 *
 * Named by what they are structurally, not by hue, so a light theme can invert
 * the lot without a single call site changing: `deckTop` is always the surface a
 * machine stands on, whatever colour that surface is in the current theme.
 */
export interface StrataMaterials {
	gridMinor: string;
	gridMajor: string;
	substrateFleck: string;
	substrateRing: string;
	deckSkirt: string;
	deckRim: string;
	deckShadow: string;
	deckBody: string;
	deckTop: string;
	deckInlay: string;
	deckRail: string;
	deckFoot: string;
	/** Machine body, when the card is live. */
	shell: string;
	/** Machine body, when the card is finished. */
	shellDone: string;
	/** Machine body, when the card is quiet (hibernated, unstarted, unknown). */
	shellQuiet: string;
	panelDark: string;
	panelBlack: string;
	glass: string;
	mastPipe: string;
	/** Route colours by kind. */
	route: Record<StrataRouteKind, string>;
	/** A route dimmed because it is outside the current selection. */
	routeMuted: string;
	/** The stop plate and ring drawn along a held route. */
	holdPlate: string;
	holdRing: string;
	/** Neutral ink for a card whose recorded status is NOT KNOWN. */
	unknown: string;
}

/** How a machine is drawn: colour source, and whether it reads as dormant. */
export interface MachineLook {
	/** Status colour, or the neutral unknown ink. Never a substituted live status. */
	accent: string;
	quiet: boolean;
	done: boolean;
}

/**
 * A card's look at the cursor.
 *
 * `status === null` is the load-bearing case: it renders with the neutral ink and
 * as quiet, because a coloured machine reads as a known state. Substituting the
 * live status here is exactly what `task-history.ts` forbids.
 */
export function machineLook(
	machine: StrataMachine,
	statusColor: (status: TaskStatus) => string,
	materials: StrataMaterials,
): MachineLook {
	if (machine.status === null) {
		return { accent: materials.unknown, quiet: true, done: false };
	}
	const done = machine.status === "completed" || machine.status === "cancelled";
	const quiet = machine.hibernated || machine.status === "todo";
	return { accent: statusColor(machine.status), quiet: quiet || done, done };
}

/**
 * The substrate: a wide etched grid, scattered plates and three partial rings.
 *
 * A quiet floor rather than a starfield — it gives the eye a horizon to judge
 * the decks against, and its faint arcs are what make an orbit feel like an
 * orbit instead of a spin.
 */
export function buildSubstrate(
	materials: StrataMaterials,
	extent: number,
): { base: MeshBuilder; detail: MeshBuilder } {
	const base = new MeshBuilder();
	const detail = new MeshBuilder();
	const reach = Math.max(100, Math.ceil(extent * 1.7));
	for (let i = -reach; i <= reach; i += 5) {
		const color = i % 20 === 0 ? materials.gridMajor : materials.gridMinor;
		base.beam([i, -5, -reach], [i, -5, reach], 0.021, color, 0.2);
		base.beam([-reach, -5, i], [reach, -5, i], 0.021, color, 0.2);
	}
	for (let i = 0; i < 130; i++) {
		const x = (noise(i * 3) - 0.5) * reach * 2;
		const z = (noise(i * 3 + 1) - 0.5) * reach * 1.8;
		if (Math.abs(x) < 35 && Math.abs(z) < 30) continue;
		detail.box(x, -4.98, z, 0.1, 0.015, 0.1, materials.substrateFleck, 0.5);
	}
	const ring = Math.max(48, extent * 0.92);
	base.torus(0, -4.93, 0, ring, 0.029, materials.substrateRing, 0.4, "xz", Math.PI * 1.6, 0.2);
	base.torus(0, -4.93, 0, ring * 1.04, 0.018, materials.gridMajor, 0.3, "xz", Math.PI * 1.4, 0.3);
	base.torus(0, -4.93, 0, ring * 1.42, 0.021, materials.substrateRing, 0.4);
	return { base, detail };
}

/**
 * One district platform: seven poured hex layers, etched deck joints, six edge
 * rails with the district's own hue, and three event strata hanging below.
 *
 * The strata rings sit *under* the deck deliberately: history accumulates
 * beneath the work rather than moving a card around, which is the one idea the
 * whole stage is named after.
 */
export function buildDistrict(
	district: StrataDistrict,
	materials: StrataMaterials,
	target: { base: MeshBuilder; detail: MeshBuilder; ghost: MeshBuilder },
): void {
	const [x, y, z] = district.center;
	const r = district.radius;
	const hue = district.color;
	const { base: b, detail, ghost } = target;
	const hex = Math.PI / 6;
	b.cyl(x, y - 1.9, z, r * 0.93, 0.3, materials.deckShadow, 6, r * 0.99, 0, hex);
	b.cyl(x, y - 1.55, z, r * 1.01, 0.33, materials.deckRim, 6, r * 1.035, 0, hex);
	b.cyl(x, y - 1.15, z, r * 1.04, 0.24, materials.deckSkirt, 6, r * 1.04, 0, hex);
	b.cyl(x, y - 0.89, z, r * 1.037, 0.055, hue, 6, r * 1.036, 0.48, hex);
	b.cyl(x, y - 0.82, z, r * 1.037, 0.57, materials.deckRail, 6, r, 0, hex);
	b.cyl(x, y - 0.24, z, r, 0.55, materials.deckBody, 6, r * 0.985, 0, hex);
	b.cyl(x, y + 0.315, z, r * 0.91, 0.07, materials.deckTop, 6, r * 0.91, 0, hex);
	// Etched deck joints and recessed service lanes.
	for (let k = -3; k <= 3; k++) {
		const half = Math.sqrt(Math.max(0, r * r - k * k * 9)) * 0.75;
		detail.beam(
			[x - half, y + 0.4, z + k * 2.8],
			[x + half, y + 0.4, z + k * 2.8],
			0.025,
			materials.deckInlay,
			0.1,
		);
	}
	for (let k = 0; k < 6; k++) {
		const a = (k * Math.PI) / 3 + hex;
		const xx = x + Math.cos(a) * r * 0.88;
		const zz = z + Math.sin(a) * r * 0.88;
		detail.box(xx, y + 0.35, zz, 1.7, 0.15, 0.65, materials.deckFoot, 0, -a);
		detail.box(xx, y + 0.51, zz, 1.22, 0.04, 0.11, hue, 0.8, -a);
		const a2 = a + 0.07;
		detail.box(
			x + Math.cos(a2) * r * 0.97,
			y - 1.1,
			z + Math.sin(a2) * r * 0.97,
			0.22, 0.2, 1.3,
			materials.deckShadow, 0, -a,
		);
		for (let j = 0; j < 4; j++) {
			detail.box(
				x + Math.cos(a) * r * 0.997 + Math.sin(a) * (0.18 * j - 0.3),
				y - 0.61,
				z + Math.sin(a) * r * 0.997 - Math.cos(a) * (0.18 * j - 0.3),
				0.07, 0.06, 0.3,
				hue, 0.7, -a,
			);
		}
	}
	// Layered event strata stay below the work, rather than moving the card around.
	for (let k = 0; k < 3; k++) {
		ghost.torus(
			x, y - 2.3 - k * 0.44, z,
			r * (0.7 + k * 0.05), 0.035,
			hue, 0.5, "xz",
			Math.PI * (1.15 + k * 0.17), k * 0.7,
		);
	}
}

/**
 * One machine.
 *
 * Three silhouettes by recorded `taskType`: a coordinator mast with a dish, a
 * reviewer gantry, a worker shed. The role is a fact off the task, so the shape
 * carries information rather than decoration — and none of the three implies
 * ownership of another (§5.9).
 *
 * `far` is the distant level of detail: five boxes instead of forty, swapped in
 * when the camera is pulled back far enough that the detail is sub-pixel.
 */
export function buildMachine(
	machine: StrataMachine,
	look: MachineLook,
	materials: StrataMaterials,
	far: boolean,
): MeshBuilder {
	const b = new MeshBuilder();
	const c = look.accent;
	const quiet = look.quiet;
	const shell = quiet
		? materials.shellQuiet
		: look.done
			? materials.shellDone
			: materials.shell;
	const dark = materials.panelDark;
	const black = materials.panelBlack;
	const hex = Math.PI / 6;

	if (far) {
		b.cyl(0, 0, 0, 1.8, 0.3, dark, 6);
		b.box(0, 0.3, 0, 1.35, 2.5, 1.3, shell);
		b.box(0, 2.81, 0, 1.25, 0.08, 1.2, c, 0.7);
		b.box(0.8, 0.3, 0.3, 0.4, 1.5, 0.8, dark);
		if (machine.role === "coordinator") b.torus(0, 3.4, 0, 0.9, 0.1, c, 0.7, "xy");
		return b;
	}

	// The pad, and the status halo around it. A broken arc is the recorded
	// "nothing was delivered here" verdict, not a decorative variant.
	b.cyl(0, 0, 0, 2.1, 0.12, materials.deckSkirt, 6, 2.1, 0, hex);
	b.cyl(0, 0.13, 0, 1.91, 0.16, quiet ? materials.deckRail : materials.deckFoot, 6, 1.85, 0, hex);
	b.cyl(0, 0.31, 0, 1.67, 0.08, materials.deckShadow, 6, 1.67, 0, hex);
	b.torus(
		0, 0.42, 0, 1.55, 0.045, c, quiet ? 0.12 : 0.8, "xz",
		machine.undelivered ? Math.PI * 1.45 : Math.PI * 1.92,
		0.3,
	);
	for (let k = 0; k < 3; k++) {
		const a = ((k * Math.PI * 2) / 3) + 0.5;
		b.box(Math.cos(a) * 1.9, 0.38, Math.sin(a) * 1.9, 0.22, 0.07, 0.55, c, quiet ? 0.1 : 0.65, -a);
	}

	if (machine.role === "coordinator") {
		b.cyl(0, 0.4, 0, 0.95, 0.32, dark, 6);
		b.cyl(0, 0.74, 0, 0.64, 2.65, shell, 6, 0.45);
		b.cyl(0, 1.3, 0, 0.74, 0.14, black, 6);
		b.cyl(0, 2.13, 0, 0.66, 0.11, c, 6, 0.66, 0.7);
		b.torus(0, 3.9, 0, 1.23, 0.12, shell, 0, "xy", Math.PI * 1.7, 0.22);
		b.torus(0, 3.9, 0, 1.08, 0.034, c, 0.9, "xy", Math.PI * 1.6, 0.2);
		b.box(-1.08, 0.55, 0, 0.22, 2.8, 0.5, dark);
		b.box(1.08, 0.55, 0, 0.22, 2.8, 0.5, dark);
		b.cyl(0, 3.6, 0, 0.18, 1.3, c, 8, 0.08, 0.7);
		b.box(0, 0.69, 1.2, 1.3, 0.34, 0.65, shell);
		b.box(0, 1.05, 1.21, 1.02, 0.02, 0.36, materials.glass, 0.5);
	} else if (machine.role === "reviewer") {
		b.box(-0.94, 0.44, 0, 0.43, 2.55, 0.64, shell);
		b.box(0.94, 0.44, 0, 0.43, 2.55, 0.64, shell);
		b.box(0, 2.99, 0, 2.38, 0.28, 0.75, shell);
		b.box(0, 3.285, 0, 1.65, 0.06, 0.25, c, 0.8);
		b.box(0, 0.47, 0, 1.07, 1.27, 1.08, dark);
		b.cyl(0, 1.75, 0, 0.73, 0.16, shell, 6);
		b.torus(0, 2.15, 0, 0.65, 0.03, c, 0.8);
		for (let j = 0; j < 3; j++) b.box(0, 0.73 + j * 0.29, 0.551, 0.74, 0.04, 0.04, c, 0.55);
	} else {
		// Height varies by seq so a deck of workers is not a row of identical boxes.
		// Deterministic, so it never changes under the user.
		const h = quiet ? 1.45 : 2.35 + ((machine.node.seq ?? 0) % 3) * 0.22;
		b.box(-0.37, 0.45, -0.21, 1.34, h, 1.33, shell);
		b.box(0.49, 0.45, 0.52, 0.69, h * 0.73, 1.15, quiet ? materials.deckRail : materials.mastPipe);
		b.box(-0.37, h + 0.46, -0.21, 1.48, 0.16, 1.44, dark);
		b.box(-0.37, h + 0.63, -0.21, 0.88, 0.055, 0.75, c, quiet ? 0.12 : 0.55);
		// Ceramic ribs and dark windows.
		for (let k = 0; k < 4; k++) {
			b.box(-0.37, 0.76 + k * 0.37, 0.469, 0.91, 0.17, 0.06, black);
			b.box(-0.53, 0.83 + k * 0.37, 0.51, 0.53, 0.033, 0.02, c, quiet ? 0.1 : 0.65);
		}
		for (let k = 0; k < 3; k++) b.box(-1.06, 0.61 + k * 0.55, -0.27, 0.1, 0.12, 1.1, dark);
		b.box(0.84, 0.74, 0.62, 0.08, h * 0.43, 0.14, c, quiet ? 0.05 : 0.65);
		b.box(0.62, 0.45, -1.03, 0.74, 0.67, 0.61, dark);
		b.box(0.62, 1.13, -1.03, 0.68, 0.1, 0.57, shell);
		b.cyl(-0.61, h + 0.63, -0.55, 0.04, 0.77, materials.mastPipe, 6);
		b.cyl(-0.61, h + 1.37, -0.55, 0.072, 0.1, c, 8, 0.07, 0.8);
	}

	// Three shelves, one per DISTINCT RECORDED STATUS the card has passed. A count
	// of movements, never a completion estimate — §5.9 forbids progress.
	for (let k = 0; k < 3; k++) {
		const active = k < machine.recordedStages;
		b.box(-1.32, 0.47 + k * 0.32, 0.91, 0.5, 0.21, 0.72, active ? shell : dark);
		b.box(
			-1.32, 0.62 + k * 0.32, 1.281, 0.33, 0.045, 0.025,
			active ? c : materials.deckInlay,
			active ? 0.7 : 0.05,
		);
	}
	// A raised mast and lamp for a card whose recorded status is asking the user.
	if (machine.status === "user-questions") {
		b.torus(0, 4.2, 0, 0.66, 0.06, c, 0.9, "xy", Math.PI * 2);
		b.box(0, 3.93, 0, 0.07, 0.44, 0.07, c, 1);
		b.box(0, 3.75, 0, 0.08, 0.08, 0.08, c, 1);
	}
	// A cross above a card the log says a message never reached.
	if (machine.undelivered) {
		b.box(-0.38, 3.77, 0, 0.8, 0.06, 0.07, c, 1, 0.7);
		b.box(-0.38, 3.77, 0, 0.8, 0.06, 0.07, c, 1, -0.7);
	}
	return b;
}

/** Where a route leaves a machine: the coordinator mast is taller than a shed. */
export function routeAnchor(machine: StrataMachine): Vec3 {
	return V.add(machine.pos, [0, machine.role === "coordinator" ? 3.5 : 2, 0]);
}

/** A 36-segment arc between two anchors, its rise scaled to the span. */
export function curve(a: Vec3, b: Vec3): Vec3[] {
	const span = Math.hypot(a[0] - b[0], a[2] - b[2]);
	const height = Math.max(2.1, Math.min(8, span * 0.23));
	const out: Vec3[] = [];
	for (let i = 0; i <= 36; i++) {
		const t = i / 36;
		out.push([
			a[0] + (b[0] - a[0]) * t,
			a[1] + (b[1] - a[1]) * t + Math.sin(t * Math.PI) * height,
			a[2] + (b[2] - a[2]) * t,
		]);
	}
	return out;
}

export function atCurve(points: Vec3[], t: number): Vec3 {
	const f = Math.max(0, Math.min(0.9999, t)) * (points.length - 1);
	const i = Math.floor(f);
	const q = f - i;
	return V.add(V.mul(points[i], 1 - q), V.mul(points[i + 1], q));
}

export interface PlacedRoute extends StrataRoute {
	points: Vec3[];
}

/**
 * Route geometry, and the vocabulary that makes a verdict readable at a glance:
 *
 * - a **delivered** route is a thin continuous beam;
 * - a **held** or **queued** route is dashed, with stop plates standing on it;
 * - a **failed** route is thick, gapped in the middle, and carries a cross.
 *
 * The gap and the cross are the same fact twice on purpose — the shape survives
 * a colour-blind reading and a greyscale screenshot, which colour alone does not.
 */
export function buildRoutes(
	routes: StrataRoute[],
	machines: Map<string, StrataMachine>,
	materials: StrataMaterials,
	highlighted: (route: StrataRoute) => boolean,
): { mesh: MeshBuilder; placed: PlacedRoute[] } {
	const mesh = new MeshBuilder();
	const placed: PlacedRoute[] = [];
	for (const route of routes) {
		const a = machines.get(route.from);
		const b = machines.get(route.to);
		if (!a || !b || a.unborn || b.unborn) continue;
		const points = curve(routeAnchor(a), routeAnchor(b));
		placed.push({ ...route, points });
		const lit = highlighted(route);
		const color = lit ? materials.route[route.kind] : materials.routeMuted;
		const emissive = route.kind === "delivered" ? 0.35 : 0.8;
		const width = route.kind === "failed" ? 0.11 : route.kind === "delivered" ? 0.045 : 0.09;
		for (let i = 0; i < points.length - 1; i++) {
			if (route.kind === "failed" && i >= 15 && i <= 20) continue;
			if ((route.kind === "held" || route.kind === "queued") && i % 4 === 3) continue;
			mesh.beam(points[i], points[i + 1], width, color, emissive);
		}
		if (route.kind === "held" || route.kind === "queued") {
			for (let k = 4; k < 33; k += 7) {
				const p = atCurve(points, k / 36);
				mesh.cyl(p[0], p[1] - 0.14, p[2], 0.24, 0.15, materials.holdPlate, 6, 0.24);
				mesh.torus(p[0], p[1] + 0.025, p[2], 0.2, 0.025, lit ? materials.holdRing : materials.routeMuted, 0.8);
			}
		}
		if (route.kind === "failed") {
			const p = atCurve(points, 0.5);
			mesh.beam(V.add(p, [-0.43, -0.43, 0]), V.add(p, [0.43, 0.43, 0]), 0.11, color, 1);
			mesh.beam(V.add(p, [0.43, -0.43, 0]), V.add(p, [-0.43, 0.43, 0]), 0.11, color, 1);
		}
	}
	return { mesh, placed };
}

/**
 * How far out the substrate has to reach: the districts plus generous margin, so
 * the grid and its arcs still run past the outermost deck.
 */
export function sceneExtent(districts: StrataDistrict[]): number {
	return Math.max(24, districtExtent(districts) * 1.3);
}

/**
 * What the camera frames: the districts' own centroid and the radius that
 * reaches the far edge of the outermost deck from there.
 *
 * Two things the first build got wrong and this fixes. It framed
 * `sceneExtent` — the padded decor radius — so the decks came out at a third of
 * their legible size adrift in empty grid. And it aimed at the world origin,
 * which is only the middle of the ring when the districts happen to be evenly
 * spread; with three of unequal size the far deck hung off the bottom edge.
 */
export function sceneBounds(districts: StrataDistrict[]): {
	center: Vec3;
	radius: number;
} {
	if (!districts.length) return { center: [0, 0, 0], radius: 16 };
	const center: Vec3 = [
		districts.reduce((sum, d) => sum + d.center[0], 0) / districts.length,
		0,
		districts.reduce((sum, d) => sum + d.center[2], 0) / districts.length,
	];
	let radius = 16;
	for (const district of districts) {
		radius = Math.max(
			radius,
			Math.hypot(district.center[0] - center[0], district.center[2] - center[2]) +
				district.radius,
		);
	}
	return { center, radius };
}

/** The radius the substrate must cover, measured from the world origin. */
export function districtExtent(districts: StrataDistrict[]): number {
	let extent = 16;
	for (const district of districts) {
		extent = Math.max(
			extent,
			Math.hypot(district.center[0], district.center[2]) + district.radius,
		);
	}
	return extent;
}
