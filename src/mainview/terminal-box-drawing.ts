// Connections: left, up, right, down; 1 = light, 2 = heavy, 3 = double.
const CONNECTIONS: Readonly<Record<number, readonly [number, number, number, number]>> = {
	0x2500: [1, 0, 1, 0], // ─
	0x2501: [2, 0, 2, 0], // ━
	0x2502: [0, 1, 0, 1], // │
	0x2503: [0, 2, 0, 2], // ┃
	0x250c: [0, 0, 1, 1], // ┌
	0x250d: [0, 0, 2, 1], // ┍
	0x250e: [0, 0, 1, 2], // ┎
	0x250f: [0, 0, 2, 2], // ┏
	0x2510: [1, 0, 0, 1], // ┐
	0x2511: [2, 0, 0, 1], // ┑
	0x2512: [1, 0, 0, 2], // ┒
	0x2513: [2, 0, 0, 2], // ┓
	0x2514: [0, 1, 1, 0], // └
	0x2515: [0, 1, 2, 0], // ┕
	0x2516: [0, 2, 1, 0], // ┖
	0x2517: [0, 2, 2, 0], // ┗
	0x2518: [1, 1, 0, 0], // ┘
	0x2519: [2, 1, 0, 0], // ┙
	0x251a: [1, 2, 0, 0], // ┚
	0x251b: [2, 2, 0, 0], // ┛
	0x251c: [0, 1, 1, 1], // ├
	0x251d: [0, 1, 2, 1], // ┝
	0x251e: [0, 2, 1, 1], // ┞
	0x251f: [0, 1, 1, 2], // ┟
	0x2520: [0, 2, 1, 2], // ┠
	0x2521: [0, 2, 2, 1], // ┡
	0x2522: [0, 1, 2, 2], // ┢
	0x2523: [0, 2, 2, 2], // ┣
	0x2524: [1, 1, 0, 1], // ┤
	0x2525: [2, 1, 0, 1], // ┥
	0x2526: [1, 2, 0, 1], // ┦
	0x2527: [1, 1, 0, 2], // ┧
	0x2528: [1, 2, 0, 2], // ┨
	0x2529: [2, 2, 0, 1], // ┩
	0x252a: [2, 1, 0, 2], // ┪
	0x252b: [2, 2, 0, 2], // ┫
	0x252c: [1, 0, 1, 1], // ┬
	0x252d: [2, 0, 1, 1], // ┭
	0x252e: [1, 0, 2, 1], // ┮
	0x252f: [2, 0, 2, 1], // ┯
	0x2530: [1, 0, 1, 2], // ┰
	0x2531: [2, 0, 1, 2], // ┱
	0x2532: [1, 0, 2, 2], // ┲
	0x2533: [2, 0, 2, 2], // ┳
	0x2534: [1, 1, 1, 0], // ┴
	0x2535: [2, 1, 1, 0], // ┵
	0x2536: [1, 1, 2, 0], // ┶
	0x2537: [2, 1, 2, 0], // ┷
	0x2538: [1, 2, 1, 0], // ┸
	0x2539: [2, 2, 1, 0], // ┹
	0x253a: [1, 2, 2, 0], // ┺
	0x253b: [2, 2, 2, 0], // ┻
	0x253c: [1, 1, 1, 1], // ┼
	0x253d: [2, 1, 1, 1], // ┽
	0x253e: [1, 1, 2, 1], // ┾
	0x253f: [2, 1, 2, 1], // ┿
	0x2540: [1, 2, 1, 1], // ╀
	0x2541: [1, 1, 1, 2], // ╁
	0x2542: [1, 2, 1, 2], // ╂
	0x2543: [2, 2, 1, 1], // ╃
	0x2544: [1, 2, 2, 1], // ╄
	0x2545: [2, 1, 1, 2], // ╅
	0x2546: [1, 1, 2, 2], // ╆
	0x2547: [2, 2, 2, 1], // ╇
	0x2548: [2, 1, 2, 2], // ╈
	0x2549: [2, 2, 1, 2], // ╉
	0x254a: [1, 2, 2, 2], // ╊
	0x254b: [2, 2, 2, 2], // ╋
	0x2550: [3, 0, 3, 0], // ═
	0x2551: [0, 3, 0, 3], // ║
	0x2552: [0, 0, 3, 1], // ╒
	0x2553: [0, 0, 1, 3], // ╓
	0x2554: [0, 0, 3, 3], // ╔
	0x2555: [3, 0, 0, 1], // ╕
	0x2556: [1, 0, 0, 3], // ╖
	0x2557: [3, 0, 0, 3], // ╗
	0x2558: [0, 1, 3, 0], // ╘
	0x2559: [0, 3, 1, 0], // ╙
	0x255a: [0, 3, 3, 0], // ╚
	0x255b: [3, 1, 0, 0], // ╛
	0x255c: [1, 3, 0, 0], // ╜
	0x255d: [3, 3, 0, 0], // ╝
	0x255e: [0, 1, 3, 1], // ╞
	0x255f: [0, 3, 1, 3], // ╟
	0x2560: [0, 3, 3, 3], // ╠
	0x2561: [3, 1, 0, 1], // ╡
	0x2562: [1, 3, 0, 3], // ╢
	0x2563: [3, 3, 0, 3], // ╣
	0x2564: [3, 0, 3, 1], // ╤
	0x2565: [1, 0, 1, 3], // ╥
	0x2566: [3, 0, 3, 3], // ╦
	0x2567: [3, 1, 3, 0], // ╧
	0x2568: [1, 3, 1, 0], // ╨
	0x2569: [3, 3, 3, 0], // ╩
	0x256a: [3, 1, 3, 1], // ╪
	0x256b: [1, 3, 1, 3], // ╫
	0x256c: [3, 3, 3, 3], // ╬
	0x2574: [1, 0, 0, 0], // ╴
	0x2575: [0, 1, 0, 0], // ╵
	0x2576: [0, 0, 1, 0], // ╶
	0x2577: [0, 0, 0, 1], // ╷
	0x2578: [2, 0, 0, 0], // ╸
	0x2579: [0, 2, 0, 0], // ╹
	0x257a: [0, 0, 2, 0], // ╺
	0x257b: [0, 0, 0, 2], // ╻
	0x257c: [1, 0, 2, 0], // ╼
	0x257d: [0, 1, 0, 2], // ╽
	0x257e: [2, 0, 1, 0], // ╾
	0x257f: [0, 2, 0, 1], // ╿
};

