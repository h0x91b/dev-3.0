import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GhosttyRendererProbe } from "../ghostty-renderer-probe";
import {
	HeadlessTerminalState,
	decodeCaptureOutput,
	replaySnapshotIntoRenderer,
	type TerminalCaptureFixture,
} from "../terminal-state";

function loadFixture(name: string): TerminalCaptureFixture {
	const path = fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url));
	return JSON.parse(readFileSync(path, "utf8")) as TerminalCaptureFixture;
}

describe("terminal-state renderer replay", () => {
	for (const name of [
		"active-screen",
		"alternate-screen",
		"cursor-modes",
		"scrollback",
		"colors",
		"unicode",
		"line-wrapping",
		"resize-history",
		"real-nvim",
		"real-powershell",
	]) {
		it(`replays the ${name} snapshot into a fresh Ghostty renderer core`, async () => {
			const fixture = loadFixture(name);
			const parser = await HeadlessTerminalState.create(fixture.initial);
			const liveRenderer = await GhosttyRendererProbe.create(fixture.initial);

			for (const event of fixture.events) {
				if (event.type === "output") {
					const data = decodeCaptureOutput(event);
					await parser.ingest(data);
					liveRenderer.ingest(data);
				} else {
					parser.resize(event.cols, event.rows);
					liveRenderer.resize(event.cols, event.rows);
				}
			}

			const snapshot = parser.snapshot();
			const liveStateAtDetach = liveRenderer.inspect();
			for (const event of fixture.afterReplay ?? []) {
				if (event.type === "output") {
					liveRenderer.ingest(decodeCaptureOutput(event));
				} else {
					liveRenderer.resize(event.cols, event.rows);
				}
			}
			const liveStateAfterReplay = liveRenderer.inspect();
			liveRenderer.dispose();

			const freshRenderer = await GhosttyRendererProbe.create(snapshot.initial);
			replaySnapshotIntoRenderer(snapshot, freshRenderer);
			expect(freshRenderer.inspect()).toEqual(liveStateAtDetach);
			for (const event of fixture.afterReplay ?? []) {
				if (event.type === "output") {
					freshRenderer.ingest(decodeCaptureOutput(event));
				} else {
					freshRenderer.resize(event.cols, event.rows);
				}
			}
			expect(freshRenderer.inspect()).toEqual(liveStateAfterReplay);

			parser.dispose();
			freshRenderer.dispose();
		});
	}
});
