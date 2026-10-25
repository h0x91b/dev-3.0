import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import { reorderDropTarget, reorderShifts, reorderTargetIndex, type RowSpan } from "../utils/reorderGeometry";

/** One list whose rows reorder among themselves; a drag never leaves its scope. */
export interface ReorderScope {
	key: string;
	ids: string[];
	/** First index a row may land at — rows pinned above it stay put. */
	minIndex?: number;
	commit: (sourceId: string, targetId: string, side: "before" | "after") => void;
}

export interface ActiveReorder {
	scope: string;
	id: string;
}

const START_DISTANCE = 4;
const EDGE_ZONE = 48;
const MAX_SCROLL_STEP = 18;
const SHIFT_MS = 150;
const SETTLE_MS = 180;
const EASE = "cubic-bezier(0.2, 0, 0, 1)";

interface Session {
	scope: ReorderScope;
	id: string;
	pointerId: number;
	startX: number;
	startY: number;
	lastY: number;
	started: boolean;
	scroller: Element;
	els: HTMLElement[];
	ids: string[];
	spans: RowSpan[];
	origin: number;
	target: number;
	shifts: number[];
	grabOffset: number;
	previewTop: number;
	preview: HTMLElement | null;
	frame: number;
	settleTimer: number;
	reducedMotion: boolean;
}

/**
 * Escape has to reach an in-flight drag first, but overlays swallow it from their
 * own window capture listeners (`useEscapeKey` stops immediate propagation) and
 * the earliest-registered one wins — so this one is installed at import time.
 */
let cancelActiveDrag: (() => void) | null = null;
if (typeof window !== "undefined") {
	window.addEventListener(
		"keydown",
		(event) => {
			if (event.key !== "Escape" || !cancelActiveDrag) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			cancelActiveDrag();
		},
		true,
	);
}

function rowKey(scope: string, id: string): string {
	return `${scope}\u0000${id}`;
}

function scrollParentOf(element: HTMLElement): Element {
	for (let node = element.parentElement; node; node = node.parentElement) {
		const { overflowY } = getComputedStyle(node);
		if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
	}
	return document.scrollingElement ?? document.documentElement;
}

function viewportOf(scroller: Element): { top: number; bottom: number } {
	if (scroller === document.scrollingElement) return { top: 0, bottom: window.innerHeight };
	const rect = scroller.getBoundingClientRect();
	return { top: rect.top, bottom: rect.bottom };
}

/** Client Y → the scroller's content Y, which does not move while it scrolls. */
function toContent(scroller: Element, clientY: number): number {
	return clientY - viewportOf(scroller).top + scroller.scrollTop;
}

function toClient(scroller: Element, contentY: number): number {
	return contentY + viewportOf(scroller).top - scroller.scrollTop;
}

/** The travelling copy: the row exactly as the list shows it, lifted and inert. */
function createPreview(row: HTMLElement, rect: DOMRect): HTMLElement {
	const preview = row.cloneNode(true) as HTMLElement;
	preview.removeAttribute("data-reorder-placeholder");
	for (const node of [preview, ...preview.querySelectorAll<HTMLElement>("*")]) {
		for (const attr of ["id", "data-testid", "data-help-id", "data-hint-id"]) node.removeAttribute(attr);
	}
	preview.setAttribute("aria-hidden", "true");
	preview.setAttribute("data-reorder-preview", "");
	preview.inert = true;
	preview.classList.add("reorder-preview");
	Object.assign(preview.style, {
		position: "fixed",
		left: `${rect.left}px`,
		top: `${rect.top}px`,
		width: `${rect.width}px`,
		height: `${rect.height}px`,
		margin: "0",
		zIndex: "1000",
		pointerEvents: "none",
	});
	document.body.appendChild(preview);
	return preview;
}

/**
 * Pointer-driven reorder for the dashboard's project rows. The native HTML5 drag
 * it replaces could not be steered: the OS drew its own ghost (sized before the
 * list collapsed), released over a gap it flew back to the origin, and WebKit
 * played that slide-back even after a successful drop. Here the preview is a
 * clone of the compact row, the rows it passes slide aside to open the slot it
 * will land in, and a drop settles into that slot before the new order renders.
 */
