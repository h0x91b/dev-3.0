import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	HeadlessTerminalState,
	decodeCaptureOutput,
	parseTerminalSnapshot,
	replayTerminalSnapshot,
	serializeTerminalSnapshot,
	type TerminalCaptureFixture,
} from "../terminal-state";

function loadFixture(name: string): TerminalCaptureFixture {
	const path = fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url));
	return JSON.parse(readFileSync(path, "utf8")) as TerminalCaptureFixture;
}

async function applyFixture(session: HeadlessTerminalState, fixture: TerminalCaptureFixture): Promise<void> {
	for (const event of fixture.events) {
		if (event.type === "output") {
			await session.ingest(decodeCaptureOutput(event));
		} else {
			session.resize(event.cols, event.rows);
		}
	}
}

describe("terminal-state snapshot spike", () => {
	it("serializes and replays an active screen into a fresh headless client", async () => {
		const fixture = loadFixture("active-screen");
		const source = await HeadlessTerminalState.create(fixture.initial);
		await applyFixture(source, fixture);

		expect(source.inspect()).toMatchObject(fixture.expected);

		const snapshot = source.snapshot();
		expect(snapshot).toMatchObject({
			format: "dev3-terminal-state-spike",
			version: 1,
			strategy: "event-journal",
			parser: "ghostty-web@0.4.0",
		});

		const encoded = serializeTerminalSnapshot(snapshot);
		const replay = await replayTerminalSnapshot(parseTerminalSnapshot(encoded));
		expect(replay.inspect()).toEqual(source.inspect());
		expect(() =>
			parseTerminalSnapshot(encoded.replace('"version":1', '"version":2')),
		).toThrow("Unsupported terminal snapshot");

		source.dispose();
		replay.dispose();
	});

	it("preserves captured byte chunks without a lossy text conversion", async () => {
		const source = await HeadlessTerminalState.create({ cols: 12, rows: 3, scrollback: 10 });
		const bytes = new TextEncoder().encode("bytes:界🙂");
		await source.ingest(bytes);

		const snapshot = source.snapshot();
		expect(snapshot.events).toEqual([
			{
				type: "output",
				encoding: "base64",
				data: Buffer.from(bytes).toString("base64"),
			},
		]);
		const replay = await replayTerminalSnapshot(parseTerminalSnapshot(serializeTerminalSnapshot(snapshot)));
		expect(replay.inspect()).toEqual(source.inspect());

		source.dispose();
		replay.dispose();
	});

	it("preserves the alternate screen and restores its hidden primary screen", async () => {
		const fixture = loadFixture("alternate-screen");
		const source = await HeadlessTerminalState.create(fixture.initial);
		await applyFixture(source, fixture);
		expect(source.inspect()).toMatchObject(fixture.expected);

		const replay = await replayTerminalSnapshot(source.snapshot());
		expect(replay.inspect()).toEqual(source.inspect());

		for (const event of fixture.afterReplay ?? []) {
			if (event.type === "output") {
				await source.ingest(decodeCaptureOutput(event));
				await replay.ingest(decodeCaptureOutput(event));
			} else {
				source.resize(event.cols, event.rows);
				replay.resize(event.cols, event.rows);
			}
		}
		expect(replay.inspect()).toEqual(source.inspect());
		if (!fixture.expectedAfterReplay) throw new Error("alternate-screen fixture needs replay state");
		expect(replay.inspect()).toMatchObject(fixture.expectedAfterReplay);

		source.dispose();
		replay.dispose();
	});

	it("restores cursor presentation and terminal modes", async () => {
		const fixture = loadFixture("cursor-modes");
		const source = await HeadlessTerminalState.create(fixture.initial);
		await applyFixture(source, fixture);
		expect(source.inspect()).toMatchObject(fixture.expected);

		const replay = await replayTerminalSnapshot(source.snapshot());
		expect(replay.inspect()).toEqual(source.inspect());

		source.dispose();
		replay.dispose();
	});

	it("bounds and restores scrollback", async () => {
		const fixture = loadFixture("scrollback");
		const source = await HeadlessTerminalState.create(fixture.initial);
		await applyFixture(source, fixture);
		expect(source.inspect()).toMatchObject(fixture.expected);

		const replay = await replayTerminalSnapshot(source.snapshot());
		expect(replay.inspect()).toEqual(source.inspect());

		source.dispose();
		replay.dispose();
	});

	it("restores truecolor, palette colors, and cell attributes", async () => {
		const fixture = loadFixture("colors");
		const source = await HeadlessTerminalState.create(fixture.initial);
		await applyFixture(source, fixture);
		const sourceState = source.inspect();
		expect(sourceState).toMatchObject(fixture.expected);
		for (const probe of fixture.expectedCells ?? []) {
			expect(sourceState.screen[probe.row].cells[probe.col]).toEqual(probe.cell);
		}

		const replay = await replayTerminalSnapshot(source.snapshot());
		expect(replay.inspect()).toEqual(sourceState);

		source.dispose();
		replay.dispose();
	});

	it("restores wide glyphs, combining marks, and emoji cell widths", async () => {
		const fixture = loadFixture("unicode");
		const source = await HeadlessTerminalState.create(fixture.initial);
		await applyFixture(source, fixture);
		const sourceState = source.inspect();
		expect(sourceState).toMatchObject(fixture.expected);
		for (const probe of fixture.expectedCells ?? []) {
			expect(sourceState.screen[probe.row].cells[probe.col]).toEqual(probe.cell);
		}

		const replay = await replayTerminalSnapshot(source.snapshot());
		expect(replay.inspect()).toEqual(sourceState);

		source.dispose();
		replay.dispose();
	});

	for (const name of ["line-wrapping", "resize-history", "real-nvim"]) {
		it(`restores the ${name} golden fixture`, async () => {
			const fixture = loadFixture(name);
			const source = await HeadlessTerminalState.create(fixture.initial);
			await applyFixture(source, fixture);
			const sourceState = source.inspect();
			expect(sourceState).toMatchObject(fixture.expected);
			if (name === "real-nvim") {
				expect(sourceState.screen.some((line) => line.text.includes("NVIM v0.12.4"))).toBe(true);
			}

			const replay = await replayTerminalSnapshot(source.snapshot());
			expect(replay.inspect()).toEqual(sourceState);

			source.dispose();
			replay.dispose();
		});
	}
});
