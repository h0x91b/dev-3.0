import type { TranslationKey } from "./i18n";

/**
 * Guided tours — the "hold my hand once" surface, and the counterpart of help
 * mode rather than a second copy of it.
 *
 * Help mode answers "what am I looking at": you ask, it explains a zone, it
 * explains nothing about order. A newcomer on an empty board has the other
 * question — "what do I press, and why" — and no amount of per-zone copy answers
 * it, because the answer is a sequence across four surfaces (board → Create Task
 * → Launch → task screen).
 *
 * Shape of the mechanism, and the two rules that keep it reusable:
 *
 * 1. **A step points, it does not block.** The overlay draws a ring and a card
 *    and nothing else is click-shielded, so the user performs the real action on
 *    the real control. There is no fake "Next" that does the work for them.
 * 2. **Progress is observed, not reported.** A step advances when the DOM shows
 *    the next anchor, so no component has to call into the tour. Participating
 *    costs one `data-tour-anchor="<id>"` attribute.
 *
 * A tour that loses sight of its anchor gives up quietly (`TourOverlay`), which
 * is what happens whenever the user goes their own way — the wizard is a guide,
 * never a cage.
 */

/** A side effect the app performs when a step opens. Kept as a tiny closed set:
 *  the registry stays data, and `App.tsx` owns the actual doing. */
export type TourEffect = "prefill-sandbox-prompt";

export interface TourStep {
	id: string;
	/** `data-tour-anchor` value of the element this step points at. */
	anchor: string;
	titleKey: TranslationKey;
	bodyKey: TranslationKey;
	/**
	 * Anchor whose appearance means "the user did it" and advances the tour.
	 * Defaults to the next step's anchor; `"manual"` waits for the Next button
	 * (used for steps that only explain what is already on screen).
	 */
	advanceOn?: string | "manual";
	effect?: TourEffect;
}

export interface Tour {
	id: string;
	titleKey: TranslationKey;
	steps: TourStep[];
}

/** The one tour today: an empty sandbox board → an agent actually working. */
export const FIRST_TASK_TOUR_ID = "first-task";

const FIRST_TASK_TOUR: Tour = {
	id: FIRST_TASK_TOUR_ID,
	titleKey: "tour.firstTask.title",
	steps: [
		{
			id: "new-task",
			anchor: "board.new-task",
			titleKey: "tour.firstTask.newTask.title",
			bodyKey: "tour.firstTask.newTask.body",
			advanceOn: "create-task.prompt",
			// The prompt is filled in before the modal opens, so the step below can
			// point at real text instead of asking a newcomer to invent one.
			effect: "prefill-sandbox-prompt",
		},
		{
			id: "prompt",
			anchor: "create-task.prompt",
			titleKey: "tour.firstTask.prompt.title",
			bodyKey: "tour.firstTask.prompt.body",
			advanceOn: "manual",
		},
		{
			id: "start",
			anchor: "create-task.run",
			titleKey: "tour.firstTask.start.title",
			bodyKey: "tour.firstTask.start.body",
			advanceOn: "launch.variants",
		},
		{
			id: "launch",
			anchor: "launch.variants",
			titleKey: "tour.firstTask.launch.title",
			bodyKey: "tour.firstTask.launch.body",
			advanceOn: "board.running-task",
		},
		// Launching from the board does NOT navigate to the task — verified in a
		// browser, where the tour ran out of anchors here and quit. So the handover is
		// a step of its own, and it teaches what a card in Agent is Working is for.
		{
			id: "open-task",
			anchor: "board.running-task",
			titleKey: "tour.firstTask.openTask.title",
			bodyKey: "tour.firstTask.openTask.body",
			advanceOn: "task.terminal",
		},
		{
			id: "terminal",
			anchor: "task.terminal",
			titleKey: "tour.firstTask.terminal.title",
			bodyKey: "tour.firstTask.terminal.body",
			advanceOn: "manual",
		},
		{
			id: "review",
			anchor: "task.git-bar",
			titleKey: "tour.firstTask.review.title",
			bodyKey: "tour.firstTask.review.body",
			advanceOn: "manual",
		},
	],
};

export const TOURS: Tour[] = [FIRST_TASK_TOUR];

const TOUR_BY_ID = new Map(TOURS.map((tour) => [tour.id, tour]));

export function tourById(id: string): Tour | undefined {
	return TOUR_BY_ID.get(id);
}

/** What a step waits for: its own `advanceOn`, else the next step's anchor, else
 *  nothing (the last step finishes on its button). */
export function tourAdvanceAnchor(tour: Tour, index: number): string | null {
	const step = tour.steps[index];
	if (!step) return null;
	if (step.advanceOn === "manual") return null;
	return step.advanceOn ?? tour.steps[index + 1]?.anchor ?? null;
}

/** DOM event any surface can fire to start a tour: `startTour("first-task")`. */
export const TOUR_START_EVENT = "tour:start";

export function startTour(tourId: string): void {
	window.dispatchEvent(new CustomEvent(TOUR_START_EVENT, { detail: tourId }));
}
