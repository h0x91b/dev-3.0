import { useMemo } from "react";
import { marked } from "marked";
import { renderMarkdownDocument } from "./markdown";

export type MarkdownDiffKind = "context" | "added" | "removed";

export type MarkdownDiffBlock = { kind: MarkdownDiffKind; html: string };

/** One diffable unit of a markdown document: a top-level block, or a single
 * item of a list (so adding one bullet does not repaint the whole list). */
type Chunk = { raw: string; listItem: boolean };

// LCS is O(old × new); a pathological pair of huge documents would freeze the
// webview, so past this many cells the renderer falls back to a plain preview.
const MAX_LCS_CELLS = 4_000_000;

function chunkMarkdown(source: string): Chunk[] {
	const chunks: Chunk[] = [];
	for (const token of marked.lexer(source, { gfm: true })) {
		if (token.type === "space") {
			continue;
		}
		const items = token.type === "list" ? (token as { items?: { raw: string }[] }).items : undefined;
		if (items?.length) {
			for (const item of items) {
				chunks.push({ raw: item.raw.replace(/\n+$/, ""), listItem: true });
			}
			continue;
		}
		const raw = token.raw.replace(/\n+$/, "");
		if (raw.trim()) {
			chunks.push({ raw, listItem: false });
		}
	}
	return chunks;
}

/** Longest common subsequence of chunk indices, matching on exact raw text. */
function lcsMatrix(a: Chunk[], b: Chunk[]): Uint32Array {
	const width = b.length + 1;
	const table = new Uint32Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i * width + j] = a[i].raw === b[j].raw
				? table[(i + 1) * width + j + 1] + 1
				: Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
		}
	}
	return table;
}

type Op = { kind: MarkdownDiffKind; chunk: Chunk };

function diffChunks(oldChunks: Chunk[], newChunks: Chunk[]): Op[] {
	const table = lcsMatrix(oldChunks, newChunks);
	const width = newChunks.length + 1;
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < oldChunks.length && j < newChunks.length) {
		if (oldChunks[i].raw === newChunks[j].raw) {
			ops.push({ kind: "context", chunk: newChunks[j] });
			i++;
			j++;
		} else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
			ops.push({ kind: "removed", chunk: oldChunks[i] });
			i++;
		} else {
			ops.push({ kind: "added", chunk: newChunks[j] });
			j++;
		}
	}
	for (; i < oldChunks.length; i++) {
		ops.push({ kind: "removed", chunk: oldChunks[i] });
	}
	for (; j < newChunks.length; j++) {
		ops.push({ kind: "added", chunk: newChunks[j] });
	}
	return ops;
}

/** Consecutive same-kind chunks render as one markdown fragment so runs of list
 * items stay a single list instead of a stack of one-item lists. */
function groupOps(ops: Op[]): { kind: MarkdownDiffKind; source: string }[] {
	const groups: { kind: MarkdownDiffKind; chunks: Chunk[] }[] = [];
	for (const op of ops) {
		const last = groups[groups.length - 1];
		if (last && last.kind === op.kind && last.chunks[0].listItem === op.chunk.listItem) {
			last.chunks.push(op.chunk);
		} else {
			groups.push({ kind: op.kind, chunks: [op.chunk] });
		}
	}
	return groups.map(({ kind, chunks }) => ({
		kind,
		source: chunks.map((chunk) => chunk.raw).join(chunks[0].listItem ? "\n" : "\n\n"),
	}));
}

/**
 * GitHub-style rich diff of a markdown document: rendered markdown where each
 * block is tagged as unchanged, added, or removed. Returns null when the diff
 * is not worth rendering (identical sides, or documents too large to diff).
 */
export function buildMarkdownDiffBlocks(oldSource: string, newSource: string): MarkdownDiffBlock[] | null {
	const oldChunks = chunkMarkdown(oldSource);
	const newChunks = chunkMarkdown(newSource);
	if ((oldChunks.length + 1) * (newChunks.length + 1) > MAX_LCS_CELLS) {
		return null;
	}
	const ops = diffChunks(oldChunks, newChunks);
	if (!ops.some((op) => op.kind !== "context")) {
		return null;
	}
	return groupOps(ops).map(({ kind, source }) => ({ kind, html: renderMarkdownDocument(source) }));
}

export function MarkdownRichDiff({ blocks }: { blocks: MarkdownDiffBlock[] }) {
	return (
		<div
			className="dev3-pr-md dev3-md-doc dev3-md-diff min-w-0 text-sm leading-relaxed text-fg"
			data-testid="markdown-rich-diff"
		>
			{blocks.map((block, index) => (
				<div
					key={index}
					className={`dev3-md-diff-block dev3-md-diff-${block.kind}`}
					data-diff-kind={block.kind}
					// eslint-disable-next-line react/no-danger -- sanitized in renderMarkdownDocument
					dangerouslySetInnerHTML={{ __html: block.html }}
				/>
			))}
		</div>
	);
}

export function useMarkdownDiffBlocks(oldSource: string, newSource: string): MarkdownDiffBlock[] | null {
	return useMemo(() => buildMarkdownDiffBlocks(oldSource, newSource), [oldSource, newSource]);
}
