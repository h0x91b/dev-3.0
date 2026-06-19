import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { DEFAULT_HINT_CHARS, generateHintStrings } from "../utils/hintLabels";

interface HintTarget {
	id: string;
	hint: string;
	element: HTMLElement;
}

interface TaskHintOverlayProps {
	/** Called when the overlay should close (committed, cancelled, or empty). */
	onExit: () => void;
}

/** Is the element rendered and at least partially inside the viewport? */
function isVisibleInViewport(el: HTMLElement): boolean {
	const r = el.getBoundingClientRect();
	if (r.width === 0 || r.height === 0) return false;
	return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
}

/**
 * Collect one clickable element per task currently on screen.
 *
 * A single task can carry `data-task-id` on more than one element — the column
 * wraps each card in a `<div data-task-id>` for drag-and-drop AND the card root
 * itself has it. Only the innermost element owns the navigation `onClick`, so
 * for each id we keep the element that has no descendant sharing the same id.
 */
function scanTargets(): HTMLElement[] {
	const all = Array.from(document.querySelectorAll<HTMLElement>("[data-task-id]"));
	const byId = new Map<string, HTMLElement>();
	for (const el of all) {
		const id = el.getAttribute("data-task-id");
		if (!id) continue;
		if (!isVisibleInViewport(el)) continue;
		// Prefer the innermost element: one that does not contain another node
		// with the same id. (querySelectorAll yields ancestors before
		// descendants, so the descendant naturally overwrites the ancestor.)
		const hasInnerTwin = el.querySelector(`[data-task-id="${CSS.escape(id)}"]`) !== null;
		if (hasInnerTwin) continue;
		if (!byId.has(id)) byId.set(id, el);
	}
	// Order spatially: down each column (left→right), top→bottom within a column,
	// so the shortest/earliest hints land on the top-left cards.
	return Array.from(byId.values()).sort((a, b) => {
		const ra = a.getBoundingClientRect();
		const rb = b.getBoundingClientRect();
		return ra.left - rb.left || ra.top - rb.top;
	});
}

function TaskHintOverlay({ onExit }: TaskHintOverlayProps) {
	const t = useT();
	const [typed, setTyped] = useState("");
	// Bumped on scroll/resize to recompute badge positions from live rects.
	const [tick, setTick] = useState(0);

	const onExitRef = useRef(onExit);
	onExitRef.current = onExit;

	const [targets] = useState<HintTarget[]>(() => {
		const els = scanTargets();
		const hints = generateHintStrings(els.length);
		return els.map((element, i) => ({
			id: element.getAttribute("data-task-id") ?? String(i),
			hint: hints[i],
			element,
		}));
	});
	const targetsRef = useRef(targets);
	targetsRef.current = targets;

	// Nothing to navigate to — close immediately rather than trap the keyboard.
	useEffect(() => {
		if (targets.length === 0) onExitRef.current();
	}, [targets.length]);

	const commit = useCallback((target: HintTarget) => {
		// Click while the element is still live, then close the overlay. The
		// click reuses the card's own navigation logic (split vs fullscreen,
		// detail modal for finished tasks), so behavior stays in lockstep.
		target.element.click();
		onExitRef.current();
	}, []);

	// Own every keystroke while active (capture phase + stopImmediatePropagation)
	// so neither focused inputs nor the app's global shortcuts react.
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopImmediatePropagation();
				onExitRef.current();
				return;
			}
			if (e.key === "Backspace") {
				e.preventDefault();
				e.stopImmediatePropagation();
				setTyped((prev) => prev.slice(0, -1));
				return;
			}
			// Let real chords (Cmd/Ctrl/Alt+key) fall through untouched.
			if (e.metaKey || e.ctrlKey || e.altKey) return;

			const key = e.key.toLowerCase();
			if (key.length === 1 && DEFAULT_HINT_CHARS.includes(key)) {
				e.preventDefault();
				e.stopImmediatePropagation();
				setTyped((prev) => {
					const next = prev + key;
					const matches = targetsRef.current.filter((tg) => tg.hint.startsWith(next));
					if (matches.length === 0) return prev; // dead key — keep current state
					if (matches.length === 1 && matches[0].hint === next) {
						commit(matches[0]);
						return prev;
					}
					return next;
				});
				return;
			}
			// Any other single key (space, letters outside the set, etc.): swallow
			// it so it can't leak to the board, but don't exit — only Esc exits.
			if (key.length === 1) {
				e.preventDefault();
				e.stopImmediatePropagation();
			}
		}
		window.addEventListener("keydown", onKeyDown, { capture: true });
		return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
	}, [commit]);

	// Recompute positions when the board scrolls or the window resizes.
	useEffect(() => {
		const bump = () => setTick((x) => x + 1);
		window.addEventListener("scroll", bump, { capture: true, passive: true });
		window.addEventListener("resize", bump);
		return () => {
			window.removeEventListener("scroll", bump, { capture: true });
			window.removeEventListener("resize", bump);
		};
	}, []);

	const visible = useMemo(() => {
		// `tick` participates so live rects are re-read after scroll/resize.
		void tick;
		return targets
			.filter((tg) => tg.hint.startsWith(typed))
			.map((tg) => ({ target: tg, rect: tg.element.getBoundingClientRect() }));
	}, [targets, typed, tick]);

	if (targets.length === 0) return null;

	return createPortal(
		<div
			className="fixed inset-0 z-[70] pointer-events-none"
			data-testid="task-hint-overlay"
			data-hint-typed={typed}
		>
			{visible.map(({ target, rect }) => (
				<span
					key={target.id}
					data-testid="task-hint-label"
					data-hint={target.hint}
					className="absolute flex items-center rounded-md border border-hint-border bg-hint px-1.5 py-0.5 font-mono text-[0.6875rem] font-bold uppercase leading-none tracking-wide text-hint-fg shadow-lg shadow-black/40"
					style={{ top: rect.top + 4, left: rect.left + 4 }}
				>
					{[...target.hint].map((ch, i) => (
						<span key={i} className={i < typed.length ? "text-hint-typed" : undefined}>
							{ch}
						</span>
					))}
				</span>
			))}

			<div className="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full border border-edge bg-overlay/95 px-3.5 py-1.5 text-xs text-fg-3 shadow-xl shadow-black/30">
				{t("hint.legend")}
			</div>
		</div>,
		document.body,
	);
}

export default TaskHintOverlay;
