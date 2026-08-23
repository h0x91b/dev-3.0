import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { tourAdvanceAnchor, type Tour } from "../tour";

/**
 * Renders one step of a guided tour: a ring around the control the user should
 * touch, and a card beside it saying what it does.
 *
 * Deliberately NOT a modal. The dim is the ring's own outer shadow rather than a
 * backdrop node, and nothing outside the card takes pointer events, because the
 * whole point is that the user clicks the real button. Progress is then observed
 * from the DOM (`tourAdvanceAnchor`), so nothing has to report back.
 *
 * Positioning mirrors `HelpOverlay`/`HintOverlay`: measure the anchor's rect and
 * place absolutely. A single timer drives both the measuring and the "did the
 * next anchor appear" check — cheaper than a MutationObserver over the whole
 * document, and immune to portals and React commit timing.
 */

/** Anchor measuring + advance polling. Slow enough to be free, fast enough that
 *  a step lands before the user's eyes have moved. */
const TICK_MS = 100;
/** How long an anchorless step waits before the tour concludes it lost the
 *  thread. Long enough to survive a screen transition, short enough that a card
 *  never lingers over a screen it has nothing to do with. */
const LOST_ANCHOR_MS = 2500;

const CARD_WIDTH = 320;
const GAP = 12;

function anchorRect(anchor: string): DOMRect | null {
	const el = document.querySelector<HTMLElement>(`[data-tour-anchor="${CSS.escape(anchor)}"]`);
	if (!el) return null;
	const r = el.getBoundingClientRect();
	return r.width === 0 && r.height === 0 ? null : r;
}

