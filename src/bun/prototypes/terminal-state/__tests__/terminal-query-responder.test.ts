import { describe, expect, it } from "vitest";
import { TerminalQueryResponder } from "../terminal-query-responder";

const ESC = "\x1b";
const BEL = "\x07";

function respondTo(responder: TerminalQueryResponder, bytes: string): string[] {
	responder.ingest(new TextEncoder().encode(bytes));
	return responder.takeResponses();
}

describe("TerminalQueryResponder", () => {
	it("answers device attributes and device status reports", () => {
		const responder = new TerminalQueryResponder(80, 24);
		expect(respondTo(responder, `${ESC}[c`)).toEqual([`${ESC}[?62;22c`]);
		expect(respondTo(responder, `${ESC}[>0c`)).toEqual([`${ESC}[>0;10;1c`]);
		expect(responder.counts.DA1).toBe(1);
		expect(responder.counts.DA2).toBe(1);
		// Device status report: terminal status and cursor position.
		expect(respondTo(responder, `${ESC}[5n`)).toEqual([`${ESC}[0n`]);
		respondTo(responder, `${ESC}[7;13H`);
		expect(respondTo(responder, `${ESC}[6n`)).toEqual([`${ESC}[7;13R`]);
	});

	it("tracks the cursor across printable wrapping and clamps it after a resize", () => {
		const responder = new TerminalQueryResponder(5, 4);
		respondTo(responder, "abcdef");
		expect(respondTo(responder, `${ESC}[6n`)).toEqual([`${ESC}[2;2R`]);

		// ...and clamps it after a resize.
		const big = new TerminalQueryResponder(80, 24);
		respondTo(big, `${ESC}[20;70H`);
		big.resize(40, 10);
		expect(respondTo(big, `${ESC}[6n`)).toEqual([`${ESC}[10;40R`]);
	});

	it("answers XTVERSION, the kitty keyboard query, DECRQM, and OSC color queries", () => {
		const responder = new TerminalQueryResponder(80, 24);
		expect(respondTo(responder, `${ESC}[>q`)).toEqual([`${ESC}P>|dev3-spike(0.1)${ESC}\\`]);
		expect(respondTo(responder, `${ESC}[?u`)).toEqual([`${ESC}[?0u`]);
		expect(respondTo(responder, `${ESC}[?2026$p`)).toEqual([`${ESC}[?2026;0$y`]);
		expect(respondTo(responder, `${ESC}]10;?${BEL}`)).toEqual([`${ESC}]10;rgb:ffff/ffff/ffff${BEL}`]);
		expect(respondTo(responder, `${ESC}]11;?${BEL}`)).toEqual([`${ESC}]11;rgb:0000/0000/0000${BEL}`]);
		expect(responder.counts["OSC-color"]).toBe(2);
	});

	it("does not respond to non-query sequences", () => {
		const responder = new TerminalQueryResponder(80, 24);
		expect(respondTo(responder, `${ESC}[1;38;2;10;20;30mhello${ESC}[0m`)).toEqual([]);
	});
});
