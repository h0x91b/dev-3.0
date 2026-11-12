import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useHeaderFlyout } from "../useHeaderFlyout";

function rect(top: number, left: number, width: number, height: number): DOMRect {
	return { top, left, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

function Harness({ panelHeight }: { panelHeight: number }) {
	const flyout = useHeaderFlyout({ variant: "bar", isNarrow: false });
	return (
		<>
			<button
				type="button"
				ref={(el) => {
					flyout.anchorRef.current = el;
					if (el) el.getBoundingClientRect = () => rect(10, 900, 100, 30);
				}}
				{...flyout.triggerProps}
			>
				pill
			</button>
			{flyout.open && (
				<div
					ref={(el) => {
						flyout.popRef.current = el;
						if (el) el.getBoundingClientRect = () => rect(0, 0, 320, panelHeight);
					}}
					data-testid="panel"
					data-top={flyout.pos?.top ?? ""}
				/>
			)}
		</>
	);
}

describe("useHeaderFlyout bar positioning", () => {
	const originalHeight = window.innerHeight;
	const originalWidth = window.innerWidth;

	beforeEach(() => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
	});

	afterEach(() => {
		Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
		Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
	});

	function openWith(viewportHeight: number, panelHeight: number): number {
		Object.defineProperty(window, "innerHeight", { configurable: true, value: viewportHeight });
		render(<Harness panelHeight={panelHeight} />);
		act(() => {
			fireEvent.click(screen.getByText("pill"));
		});
		return Number(screen.getByTestId("panel").dataset.top);
	}

	it("keeps a panel taller than the room below the pill anchored under it", () => {
		// Pill bottom 40 + gap 6; a 600px panel in a 320px window must not slide up over the pill.
		expect(openWith(320, 600)).toBe(46);
	});

	it("anchors a panel that fits under the pill the same way", () => {
		expect(openWith(900, 400)).toBe(46);
	});
});
