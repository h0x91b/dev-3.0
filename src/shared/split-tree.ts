export type SplitOrientation = "horizontal" | "vertical";
export type SplitDirection = "left" | "right" | "up" | "down";
export const MIN_SPLIT_RATIO = 0.1;
export const MAX_SPLIT_RATIO = 0.9;

export interface SplitPaneNode {
	type: "pane";
	id: string;
}

export interface SplitBranchNode {
	type: "split";
	id: string;
	orientation: SplitOrientation;
	ratio: number;
	first: SplitNode;
	second: SplitNode;
}

export type SplitNode = SplitPaneNode | SplitBranchNode;

export interface SplitTree {
	version: 1;
	root: SplitNode;
	activePaneId: string;
	zoomedPaneId: string | null;
	nextPaneOrdinal: number;
	nextSplitOrdinal: number;
}

export interface SplitTreeValidation {
	valid: boolean;
	errors: string[];
}

export interface SplitPaneRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export function createSplitTree(): SplitTree {
	return {
		version: 1,
		root: { type: "pane", id: "pane-1" },
		activePaneId: "pane-1",
		zoomedPaneId: null,
		nextPaneOrdinal: 2,
		nextSplitOrdinal: 1,
	};
}

function paneIds(node: SplitNode, out: string[]): void {
	if (node.type === "pane") {
		out.push(node.id);
		return;
	}
	paneIds(node.first, out);
	paneIds(node.second, out);
}

export function listPaneIds(tree: SplitTree): string[] {
	const ids: string[] = [];
	paneIds(tree.root, ids);
	return ids;
}