export function useReorderDrag() {
	const [active, setActive] = useState<ActiveReorder | null>(null);
	const rows = useRef(new Map<string, HTMLElement>());
	const refCallbacks = useRef(new Map<string, (el: HTMLElement | null) => void>());
	const session = useRef<Session | null>(null);

	const rowRef = useCallback((scope: string, id: string) => {
		const key = rowKey(scope, id);
		let callback = refCallbacks.current.get(key);
		if (!callback) {
			callback = (el) => {
				if (el) rows.current.set(key, el);
				else rows.current.delete(key);
			};
			refCallbacks.current.set(key, callback);
		}
		return callback;
	}, []);

	const handlers = useRef<{
		move: (event: PointerEvent) => void;
		up: (event: PointerEvent) => void;
		cancel: () => void;
		scroll: () => void;
	} | null>(null);

	function detach(s: Session) {
		const h = handlers.current;
		if (h) {
			window.removeEventListener("pointermove", h.move);
			window.removeEventListener("pointerup", h.up);
			window.removeEventListener("pointercancel", h.cancel);
			window.removeEventListener("blur", h.cancel);
			s.scroller.removeEventListener("scroll", h.scroll);
		}
		cancelAnimationFrame(s.frame);
		cancelActiveDrag = null;
	}

	function applyShifts(s: Session) {
		s.els.forEach((el, i) => {
			el.style.transform = s.shifts[i] ? `translateY(${s.shifts[i]}px)` : "";
		});
	}

	function retarget(s: Session) {
		const span = s.spans[s.origin];
		const previewMid = toContent(s.scroller, s.lastY - s.grabOffset) + span.height / 2;
		const target = reorderTargetIndex(s.spans, s.origin, previewMid, s.scope.minIndex ?? 0);
		if (target === s.target) return;
		s.target = target;
		s.shifts = reorderShifts(s.spans, s.origin, target);
		applyShifts(s);
	}

	function autoScroll(s: Session) {
		const view = viewportOf(s.scroller);
		let step = 0;
		if (s.lastY < view.top + EDGE_ZONE) step = -Math.ceil(((view.top + EDGE_ZONE - s.lastY) / EDGE_ZONE) * MAX_SCROLL_STEP);
		else if (s.lastY > view.bottom - EDGE_ZONE) step = Math.ceil(((s.lastY - (view.bottom - EDGE_ZONE)) / EDGE_ZONE) * MAX_SCROLL_STEP);
		if (step !== 0) s.scroller.scrollTop += Math.max(-MAX_SCROLL_STEP, Math.min(MAX_SCROLL_STEP, step));
		s.frame = requestAnimationFrame(() => autoScroll(s));
	}

	function start(s: Session): boolean {
		const key = rowKey(s.scope.key, s.id);
		const before = rows.current.get(key)?.getBoundingClientRect().top;
		// Collapsing the list moves the dragged row; scroll by the same amount so
		// it stays under the pointer.
		flushSync(() => setActive({ scope: s.scope.key, id: s.id }));
		const row = rows.current.get(key);
		if (!row || before === undefined) return false;
		s.scroller = scrollParentOf(row);
		const shift = row.getBoundingClientRect().top - before;
		if (shift !== 0) s.scroller.scrollTop += shift;

		const present = s.scope.ids.filter((id) => rows.current.has(rowKey(s.scope.key, id)));
		s.ids = present;
		s.els = present.map((id) => rows.current.get(rowKey(s.scope.key, id))!);
		s.origin = present.indexOf(s.id);
		s.spans = s.els.map((el) => {
			const rect = el.getBoundingClientRect();
			return { top: toContent(s.scroller, rect.top), height: rect.height };
		});
		s.target = s.origin;
		s.shifts = s.els.map(() => 0);

		const rect = row.getBoundingClientRect();
		s.grabOffset = Math.min(Math.max(s.lastY - rect.top, 4), Math.max(rect.height - 4, 4));
		s.previewTop = rect.top;
		s.preview = createPreview(row, rect);
		const transition = s.reducedMotion ? "" : `transform ${SHIFT_MS}ms ${EASE}`;
		for (const el of s.els) el.style.transition = transition;
		document.documentElement.setAttribute("data-reordering", "");
		s.started = true;
		s.scroller.addEventListener("scroll", handlers.current!.scroll, { passive: true });
		s.frame = requestAnimationFrame(() => autoScroll(s));
		return true;
	}

	function teardown(s: Session) {
		detach(s);
		window.clearTimeout(s.settleTimer);
		for (const el of s.els) {
			el.style.transition = "";
			el.style.transform = "";
		}
		s.preview?.remove();
		document.documentElement.removeAttribute("data-reordering");
		if (session.current === s) session.current = null;
	}

	/** Lands the preview in the slot the list shows, then swaps in the real order. */
	function finish(s: Session, accept: boolean) {
		detach(s);
		if (!s.started) {
			session.current = null;
			return;
		}
		const drop = accept ? reorderDropTarget(s.ids, s.origin, s.target) : null;
		if (!drop) {
			s.shifts = s.els.map(() => 0);
			applyShifts(s);
		}
		const landing = toClient(s.scroller, s.spans[s.origin].top + s.shifts[s.origin]);
		const complete = () => {
			flushSync(() => {
				if (drop) s.scope.commit(s.id, drop.targetId, drop.side);
				setActive(null);
			});
			teardown(s);
			// The list expands back to full rows; keep the dropped row where it landed.
			const row = rows.current.get(rowKey(s.scope.key, s.id));
			const delta = row ? row.getBoundingClientRect().top - landing : 0;
			if (delta !== 0) s.scroller.scrollTop += delta;
		};
		if (s.reducedMotion || !s.preview) {
			complete();
			return;
		}
		s.preview.style.transition = `transform ${SETTLE_MS}ms ${EASE}`;
		s.preview.style.transform = `translateY(${landing - s.previewTop}px)`;
		s.settleTimer = window.setTimeout(complete, SETTLE_MS);
	}

	if (!handlers.current) {
		handlers.current = {
			move: (event) => {
				const s = session.current;
				if (!s || event.pointerId !== s.pointerId || s.settleTimer) return;
				s.lastY = event.clientY;
				if (!s.started) {
					if (Math.hypot(event.clientX - s.startX, event.clientY - s.startY) < START_DISTANCE) return;
					if (!start(s)) {
						teardown(s);
						setActive(null);
						return;
					}
				}
				if (s.preview) s.preview.style.transform = `translateY(${event.clientY - s.grabOffset - s.previewTop}px)`;
				retarget(s);
			},
			up: (event) => {
				const s = session.current;
				if (s && event.pointerId === s.pointerId && !s.settleTimer) finish(s, true);
			},
			cancel: () => {
				const s = session.current;
				if (s && !s.settleTimer) finish(s, false);
			},
			scroll: () => {
				const s = session.current;
				if (s?.started && !s.settleTimer) retarget(s);
			},
		};
	}

	const begin = useCallback((event: ReactPointerEvent<HTMLElement>, scope: ReorderScope, id: string) => {
		if (event.button !== 0 || session.current || !scope.ids.includes(id)) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture?.(event.pointerId);
		session.current = {
			scope,
			id,
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			lastY: event.clientY,
			started: false,
			scroller: document.documentElement,
			els: [],
			ids: [],
			spans: [],
			origin: -1,
			target: -1,
			shifts: [],
			grabOffset: 0,
			previewTop: 0,
			preview: null,
			frame: 0,
			settleTimer: 0,
			reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
		};
		const h = handlers.current!;
		window.addEventListener("pointermove", h.move);
		window.addEventListener("pointerup", h.up);
		window.addEventListener("pointercancel", h.cancel);
		window.addEventListener("blur", h.cancel);
		cancelActiveDrag = h.cancel;
	}, []);

	useEffect(() => () => {
		if (session.current) teardown(session.current);
	}, []);

	return { active, begin, rowRef };
}