export function isTerminalBoxGlyph(codepoint: number): boolean {
	return CONNECTIONS[codepoint] !== undefined
		|| (codepoint >= 0x2504 && codepoint <= 0x250b)
		|| (codepoint >= 0x254c && codepoint <= 0x254f)
		|| (codepoint >= 0x256d && codepoint <= 0x2570);
}

export function drawTerminalBox(
	ctx: CanvasRenderingContext2D, codepoint: number, x: number, y: number,
	width: number, height: number, ratio: number, thickness: number,
): boolean {
	if (!isTerminalBoxGlyph(codepoint)) return false;
	const physicalWidth = Math.round(width * ratio);
	const physicalHeight = Math.round(height * ratio);
	const cx = Math.floor((physicalWidth - 1) / 2) + 0.5;
	const cy = Math.floor((physicalHeight - 1) / 2) + 0.5;
	x = Math.round(x * ratio) / ratio;
	y = Math.round(y * ratio) / ratio;
	ctx.beginPath();
	if (codepoint >= 0x256d && codepoint <= 0x2570) {
		const right = codepoint === 0x256d || codepoint === 0x2570;
		const down = codepoint === 0x256d || codepoint === 0x256e;
		const radius = Math.max(thickness / 2, Math.floor(Math.min(cx, physicalWidth - cx, cy, physicalHeight - cy)));
		const arcX = cx + (right ? radius : -radius);
		const arcY = cy + (down ? radius : -radius);
		const start = right ? (down ? Math.PI : Math.PI / 2) : (down ? 3 * Math.PI / 2 : 0);
		const end = start + Math.PI / 2;
		ctx.arc(x + arcX / ratio, y + arcY / ratio, (radius + thickness / 2) / ratio, start, end);
		ctx.arc(x + arcX / ratio, y + arcY / ratio, (radius - thickness / 2) / ratio, end, start, true);
		ctx.closePath();
		ctx.rect(x + (right ? arcX : 0) / ratio, y + (cy - thickness / 2) / ratio,
			(right ? physicalWidth - arcX : arcX) / ratio, thickness / ratio);
		ctx.rect(x + (cx - thickness / 2) / ratio, y + (down ? arcY : 0) / ratio,
			thickness / ratio, (down ? physicalHeight - arcY : arcY) / ratio);
		ctx.fill();
		return true;
	}
	const dashCount = codepoint >= 0x2504 && codepoint <= 0x250b ? (codepoint < 0x2508 ? 3 : 4)
		: codepoint >= 0x254c && codepoint <= 0x254f ? 2 : 0;
	if (dashCount) {
		const horizontal = (codepoint & 2) === 0;
		const weight = (codepoint & 1 ? 3 : 1) * thickness;
		const length = horizontal ? physicalWidth : physicalHeight;
		const gap = Math.max(1, Math.round(length / (dashCount * 3)));
		for (let dash = 0; dash < dashCount; dash++) {
			const start = Math.round(dash * length / dashCount + gap / 2);
			const end = Math.round((dash + 1) * length / dashCount - gap / 2);
			if (horizontal) ctx.rect(x + start / ratio, y + (cy - weight / 2) / ratio, (end - start) / ratio, weight / ratio);
			else ctx.rect(x + (cx - weight / 2) / ratio, y + start / ratio, weight / ratio, (end - start) / ratio);
		}
		ctx.fill();
		return true;
	}
	const arms = CONNECTIONS[codepoint];
	if (codepoint >= 0x2550 && codepoint <= 0x256c) {
		for (let direction = 0; direction < 4; direction++) {
			const style = arms[direction];
			if (!style) continue;
			const horizontal = (direction & 1) === 0;
			const positive = direction >= 2;
			const before = arms[horizontal ? 1 : 0];
			const after = arms[horizontal ? 3 : 2];
			const count = style === 3 ? 2 : 1;
			for (let rail = 0; rail < count; rail++) {
				const cross = (horizontal ? cy : cx) + (count === 2 ? (rail ? thickness : -thickness) : 0);
				let join: number;
				if (count === 2) {
					const near = rail ? after : before;
					const far = rail ? before : after;
					join = near ? (near === 3 ? thickness : 0) : far === 3 ? -thickness : 0;
				} else {
					join = before === 3 || after === 3 ? thickness : 0;
					if (!(before && after)) join = -join;
				}
				// Turn each rail into its neighbour; do not bridge the double-line gap.
				const centre = (horizontal ? cx : cy) + (positive ? join : -join);
				const start = positive ? centre - thickness / 2 : 0;
				const end = positive ? (horizontal ? physicalWidth : physicalHeight) : centre + thickness / 2;
				if (horizontal) ctx.rect(x + start / ratio, y + (cross - thickness / 2) / ratio, (end - start) / ratio, thickness / ratio);
				else ctx.rect(x + (cross - thickness / 2) / ratio, y + start / ratio, thickness / ratio, (end - start) / ratio);
			}
		}
		ctx.fill();
		return true;
	}
	const left = arms[0] ? (arms[0] === 2 ? 3 : 1) * thickness : 0;
	const up = arms[1] ? (arms[1] === 2 ? 3 : 1) * thickness : 0;
	const right = arms[2] ? (arms[2] === 2 ? 3 : 1) * thickness : 0;
	const down = arms[3] ? (arms[3] === 2 ? 3 : 1) * thickness : 0;
	// Native one-pixel hairlines meet at their centres: an elbow covers three
	// quarters of its corner pixel. Wider strokes use the full mitered joint.
	const hairline = Math.max(left, up, right, down) === 1;
	const horizontal = hairline ? 0 : Math.max(left, right) / 2;
	const vertical = hairline ? 0 : Math.max(up, down) / 2;
	if (left) ctx.rect(x, y + (cy - left / 2) / ratio, (cx + vertical) / ratio, left / ratio);
	if (right) ctx.rect(x + (cx - vertical) / ratio, y + (cy - right / 2) / ratio,
		(physicalWidth - cx + vertical) / ratio, right / ratio);
	if (up) ctx.rect(x + (cx - up / 2) / ratio, y, up / ratio, (cy + horizontal) / ratio);
	if (down) ctx.rect(x + (cx - down / 2) / ratio, y + (cy - horizontal) / ratio,
		down / ratio, (physicalHeight - cy + horizontal) / ratio);
	ctx.fill();
	return true;
}
