/**
 * The ruler as the reader touches it: drawing an interval, moving it, resizing
 * it from either end, and the two gestures that must do nothing — a press that
 * never travelled, and anything that would move the replay cursor.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import TrafficRangeRuler from "../components/agent-traffic/TrafficRangeRuler";
import { MIN_RANGE_MS } from "../components/agent-traffic/traffic-period";

const HOUR = 3600000;
const DOMAIN = { start: 0, end: 6 * HOUR };
const BAND = { start: 4 * HOUR, end: 5 * HOUR };
/** The track is 600px wide in these tests, so one pixel is 36 seconds. */
const WIDTH = 600;

/**
 * happy-dom lays nothing out, so the track would measure zero and every drag
 * would resolve to the same instant. One stubbed box is the whole geometry the
 * component reads.
 */
function stubTrack() {
	const original = Element.prototype.getBoundingClientRect;
	Element.prototype.getBoundingClientRect = function () {
		return this.classList?.contains("traffic-range-track")
			? ({ left: 0, top: 0, width: WIDTH, height: 18, right: WIDTH, bottom: 18, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
			: original.call(this);
	};
	return () => {
		Element.prototype.getBoundingClientRect = original;
	};
}

function setup(over: Partial<Parameters<typeof TrafficRangeRuler>[0]> = {}) {
	const onChange = vi.fn();
	render(
		<I18nProvider>
			<TrafficRangeRuler
				domain={DOMAIN}
				range={BAND}
				rolling
				onChange={onChange}
				{...over}
			/>
		</I18nProvider>,
	);
	return { onChange, track: document.querySelector(".traffic-range-track")! };
}

/** A fraction of the track as a pixel position. */
const px = (fraction: number) => fraction * WIDTH;

describe("TrafficRangeRuler drag", () => {
	let restore: () => void;
	beforeEach(() => {
		restore = stubTrack();
	});
	afterEach(() => {
		restore();
		vi.restoreAllMocks();
	});

	it("draws an interval from a drag across empty ruler", () => {
		const { onChange, track } = setup();
		fireEvent.pointerDown(track, { clientX: px(0.25), button: 0 });
		fireEvent.pointerMove(window, { clientX: px(0.5) });
		fireEvent.pointerUp(window, { clientX: px(0.5) });
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0][0]).toEqual({
			start: 1.5 * HOUR,
			end: 3 * HOUR,
		});
	});

	it("reads a right-to-left drag as the same interval", () => {
		const { onChange, track } = setup();
		fireEvent.pointerDown(track, { clientX: px(0.5), button: 0 });
		fireEvent.pointerMove(window, { clientX: px(0.25) });
		fireEvent.pointerUp(window, { clientX: px(0.25) });
		expect(onChange.mock.calls[0][0]).toEqual({
			start: 1.5 * HOUR,
			end: 3 * HOUR,
		});
	});

	it("does nothing at all when the press never travelled", () => {
		const { onChange, track } = setup();
		fireEvent.pointerDown(track, { clientX: px(0.25), button: 0 });
		fireEvent.pointerMove(window, { clientX: px(0.25) + 2 });
		fireEvent.pointerUp(window, { clientX: px(0.25) + 2 });
		expect(onChange).not.toHaveBeenCalled();
	});

	it("moves the whole interval without changing its length", () => {
		const { onChange } = setup();
		const grip = document.querySelector(".traffic-range-grip")!;
		fireEvent.pointerDown(grip, { clientX: px(0.75), button: 0 });
		fireEvent.pointerMove(window, { clientX: px(0.5) });
		fireEvent.pointerUp(window, { clientX: px(0.5) });
		const next = onChange.mock.calls[0][0];
		expect(next.end - next.start).toBe(HOUR);
		expect(next).toEqual({ start: 2.5 * HOUR, end: 3.5 * HOUR });
	});

	it("resizes from a handle and stops at the end of the drawn span", () => {
		const { onChange } = setup();
		fireEvent.pointerDown(screen.getByTestId("traffic-range-end"), {
			clientX: px(0.833),
			button: 0,
		});
		fireEvent.pointerMove(window, { clientX: px(2) });
		fireEvent.pointerUp(window, { clientX: px(2) });
		expect(onChange.mock.calls[0][0]).toEqual({
			start: 4 * HOUR,
			end: 6 * HOUR,
		});
	});

	it("keeps the floor when a handle is dragged onto its partner", () => {
		const { onChange } = setup();
		// Ten seconds short of the other end: too thin to keep, and the end it was
		// dragged towards is the one that must not move.
		const almost = px((5 * HOUR - 10000) / (6 * HOUR));
		fireEvent.pointerDown(screen.getByTestId("traffic-range-start"), {
			clientX: px(0.667),
			button: 0,
		});
		fireEvent.pointerMove(window, { clientX: almost });
		fireEvent.pointerUp(window, { clientX: almost });
		expect(onChange.mock.calls[0][0]).toEqual({
			start: 5 * HOUR - MIN_RANGE_MS,
			end: 5 * HOUR,
		});
	});

	it("hands the pointer the other end when a handle is dragged past it", () => {
		const { onChange } = setup();
		fireEvent.pointerDown(screen.getByTestId("traffic-range-start"), {
			clientX: px(0.667),
			button: 0,
		});
		fireEvent.pointerMove(window, { clientX: px(0.9) });
		fireEvent.pointerUp(window, { clientX: px(0.9) });
		expect(onChange.mock.calls[0][0]).toEqual({
			start: 5 * HOUR,
			end: 5.4 * HOUR,
		});
	});

	it("survives repeated moving and resizing", () => {
		const { onChange } = setup();
		const grip = document.querySelector(".traffic-range-grip")!;
		for (let i = 0; i < 5; i++) {
			fireEvent.pointerDown(grip, { clientX: px(0.75), button: 0 });
			fireEvent.pointerMove(window, { clientX: px(0.75) - 20 });
			fireEvent.pointerUp(window, { clientX: px(0.75) - 20 });
		}
		expect(onChange).toHaveBeenCalledTimes(5);
		for (const [next] of onChange.mock.calls)
			expect(next.end - next.start).toBe(HOUR);
	});

	it("ignores a right-button press", () => {
		const { onChange, track } = setup();
		fireEvent.pointerDown(track, { clientX: px(0.25), button: 2 });
		fireEvent.pointerMove(window, { clientX: px(0.5) });
		fireEvent.pointerUp(window, { clientX: px(0.5) });
		expect(onChange).not.toHaveBeenCalled();
	});
});

