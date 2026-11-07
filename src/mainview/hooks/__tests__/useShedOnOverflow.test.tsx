import { render, screen } from "@testing-library/react";
import { useRef } from "react";
import { useShedOnOverflow } from "../useShedOnOverflow";

/** happy-dom does no layout, so the row's widths are stubbed per test. */
function Row({ contentWidth, boxWidth, resetKey = "a" }: { contentWidth: number; boxWidth: number; resetKey?: string }) {
	const ref = useRef<HTMLDivElement>(null);
	const level = useShedOnOverflow(ref, 2, resetKey);
	return (
		<div
			ref={(el) => {
				ref.current = el;
				if (!el) return;
				// Every shed item is worth 30px of content.
				Object.defineProperty(el, "scrollWidth", { configurable: true, get: () => contentWidth - (2 - level) * 30 });
				Object.defineProperty(el, "clientWidth", { configurable: true, get: () => boxWidth });
			}}
			data-testid="row"
			data-level={level}
		/>
	);
}

describe("useShedOnOverflow", () => {
	it("keeps every item when the row fits", () => {
		render(<Row contentWidth={200} boxWidth={250} />);
		expect(screen.getByTestId("row")).toHaveAttribute("data-level", "2");
	});

	it("sheds one item at a time until the row fits", () => {
		render(<Row contentWidth={270} boxWidth={250} />);
		expect(screen.getByTestId("row")).toHaveAttribute("data-level", "1");
	});

	it("sheds everything when even one item does not fit", () => {
		render(<Row contentWidth={320} boxWidth={250} />);
		expect(screen.getByTestId("row")).toHaveAttribute("data-level", "0");
	});

	it("starts from the top again when the content changes", () => {
		const { rerender } = render(<Row contentWidth={320} boxWidth={250} resetKey="crowded" />);
		expect(screen.getByTestId("row")).toHaveAttribute("data-level", "0");
		rerender(<Row contentWidth={200} boxWidth={250} resetKey="roomy" />);
		expect(screen.getByTestId("row")).toHaveAttribute("data-level", "2");
	});
});
