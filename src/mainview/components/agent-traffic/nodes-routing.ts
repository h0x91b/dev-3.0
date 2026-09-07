export interface RoutePoint { x: number; y: number }
export interface RouteBox { x: number; y: number; width: number; height: number }
interface Obstacle { left: number; right: number; top: number; bottom: number }

// Rounded corners can cut inward by 12px; leave another 14px before card ink.
const CLEARANCE = 26;

function intersects(a: RoutePoint, b: RoutePoint, box: Obstacle): boolean {
	if (a.x === b.x) return a.x > box.left && a.x < box.right && Math.max(a.y, b.y) > box.top && Math.min(a.y, b.y) < box.bottom;
	if (a.y === b.y) return a.y > box.top && a.y < box.bottom && Math.max(a.x, b.x) > box.left && Math.min(a.x, b.x) < box.right;
	return true;
}

function simplify(points: RoutePoint[]): RoutePoint[] {
	const result: RoutePoint[] = [];
	for (const point of points) {
		const last = result[result.length - 1];
		if (last?.x === point.x && last.y === point.y) continue;
		const previous = result[result.length - 2];
		if (previous && last && ((previous.x === last.x && last.x === point.x) || (previous.y === last.y && last.y === point.y))) result.pop();
		result.push(point);
	}
	return result;
}

interface Entry { id: number; cost: number; estimate: number }
class Frontier {
	private entries: Entry[] = [];
	private before(a: Entry, b: Entry) {
		return a.estimate < b.estimate || (a.estimate === b.estimate && (a.cost > b.cost || (a.cost === b.cost && a.id < b.id)));
	}
	push(entry: Entry) {
		let index = this.entries.length;
		this.entries.push(entry);
		while (index > 0) {
			const parent = (index - 1) >> 1;
			if (!this.before(entry, this.entries[parent])) break;
			this.entries[index] = this.entries[parent];
			index = parent;
		}
		this.entries[index] = entry;
	}
	pop(): Entry | undefined {
		const first = this.entries[0];
		const tail = this.entries.pop();
		if (!tail || !this.entries.length) return first;
		let index = 0;
		while (index * 2 + 1 < this.entries.length) {
			let child = index * 2 + 1;
			if (child + 1 < this.entries.length && this.before(this.entries[child + 1], this.entries[child])) child++;
			if (!this.before(this.entries[child], tail)) break;
			this.entries[index] = this.entries[child];
			index = child;
		}
		this.entries[index] = tail;
		return first;
	}
}

/** A shared corridor grid bounds routing work by card coordinates, not pixels. */
export function createTrafficRouter(boxes: RouteBox[]) {
	const obstacles = boxes.map(box => ({ left: box.x - CLEARANCE, right: box.x + box.width + CLEARANCE, top: box.y - CLEARANCE, bottom: box.y + box.height + CLEARANCE }));
	const xs = [...new Set(boxes.flatMap((box, i) => [obstacles[i].left, obstacles[i].right, box.x + box.width / 2]))].sort((a, b) => a - b);
	const ys = [...new Set(boxes.flatMap((box, i) => [obstacles[i].top, obstacles[i].bottom, box.y + box.height * .52]))].sort((a, b) => a - b);
	const xIndex = new Map(xs.map((x, index) => [x, index]));
	const yIndex = new Map(ys.map((y, index) => [y, index]));
	const columns = xs.length;
	const size = columns * ys.length;
	const horizontal = new Uint8Array(size);
	const vertical = new Uint8Array(size);
	const blocked = new Uint8Array(size);
	for (const box of obstacles) {
		const left = xIndex.get(box.left)!, right = xIndex.get(box.right)!;
		const top = yIndex.get(box.top)!, bottom = yIndex.get(box.bottom)!;
		for (let y = top + 1; y < bottom; y++) {
			for (let x = left; x < right; x++) horizontal[y * columns + x] = 1;
			for (let x = left + 1; x < right; x++) blocked[y * columns + x] = 1;
		}
		for (let y = top; y < bottom; y++) {
			for (let x = left + 1; x < right; x++) vertical[y * columns + x] = 1;
		}
	}
	const clear = (points: RoutePoint[], ignore = -1) => points.slice(1).every((point, index) => obstacles.every((box, obstacle) => obstacle === ignore || !intersects(points[index], point, box)));

	return (preferred: RoutePoint[], source: RouteBox, target: RouteBox): RoutePoint[] | null => {
		const path = simplify(preferred);
		if (path.length < 2) return null;
		const first = path[0], last = path[path.length - 1];
		const next = path[1], previous = path[path.length - 2];
		const start = { x: first.x + Math.sign(next.x - first.x) * CLEARANCE, y: first.y + Math.sign(next.y - first.y) * CLEARANCE };
		const end = { x: last.x + Math.sign(previous.x - last.x) * CLEARANCE, y: last.y + Math.sign(previous.y - last.y) * CLEARANCE };
		if (!clear([first, start], boxes.indexOf(source)) || !clear([end, last], boxes.indexOf(target))) return null;
		const middle = [start, ...path.slice(1, -1), end];
		if (clear(middle)) return path;
		const sx = xIndex.get(start.x), sy = yIndex.get(start.y), ex = xIndex.get(end.x), ey = yIndex.get(end.y);
		if (sx === undefined || sy === undefined || ex === undefined || ey === undefined) return null;
		const startId = sy * columns + sx, endId = ey * columns + ex;
		if (blocked[startId] || blocked[endId]) return null;
		const costs = new Float64Array(size).fill(Infinity);
		const parents = new Int32Array(size).fill(-1);
		const frontier = new Frontier();
		const heuristic = (x: number, y: number) => Math.abs(xs[x] - end.x) + Math.abs(ys[y] - end.y);
		costs[startId] = 0;
		frontier.push({ id: startId, cost: 0, estimate: heuristic(sx, sy) });
		let current: Entry | undefined;
		while ((current = frontier.pop())) {
			if (current.cost !== costs[current.id]) continue;
			if (current.id === endId) {
				const route: RoutePoint[] = [];
				for (let id = endId; id !== -1; id = parents[id]) route.push({ x: xs[id % columns], y: ys[Math.floor(id / columns)] });
				return simplify([first, ...route.reverse(), last]);
			}
			const x = current.id % columns, y = Math.floor(current.id / columns);
			const visit = (nx: number, ny: number, obstructed: number) => {
				if (obstructed || nx < 0 || nx >= columns || ny < 0 || ny >= ys.length) return;
				const id = ny * columns + nx;
				if (blocked[id]) return;
				const cost = current!.cost + Math.abs(xs[nx] - xs[x]) + Math.abs(ys[ny] - ys[y]);
				if (cost >= costs[id]) return;
				costs[id] = cost;
				parents[id] = current!.id;
				frontier.push({ id, cost, estimate: cost + heuristic(nx, ny) });
			};
			visit(x - 1, y, horizontal[current.id - 1]);
			visit(x + 1, y, horizontal[current.id]);
			visit(x, y - 1, vertical[current.id - columns]);
			visit(x, y + 1, vertical[current.id]);
		}
		return null;
	};
}
