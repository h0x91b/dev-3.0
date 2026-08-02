/**
 * Column-agent failure copy selection.
 *
 * The invariants: a recognised failure is explained in localized copy and never
 * quotes the backend's English error; an unrecognised one still surfaces that
 * error verbatim as diagnostics; and a built-in column is named by localizing its
 * status while only a user-named custom column appears literally.
 */
import { describe, it, expect } from "vitest";
import { columnAgentDisplayName, columnAgentFailureCopy } from "../columnAgentFailureToast";

const localizedStatus = (status: string) => `L(${status})`;
const AI_REVIEW = { kind: "builtin", status: "review-by-ai" } as const;
const CUSTOM = { kind: "custom", name: "Security Review" } as const;

describe("columnAgentDisplayName", () => {
	it("localizes a built-in column and leaves a custom one literal", () => {
		expect(columnAgentDisplayName(AI_REVIEW, localizedStatus)).toBe("L(review-by-ai)");
		expect(columnAgentDisplayName(CUSTOM, localizedStatus)).toBe("Security Review");
	});
});

describe("columnAgentFailureCopy", () => {
	it("explains a known terminal-not-running failure and names where the task went", () => {
		const copy = columnAgentFailureCopy(
			{
				column: AI_REVIEW,
				error: "the task terminal is not running, so it has no pane to split",
				movedTo: "review-by-user",
				reason: "terminal-not-running",
			},
			localizedStatus,
		);
		expect(copy.key).toBe("kanban.columnAgentNoTerminalMoved");
		expect(copy.params).toEqual({ columnName: "L(review-by-ai)", status: "L(review-by-user)" });
		// The English backend sentence must not reach a localized message.
		expect(copy.params.error).toBeUndefined();
	});

	it("explains a known failure without a fallback move, keeping the custom column's own name", () => {
		const copy = columnAgentFailureCopy(
			{ column: CUSTOM, error: "whatever", reason: "terminal-not-running" },
			localizedStatus,
		);
		expect(copy.key).toBe("kanban.columnAgentNoTerminal");
		expect(copy.params).toEqual({ columnName: "Security Review" });
	});

	it("falls back to the generic moved copy, carrying the error as diagnostics", () => {
		const copy = columnAgentFailureCopy(
			{ column: AI_REVIEW, error: "agent binary missing", movedTo: "review-by-user" },
			localizedStatus,
		);
		expect(copy.key).toBe("kanban.columnAgentFailedMoved");
		expect(copy.params).toEqual({
			columnName: "L(review-by-ai)",
			status: "L(review-by-user)",
			error: "agent binary missing",
		});
	});

	it("falls back to the generic stay-put copy", () => {
		const copy = columnAgentFailureCopy({ column: CUSTOM, error: "boom" }, localizedStatus);
		expect(copy.key).toBe("kanban.columnAgentFailed");
		expect(copy.params).toEqual({ columnName: "Security Review", error: "boom" });
	});
});
