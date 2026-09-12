import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import { useT } from "../../i18n";
import { MarkdownContent, useMarkdownRendererConfig } from "./markdown";
import { MarkdownImageProvider } from "./markdown-images";

export type MarkdownDiffKind = "context" | "added" | "removed";

export type MarkdownDiffBlock = {
	kind: MarkdownDiffKind;
	source: string;
	/** 1-based line this block starts on, in the file side its kind belongs to. */
	startLine: number;
	/** Unchanged and far enough from every change to be worth hiding: the reader
	 *  gets a foldable row instead of the block, so a one-line edit in a long
	 *  document is not buried under the rest of the file. */
	folded?: boolean;
};

/** Unchanged chunks kept beside a change, so an edit is read in its context. */
const CONTEXT_CHUNKS = 3;

/** A shorter unchanged run just renders: the fold row would cost more than it hides. */
const MIN_FOLDED_LINES = 6;

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

/**
 * Which chunks the reader sees without asking: every change, plus `CONTEXT_CHUNKS`
 * unchanged chunks on each side of one. A hidden run shorter than
 * `MIN_FOLDED_LINES` is put back — folding it would trade lines for a row.
 */
function markVisible(ops: Op[]): boolean[] {
	const visible = ops.map((op) => op.kind !== "context");
	for (let index = 0; index < ops.length; index++) {
		if (ops[index].kind === "context") continue;
		for (let offset = 1; offset <= CONTEXT_CHUNKS; offset++) {
			if (index - offset >= 0) visible[index - offset] = true;
			if (index + offset < ops.length) visible[index + offset] = true;
		}
	}

	let runStart = 0;
	for (let index = 0; index <= ops.length; index++) {
		if (index < ops.length && !visible[index]) continue;
		if (index > runStart) {
			let lines = 0;
			for (let i = runStart; i < index; i++) lines += lineCount(ops[i].chunk.raw);
			if (lines < MIN_FOLDED_LINES) {
				for (let i = runStart; i < index; i++) visible[i] = true;
			}
		}
		runStart = index + 1;
	}
	return visible;
}

/** Consecutive same-kind chunks render as one markdown fragment so runs of list
 * items stay a single list instead of a stack of one-item lists. Folded chunks
 * never join a visible group — the fold has to be a seam. */
function groupOps(ops: Op[], visible: boolean[]): MarkdownDiffBlock[] {
	const groups: { kind: MarkdownDiffKind; chunks: Chunk[]; folded: boolean }[] = [];
	ops.forEach((op, index) => {
		const last = groups[groups.length - 1];
		const folded = !visible[index];
		if (last && last.kind === op.kind && last.folded === folded && last.chunks[0].listItem === op.chunk.listItem) {
			last.chunks.push(op.chunk);
		} else {
			groups.push({ kind: op.kind, chunks: [op.chunk], folded });
		}
	});
	return groups.map(({ kind, chunks, folded }) => {
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
		return folded
			? { kind, source, startLine: chunks[0].startLine, folded }
			: { kind, source, startLine: chunks[0].startLine };
	});
}

const HEADING_PATTERN = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm;

/** Plain text of the last heading in a source fragment — the fold row uses it to
 *  say which section the hidden run sits in. */
export function lastHeadingText(source: string): string | null {
	let text: string | null = null;
	for (const match of source.matchAll(HEADING_PATTERN)) text = match[1];
	if (!text) return null;
	return text
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_]/g, "")
		.trim() || null;
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
	return groupOps(ops, markVisible(ops));
}

/** File lines carrying a review comment, per side of the diff. */
export interface MarkdownCommentedLines {
	oldFile: ReadonlySet<number>;
	newFile: ReadonlySet<number>;
}

/** A comment anchors to a file line and revealing it scrolls to the rendered
 *  block, so a commented block is never folded away. */
function isCommented(block: MarkdownDiffBlock, commented: MarkdownCommentedLines | null | undefined): boolean {
	const lines = block.kind === "removed" ? commented?.oldFile : commented?.newFile;
	if (!lines?.size) return false;
	const last = block.startLine + lineCount(block.source) - 1;
	for (let line = block.startLine; line <= last; line++) {
		if (lines.has(line)) return true;
	}
	return false;
}

type RenderSegment =
	| { folded: false; blocks: MarkdownDiffBlock[] }
	| { folded: true; blocks: MarkdownDiffBlock[]; lines: number; heading: string | null };

/** Consecutive folded blocks become one row; everything else renders as before. */
function toRenderSegments(
	blocks: MarkdownDiffBlock[],
	commentedLines: MarkdownCommentedLines | null | undefined,
): RenderSegment[] {
	const segments: RenderSegment[] = [];
	let heading: string | null = null;
	for (const block of blocks) {
		const fold = block.folded === true && !isCommented(block, commentedLines);
		const last = segments[segments.length - 1];
		if (last && last.folded === fold) {
			last.blocks.push(block);
			if (last.folded) last.lines += lineCount(block.source);
		} else if (fold) {
			segments.push({ folded: true, blocks: [block], lines: lineCount(block.source), heading });
		} else {
			segments.push({ folded: false, blocks: [block] });
		}
		heading = lastHeadingText(block.source) ?? heading;
	}
	return segments;
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
	const t = useT();
	const rendererConfig = useMarkdownRendererConfig();
	const segments = useMemo(() => toRenderSegments(blocks, commentedLines), [blocks, commentedLines]);
	const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(() => new Set());
	// Folds reopen closed when the document itself changes; a comment landing on a
	// visible block must not throw away what the reader already unfolded.
	useEffect(() => setUnfolded(new Set()), [blocks]);

	const renderBlock = (block: MarkdownDiffBlock, key: string) => (
		<div
			key={key}
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
	);

	return (
		<div
			className="dev3-pr-md dev3-md-doc dev3-md-diff min-w-0 text-sm leading-relaxed text-fg"
			data-testid="markdown-rich-diff"
		>
			<MarkdownImageProvider resetKey={blocks}>
				{segments.map((segment, segmentIndex) => {
					if (!segment.folded || unfolded.has(segmentIndex)) {
						return segment.blocks.map((block, index) => renderBlock(block, `${segmentIndex}:${index}`));
					}
					return (
						<button
							key={segmentIndex}
							type="button"
							data-testid="markdown-diff-unfold"
							onClick={() => setUnfolded((current) => new Set(current).add(segmentIndex))}
							className="dev3-md-diff-fold"
						>
							<span aria-hidden="true" className="dev3-md-diff-fold-icon">⋯</span>
							<span>{t.plural("infoPanel.diffMdUnchangedLines", segment.lines)}</span>
							{segment.heading && <span className="dev3-md-diff-fold-heading">{segment.heading}</span>}
						</button>
					);
				})}
			</MarkdownImageProvider>
		</div>
	);
}

export function useMarkdownDiffBlocks(oldSource: string, newSource: string): MarkdownDiffBlock[] | null {
	return useMemo(() => buildMarkdownDiffBlocks(oldSource, newSource), [oldSource, newSource]);
}
