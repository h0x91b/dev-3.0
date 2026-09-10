import { describe, it, expect } from "vitest";
import { spaceDroppedPaths, type DropSpacingLine } from "../terminal-drop-spacing";

/** A line whose cells come from `text`; a wide char occupies two cells. */
function line(text: string): DropSpacingLine {
	const cells: { chars: string; width: number }[] = [];
	for (const ch of text) {
		const width = ch.codePointAt(0)! > 0xffff ? 2 : 1;
		cells.push({ chars: ch, width });
		if (width === 2) cells.push({ chars: "", width: 0 });
	}
	return { getCell: (x) => (cells[x] ? { getChars: () => cells[x].chars, getWidth: () => cells[x].width } : undefined) };
}

describe("spaceDroppedPaths", () => {
	it("adds a space on both sides when the cursor sits after typed text", () => {
		expect(spaceDroppedPaths("/tmp/a.png", line("look at"), 7)).toBe(" /tmp/a.png ");
	});

	it("does not double a space the user already typed", () => {
		expect(spaceDroppedPaths("/tmp/a.png", line("look at "), 8)).toBe("/tmp/a.png ");
	});

	it("adds no leading space at the start of the line", () => {
		expect(spaceDroppedPaths("/tmp/a.png", line(""), 0)).toBe("/tmp/a.png ");
	});

	it("treats a blank cell as a separator", () => {
		expect(spaceDroppedPaths("/tmp/a.png", line("hi"), 5)).toBe("/tmp/a.png ");
	});

	it("keeps a space after a wide char whose spacer cell reads blank", () => {
		expect(spaceDroppedPaths("/tmp/a.png", line("see 🙂"), 6)).toBe(" /tmp/a.png ");
	});

	it("separates a second drop from the first", () => {
		const first = spaceDroppedPaths("/tmp/a.png", line("look"), 4);
		expect(first).toBe(" /tmp/a.png ");
		// The first drop left a trailing space, so the second adds none of its own.
		expect(spaceDroppedPaths("/tmp/b.png", line(`look${first}`), 4 + first.length)).toBe("/tmp/b.png ");
	});

	it("falls back to no leading space when the buffer is unreadable", () => {
		expect(spaceDroppedPaths("/tmp/a.png", undefined, 12)).toBe("/tmp/a.png ");
	});

	it("never touches spaces inside the dropped text", () => {
		expect(spaceDroppedPaths("/tmp/a.png /tmp/b.png", line("x"), 1)).toBe(" /tmp/a.png /tmp/b.png ");
	});
});