function replacePane(node: SplitNode, paneId: string, replacement: SplitNode): SplitNode {
	if (node.type === "pane") return node.id === paneId ? replacement : node;
	const first = replacePane(node.first, paneId, replacement);
	const second = replacePane(node.second, paneId, replacement);
	return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function splitPane(tree: SplitTree, paneId: string, orientation: SplitOrientation): SplitTree {
	if (!listPaneIds(tree).includes(paneId)) return tree;
	const nextPaneId = `pane-${tree.nextPaneOrdinal}`;
	const branch: SplitBranchNode = {
		type: "split",
		id: `split-${tree.nextSplitOrdinal}`,
		orientation,
		ratio: 0.5,
		first: { type: "pane", id: paneId },
		second: { type: "pane", id: nextPaneId },
	};
	return {
		...tree,
		root: replacePane(tree.root, paneId, branch),
		activePaneId: nextPaneId,
		zoomedPaneId: tree.zoomedPaneId === null ? null : nextPaneId,
		nextPaneOrdinal: tree.nextPaneOrdinal + 1,
		nextSplitOrdinal: tree.nextSplitOrdinal + 1,
	};
}

export function activatePane(tree: SplitTree, paneId: string): SplitTree {
	if (!listPaneIds(tree).includes(paneId) || tree.activePaneId === paneId) return tree;
	return {
		...tree,
		activePaneId: paneId,
		zoomedPaneId: tree.zoomedPaneId === null ? null : paneId,
	};
}

interface RemoveResult {
	node: SplitNode | null;
	removed: boolean;
	fallbackPaneId: string | null;
}

function firstPaneId(node: SplitNode): string {
	return node.type === "pane" ? node.id : firstPaneId(node.first);
}

function removePane(node: SplitNode, paneId: string): RemoveResult {
	if (node.type === "pane") {
		return node.id === paneId
			? { node: null, removed: true, fallbackPaneId: null }
			: { node, removed: false, fallbackPaneId: null };
	}

	const first = removePane(node.first, paneId);
	if (first.removed) {
		if (first.node === null) {
			return { node: node.second, removed: true, fallbackPaneId: firstPaneId(node.second) };
		}
		return { node: { ...node, first: first.node }, removed: true, fallbackPaneId: first.fallbackPaneId };
	}

	const second = removePane(node.second, paneId);
	if (!second.removed) return { node, removed: false, fallbackPaneId: null };
	if (second.node === null) {
		return { node: node.first, removed: true, fallbackPaneId: firstPaneId(node.first) };
	}
	return { node: { ...node, second: second.node }, removed: true, fallbackPaneId: second.fallbackPaneId };
}

export function closePane(tree: SplitTree, paneId: string): SplitTree {
	const ids = listPaneIds(tree);
	if (ids.length === 1 || !ids.includes(paneId)) return tree;
	const result = removePane(tree.root, paneId);
	if (!result.removed || result.node === null) return tree;
	return {
		...tree,
		root: result.node,
		activePaneId: tree.activePaneId === paneId
			? result.fallbackPaneId ?? firstPaneId(result.node)
			: tree.activePaneId,
		zoomedPaneId: tree.zoomedPaneId === paneId ? null : tree.zoomedPaneId,
	};
}

function collectPaneRects(
	node: SplitNode,
	rect: SplitPaneRect,
	out: Map<string, SplitPaneRect>,
): void {
	if (node.type === "pane") {
		out.set(node.id, rect);
		return;
	}
	if (node.orientation === "horizontal") {
		const firstWidth = rect.width * node.ratio;
		collectPaneRects(node.first, { ...rect, width: firstWidth }, out);
		collectPaneRects(node.second, {
			x: rect.x + firstWidth,
			y: rect.y,
			width: rect.width - firstWidth,
			height: rect.height,
		}, out);
		return;
	}
	const firstHeight = rect.height * node.ratio;
	collectPaneRects(node.first, { ...rect, height: firstHeight }, out);
	collectPaneRects(node.second, {
		x: rect.x,
		y: rect.y + firstHeight,
		width: rect.width,
		height: rect.height - firstHeight,
	}, out);
}

export function getPaneRects(tree: SplitTree): Map<string, SplitPaneRect> {
	const rects = new Map<string, SplitPaneRect>();
	collectPaneRects(tree.root, { x: 0, y: 0, width: 1, height: 1 }, rects);
	return rects;
}

function rangesOverlap(startA: number, sizeA: number, startB: number, sizeB: number): boolean {
	return Math.min(startA + sizeA, startB + sizeB) > Math.max(startA, startB);
}

export function focusPane(tree: SplitTree, direction: SplitDirection): SplitTree {
	const rects = getPaneRects(tree);
	const active = rects.get(tree.activePaneId);
	if (!active) return tree;
	const activeX = active.x + active.width / 2;
	const activeY = active.y + active.height / 2;
	let bestId: string | null = null;
	let bestScore = Number.POSITIVE_INFINITY;

	for (const [paneId, candidate] of rects) {
		if (paneId === tree.activePaneId) continue;
		const x = candidate.x + candidate.width / 2;
		const y = candidate.y + candidate.height / 2;
		const horizontal = direction === "left" || direction === "right";
		const primary = direction === "left"
			? activeX - x
			: direction === "right"
				? x - activeX
				: direction === "up"
					? activeY - y
					: y - activeY;
		if (primary <= 0) continue;
		const orthogonal = horizontal ? Math.abs(activeY - y) : Math.abs(activeX - x);
		const overlaps = horizontal
			? rangesOverlap(active.y, active.height, candidate.y, candidate.height)
			: rangesOverlap(active.x, active.width, candidate.x, candidate.width);
		const score = (overlaps ? 0 : 1_000_000) + primary * 1_000 + orthogonal;
		if (score < bestScore) {
			bestScore = score;
			bestId = paneId;
		}
	}

	return bestId ? activatePane(tree, bestId) : tree;
}

function updateSplitRatio(node: SplitNode, splitId: string, ratio: number): SplitNode {
	if (node.type === "pane") return node;
	if (node.id === splitId) return node.ratio === ratio ? node : { ...node, ratio };
	const first = updateSplitRatio(node.first, splitId, ratio);
	const second = updateSplitRatio(node.second, splitId, ratio);
	return first === node.first && second === node.second ? node : { ...node, first, second };
}

function findSplit(node: SplitNode, splitId: string): SplitBranchNode | null {
	if (node.type === "pane") return null;
	if (node.id === splitId) return node;
	return findSplit(node.first, splitId) ?? findSplit(node.second, splitId);
}

export function setSplitRatio(tree: SplitTree, splitId: string, ratio: number): SplitTree {
	if (!Number.isFinite(ratio) || !findSplit(tree.root, splitId)) return tree;
	const bounded = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
	const root = updateSplitRatio(tree.root, splitId, bounded);
	return root === tree.root ? tree : { ...tree, root };
}

export function resizeSplit(tree: SplitTree, splitId: string, delta: number): SplitTree {
	const split = findSplit(tree.root, splitId);
	return split ? setSplitRatio(tree, splitId, split.ratio + delta) : tree;
}

export function zoomPane(tree: SplitTree, paneId: string = tree.activePaneId): SplitTree {
	if (!listPaneIds(tree).includes(paneId)) return tree;
	if (tree.zoomedPaneId === paneId && tree.activePaneId === paneId) return tree;
	return { ...tree, activePaneId: paneId, zoomedPaneId: paneId };
}

export function unzoomPane(tree: SplitTree): SplitTree {
	return tree.zoomedPaneId === null ? tree : { ...tree, zoomedPaneId: null };
}

export function toggleZoom(tree: SplitTree, paneId: string = tree.activePaneId): SplitTree {
	return tree.zoomedPaneId === paneId ? unzoomPane(tree) : zoomPane(tree, paneId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ValidationContext {
	errors: string[];
	nodeIds: Set<string>;
	paneIds: Set<string>;
	seenNodes: Set<object>;
	maxPaneOrdinal: number;
	maxSplitOrdinal: number;
}

function recordNodeId(ctx: ValidationContext, value: unknown, kind: "pane" | "split", path: string): string | null {
	if (typeof value !== "string" || value.length === 0) {
		ctx.errors.push(`${path}.id must be a non-empty string`);
		return null;
	}
	if (ctx.nodeIds.has(value)) ctx.errors.push(`node id ${value} must be unique`);
	ctx.nodeIds.add(value);
	if (kind === "pane") {
		ctx.paneIds.add(value);
		const match = /^pane-(\d+)$/.exec(value);
		if (match) ctx.maxPaneOrdinal = Math.max(ctx.maxPaneOrdinal, Number(match[1]));
	} else {
		const match = /^split-(\d+)$/.exec(value);
		if (match) ctx.maxSplitOrdinal = Math.max(ctx.maxSplitOrdinal, Number(match[1]));
	}
	return value;
}

function validateNode(value: unknown, path: string, ctx: ValidationContext): void {
	if (!isRecord(value)) {
		ctx.errors.push(`${path} must be a pane or split node`);
		return;
	}
	if (ctx.seenNodes.has(value)) {
		ctx.errors.push(`${path} must not contain a cycle or repeated node object`);
		return;
	}
	ctx.seenNodes.add(value);
	if (ctx.seenNodes.size > 10_000) {
		ctx.errors.push("tree exceeds the 10000 node safety limit");
		return;
	}

	if (value.type === "pane") {
		recordNodeId(ctx, value.id, "pane", path);
		return;
	}
	if (value.type !== "split") {
		ctx.errors.push(`${path}.type must be pane or split`);
		return;
	}
	recordNodeId(ctx, value.id, "split", path);
	if (value.orientation !== "horizontal" && value.orientation !== "vertical") {
		ctx.errors.push(`${path}.orientation must be horizontal or vertical`);
	}
	if (
		typeof value.ratio !== "number" ||
		!Number.isFinite(value.ratio) ||
		value.ratio < MIN_SPLIT_RATIO ||
		value.ratio > MAX_SPLIT_RATIO
	) {
		ctx.errors.push(`${path}.ratio must be between ${MIN_SPLIT_RATIO} and ${MAX_SPLIT_RATIO}`);
	}
	validateNode(value.first, `${path}.first`, ctx);
	validateNode(value.second, `${path}.second`, ctx);
}

function validateNextOrdinal(
	value: unknown,
	maxOrdinal: number,
	name: "nextPaneOrdinal" | "nextSplitOrdinal",
	errors: string[],
): void {
	if (!Number.isSafeInteger(value) || (value as number) <= maxOrdinal) {
		errors.push(`${name} must be a safe integer greater than existing ids`);
	}
}

export function validateSplitTree(tree: unknown): SplitTreeValidation {
	const errors: string[] = [];
	if (!isRecord(tree)) return { valid: false, errors: ["tree must be an object"] };
	if (tree.version !== 1) errors.push("tree version must be 1");
	const ctx: ValidationContext = {
		errors,
		nodeIds: new Set(),
		paneIds: new Set(),
		seenNodes: new Set(),
		maxPaneOrdinal: 0,
		maxSplitOrdinal: 0,
	};
	validateNode(tree.root, "root", ctx);
	if (ctx.paneIds.size === 0) errors.push("tree must contain at least one pane");
	if (typeof tree.activePaneId !== "string" || !ctx.paneIds.has(tree.activePaneId)) {
		errors.push("active pane must exist");
	}
	if (tree.zoomedPaneId !== null && (
		typeof tree.zoomedPaneId !== "string" || !ctx.paneIds.has(tree.zoomedPaneId)
	)) {
		errors.push("zoomed pane must exist");
	}
	if (tree.zoomedPaneId !== null && tree.zoomedPaneId !== tree.activePaneId) {
		errors.push("zoomed pane must be active");
	}
	validateNextOrdinal(tree.nextPaneOrdinal, ctx.maxPaneOrdinal, "nextPaneOrdinal", errors);
	validateNextOrdinal(tree.nextSplitOrdinal, ctx.maxSplitOrdinal, "nextSplitOrdinal", errors);
	return { valid: errors.length === 0, errors };
}

export function serializeSplitTree(tree: SplitTree): string {
	const validation = validateSplitTree(tree);
	if (!validation.valid) throw new Error(`Cannot serialize invalid SplitTree: ${validation.errors.join("; ")}`);
	return JSON.stringify(tree);
}

export function restoreSplitTree(serialized: string): SplitTree | null {
	try {
		const value: unknown = JSON.parse(serialized);
		return validateSplitTree(value).valid ? value as SplitTree : null;
	} catch {
		return null;
	}
}
