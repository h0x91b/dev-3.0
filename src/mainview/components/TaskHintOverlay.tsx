import { useEffect, useRef, useState } from "react";
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

/**
 * A card is hintable only if it's on screen AND actually the top-most element at
 * its badge anchor. The occlusion test does double duty:
 *   - cards hidden behind a modal/palette backdrop are skipped, so pressing `f`
 *     while a dialog is open yields no hints and the overlay closes itself;
 *   - cards scrolled under a column's own scroll-clip or the page header are
 *     skipped, so no phantom badge floats in the header over an off-screen card.
 */
function isHintable(el: HTMLElement): boolean {
	const r = el.getBoundingClientRect();
	if (r.width === 0 || r.height === 0) return false;
	if (r.bottom <= 0 || r.right <= 0 || r.top >= window.innerHeight || r.left >= window.innerWidth) {
		return false;
	}
	// Probe just inside the top-left, where the badge sits.
	const x = Math.max(0, Math.min(window.innerWidth - 1, r.left + 8));
	const y = Math.max(0, Math.min(window.innerHeight - 1, r.top + 8));
	const topEl = typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null;
	// No layout engine (e.g. jsdom) → can't test occlusion; trust the viewport check.
	if (!topEl) return true;
	return el.contains(topEl);
}

/**
 * Collect one clickable element per task currently on screen.
 *
 * A single task can carry `data-task-id` on more than one element — the column
 * wraps each card in a `<div data-task-id>` for drag-and-drop AND the card root
 * itself has it. Only the innermost element owns the navigation `onClick`, so
 * for each id we keep the element that has no descendant sharing the same id.
 * Clones living inside dialogs/popovers (e.g. the stuck-preparation popover)
 * are skipped — they have no navigation handler.
 */
function scanTargets(): Array<{ id: string; element: HTMLElement }> {
	const all = Array.from(document.querySelectorAll<HTMLElement>("[data-task-id]"));
	const byId = new Map<string, HTMLElement>();
	for (const el of all) {
		const id = el.getAttribute("data-task-id");
		if (!id) continue;
		if (el.closest('[role="dialog"]')) continue;
		if (!isHintable(el)) continue;
		// Not the innermost element (it wraps another node with the same id).
		if (el.querySelector(`[data-task-id="${CSS.escape(id)}"]`)) continue;
		if (!byId.has(id)) byId.set(id, el);
	}
	// Order spatially: down each column (left→right), top→bottom within a column,
	// so the shortest/earliest hints land on the top-left cards.
	return Array.from(byId, ([id, element]) => ({ id, element })).sort((a, b) => {
		const ra = a.element.getBoundingClientRect();
		const rb = b.element.getBoundingClientRect();
		return ra.left - rb.left || ra.top - rb.top;
	});
}

function TaskHintOverlay({ onExit }: TaskHintOverlayProps) {
	const t = useT();
	const [typed, setTyped] = useState("");
	// Mirror of `typed` for the keydown handler so it stays pure (no reading
	// state inside a state updater).
	const typedRef = useRef("");
	// Re-render trigger to re-read live rects after scroll/resize.
	const [, bumpReposition] = useState(0);

	const onExitRef = useRef(onExit);
	onExitRef.current = onExit;

	const [targets] = useState<HintTarget[]>(() => {
		const found = scanTargets();
		const hints = generateHintStrings(found.length);
		return found.map(({ id, element }, i) => ({ id, hint: hints[i], element }));
	});
	const targetsRef = useRef(targets);
	targetsRef.current = targets;

	// Nothing to navigate to — close immediately rather than trap the keyboard.
	useEffect(() => {
		if (targets.length === 0) onExitRef.current();
	}, [targets.length]);

	// Own every keystroke while active (capture phase + stopImmediatePropagation)
	// so neither focused inputs nor the app's global shortcuts react.
	useEffect(() => {
		function setTypedBoth(next: string) {
			typedRef.current = next;
			setTyped(next);
		}
		function commit(target: HintTarget) {
			onExitRef.current();
			// The card may have detached (column move, websocket update) while the
			// overlay was open — clicking an orphan would silently do nothing.
			if (!document.contains(target.element)) return;
			// Reuses the card's own navigation logic (split vs fullscreen, detail
			// modal for finished tasks), so behavior stays in lockstep.
			target.element.click();
		}
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
				setTypedBoth(typedRef.current.slice(0, -1));
				return;
			}
			// Let real chords (Cmd/Ctrl/Alt+key) fall through untouched.
			if (e.metaKey || e.ctrlKey || e.altKey) return;

			const key = e.key.toLowerCase();
			if (key.length === 1 && DEFAULT_HINT_CHARS.includes(key)) {
				e.preventDefault();
				e.stopImmediatePropagation();
				const next = typedRef.current + key;
				const matches = targetsRef.current.filter((tg) => tg.hint.startsWith(next));
				if (matches.length === 0) return; // dead key — ignore
				if (matches.length === 1 && matches[0].hint === next) {
					commit(matches[0]);
					return;
				}
				setTypedBoth(next);
				return;
			}
			// Any other single key: swallow it so it can't leak to the board, but
			// don't exit — only Esc exits.
			if (key.length === 1) {
				e.preventDefault();
				e.stopImmediatePropagation();
			}
		}
		window.addEventListener("keydown", onKeyDown, { capture: true });
		return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
	}, []);

	// Recompute positions when the board scrolls or the window resizes.
	useEffect(() => {
		const bump = () => bumpReposition((x) => x + 1);
		window.addEventListener("scroll", bump, { capture: true, passive: true });
		window.addEventListener("resize", bump);
		return () => {
			window.removeEventListener("scroll", bump, { capture: true });
			window.removeEventListener("resize", bump);
		};
	}, []);

	if (targets.length === 0) return null;

	// Recomputed every render (cheap for a handful of cards); the reposition
	// re-render above keeps the live rects fresh during scroll/resize.
	const visible = targets
		.filter((tg) => tg.hint.startsWith(typed))
		.map((tg) => ({ target: tg, rect: tg.element.getBoundingClientRect() }));

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
