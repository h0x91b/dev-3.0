import { reorderDropTarget, reorderShifts, reorderTargetIndex, type RowSpan } from "../reorderGeometry";

// Four 50px rows on a 60px pitch: 10px gaps, middles at 25, 85, 145, 205.
const rows: RowSpan[] = [0, 60, 120, 180].map((top) => ({ top, height: 50 }));

describe("reorderTargetIndex", () => {
	it("counts the other rows whose middle the preview has passed", () => {
		expect(reorderTargetIndex(rows, 0, 30)).toBe(0);
		expect(reorderTargetIndex(rows, 0, 90)).toBe(1);
		expect(reorderTargetIndex(rows, 0, 500)).toBe(3);
		expect(reorderTargetIndex(rows, 3, -100)).toBe(0);
		expect(reorderTargetIndex(rows, 3, 100)).toBe(2);
	});

	it("never lands above a pinned row", () => {
		expect(reorderTargetIndex(rows, 3, -100, 1)).toBe(1);
	});
});

describe("reorderShifts", () => {
	it("slides the passed rows into the old slot and moves the slot to the target", () => {
		expect(reorderShifts(rows, 0, 2)).toEqual([120, -60, -60, 0]);
		expect(reorderShifts(rows, 3, 1)).toEqual([0, 60, 60, -120]);
	});

	it("moves nothing while the row is over its own slot", () => {
		expect(reorderShifts(rows, 2, 2)).toEqual([0, 0, 0, 0]);
	});

	it("keeps the gap when the dragged row is taller than its neighbours", () => {
		const mixed: RowSpan[] = [{ top: 0, height: 80 }, { top: 90, height: 50 }, { top: 150, height: 50 }];
		// The rows that move up close an 80px row plus its 10px gap.
		expect(reorderShifts(mixed, 0, 2)).toEqual([120, -90, -90]);
	});
});

describe("reorderDropTarget", () => {
	it("names the row to drop next to, on the side the drag came from", () => {
		expect(reorderDropTarget(["a", "b", "c"], 0, 2)).toEqual({ targetId: "c", side: "after" });
		expect(reorderDropTarget(["a", "b", "c"], 2, 0)).toEqual({ targetId: "a", side: "before" });
	});

	it("is null for a drop back into the original slot", () => {
		expect(reorderDropTarget(["a", "b", "c"], 1, 1)).toBeNull();
	});
});
