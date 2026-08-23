import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { tourAdvanceAnchor, type Tour } from "../tour";

/**
 * Renders one step of a guided tour: a hole around the control the user should
 * touch, a card beside it, and a shield over everything else.
 *
 * The shield is the point. A pointing-only overlay was tried first and died on
 * its first live run: every other control stayed live, so the user clicked past
 * the step, the step's anchor never appeared, and the tour quit — see the
 * decision record. Now the ringed control and the card are the only clickable
 * things on screen, so the only way forward is the way the step describes.
 *
 * Progress is still observed from the DOM (`tourAdvanceAnchor`), so a
 * participating control costs one attribute and never calls in.
 *
 * Positioning mirrors `HelpOverlay`/`HintOverlay`: measure the anchor's rect and
 * place absolutely. A single timer drives the measuring, the shield geometry and
 * the "did the next anchor appear" check — cheaper than a MutationObserver over
 * the whole document, and immune to portals and React commit timing.
 */

/** Anchor measuring + advance polling. Slow enough to be free, fast enough that
 *  a step lands before the user's eyes have moved. */
const TICK_MS = 100;
/** How long an anchorless step waits before it says so. Long enough to survive a
 *  screen transition; then the card offers restart-or-leave rather than
 *  vanishing, because a tour that disappears mid-flow reads as a crash. */
const LOST_ANCHOR_MS = 2500;
/** How long a blocked click keeps the ring emphasised. */
const NUDGE_MS = 600;

const CARD_WIDTH = 320;
const GAP = 12;
/** Slack between the anchor's box and the hole in the shield. */
const HOLE_PAD = 4;

function anchorEl(anchor: string): HTMLElement | null {
	return document.querySelector<HTMLElement>(`[data-tour-anchor="${CSS.escape(anchor)}"]`);
}

function anchorRect(anchor: string): DOMRect | null {
	const el = anchorEl(anchor);
	if (!el) return null;
	const r = el.getBoundingClientRect();
	return r.width === 0 && r.height === 0 ? null : r;
}

/** The furthest step whose anchor is on screen right now — i.e. how far the app
 *  itself has actually got. Used to re-find the tour's place instead of guessing:
 *  the app cannot be rewound, so the tour follows it, never the other way round.
 *  Furthest, not first: the board's New Task button is visible under every modal,
 *  and picking it would drag the user back to step one. */
