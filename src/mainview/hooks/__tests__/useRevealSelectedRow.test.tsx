import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { computeRevealScrollTop, useRevealSelectedRow } from "../useRevealSelectedRow";

/** Container viewport: 0..200 in client coords, with a 20px sticky tier header. */
const CONTAINER_TOP = 0;
const CONTAINER_BOTTOM = 200;
const HEADER_HEIGHT = 20;
const ROW_HEIGHT = 40;

/** Rects come from `data-rect`, since happy-dom has no layout. */
function stubRects() {
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
		const raw = (this as HTMLElement).dataset.rect;
		const { top = 0, bottom = 0 } = raw ? JSON.parse(raw) : {};
		return { top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} } as DOMRect;
	});
}

interface HarnessProps {
	order: string[];
	selectedId: string | null;
	/** Scroll offset the rects are drawn at — the test keeps it in sync with the element. */
	scrollTop: number;
	/** Stands in for an unrelated task update: re-renders without moving anything. */
	tick?: number;
}

function Harness({ order, selectedId, scrollTop }: HarnessProps) {
	const listRef = useRef<HTMLDivElement>(null);
	const index = selectedId ? order.indexOf(selectedId) : -1;
	useRevealSelectedRow(listRef, selectedId, index >= 0 ? `${selectedId}:${index}` : null);
	return (
		<div
			ref={listRef}
			data-testid="list"
			data-rect={JSON.stringify({ top: CONTAINER_TOP, bottom: CONTAINER_BOTTOM })}
		>
			<div data-sidebar-tier>
				<div data-sidebar-tier-header data-rect={JSON.stringify({ top: CONTAINER_TOP, bottom: CONTAINER_TOP + HEADER_HEIGHT })} />
				{order.map((id, i) => {
					const top = CONTAINER_TOP - scrollTop + HEADER_HEIGHT + i * ROW_HEIGHT;
					return <div key={id} data-task-id={id} data-rect={JSON.stringify({ top, bottom: top + ROW_HEIGHT })} />;
				})}
			</div>
		</div>
	);
}

describe("computeRevealScrollTop", () => {
	const base = { containerTop: 0, containerBottom: 200, headerHeight: 20, scrollTop: 100 };

	it("returns null while the row sits fully inside the viewport", () => {
		expect(computeRevealScrollTop({ ...base, rowTop: 60, rowBottom: 100 })).toBeNull();
	});

	it("scrolls up by exactly what the sticky header hides", () => {
		expect(computeRevealScrollTop({ ...base, rowTop: 5, rowBottom: 45 })).toBe(85);
	});

	it("scrolls down by exactly the overflow below the fold", () => {
		expect(computeRevealScrollTop({ ...base, rowTop: 190, rowBottom: 230 })).toBe(130);
	});

	it("leaves a row taller than the viewport aligned to its top", () => {
		expect(computeRevealScrollTop({ ...base, rowTop: 20, rowBottom: 400 })).toBeNull();
		expect(computeRevealScrollTop({ ...base, rowTop: 10, rowBottom: 400 })).toBe(90);
	});
});

