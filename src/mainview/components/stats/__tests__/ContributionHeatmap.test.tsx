import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContributionHeatmap } from "../ContributionHeatmap";
import type { HeatmapDay } from "../../../utils/productivityStats";

const DAY = 86_400_000;

function makeDays(n: number, counts: Record<number, number> = {}): HeatmapDay[] {
	const start = Date.parse("2026-01-04T00:00:00.000Z"); // a Sunday
	return Array.from({ length: n }, (_, i) => ({ ms: start + i * DAY, count: counts[i] ?? 0 }));
}

describe("ContributionHeatmap", () => {
	it("renders one titled cell per day", () => {
		const days = makeDays(14, { 2: 3 });
		const { container } = render(
			<ContributionHeatmap
				days={days}
				maxCount={3}
				legendLess="Less"
				legendMore="More"
				tooltipFor={(count, ms) => `${count}@${ms}`}
			/>,
		);
		// Legend swatches carry no title; only day cells do.
		const cells = container.querySelectorAll("[title]");
		expect(cells).toHaveLength(14);
	});

	it("builds the tooltip from the cell's count and timestamp", () => {
		const days = makeDays(7, { 0: 5 });
		const { container } = render(
			<ContributionHeatmap
				days={days}
				maxCount={5}
				legendLess="Less"
				legendMore="More"
				tooltipFor={(count) => `${count} tasks`}
			/>,
		);
		const titled = [...container.querySelectorAll("[title]")].map((el) => el.getAttribute("title"));
		expect(titled).toContain("5 tasks");
	});
});
