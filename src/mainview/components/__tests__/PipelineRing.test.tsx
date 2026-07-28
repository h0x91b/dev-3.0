import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PipelineRing from "../PipelineRing";
import { I18nProvider } from "../../i18n";
import type { TaskStatus } from "../../../shared/types";

function renderRing(status: TaskStatus) {
	return render(
		<I18nProvider>
			<PipelineRing status={status} />
		</I18nProvider>,
	);
}

describe("PipelineRing", () => {
	it("shows the 1-based stage index for a pipeline status", () => {
		renderRing("review-by-user");

		expect(screen.getByRole("img")).toHaveTextContent("5");
	});

	it("marks the cancelled side-branch with a cross instead of an index", () => {
		renderRing("cancelled");

		expect(screen.getByRole("img")).toHaveTextContent("×");
	});

	it("labels the ring with its stage position for screen readers", () => {
		renderRing("todo");

		expect(screen.getByRole("img")).toHaveAccessibleName("Stage 1 of 7");
	});
});
