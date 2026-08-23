import { describe, expect, it } from "vitest";

import { scanHumanTerminalInput } from "../../shared/human-terminal-input";

const SHIFT_ENTER = "\x1b\r";

describe("scanHumanTerminalInput — is that a submit?", () => {
	it("reads a plain Enter as a submit", () => {
		expect(scanHumanTerminalInput("\r").submitted).toBe(true);
		expect(scanHumanTerminalInput("fix the test\r").submitted).toBe(true);
	});

	it("does NOT read Shift+Enter as a submit", () => {
		// dev3 encodes Shift+Enter as ESC+CR: a newline the user is still writing.
		expect(scanHumanTerminalInput(SHIFT_ENTER).submitted).toBe(false);
		expect(scanHumanTerminalInput(`first line${SHIFT_ENTER}second line`).submitted).toBe(false);
	});

	it("still sees the submit that ends a multi-line prompt", () => {
		expect(scanHumanTerminalInput(`one${SHIFT_ENTER}two\r`).submitted).toBe(true);
	});

	it("ignores ordinary typing, LF, and escape sequences", () => {
		expect(scanHumanTerminalInput("checking the diff").submitted).toBe(false);
		expect(scanHumanTerminalInput("\n").submitted).toBe(false);
		expect(scanHumanTerminalInput("\x1b[Z").submitted).toBe(false); // Shift+Tab
		expect(scanHumanTerminalInput("\x1b[1;2H").submitted).toBe(false); // Shift+Home
		expect(scanHumanTerminalInput("\x1b").submitted).toBe(false); // a bare Escape
	});

	it("treats CRs inside a bracketed paste as content, not keypresses", () => {
		const paste = `\x1b[200~line one\rline two\r\x1b[201~`;
		expect(scanHumanTerminalInput(paste)).toEqual({ submitted: false, inPaste: false });
	});

	it("sees the Enter that follows a paste", () => {
		expect(scanHumanTerminalInput(`\x1b[200~pasted\r\x1b[201~\r`).submitted).toBe(true);
	});

	it("carries an unfinished paste across chunks, so its content is never a submit", () => {
		const first = scanHumanTerminalInput("\x1b[200~line one\r");
		expect(first).toEqual({ submitted: false, inPaste: true });
		const second = scanHumanTerminalInput("line two\r\x1b[201~", first.inPaste);
		expect(second).toEqual({ submitted: false, inPaste: false });
		// And the very next Enter, outside the paste, is his own again.
		expect(scanHumanTerminalInput("\r", second.inPaste).submitted).toBe(true);
	});
});