function resyncTarget(tour: Tour, stepIndex: number): number | null {
	for (let i = tour.steps.length - 1; i >= 0; i--) {
		if (i === stepIndex) continue;
		if (anchorRect(tour.steps[i].anchor)) return i;
	}
	return null;
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
	const [lost, setLost] = useState(false);
	const [nudging, setNudging] = useState(false);
	const [backReachable, setBackReachable] = useState(false);

	const onExitRef = useRef(onExit);
	onExitRef.current = onExit;
	const onStepChangeRef = useRef(onStepChange);
	onStepChangeRef.current = onStepChange;

	const isLast = stepIndex === tour.steps.length - 1;
	const advanceAnchor = tourAdvanceAnchor(tour, stepIndex);
	// Back is only honest over an explanation whose screen is still up. A step that
	// pressed a real control cannot be undone — the task exists, the modal is gone —
	// so stepping back onto it would land on a dead anchor. Live QA found exactly
	// that: Back from Launch pointed at Save & Start in a modal that had closed.
	const prevStep = stepIndex > 0 ? tour.steps[stepIndex - 1] : undefined;
	const prevAnchor = prevStep && !prevStep.action ? prevStep.anchor : null;

	// One timer per step: re-measure the hole, and watch for the anchor that means
	// the user performed the action.
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
			setBackReachable(prevAnchor ? !!anchorRect(prevAnchor) : false);

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
				setLost(false);
				return;
			}
			// A step that waits for something the agent produces is not lost while its
			// anchor is missing — that IS the step. It parks and says so.
			if (step.waitsForAnchor) return;
			missingSince ??= performance.now();
			if (performance.now() - missingSince < LOST_ANCHOR_MS) return;
			// The last step's anchor going away is the user finishing the last action,
			// not the tour losing its place. Ending here is the ending.
			if (stepIndex === tour.steps.length - 1) {
				onExitRef.current(true);
				return;
			}
			// The step's screen is gone. Follow the app to wherever it actually is
			// before admitting defeat — that turns a dead end into a silent recovery.
			const resync = resyncTarget(tour, stepIndex);
			if (resync !== null) {
				onStepChangeRef.current(resync);
				return;
			}
			setLost(true);
		};
		tick();
		const timer = window.setInterval(tick, TICK_MS);
		return () => window.clearInterval(timer);
	}, [step, advanceAnchor, stepIndex, tour, prevAnchor]);

	useEffect(() => {
		setLost(false);
	}, [stepIndex]);

	useEffect(() => {
		const measured = cardRef.current?.offsetHeight;
		if (measured && measured !== cardHeight) setCardHeight(measured);
	}, [cardHeight, step, rect]);

	// Escape leaves the tour, like every other overlay in the app. The only other
	// way out is the Skip button — a stray click cannot end it any more.
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

	// A click on the shield is the user reaching for something the step did not
	// ask for. Say so with the ring rather than silently eating it.
	const nudgeTimer = useRef<number | null>(null);
	const nudge = useCallback(() => {
		setNudging(true);
		if (nudgeTimer.current) window.clearTimeout(nudgeTimer.current);
		nudgeTimer.current = window.setTimeout(() => setNudging(false), NUDGE_MS);
	}, []);
	useEffect(() => () => { if (nudgeTimer.current) window.clearTimeout(nudgeTimer.current); }, []);

	// The primary button. A step that names one control presses it (`action`), a
	// step that only explains moves on, and a step waiting on a choice the user
	// must make themselves has no primary button at all.
	const clickAnchor = useCallback(() => {
		if (!step) return;
		const el = anchorEl(step.anchor);
		if (!el) return;
		// A disabled control eats the click and nothing happens, which reads as the
		// card being broken. Live QA hit exactly that on Merge, which stays disabled
		// until the agent has committed. Flash the ring instead of lying.
		const off = (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
		if (off) { nudge(); return; }
		el.click();
	}, [step, nudge]);

	const advance = useCallback(() => {
		if (step?.action === "click-anchor") { clickAnchor(); return; }
		if (isLast) onExitRef.current(true);
		else onStepChangeRef.current(stepIndex + 1);
	}, [step, clickAnchor, isLast, stepIndex]);

	if (!step) return null;

	const waiting = !!advanceAnchor && step.action !== "click-anchor";
	// Waiting on the agent, not on the user: the step's own anchor has not been
	// produced yet. Its Next is hidden, or pressing it would skip the very thing
	// the step exists to show.
	const pendingAnchor = !!step.waitsForAnchor && !rect;
	const primaryLabel = step.action === "click-anchor" ? t("tour.doIt") : t(isLast ? "tour.finish" : "tour.next");

	// No anchor yet (a screen still mounting): the card parks bottom-centre rather
	// than vanishing, so Skip and Next stay reachable.
	const position = rect
		? cardPosition(rect, cardHeight)
		: { top: Math.max(GAP, window.innerHeight - cardHeight - 96), left: Math.max(GAP, window.innerWidth / 2 - CARD_WIDTH / 2) };

	// Shield: four bands around the hole, so the hole is a real gap in the DOM and
	// the control inside it receives clicks normally. With no anchor to spare, the
	// whole viewport is covered.
	const hole = rect
		? { top: rect.top - HOLE_PAD, left: rect.left - HOLE_PAD, right: rect.right + HOLE_PAD, bottom: rect.bottom + HOLE_PAD }
		: null;
	// Waiting on the agent is the one state with nothing to enforce, so it must not
	// cage: live QA caught the agent asking for permission while the shield covered
	// the whole screen, and the answer it was waiting for could not be typed.
	const bands: { key: string; style: React.CSSProperties }[] = pendingAnchor
		? []
		: hole
		? [
				{ key: "top", style: { top: 0, left: 0, right: 0, height: Math.max(0, hole.top) } },
				{ key: "bottom", style: { top: Math.max(0, hole.bottom), left: 0, right: 0, bottom: 0 } },
				{ key: "left", style: { top: Math.max(0, hole.top), height: hole.bottom - hole.top, left: 0, width: Math.max(0, hole.left) } },
				{ key: "right", style: { top: Math.max(0, hole.top), height: hole.bottom - hole.top, left: Math.max(0, hole.right), right: 0 } },
			]
		: [{ key: "all", style: { inset: 0 } }];

	return createPortal(
		<div
			className="fixed inset-0 z-[90] pointer-events-none"
			data-testid="tour-overlay"
			data-tour-step={step.id}
			data-tour-lost={lost ? "true" : undefined}
		>
			{bands.map((band) => (
				<div
					key={band.key}
					aria-hidden="true"
					data-testid={`tour-shield-${band.key}`}
					onClick={nudge}
					className="absolute pointer-events-auto bg-black/45 cursor-not-allowed"
					style={band.style}
				/>
			))}
			{rect && (
				<div
					aria-hidden="true"
					data-testid="tour-ring"
					className={`absolute rounded-xl border-2 pointer-events-none transition-colors duration-150 ${
						nudging ? "border-accent bg-accent/25 ring-4 ring-accent/30" : "border-accent bg-accent/10"
					}`}
					style={{ top: hole?.top, left: hole?.left, width: rect.width + HOLE_PAD * 2, height: rect.height + HOLE_PAD * 2 }}
				/>
			)}
			<div
				ref={cardRef}
				role="dialog"
				aria-modal="true"
				aria-label={t(tour.titleKey)}
				className="absolute pointer-events-auto rounded-2xl border border-edge-active bg-overlay p-4 shadow-2xl shadow-black/50"
				style={{ top: position.top, left: position.left, width: CARD_WIDTH }}
			>
				<div className="flex items-baseline justify-between gap-3">
					<h2 className="text-fg text-sm font-semibold text-pretty">{t(lost ? "tour.lost.title" : step.titleKey)}</h2>
					<span className="text-fg-muted text-micro tabular-nums flex-shrink-0">
						{stepIndex + 1}/{tour.steps.length}
					</span>
				</div>
				<p className="text-fg-2 text-sm leading-relaxed text-pretty mt-1.5">{t(lost ? "tour.lost.body" : step.bodyKey)}</p>
				{waiting && !lost && (
					<p className="text-fg-3 text-xs mt-2" data-testid="tour-waiting">{t("tour.waiting")}</p>
				)}
				{pendingAnchor && !lost && (
					<p className="text-fg-3 text-xs mt-2" data-testid="tour-pending">{t("tour.pending")}</p>
				)}
				<div className="flex items-center justify-between gap-2 mt-3.5">
					<button
						type="button"
						onClick={() => onExitRef.current(false)}
						data-testid="tour-skip"
						className="text-fg-3 text-xs hover:text-fg transition-[color,transform] duration-150 ease-out motion-safe:active:scale-[0.96]"
					>
						{t(lost ? "tour.exit" : "tour.skip")}
					</button>
					<div className="flex items-center gap-2">
						{!lost && stepIndex > 0 && backReachable && (
							<button
								type="button"
								onClick={() => onStepChangeRef.current(stepIndex - 1)}
								data-testid="tour-back"
								className="px-3 py-1.5 rounded-lg border border-edge text-fg-2 text-xs font-medium hover:text-fg hover:border-edge-active transition-[color,border-color,transform] duration-150 ease-out motion-safe:active:scale-[0.96]"
							>
								{t("tour.back")}
							</button>
						)}
						{/* No restart button here on purpose: the lost state is only reached
						    when not one step's anchor is on screen, so there is nowhere to
						    restart to. Re-entry lives in help mode instead. */}
						{!lost &&
							!waiting &&
							!pendingAnchor && (
								<button
									type="button"
									onClick={advance}
									data-testid="tour-next"
									className="px-3.5 py-1.5 rounded-lg bg-accent-fill text-white text-xs font-semibold hover:bg-accent-fill-hover transition-[background-color,transform] duration-150 ease-out motion-safe:active:scale-[0.96]"
								>
									{primaryLabel}
								</button>
							)}
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}