describe("useRevealSelectedRow", () => {
	beforeEach(stubRects);
	afterEach(() => vi.restoreAllMocks());

	function setup(props: HarnessProps) {
		const view = render(<Harness {...props} />);
		const list = screen.getByTestId("list") as HTMLDivElement;
		list.scrollTop = props.scrollTop;
		return { view, list };
	}

	it("reveals the selected row after a reorder pushes it below the fold", () => {
		const { view, list } = setup({ order: ["a", "b", "c", "d", "e", "f"], selectedId: "a", scrollTop: 0 });
		expect(list.scrollTop).toBe(0);

		// "a" starts working and sinks to the bottom of the list, below the fold.
		view.rerender(<Harness order={["b", "c", "d", "e", "f", "a"]} selectedId="a" scrollTop={0} />);
		expect(list.scrollTop).toBe(60);
	});

	it("does not scroll when the reordered row is still visible", () => {
		const { view, list } = setup({ order: ["a", "b", "c", "d"], selectedId: "a", scrollTop: 0 });

		view.rerender(<Harness order={["b", "c", "a", "d"]} selectedId="a" scrollTop={0} />);
		expect(list.scrollTop).toBe(0);
	});

	it("ignores background task updates that leave the selected row where it was", () => {
		const { view, list } = setup({ order: ["a", "b", "c", "d", "e", "f", "g"], selectedId: "g", scrollTop: 0 });
		expect(list.scrollTop).toBe(0);

		// Row "g" is out of view the whole time; nothing about the selection moved.
		view.rerender(<Harness order={["a", "b", "c", "d", "e", "f", "g"]} selectedId="g" scrollTop={0} tick={1} />);
		expect(list.scrollTop).toBe(0);
	});

	it("reveals a row selected from the keyboard without reordering the list", () => {
		const { view, list } = setup({ order: ["a", "b", "c", "d", "e", "f"], selectedId: "a", scrollTop: 0 });

		view.rerender(<Harness order={["a", "b", "c", "d", "e", "f"]} selectedId="f" scrollTop={0} />);
		expect(list.scrollTop).toBe(60);
	});

	it("leaves a manual scroll alone when nothing about the selection changed", () => {
		const { view, list } = setup({ order: ["a", "b", "c", "d", "e", "f"], selectedId: "a", scrollTop: 0 });

		// The user scrolls down past the selected row.
		list.scrollTop = 120;
		fireEvent.scroll(list);
		view.rerender(<Harness order={["a", "b", "c", "d", "e", "f"]} selectedId="a" scrollTop={120} tick={1} />);
		expect(list.scrollTop).toBe(120);
	});

	it("scrolls back up when the selected row lands above the sticky header", () => {
		const { view, list } = setup({ order: ["a", "b", "c", "d", "e", "f"], selectedId: "f", scrollTop: 120 });

		// "f" moves to the top tier while the view stays scrolled down.
		view.rerender(<Harness order={["f", "a", "b", "c", "d", "e"]} selectedId="f" scrollTop={120} />);
		expect(list.scrollTop).toBe(0);
	});

	it("leaves a row the user scrolled away from where it is", () => {
		const { view, list } = setup({ order: ["a", "b", "c", "d", "e", "f"], selectedId: "a", scrollTop: 0 });

		// The user scrolls "a" off the top and keeps browsing further down the list.
		list.scrollTop = 200;
		view.rerender(<Harness order={["a", "b", "c", "d", "e", "f"]} selectedId="a" scrollTop={200} />);
		fireEvent.scroll(list);

		view.rerender(<Harness order={["b", "a", "c", "d", "e", "f"]} selectedId="a" scrollTop={200} />);

		expect(list.scrollTop).toBe(200);
	});

	it("reveals a newly selected task even when the list was scrolled away", () => {
		const { view, list } = setup({ order: ["a", "b", "c", "d", "e", "f"], selectedId: "a", scrollTop: 0 });

		list.scrollTop = 200;
		fireEvent.scroll(list);
		expect(list.scrollTop).toBe(200);

		// Picking another task is an explicit request to see it.
		view.rerender(<Harness order={["a", "b", "c", "d", "e", "f"]} selectedId="b" scrollTop={200} />);
		expect(list.scrollTop).toBe(40);
	});

	it("finishes a reveal the browser clamped while the rows below were still laying out", () => {
		const frames: FrameRequestCallback[] = [];
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
		vi.stubGlobal("cancelAnimationFrame", () => {});
		const { view, list } = setup({ order: ["a", "b", "c", "d", "e", "f"], selectedId: "a", scrollTop: 0 });

		// Only part of the list exists yet, so the browser clamps the scroll short.
		let maxScroll = 20;
		let value = 0;
		Object.defineProperty(list, "scrollTop", {
			get: () => value,
			set: (v: number) => { value = Math.min(v, maxScroll); },
			configurable: true,
		});

		view.rerender(<Harness order={["b", "c", "d", "e", "f", "a"]} selectedId="a" scrollTop={0} />);
		expect(list.scrollTop).toBe(20);
		expect(frames).toHaveLength(1);

		// The rest of the rows land and the pending reveal completes on the next
		// frame. The harness draws rows at a fixed offset, so the retry still
		// measures the row below the fold and scrolls the rest of the way.
		maxScroll = 1000;
		frames.pop()!(0);
		expect(list.scrollTop).toBe(80);

		vi.unstubAllGlobals();
	});

	it("does nothing without a selected task", () => {
		const { view, list } = setup({ order: ["a", "b", "c", "d", "e", "f"], selectedId: null, scrollTop: 90 });

		view.rerender(<Harness order={["b", "a", "c", "d", "e", "f"]} selectedId={null} scrollTop={90} />);
		expect(list.scrollTop).toBe(90);
	});
});
