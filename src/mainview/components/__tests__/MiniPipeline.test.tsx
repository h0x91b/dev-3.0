import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import MiniPipeline from "../MiniPipeline";

describe("MiniPipeline", () => {
	it("does not render a question badge for user-questions", () => {
		const { container } = render(<MiniPipeline status="user-questions" />);

		expect(container.textContent).toBe("");
	});

	it("does not render a cancelled badge marker", () => {
		const { container } = render(<MiniPipeline status="cancelled" />);

		expect(container.textContent).toBe("");
	});
});
