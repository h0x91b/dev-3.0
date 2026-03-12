import { describe, it, expect } from "vitest";
import {
	PIPELINE_STAGES,
	getPipelineIndex,
	getStageStates,
	isSideBranch,
} from "../StatusPipeline";

describe("getPipelineIndex", () => {
	it("returns correct index for each main stage", () => {
		expect(getPipelineIndex("todo")).toBe(0);
		expect(getPipelineIndex("in-progress")).toBe(1);
		expect(getPipelineIndex("review-by-ai")).toBe(2);
		expect(getPipelineIndex("review-by-user")).toBe(3);
		expect(getPipelineIndex("review-by-colleague")).toBe(4);
		expect(getPipelineIndex("completed")).toBe(5);
	});

	it("maps user-questions to in-progress index", () => {
		expect(getPipelineIndex("user-questions")).toBe(
			PIPELINE_STAGES.indexOf("in-progress"),
		);
	});

	it("maps cancelled to in-progress index, not completed", () => {
		const inProgressIdx = PIPELINE_STAGES.indexOf("in-progress");
		const completedIdx = PIPELINE_STAGES.indexOf("completed");
		const cancelledIdx = getPipelineIndex("cancelled");

		expect(cancelledIdx).toBe(inProgressIdx);
		expect(cancelledIdx).not.toBe(completedIdx);
	});
});

describe("getStageStates", () => {
	it("marks all stages as future for todo", () => {
		const states = getStageStates("todo");
		expect(states).toEqual(["current", "future", "future", "future", "future", "future"]);
	});

	it("marks previous stages as done, current as current, rest as future", () => {
		const states = getStageStates("review-by-ai");
		expect(states).toEqual(["done", "done", "current", "future", "future", "future"]);
	});

	it("marks all stages as done for completed except last", () => {
		const states = getStageStates("completed");
		expect(states).toEqual(["done", "done", "done", "done", "done", "current"]);
	});

	it("cancelled shows pipeline stopped at in-progress, not at completed", () => {
		const states = getStageStates("cancelled");
		expect(states).toEqual(["done", "current", "future", "future", "future", "future"]);
	});

	it("user-questions shows pipeline at in-progress", () => {
		const states = getStageStates("user-questions");
		expect(states).toEqual(["done", "current", "future", "future", "future", "future"]);
	});
});

describe("isSideBranch", () => {
	it("returns true for user-questions and cancelled", () => {
		expect(isSideBranch("user-questions")).toBe(true);
		expect(isSideBranch("cancelled")).toBe(true);
	});

	it("returns false for main pipeline stages", () => {
		for (const stage of PIPELINE_STAGES) {
			expect(isSideBranch(stage)).toBe(false);
		}
	});
});
