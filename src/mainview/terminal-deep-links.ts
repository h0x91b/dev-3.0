import type { ILink, ILinkProvider, Terminal } from "ghostty-web";
import { findDeepLinksInText } from "../shared/deep-link";
import { createRowCache, getLogicalLines, mapRangeToBuffer, type BufferRange, type RowCache } from "./terminal-file-links";

/**
 * Turns a bare `dev3://…` link in terminal output into a Cmd/Ctrl+Click link.
 *
 * ghostty-web's built-in URL provider only knows http(s), mailto, ftp, ssh,
 * git, tel, magnet, gemini, gopher and news — a custom scheme is invisible to
 * it, so a printed deep link was plain text on every backend. Detection reuses
 * the file-path provider's logical-line reassembly, because a task link is ~47
 * characters and wraps in a narrow pane; resolution happens on activation, so
 * nothing here touches the boards.
 */

export interface DeepLinkProviderOptions {
	term: Pick<Terminal, "buffer">;
	onActivate: (uri: string, event: MouseEvent) => void;
}

export interface DeepLinkProvider extends ILinkProvider {
	/** Link ranges for a set of absolute buffer rows — the underline overlay's feed. */
	linksForRows(ys: number[]): BufferRange[];
}

interface RowLink {
	uri: string;
	segments: BufferRange[];
}

export function createDeepLinkProvider(options: DeepLinkProviderOptions): DeepLinkProvider {
	function computeLinks(y: number, cache?: RowCache): RowLink[] {
		const links: RowLink[] = [];
		for (const logical of getLogicalLines((row) => options.term.buffer.active.getLine(row), y, cache)) {
			for (const match of findDeepLinksInText(logical.text)) {
				const segments = mapRangeToBuffer(logical.rows, match.start, match.end);
				if (segments.length > 0) links.push({ uri: match.raw, segments });
			}
		}
		return links;
	}

	return {
		provideLinks(y, callback) {
			try {
				// One ILink per row segment: ghostty hit-tests a multi-row range as
				// whole rows, which would claim a split window's other pane.
				const links: ILink[] = computeLinks(y).flatMap(({ uri, segments }) =>
					segments.map((range) => ({
						text: uri,
						range,
						activate: (event: MouseEvent) => {
							if (event.ctrlKey || event.metaKey) options.onActivate(uri, event);
						},
					})),
				);
				callback(links.length > 0 ? links : undefined);
			} catch {
				callback(undefined);
			}
		},
		linksForRows(ys) {
			const ranges: BufferRange[] = [];
			const seen = new Set<string>();
			const cache = createRowCache();
			for (const y of ys) {
				try {
					for (const { segments } of computeLinks(y, cache)) {
						for (const range of segments) {
							const key = `${range.start.y}:${range.start.x}:${range.end.x}`;
							if (seen.has(key)) continue;
							seen.add(key);
							ranges.push(range);
						}
					}
				} catch {
					// skip unreadable rows
				}
			}
			return ranges;
		},
		dispose() {},
	};
}
