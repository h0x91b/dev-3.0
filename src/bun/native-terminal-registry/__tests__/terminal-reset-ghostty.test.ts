/**
 * The run wrapper's terminal reset, fed to the native backend's Ghostty parser:
 * it must neither move the cursor on a normal exit nor strand the main screen.
 */
import { describe, expect, it } from "vitest";
import { launchDialect } from "../../../shared/platform-launch";
import { GhosttyLiveParser } from "../ghostty-live";

const ESC = "\x1b";
const [, printfLine] = launchDialect("linux").restoreTerminalState();
const RESET = printfLine.slice("printf '".length, -1).replaceAll("\\033", ESC);
const MAIN = "l1\r\nl2\r\nl3\r\nl4";

async function exitAfter(output: string) {
	const parser = await GhosttyLiveParser.create({ cols: 20, rows: 8, scrollbackLimit: 100 });
	parser.ingest(new TextEncoder().encode(`${output}${RESET}\r\nNOTICE`));
	const state = parser.inspect(0);
	return { state, lines: state.screen.map((line) => line.text.trimEnd()).slice(0, 6) };
}

describe("terminal reset against Ghostty", () => {
	it("leaves cursor and screen alone when the agent never left the normal screen", async () => {
		const { state, lines } = await exitAfter(MAIN);
		expect(lines).toEqual(["l1", "l2", "l3", "l4", "NOTICE", ""]);
		expect(state.activeBuffer).toBe("normal");
	});

	it("returns to the intact main screen after an alternate-screen session", async () => {
		const { state, lines } = await exitAfter(`${MAIN}${ESC}[?1049h${ESC}[2J${ESC}[HALT1\r\nALT2\r\nALT3`);
		expect(lines).toEqual(["l1", "l2", "l3", "l4", "NOTICE", ""]);
		expect(state.activeBuffer).toBe("normal");
	});
});
