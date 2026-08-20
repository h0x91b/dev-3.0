import { useMemo } from "react";
import { marked } from "marked";
import { MarkdownContent, useMarkdownRendererConfig } from "./markdown";
import { MarkdownImageProvider } from "./markdown-images";

export type MarkdownDiffKind = "context" | "added" | "removed";

export type MarkdownDiffBlock = {
	kind: MarkdownDiffKind;
	source: string;
	/** 1-based line this block starts on, in the file side its kind belongs to. */
	startLine: number;
};

/** One diffable unit of a markdown document: a top-level block, or a single
 * item of a list (so adding one bullet does not repaint the whole list). */
type Chunk = { raw: string; listItem: boolean; startLine: number };

// LCS is O(old × new); a pathological pair of huge documents would freeze the
// webview, so past this many cells the renderer falls back to a plain preview.
const MAX_LCS_CELLS = 4_000_000;

function chunkMarkdown(source: string): Chunk[] {
	const chunks: Chunk[] = [];
	// Tokens arrive in document order and their `raw` is verbatim, so a moving
	// cursor turns each one into a line number without re-lexing.
	let cursor = 0;
	let cursorLine = 1;
	const lineOf = (raw: string): number => {
		const index = source.indexOf(raw, cursor);
		if (index < 0) return cursorLine;
		for (let i = cursor; i < index; i++) {
			if (source[i] === "\n") cursorLine++;
		}
		cursor = index;
		return cursorLine;
	};

	for (const token of marked.lexer(source, { gfm: true })) {
		if (token.type === "space") {
			continue;
		}
		const items = token.type === "list" ? (token as { items?: { raw: string }[] }).items : undefined;
		if (items?.length) {
			for (const item of items) {
				const startLine = lineOf(item.raw);
				chunks.push({ raw: item.raw.replace(/\n+$/, ""), listItem: true, startLine });
			}
			continue;
		}
		const startLine = lineOf(token.raw);
		const raw = token.raw.replace(/\n+$/, "");
		if (raw.trim()) {
			chunks.push({ raw, listItem: false, startLine });
		}
	}
	return chunks;
}

function lineCount(raw: string): number {
	let lines = 1;
	for (const character of raw) {
		if (character === "\n") lines++;
	}
	return lines;
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
function groupOps(ops: Op[]): MarkdownDiffBlock[] {
	const groups: { kind: MarkdownDiffKind; chunks: Chunk[] }[] = [];
	for (const op of ops) {
		const last = groups[groups.length - 1];
		if (last && last.kind === op.kind && last.chunks[0].listItem === op.chunk.listItem) {
			last.chunks.push(op.chunk);
		} else {
			groups.push({ kind: op.kind, chunks: [op.chunk] });
		}
	}
	return groups.map(({ kind, chunks }) => {
		// Chunks are rejoined with the exact blank lines that separated them in
		// the file, so the group's rendered line numbers stay the file's own —
		// a fixed separator would drift the moment the gap was not one blank line.
		let source = chunks[0].raw;
		let line = chunks[0].startLine + lineCount(chunks[0].raw);
		for (const chunk of chunks.slice(1)) {
			source += "\n".repeat(Math.max(1, chunk.startLine - line + 1));
			source += chunk.raw;
			line = chunk.startLine + lineCount(chunk.raw);
		}
		return { kind, source, startLine: chunks[0].startLine };
	});
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
	return groupOps(ops);
}

/** File lines carrying a review comment, per side of the diff. */
export interface MarkdownCommentedLines {
	oldFile: ReadonlySet<number>;
	newFile: ReadonlySet<number>;
}

export function MarkdownRichDiff({ blocks, imageBaseDir, imageRootDir, commentedLines }: {
	blocks: MarkdownDiffBlock[];
	/** Directory of the document, so repo-relative images can be read off disk. */
	imageBaseDir?: string | null;
	/** Checkout root, for root-relative image paths (`/docs/shot.png`). */
	imageRootDir?: string | null;
	/** Set to mark commented blocks in place and make blocks line-addressable. */
	commentedLines?: MarkdownCommentedLines | null;
}) {
	const rendererConfig = useMarkdownRendererConfig();
	return (
		<div
			className="dev3-pr-md dev3-md-doc dev3-md-diff min-w-0 text-sm leading-relaxed text-fg"
			data-testid="markdown-rich-diff"
		>
			<MarkdownImageProvider resetKey={blocks}>
				{blocks.map((block, index) => (
					<div
						key={index}
						className={`dev3-md-diff-block dev3-md-diff-${block.kind}`}
						data-diff-kind={block.kind}
					>
						<MarkdownContent
							body={block.source}
							document
							imageBaseDir={imageBaseDir}
							imageRootDir={imageRootDir}
							rendererConfig={rendererConfig}
							sourceLines={{
								lineOffset: block.startLine,
								commentedLines: block.kind === "removed"
									? commentedLines?.oldFile
									: commentedLines?.newFile,
							}}
						/>
					</div>
				))}
			</MarkdownImageProvider>
		</div>
	);
}

export function useMarkdownDiffBlocks(oldSource: string, newSource: string): MarkdownDiffBlock[] | null {
	return useMemo(() => buildMarkdownDiffBlocks(oldSource, newSource), [oldSource, newSource]);
}
