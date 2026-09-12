import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isMac } from "../utils/platform";
import {
	clearFindHighlights,
	collectFindRanges,
	paintFindRanges,
	scrollRangeIntoView,
} from "../utils/find-in-dom";

export interface FindController {
	isOpen: boolean;
	query: string;
	setQuery: (query: string) => void;
	/** null while nothing is searched (empty query) — the counter stays hidden. */
	matches: number | null;
	activeIndex: number;
	step: (delta: 1 | -1) => void;
	close: () => void;
}

interface FindOptions {
	/** Changes whenever the searched content is replaced, so ranges are rebuilt. */
	contentKey: unknown;
	/** Called after ⌘F opens (or re-triggers) the bar, to focus its input. */
	onOpen?: () => void;
	enabled?: boolean;
}

/**
 * ⌘F / Ctrl+F find over a rendered container. The keydown listener is
 * capture-phase and stops immediate propagation, so an overlay using this hook
 * pre-empts the board-level ⌘F handlers listening on the same window.
 */
export function useFindInElement(
	rootRef: RefObject<HTMLElement | null>,
	{ contentKey, onOpen, enabled = true }: FindOptions,
): FindController {
	const [isOpen, setIsOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const [ranges, setRanges] = useState<Range[]>([]);
	const onOpenRef = useRef(onOpen);
	onOpenRef.current = onOpen;

	const close = useCallback(() => {
		setIsOpen(false);
		setQuery("");
		setActiveIndex(0);
		setRanges([]);
		clearFindHighlights();
	}, []);

	// A new query (or freshly rendered content) rebuilds the ranges and jumps back
	// to the first hit; stepping only repaints, which is why it is a second effect.
	useEffect(() => {
		if (!isOpen) return;
		setRanges(query.trim() ? collectFindRanges(rootRef.current, query) : []);
		setActiveIndex(0);
	}, [isOpen, query, contentKey, rootRef]);

	useEffect(() => {
		if (!isOpen) return;
		paintFindRanges(ranges, activeIndex);
		scrollRangeIntoView(ranges[activeIndex]);
	}, [isOpen, ranges, activeIndex]);

	useEffect(() => () => clearFindHighlights(), []);

	const total = ranges.length;
	const step = useCallback((delta: 1 | -1) => {
		if (total === 0) return;
		setActiveIndex((index) => ((index + delta) % total + total) % total);
	}, [total]);

	useEffect(() => {
		if (!enabled) return;
		function onKeyDown(event: KeyboardEvent) {
			const combo = isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
			// `code` first: on a non-Latin layout ⌘F still reports `KeyF` while `key`
			// carries the layout's own letter.
			const isFind = event.code === "KeyF" || event.key.toLowerCase() === "f";
			if (!combo || !isFind || event.shiftKey || event.altKey) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			setIsOpen(true);
			window.requestAnimationFrame(() => onOpenRef.current?.());
		}
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [enabled]);

	return { isOpen, query, setQuery, matches: query.trim() ? total : null, activeIndex, step, close };
}
