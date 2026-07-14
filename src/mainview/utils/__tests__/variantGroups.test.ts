import { describe, expect, it } from "vitest";
import type { Task } from "../../../shared/types";
import { getAdjacentAliveVariant, getAliveVariants, selectVariantDots, sortVariants } from "../variantGroups";

function makeVariant(index: number, status: Task["status"] = "in-progress"): Task {
	return {
		id: `variant-${index}`,
		seq: 100,
		projectId: "project-1",
		title: `Variant ${index}`,
		description: "",
		status,
		baseBranch: "main",
		worktreePath: `/tmp/variant-${index}`,
		branchName: `variant-${index}`,
		groupId: "group-1",
		variantIndex: index,
		agentId: "builtin-claude",
		configId: "claude-auto",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

describe("variant group utilities", () => {
	it("sorts variants by index with a stable id fallback", () => {
		const variants = [makeVariant(3), makeVariant(1), makeVariant(2)];
		expect(sortVariants(variants).map((variant) => variant.variantIndex)).toEqual([1, 2, 3]);
	});

	it("hides dots for singleton groups", () => {
		expect(selectVariantDots([makeVariant(1)], "variant-1")).toEqual([]);
	});

	it.each([
		[2, 1, [1, 2]],
		[3, 1, [1, 2, 3]],
		[5, 5, [1, 2, 5]],
		[12, 12, [1, 2, 12]],
	] as const)("selects a capped stable dot set for %i variants at self %i", (count, current, expected) => {
		const variants = Array.from({ length: count }, (_, offset) => makeVariant(offset + 1));
		expect(selectVariantDots(variants, `variant-${current}`).map((variant) => variant.variantIndex)).toEqual(expected);
	});

	it("always includes the current variant even when it is not among the lowest indexes", () => {
		const variants = [makeVariant(1), makeVariant(2), makeVariant(3), makeVariant(4), makeVariant(5)];
		expect(selectVariantDots(variants, "variant-4").map((variant) => variant.variantIndex)).toEqual([1, 2, 4]);
	});

	it("filters the cycle ring to alive variants and keeps variant order", () => {
		const variants = [
			makeVariant(3, "completed"),
			makeVariant(1),
			makeVariant(4),
			makeVariant(2, "cancelled"),
		];
		expect(getAliveVariants(variants).map((variant) => variant.variantIndex)).toEqual([1, 4]);
		expect(getAdjacentAliveVariant(variants, "variant-1", 1)?.variantIndex).toBe(4);
		expect(getAdjacentAliveVariant(variants, "variant-1", -1)?.variantIndex).toBe(4);
	});

	it("wraps next and previous across the alive ring", () => {
		const variants = [makeVariant(1), makeVariant(2), makeVariant(3)];
		expect(getAdjacentAliveVariant(variants, "variant-3", 1)?.variantIndex).toBe(1);
		expect(getAdjacentAliveVariant(variants, "variant-1", -1)?.variantIndex).toBe(3);
	});

	it("returns null for missing or single-alive current variants", () => {
		const variants = [makeVariant(1), makeVariant(2, "completed")];
		expect(getAdjacentAliveVariant(variants, "variant-1", 1)).toBeNull();
		expect(getAdjacentAliveVariant(variants, "missing", 1)).toBeNull();
		expect(getAdjacentAliveVariant([makeVariant(1)], "variant-1", 1)).toBeNull();
	});
});
