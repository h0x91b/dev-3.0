/**
 * Column-agent failure copy selection (seq 1395).
 *
 * The guarantee: a recognised failure is explained in localized copy and never
 * quotes the backend's English error, while an unrecognised one still surfaces
 * that error verbatim as diagnostics.
 */
import { describe, it, expect } from "vitest";
import { columnAgentFailureCopy } from "../columnAgentFailureToast";

const localizedStatus = (status: string) => `L(${status})`;

describe("columnAgentFailureCopy", () => {
	it("explains a known terminal-not-running failure and names where the task went", () => {
		const copy = columnAgentFailureCopy(
			{ columnName: "AI Review", error: "the task terminal is not running, so it has no pane to split", movedTo: "review-by-user", reason: "terminal-not-running" },
			localizedStatus,
		);
		expect(copy.key).toBe("kanban.columnAgentNoTerminalMoved");
		expect(copy.params).toEqual({ columnName: "AI Review", status: "L(review-by-user)" });
		// The English backend sentence must not reach a localized message.
		expect(copy.params.error).toBeUndefined();
	});

	it("explains a known failure without a fallback move (custom column stays put)", () => {
		const copy = columnAgentFailureCopy(
			{ columnName: "Security Review", error: "whatever", reason: "terminal-not-running" },
			localizedStatus,
		);
		expect(copy.key).toBe("kanban.columnAgentNoTerminal");
		expect(copy.params).toEqual({ columnName: "Security Review" });
	});

	it("falls back to the generic moved copy, carrying the error as diagnostics", () => {
		const copy = columnAgentFailureCopy(
			{ columnName: "AI Review", error: "agent binary missing", movedTo: "review-by-user" },
			localizedStatus,
		);
		expect(copy.key).toBe("kanban.columnAgentFailedMoved");
		expect(copy.params).toEqual({ columnName: "AI Review", status: "L(review-by-user)", error: "agent binary missing" });
	});

	it("falls back to the generic stay-put copy", () => {
		const copy = columnAgentFailureCopy({ columnName: "Security Review", error: "boom" }, localizedStatus);
		expect(copy.key).toBe("kanban.columnAgentFailed");
		expect(copy.params).toEqual({ columnName: "Security Review", error: "boom" });
	});
});