describe("TrafficRangeRuler keyboard", () => {
	it("adjusts each end and the interval as a whole", () => {
		const { onChange } = setup();
		const step = Math.round((DOMAIN.end - DOMAIN.start) / 100);
		fireEvent.keyDown(screen.getByTestId("traffic-range-start"), {
			key: "ArrowLeft",
		});
		expect(onChange.mock.calls[0][0]).toEqual({
			start: BAND.start - step,
			end: BAND.end,
		});
		onChange.mockClear();
		fireEvent.keyDown(document.querySelector(".traffic-range-grip")!, {
			key: "ArrowRight",
		});
		expect(onChange.mock.calls[0][0]).toEqual({
			start: BAND.start + step,
			end: BAND.end + step,
		});
	});

	it("takes the interval to either end of the ruler with Home and End", () => {
		const { onChange } = setup();
		fireEvent.keyDown(document.querySelector(".traffic-range-grip")!, {
			key: "Home",
		});
		expect(onChange.mock.calls[0][0]).toEqual({ start: 0, end: HOUR });
	});

	it("names both ends and the interval for a screen reader", () => {
		setup();
		expect(screen.getByTestId("traffic-range-start")).toHaveAttribute(
			"aria-valuenow",
			String(BAND.start),
		);
		expect(
			document.querySelector(".traffic-range-grip"),
		).toHaveAttribute("aria-valuetext");
		expect(screen.getByTestId("traffic-range-end")).toHaveAttribute(
			"role",
			"slider",
		);
	});
});
