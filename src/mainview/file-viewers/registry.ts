import type { Context } from "cordis";
import type { ComponentType, Ref } from "react";
import type { FilePreviewResult } from "../../shared/types";
import type { SyntaxToken } from "../components/file-preview-syntax";
import { defineAppSlot } from "../plugins/root";
import { SlotRegistry, type SlotItem } from "../plugins/slot-registry";

// Internal for now: no manifest kind declares `fileViewers`, so the extension guard
// unloads any extension that registers here (decisions/2026/11/22/file-viewers-slot.md).
declare module "cordis" {
	interface Context {
		fileViewers: FileViewerRegistry;
	}
}

/** What a viewer's matcher decides on: the loaded preview, its path, and whether the user asked for the source. */
export interface FileViewerMatch {
	preview: FilePreviewResult;
	path: string;
	/** The header's Raw toggle is on: a rendering viewer (markdown) steps aside for the source view. */
	showRaw: boolean;
}

/**
 * What a viewer draws from. The host keeps everything a review comment anchors to: it
 * reads a text selection itself, from the `data-preview-line` marks a viewer puts on its
 * lines, and draws the image region overlay over the `imageRef` element. A viewer only
 * renders the content and shows which lines already carry a comment.
 */
export interface FileViewerProps extends FileViewerMatch {
	fileName: string;
	/** The file's folder, for relative links and images; "" at the root. */
	dirName: string;
	/** 1-based line a `:line` link pointed at; mark it with `targetLineRef` so the host scrolls to it. */
	line?: number;
	targetLineRef: Ref<HTMLDivElement>;
	wrapLines: boolean;
	expanded: boolean;
	/** Highlighted tokens per 1-based line, when the host highlighted this text. */
	syntaxLines: ReadonlyMap<number, SyntaxToken[]> | null;
	theme: "dark" | "light";
	/** 1-based lines inside a review comment's range. */
	commentedLines: ReadonlySet<number>;
	/** The picture element, measured by the host for the region overlay. */
	imageRef: Ref<HTMLImageElement>;
	onImageLoad: (width: number, height: number) => void;
	/** The engine cannot play this media: the host shrinks the dialog to a notice. */
	onMediaUnplayable: () => void;
}

/** A body for one kind of file. The first item, by `order`, whose `matches` holds draws the preview. */
export interface FileViewerItem extends SlotItem {
	matches: (match: FileViewerMatch) => boolean;
	component: ComponentType<FileViewerProps>;
}

export class FileViewerRegistry extends SlotRegistry<FileViewerItem> {
	constructor(ctx: Context) {
		super(ctx, "fileViewers", { kind: "contribute", noun: "file viewer" });
	}
}

export const getFileViewerRegistry = defineAppSlot((root) => new FileViewerRegistry(root));

const reported = new Set<string>();

/** A throwing matcher counts as no match, reported once per viewer id. */
export function viewerMatches(item: FileViewerItem, match: FileViewerMatch): boolean {
	try {
		return item.matches(match);
	} catch (err) {
		if (!reported.has(item.id)) {
			reported.add(item.id);
			console.error(`[fileViewers] matches of file viewer ${item.id} threw; skipping it:`, err);
		}
		return false;
	}
}

export function resetFileViewerFailuresForTests(): void {
	reported.clear();
}
