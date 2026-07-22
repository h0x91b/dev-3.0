import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_JOURNAL_MAX_BYTES,
	encodeJournalFrame,
	JournalWriter,
	parseJournal,
	parseJournalFrame,
	pushFrameCapped,
} from "../journal";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe("native-session journal frames", () => {
	it("round-trips a frame through encode/parse", () => {
		const line = encodeJournalFrame(3, "2026-07-20T00:00:00.000Z", enc("hello ✓"));
		const frame = parseJournalFrame(line);
		expect(frame?.seq).toBe(3);
		expect(frame?.t).toBe("2026-07-20T00:00:00.000Z");
		expect(dec(frame!.data)).toBe("hello ✓");
	});

	it("parses a multi-line journal and skips junk lines", () => {
		const text = `${encodeJournalFrame(0, "t", enc("a"))}not-json\n${encodeJournalFrame(1, "t", enc("b"))}`;
		const frames = parseJournal(text);
		expect(frames.map((f) => dec(f.data))).toEqual(["a", "b"]);
	});

	it("caps the rolling buffer to maxBytes, always keeping the newest frame", () => {
		let frames: string[] = [];
		let bytes = 0;
		for (let i = 0; i < 50; i++) {
			const line = encodeJournalFrame(i, "t", enc(`chunk-${i}-`.repeat(4)));
			({ frames, bytes } = pushFrameCapped(frames, bytes, line, 400));
		}
		expect(bytes).toBeLessThanOrEqual(400);
		expect(frames.length).toBeGreaterThanOrEqual(1);
		// Oldest frames were dropped; the most recent one is always retained.
		const parsed = parseJournal(frames.join(""));
		expect(parsed[parsed.length - 1]?.seq).toBe(49);
	});

	it("keeps a single over-cap frame rather than dropping everything", () => {
		const huge = encodeJournalFrame(0, "t", enc("x".repeat(1000)));
		const { frames, bytes } = pushFrameCapped([], 0, huge, 100);
		expect(frames).toHaveLength(1);
		expect(bytes).toBeGreaterThan(100);
	});

	it("JournalWriter flushes the capped tail to disk", () => {
		const dir = mkdtempSync(join(tmpdir(), "dev3-native-journal-"));
		const path = join(dir, "journal.ndjson");
		try {
			const writer = new JournalWriter(path, DEFAULT_JOURNAL_MAX_BYTES);
			writer.record(enc("one\n"), "2026-07-20T00:00:00.000Z");
			writer.record(enc("two\n"), "2026-07-20T00:00:01.000Z");
			writer.stop();
			const frames = parseJournal(readFileSync(path, "utf8"));
			expect(frames.map((f) => dec(f.data))).toEqual(["one\n", "two\n"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the last complete journal when publishing the next tail fails", () => {
		const dir = mkdtempSync(join(tmpdir(), "dev3-native-journal-atomic-"));
		const path = join(dir, "journal.ndjson");
		const oldLine = encodeJournalFrame(0, "2026-07-20T00:00:00.000Z", enc("old\n"));
		try {
			writeFileSync(path, oldLine);
			mkdirSync(`${path}.${process.pid}.tmp`);
			const writer = new JournalWriter(path);
			writer.record(enc("new\n"), "2026-07-20T00:00:01.000Z");
			writer.stop();

			expect(readFileSync(path, "utf8")).toBe(oldLine);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("replays the current in-memory tail before a disk flush", () => {
		const writer = new JournalWriter("unused");
		writer.record(enc("before-attach\n"), "2026-07-20T00:00:00.000Z");

		expect(writer.replay().map(dec)).toEqual(["before-attach\n"]);
	});
});
