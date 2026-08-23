import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TourOverlay from "../TourOverlay";
import { I18nProvider } from "../../i18n";
import type { Tour } from "../../tour";

/**
 * The engine's contract: it advances on an anchor appearing, it must NOT
 * re-advance the instant you press Back, its button presses the real control,
 * everything else on screen is shielded, and losing the anchor says so instead
 * of ending the tour. Timing behaviour throughout, so the clock is fake and
 * jsdom's zero-sized rects are given real numbers.
 */

const TOUR: Tour = {
	id: "test-tour",
	titleKey: "tour.firstTask.title",
	steps: [
		{ id: "one", anchor: "a", titleKey: "tour.firstTask.newTask.title", bodyKey: "tour.firstTask.newTask.body", action: "click-anchor" },
		{ id: "two", anchor: "b", titleKey: "tour.firstTask.prompt.title", bodyKey: "tour.firstTask.prompt.body", advanceOn: "manual" },
	],
};

/** A step that waits on a choice only the user can make: an advance anchor, no action. */
const WAITING_TOUR: Tour = {
	id: "waiting-tour",
	titleKey: "tour.firstTask.title",
	steps: [
		{ id: "pick", anchor: "a", titleKey: "tour.firstTask.launch.title", bodyKey: "tour.firstTask.launch.body", advanceOn: "b" },
		{ id: "done", anchor: "b", titleKey: "tour.firstTask.review.title", bodyKey: "tour.firstTask.review.body", advanceOn: "manual" },
	],
};

const anchors: HTMLElement[] = [];

/** happy-dom measures everything as 0×0, which the overlay reads as "no anchor". */
function anchor(id: string): HTMLElement {
	const el = document.createElement("div");
	anchors.push(el);
	el.setAttribute("data-tour-anchor", id);
	el.getBoundingClientRect = () => ({ top: 10, left: 10, width: 100, height: 20, bottom: 30, right: 110, x: 10, y: 10, toJSON: () => ({}) }) as DOMRect;
	document.body.appendChild(el);
	return el;
}

function renderTour(
	stepIndex: number,
	handlers: { onStepChange?: (i: number) => void; onExit?: (done: boolean) => void } = {},
	tour: Tour = TOUR,
) {
	return render(
		<I18nProvider>
			<TourOverlay
				tour={tour}
				stepIndex={stepIndex}
				onStepChange={handlers.onStepChange ?? (() => {})}
				onExit={handlers.onExit ?? (() => {})}
			/>
		</I18nProvider>,
	);
}

/** Push the overlay's polling loop forward by `ms` of fake time. */
function tick(ms: number) {
	act(() => { vi.advanceTimersByTime(ms); });
}

describe("TourOverlay", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		// Only our own nodes — wiping the whole body steals the portal container
		// React unmounts into and turns cleanup into a DOMException.
		while (anchors.length > 0) anchors.pop()?.remove();
	});

	it("rings the step's anchor and names the step", () => {
		anchor("a");
		renderTour(0);
		expect(screen.getByTestId("tour-ring")).toBeInTheDocument();
		expect(screen.getByTestId("tour-overlay")).toHaveAttribute("data-tour-step", "one");
		expect(screen.getByText("1/2")).toBeInTheDocument();
	});

	it("shields the screen around the anchor, leaving the anchor itself clickable", () => {
		anchor("a");
		renderTour(0);
		for (const band of ["top", "bottom", "left", "right"]) {
			expect(screen.getByTestId(`tour-shield-${band}`)).toBeInTheDocument();
		}
		expect(screen.queryByTestId("tour-shield-all")).not.toBeInTheDocument();
	});

	it("shields the whole viewport when there is no anchor to spare", () => {
		renderTour(0);
		expect(screen.getByTestId("tour-shield-all")).toBeInTheDocument();
		expect(screen.queryByTestId("tour-shield-top")).not.toBeInTheDocument();
	});

	it("presses the real control instead of faking progress", () => {
		const el = anchor("a");
		const clicked = vi.fn();
		el.addEventListener("click", clicked);
		const onStepChange = vi.fn();
		renderTour(0, { onStepChange });

		fireEvent.click(screen.getByTestId("tour-next"));
		expect(clicked).toHaveBeenCalled();
		// The step ends when the DOM says so, never because the button was pressed.
		expect(onStepChange).not.toHaveBeenCalled();
	});

	it("has no button at all on a step waiting for the user's own choice", () => {
		anchor("a");
		renderTour(0, {}, WAITING_TOUR);
		expect(screen.queryByTestId("tour-next")).not.toBeInTheDocument();
		expect(screen.getByTestId("tour-waiting")).toBeInTheDocument();
	});

	it("advances on its own once the next step's anchor appears", () => {
		anchor("a");
		const onStepChange = vi.fn();
		renderTour(0, { onStepChange });
		tick(200);
		expect(onStepChange).not.toHaveBeenCalled();

		anchor("b");
		tick(200);
		expect(onStepChange).toHaveBeenCalledWith(1);
	});

	it("does not re-advance when the target is already on screen (Back stays usable)", () => {
		anchor("a");
		anchor("b");
		const onStepChange = vi.fn();
		renderTour(0, { onStepChange });
		tick(1000);
		// `b` was never observed absent, so auto-advance is unarmed: this is the
		// state right after pressing Back out of step two.
		expect(onStepChange).not.toHaveBeenCalled();
	});

	it("says it lost the thread instead of ending the tour", () => {
		const el = anchor("a");
		const onExit = vi.fn();
		const onStepChange = vi.fn();
		renderTour(0, { onExit, onStepChange });
		tick(200);
		expect(screen.queryByTestId("tour-restart")).not.toBeInTheDocument();

		el.remove();
		tick(1000);
		expect(screen.queryByTestId("tour-restart")).not.toBeInTheDocument();
		tick(2000);
		expect(screen.getByTestId("tour-restart")).toBeInTheDocument();
		expect(onExit).not.toHaveBeenCalled();

		fireEvent.click(screen.getByTestId("tour-restart"));
		expect(onStepChange).toHaveBeenCalledWith(0);
	});

	it("recovers on its own when the anchor comes back", () => {
		const el = anchor("a");
		renderTour(0);
		el.remove();
		tick(3000);
		expect(screen.getByTestId("tour-restart")).toBeInTheDocument();

		anchor("a");
		tick(200);
		expect(screen.queryByTestId("tour-restart")).not.toBeInTheDocument();
	});

	it("reports a completed tour from the last step's button", () => {
		anchor("b");
		const onExit = vi.fn();
		renderTour(1, { onExit });
		fireEvent.click(screen.getByTestId("tour-next"));
		expect(onExit).toHaveBeenCalledWith(true);
	});

	it("reports skipping as not completed", () => {
		anchor("a");
		const onExit = vi.fn();
		renderTour(0, { onExit });
		fireEvent.click(screen.getByTestId("tour-skip"));
		expect(onExit).toHaveBeenCalledWith(false);
	});

	it("keeps the card reachable while no anchor is on screen", () => {
		renderTour(0);
		expect(screen.queryByTestId("tour-ring")).not.toBeInTheDocument();
		expect(screen.getByTestId("tour-next")).toBeInTheDocument();
		expect(screen.getByTestId("tour-skip")).toBeInTheDocument();
	});

	it("offers Back on a later step only", () => {
		anchor("b");
		renderTour(1);
		expect(screen.getByTestId("tour-back")).toBeInTheDocument();
	});
});
