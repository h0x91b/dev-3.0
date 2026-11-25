/**
 * The native terminal's per-viewer bridge state (seq 1300).
 *
 * Two invariants the remote path depends on: a viewer either resumes exactly
 * where it stopped or is told the screen was replaced (never a silent gap), and
 * exactly one viewer holds the write lease at any moment while viewers remain.
 */
import { describe, it, expect } from "vitest";
import { NativeBridgeJournal, NativeClientLease } from "../native-terminal-bridge";

describe("NativeBridgeJournal", () => {
	it("numbers frames from 1, reports the watermark, and never burns a number on an empty frame", () => {
		const journal = new NativeBridgeJournal();

		expect(journal.push("a")).toBe(1);
		expect(journal.push("b")).toBe(2);
		expect(journal.tailSeq).toBe(2);
		expect(journal.headSeq).toBe(1);
		expect(journal.push("")).toBe(2);
		expect(journal.tailSeq).toBe(2);
	});

	it("hands a first-time viewer the whole tail, empty or not, flagged as a rebuild", () => {
		const journal = new NativeBridgeJournal();
		expect(journal.replayFrom(null)).toEqual({ seq: 0, data: "", resumed: false, reset: "fresh" });

		journal.push("one");
		journal.push("two");
		expect(journal.replayFrom(null)).toEqual({ seq: 2, data: "onetwo", resumed: false, reset: "fresh" });
	});

	it("sends a level viewer nothing, and a reconnecting one only the frames it missed", () => {
		const journal = new NativeBridgeJournal();
		journal.push("one");

		expect(journal.replayFrom(1)).toEqual({ seq: 1, data: "", resumed: true });
		// A watermark ahead of us (stale reconnect ordering) must never rewind either.
		expect(journal.replayFrom(9)).toEqual({ seq: 1, data: "", resumed: true });

		journal.push("two");
		journal.push("three");
		expect(journal.replayFrom(1)).toEqual({ seq: 3, data: "twothree", resumed: true });
	});

	it("resumes a viewer whose missing range survived the cap, and resyncs one whose watermark was evicted", () => {
		const journal = new NativeBridgeJournal(8);
		journal.push("aaaa");
		journal.push("bbbb");
		journal.push("cccc"); // evicts "aaaa"

		// Eviction alone is not a gap: frames 2 and 3 are exactly what seq 1 missed.
		expect(journal.headSeq).toBe(2);
		expect(journal.replayFrom(1)).toEqual({ seq: 3, data: "bbbbcccc", resumed: true });
		expect(journal.resyncCount).toBe(0);

		journal.push("dddd"); // frames 1 and 2 are gone

		expect(journal.headSeq).toBe(3);
		const replay = journal.replayFrom(1);

		expect(replay).toEqual({ seq: 4, data: "ccccdddd", resumed: false, reset: "pressure" });
		expect(journal.resyncCount).toBe(1);
	});

	it("keeps the newest frame even when it alone exceeds the cap", () => {
		const journal = new NativeBridgeJournal(4);
		journal.push("aaaa");
		journal.push("bbbbbbbbbb");

		expect(journal.replayFrom(1)).toMatchObject({ data: "bbbbbbbbbb", resumed: true });
	});
});

describe("NativeClientLease", () => {
	it("makes the first viewer the writer and every later one an observer, ignoring strangers and leaving observers", () => {
		const lease = new NativeClientLease<string>();

		expect(lease.attach("desktop")).toBe("writer");
		expect(lease.attach("browser")).toBe("observer");
		expect(lease.canWrite("desktop")).toBe(true);
		expect(lease.canWrite("browser")).toBe(false);
		// A viewer that never attached cannot claim, and an observer leaving says nothing.
		expect(lease.claim("stranger")).toBeNull();
		expect(lease.detach("browser")).toBeNull();
		expect(lease.writer).toBe("desktop");
	});

	it("moves the lease atomically on takeover", () => {
		const lease = new NativeClientLease<string>();
		lease.attach("desktop");
		lease.attach("browser");

		expect(lease.claim("browser")).toEqual({ writer: "browser", previous: "desktop" });
		expect(lease.roleOf("desktop")).toBe("observer");
		expect(lease.roleOf("browser")).toBe("writer");
		// Re-claiming is a no-op, not a second transfer.
		expect(lease.claim("browser")).toBeNull();
	});

	it("promotes a remaining viewer when the writer disconnects", () => {
		const lease = new NativeClientLease<string>();
		lease.attach("desktop");
		lease.attach("browser");

		expect(lease.detach("desktop")).toEqual({ writer: "browser", previous: "desktop" });
		expect(lease.canWrite("browser")).toBe(true);
	});

	it("leaves no writer once the last viewer is gone, and re-seeds on the next attach", () => {
		const lease = new NativeClientLease<string>();
		lease.attach("desktop");

		expect(lease.detach("desktop")).toEqual({ writer: null, previous: "desktop" });
		expect(lease.size).toBe(0);
		expect(lease.attach("browser")).toBe("writer");
	});

	it("hands the lease to the next viewer on an explicit release", () => {
		const lease = new NativeClientLease<string>();
		lease.attach("desktop");
		lease.attach("browser");

		expect(lease.release("desktop")).toEqual({ writer: "browser", previous: "desktop" });
		expect(lease.release("desktop")).toBeNull();
	});
});
