import { describe, it, expect, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { useIsTruncated } from "../useIsTruncated";

/**
 * happy-dom reports 0 for every layout box, so the widths are stubbed per
 * element via the `data-*` attributes the getters below read back.
 */
beforeAll(() => {
	Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
		configurable: true,
		get(this: HTMLElement) {
			return Number(this.dataset.scroll ?? 0);
		},
	});
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get(this: HTMLElement) {
			return Number(this.dataset.client ?? 0);
		},
	});
});

function Probe({ scroll, client }: { scroll: number; client: number }) {
	const [ref, truncated] = useIsTruncated<HTMLSpanElement>("text");
	return (
		<span ref={ref} data-scroll={scroll} data-client={client} data-testid="probe">
			{truncated ? "clipped" : "fits"}
		</span>
	);
}

describe("useIsTruncated", () => {
	it("reports clipped when the content is wider than the box", () => {
		render(<Probe scroll={200} client={80} />);
		expect(screen.getByTestId("probe")).toHaveTextContent("clipped");
	});

	it("reports fitting when the content is not wider", () => {
		render(<Probe scroll={80} client={80} />);
		expect(screen.getByTestId("probe")).toHaveTextContent("fits");
	});

	it("tolerates a 1px sub-pixel rounding overflow", () => {
		render(<Probe scroll={81} client={80} />);
		expect(screen.getByTestId("probe")).toHaveTextContent("fits");
	});
});