function sameRect(a: DOMRect | null, b: DOMRect | null): boolean {
	if (!a || !b) return a === b;
	return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

/** Below the anchor when there is room, above otherwise, always inside the
 *  viewport — a card pinned half off-screen teaches nothing. */
function cardPosition(rect: DOMRect, cardHeight: number): { top: number; left: number } {
	const below = rect.bottom + GAP;
	const fitsBelow = below + cardHeight <= window.innerHeight - GAP;
	const top = fitsBelow ? below : Math.max(GAP, rect.top - GAP - cardHeight);
	const wanted = rect.left + rect.width / 2 - CARD_WIDTH / 2;
	const left = Math.min(Math.max(GAP, wanted), Math.max(GAP, window.innerWidth - CARD_WIDTH - GAP));
	return { top, left };
}

interface TourOverlayProps {
	tour: Tour;
	stepIndex: number;
	onStepChange: (index: number) => void;
	/** `completed` distinguishes "walked to the end" from skipped or lost. */
	onExit: (completed: boolean) => void;
}

export default function TourOverlay({ tour, stepIndex, onStepChange, onExit }: TourOverlayProps) {
	const t = useT();
	const step = tour.steps[stepIndex];
	const cardRef = useRef<HTMLDivElement | null>(null);
	const [rect, setRect] = useState<DOMRect | null>(() => (step ? anchorRect(step.anchor) : null));
	const [cardHeight, setCardHeight] = useState(150);

	const onExitRef = useRef(onExit);
	onExitRef.current = onExit;
	const onStepChangeRef = useRef(onStepChange);
	onStepChangeRef.current = onStepChange;

	const isLast = stepIndex === tour.steps.length - 1;
	const advanceAnchor = tourAdvanceAnchor(tour, stepIndex);

	// One timer per step: re-measure the ring, and watch for the anchor that means
	// the user performed the action. A step whose own anchor has been gone for
	// LOST_ANCHOR_MS ends the tour — the user went their own way.
	useEffect(() => {
		if (!step) return;
		let missingSince: number | null = null;
		// Auto-advance arms only once the target has been seen ABSENT. Without this,
		// stepping Back would re-advance on the very next tick — the modal that
		// satisfied the step is still open — and Back would be a dead button.
		let armed = advanceAnchor ? !anchorRect(advanceAnchor) : false;
		const tick = () => {
			const next = anchorRect(step.anchor);
			setRect((prev) => (sameRect(prev, next) ? prev : next));

			if (advanceAnchor) {
				const present = !!anchorRect(advanceAnchor);
				if (!present) armed = true;
				else if (armed) {
					onStepChangeRef.current(stepIndex + 1);
					return;
				}
			}
			if (next) {
				missingSince = null;
				return;
			}
			missingSince ??= performance.now();
			if (performance.now() - missingSince >= LOST_ANCHOR_MS) onExitRef.current(false);
		};
		tick();
		const timer = window.setInterval(tick, TICK_MS);
		return () => window.clearInterval(timer);
	}, [step, advanceAnchor, stepIndex]);

	useEffect(() => {
		const measured = cardRef.current?.offsetHeight;
		if (measured && measured !== cardHeight) setCardHeight(measured);
	}, [cardHeight, step, rect]);

	// Escape leaves the tour, like every other overlay in the app.
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopImmediatePropagation();
			onExitRef.current(false);
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	const advance = useCallback(() => {
		if (isLast) onExitRef.current(true);
		else onStepChangeRef.current(stepIndex + 1);
	}, [isLast, stepIndex]);

	if (!step) return null;

	// No anchor yet (a screen still mounting): the card parks bottom-centre rather
	// than vanishing, so Skip and Next stay reachable.
	const position = rect
		? cardPosition(rect, cardHeight)
		: { top: Math.max(GAP, window.innerHeight - cardHeight - 96), left: Math.max(GAP, window.innerWidth / 2 - CARD_WIDTH / 2) };

	return createPortal(
		<div className="fixed inset-0 z-[90] pointer-events-none" data-testid="tour-overlay" data-tour-step={step.id}>
			{rect && (
				<div
					aria-hidden="true"
					data-testid="tour-ring"
					// Ring only, no spotlight scrim. A full-screen dim was tried and dropped:
					// the last two steps ask the user to READ the terminal and the git bar,
					// and darkening the thing you are explaining is self-defeating.
					className="absolute rounded-xl border-2 border-accent bg-accent/10"
					style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }}
				/>
			)}
			<div
				ref={cardRef}
				role="dialog"
				aria-modal="false"
				aria-label={t(tour.titleKey)}
				className="absolute pointer-events-auto rounded-2xl border border-edge-active bg-overlay p-4 shadow-2xl shadow-black/50"
				style={{ top: position.top, left: position.left, width: CARD_WIDTH }}
			>
				<div className="flex items-baseline justify-between gap-3">
					<h2 className="text-fg text-sm font-semibold text-pretty">{t(step.titleKey)}</h2>
					<span className="text-fg-muted text-micro tabular-nums flex-shrink-0">
						{stepIndex + 1}/{tour.steps.length}
					</span>
				</div>
				<p className="text-fg-2 text-sm leading-relaxed text-pretty mt-1.5">{t(step.bodyKey)}</p>
				<div className="flex items-center justify-between gap-2 mt-3.5">
					<button
						type="button"
						onClick={() => onExitRef.current(false)}
						data-testid="tour-skip"
						className="text-fg-3 text-xs hover:text-fg transition-[color,transform] duration-150 ease-out motion-safe:active:scale-[0.96]"
					>
						{t("tour.skip")}
					</button>
					<div className="flex items-center gap-2">
						{stepIndex > 0 && (
							<button
								type="button"
								onClick={() => onStepChangeRef.current(stepIndex - 1)}
								data-testid="tour-back"
								className="px-3 py-1.5 rounded-lg border border-edge text-fg-2 text-xs font-medium hover:text-fg hover:border-edge-active transition-[color,border-color,transform] duration-150 ease-out motion-safe:active:scale-[0.96]"
							>
								{t("tour.back")}
							</button>
						)}
						<button
							type="button"
							onClick={advance}
							data-testid="tour-next"
							className="px-3.5 py-1.5 rounded-lg bg-accent-fill text-white text-xs font-semibold hover:bg-accent-fill-hover transition-[background-color,transform] duration-150 ease-out motion-safe:active:scale-[0.96]"
						>
							{t(isLast ? "tour.finish" : "tour.next")}
						</button>
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}
