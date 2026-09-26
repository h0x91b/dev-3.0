// Unicode light/heavy box connections: left, up, right, down; 1 = light, 2 = heavy.
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
	return CONNECTIONS[codepoint] !== undefined;
}

export function drawTerminalBox(
	ctx: CanvasRenderingContext2D, codepoint: number, x: number, y: number,
	width: number, height: number, ratio: number, thickness: number,
): boolean {
	const arms = CONNECTIONS[codepoint];
	if (!arms) return false;
	const physicalWidth = Math.round(width * ratio);
	const physicalHeight = Math.round(height * ratio);
	const cx = Math.floor((physicalWidth - 1) / 2) + 0.5;
	const cy = Math.floor((physicalHeight - 1) / 2) + 0.5;
	const left = arms[0] ? (arms[0] === 2 ? 3 : 1) * thickness : 0;
	const up = arms[1] ? (arms[1] === 2 ? 3 : 1) * thickness : 0;
	const right = arms[2] ? (arms[2] === 2 ? 3 : 1) * thickness : 0;
	const down = arms[3] ? (arms[3] === 2 ? 3 : 1) * thickness : 0;
	// Native one-pixel hairlines meet at their centres: an elbow covers three
	// quarters of its corner pixel. Wider strokes use the full mitered joint.
	const hairline = Math.max(left, up, right, down) === 1;
	const horizontal = hairline ? 0 : Math.max(left, right) / 2;
	const vertical = hairline ? 0 : Math.max(up, down) / 2;
	x = Math.round(x * ratio) / ratio;
	y = Math.round(y * ratio) / ratio;
	// One filled path makes mixed-width joints a union, including under faint alpha.
	ctx.beginPath();
	if (left) ctx.rect(x, y + (cy - left / 2) / ratio, (cx + vertical) / ratio, left / ratio);
	if (right) ctx.rect(x + (cx - vertical) / ratio, y + (cy - right / 2) / ratio,
		(physicalWidth - cx + vertical) / ratio, right / ratio);
	if (up) ctx.rect(x + (cx - up / 2) / ratio, y, up / ratio, (cy + horizontal) / ratio);
	if (down) ctx.rect(x + (cx - down / 2) / ratio, y + (cy - horizontal) / ratio,
		down / ratio, (physicalHeight - cy + horizontal) / ratio);
	ctx.fill();
	return true;
}
