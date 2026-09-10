/** The slice of ghostty's buffer API needed to read the cell left of the cursor. */
export interface DropSpacingCell {
	getChars(): string;
	getWidth(): number;
}

export interface DropSpacingLine {
	getCell(x: number): DropSpacingCell | undefined;
}

function needsLeadingSpace(line: DropSpacingLine | undefined, cursorX: number): boolean {
	if (!line || cursorX <= 0) return false;
	const chars = line.getCell(cursorX - 1)?.getChars() ?? "";
	if (chars.trim() !== "") return true;
	// A wide char (emoji, CJK) leaves a blank spacer cell behind it, so a blank
	// right after one is still real content the path must not glue onto.
	return chars === "" && cursorX >= 2 && (line.getCell(cursorX - 2)?.getWidth() ?? 1) === 2;
}

/**
 * Separate dropped paths from what the user already typed: a leading space
 * unless the cursor already sits after one, and always a trailing space so the
 * next keystroke does not glue onto the path.
 */
export function spaceDroppedPaths(text: string, line: DropSpacingLine | undefined, cursorX: number): string {
	return (needsLeadingSpace(line, cursorX) ? " " : "") + text + " ";
}
