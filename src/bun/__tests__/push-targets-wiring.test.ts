/**
 * The desktop entry must not push to one audience only.
 *
 * `src/bun/index.ts` serves Electrobun windows AND whatever browser is attached
 * over the remote-access server, and its hooks were wired by hand: four of them
 * broadcast to windows alone, so eight events never left the desktop. The one
 * users saw was `ptyDied` — a remote phone kept rendering a terminal that had
 * exited, with no "session ended" screen and no way back short of a reload.
 *
 * `index.ts` cannot be imported by a test (Electrobun APIs, top-level await, it
 * opens a window), so the chain is proved in two halves: `push-targets.test.ts`
 * proves `pushEverywhere` reaches both audiences, and this file proves every push
 * in `index.ts` goes through it. Neither half is worth much without the other.
 *
 * `sendToFocusedWindow` stays allowed on purpose: it answers a click in one
 * specific window (the update-check outcome), which has no remote counterpart.
 *
 * See decisions/2026/09/04/push-every-desktop-event-to-remote-clients.md.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENTRY_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));
const ENTRY = readFileSync(ENTRY_PATH, "utf8");

/** Lines carrying a call to one of the single-audience push helpers. */
function offendingLines(helper: string): string[] {
	return ENTRY.split("\n")
		.map((line, i) => ({ line: line.trim(), n: i + 1 }))
		.filter(({ line }) => line.includes(`${helper}(`))
		.map(({ line, n }) => `index.ts:${n}  ${line}`);
}

describe("desktop entry push wiring", () => {
	it("never broadcasts to windows alone", () => {
		const offenders = offendingLines("broadcastToAllWindows");
		expect(
			offenders,
			"Cause: `broadcastToAllWindows` reaches Electrobun windows only, so a browser attached over " +
				"remote access never hears the event — that is how a dead terminal kept looking alive on a phone.\n" +
				"Fix: call `pushEverywhere` from ./push-targets instead.\n" +
				`Offending:\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("never pushes to browsers alone", () => {
		const offenders = offendingLines("pushToBrowserClients");
		expect(
			offenders,
			"Cause: `pushToBrowserClients` skips the desktop windows, which is the same bug pointed the other way.\n" +
				"Fix: call `pushEverywhere` from ./push-targets instead.\n" +
				`Offending:\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("imports neither single-audience helper", () => {
		const imports = ENTRY.split("\n").filter(
			(line) =>
				line.startsWith("import") &&
				(line.includes("broadcastToAllWindows") || line.includes("pushToBrowserClients")),
		);
		expect(imports, `Fix: import { pushEverywhere } from "./push-targets" instead.\n${imports.join("\n")}`).toEqual([]);
	});

	it("still routes the events that were lost, by name", () => {
		// The four literal-named pushes from the four blocks that were window-only.
		// The pollers hand their own `(name, payload)` through, so the absence guards
		// above are what cover those.
		for (const event of ["ptyDied", "projectPtyDied", "updateAvailable", "updateDownloadProgress"]) {
			expect(ENTRY, `${event} must be published through pushEverywhere`).toContain(`pushEverywhere("${event}"`);
		}
	});
});
