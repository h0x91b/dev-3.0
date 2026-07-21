import { describe, expect, it } from "vitest";
import { TerminalQueryResponder } from "../terminal-query-responder";

const ESC = "\x1b";
const BEL = "\x07";

function respondTo(responder: TerminalQueryResponder, bytes: string): string[] {
	responder.ingest(new TextEncoder().encode(bytes));
	return responder.takeResponses();
}

describe("TerminalQueryResponder", () => {
	it("answers primary and secondary device attributes", () => {
		const responder = new TerminalQueryResponder(80, 24);
		expect(respondTo(responder, `${ESC}[c`)).toEqual([`${ESC}[?62;22c`]);
		expect(respondTo(responder, `${ESC}[>0c`)).toEqual([`${ESC}[>0;10;1c`]);
		expect(responder.counts.DA1).toBe(1);
		expect(responder.counts.DA2).toBe(1);
	});

	it("answers device status report for terminal status and cursor position", () => {
		const responder = new TerminalQueryResponder(80, 24);
		expect(respondTo(responder, `${ESC}[5n`)).toEqual([`${ESC}[0n`]);
		respondTo(responder, `${ESC}[7;13H`);
		expect(respondTo(responder, `${ESC}[6n`)).toEqual([`${ESC}[7;13R`]);
	});

	it("tracks the cursor across printable wrapping for cursor reports", () => {
		const responder = new TerminalQueryResponder(5, 4);
		respondTo(responder, "abcdef");
		expect(respondTo(responder, `${ESC}[6n`)).toEqual([`${ESC}[2;2R`]);
	});

	it("answers XTVERSION, the kitty keyboard query, and DECRQM", () => {
		const responder = new TerminalQueryResponder(80, 24);
		expect(respondTo(responder, `${ESC}[>q`)).toEqual([`${ESC}P>|dev3-spike(0.1)${ESC}\\`]);
		expect(respondTo(responder, `${ESC}[?u`)).toEqual([`${ESC}[?0u`]);
		expect(respondTo(responder, `${ESC}[?2026$p`)).toEqual([`${ESC}[?2026;0$y`]);
	});

	it("answers OSC foreground and background color queries", () => {
		const responder = new TerminalQueryResponder(80, 24);
		expect(respondTo(responder, `${ESC}]10;?${BEL}`)).toEqual([`${ESC}]10;rgb:ffff/ffff/ffff${BEL}`]);
		expect(respondTo(responder, `${ESC}]11;?${BEL}`)).toEqual([`${ESC}]11;rgb:0000/0000/0000${BEL}`]);
		expect(responder.counts["OSC-color"]).toBe(2);
	});

	it("clamps the tracked cursor after a resize", () => {
		const responder = new TerminalQueryResponder(80, 24);
		respondTo(responder, `${ESC}[20;70H`);
		responder.resize(40, 10);
		expect(respondTo(responder, `${ESC}[6n`)).toEqual([`${ESC}[10;40R`]);
	});

	it("does not respond to non-query sequences", () => {
		const responder = new TerminalQueryResponder(80, 24);
		expect(respondTo(responder, `${ESC}[1;38;2;10;20;30mhello${ESC}[0m`)).toEqual([]);
	});
});
