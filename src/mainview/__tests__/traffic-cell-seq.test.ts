import { describe, expect, it } from "vitest";
import {
	cellSeqFontSize,
	cellSeqInk,
} from "../components/agent-traffic/cell-seq";
import { CARD_HEIGHT, CARD_WIDTH } from "../components/agent-traffic/nodes-layout";

const size = (label: string) => cellSeqFontSize(label, CARD_WIDTH, CARD_HEIGHT);

describe("cellSeqFontSize", () => {
	it("shrinks as the seq gains digits", () => {
		expect(size("4")).toBeGreaterThan(size("49"));
		expect(size("49")).toBeGreaterThan(size("493"));
		expect(size("493")).toBeGreaterThan(size("1883"));
	});

	it("keeps every label inside the card", () => {
		for (const label of ["4", "49", "493", "1883", "49-1", "1883-12"]) {
			const fontSize = cellSeqFontSize(label, CARD_WIDTH, CARD_HEIGHT);
			expect(fontSize * label.length * 0.62).toBeLessThanOrEqual(CARD_WIDTH);
			expect(fontSize).toBeLessThanOrEqual(CARD_HEIGHT);
		}
	});

	it("scales with the card, so a wider coordinator gets a bigger number", () => {
		expect(cellSeqFontSize("1883", 370, CARD_HEIGHT)).toBeGreaterThan(
			cellSeqFontSize("1883", CARD_WIDTH, CARD_HEIGHT),
		);
	});
});

describe("cellSeqInk", () => {
	it("goes dark on a bright status fill", () => {
		expect(cellSeqInk("#ffe55f")).toBe("rgba(0, 0, 0, 0.72)");
		expect(cellSeqInk("#3cf3b0")).toBe("rgba(0, 0, 0, 0.72)");
	});

	it("goes light on a dark status fill", () => {
		expect(cellSeqInk("#0182b0")).toBe("rgba(255, 255, 255, 0.86)");
		expect(cellSeqInk("#4b59ff")).toBe("rgba(255, 255, 255, 0.86)");
	});

	it("falls back to the theme ink when the card has no status colour", () => {
		expect(cellSeqInk(undefined)).toBe("rgb(var(--text-primary))");
		expect(cellSeqInk("rgb(var(--text-tertiary))")).toBe(
			"rgb(var(--text-primary))",
		);
	});
});
