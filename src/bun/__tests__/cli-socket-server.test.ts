import { describe, it, expect, beforeEach } from "vitest";
import { flushAndEnd, drainSocket, pendingWrites, type FlushableSocket } from "../socket-backpressure";

/**
 * Creates a mock socket that simulates Bun's partial-write behavior.
 * `maxBytesPerWrite` controls how many bytes socket.write() accepts per call
 * (simulates socket buffer backpressure).
 */
function createMockSocket(maxBytesPerWrite = Infinity): FlushableSocket & {
	written: Buffer[];
	ended: boolean;
	totalBytesWritten: number;
} {
	const mock = {
		written: [] as Buffer[],
		ended: false,
		totalBytesWritten: 0,
		write(data: Buffer): number {
			const toWrite = Math.min(data.length, maxBytesPerWrite);
			if (toWrite > 0) {
				mock.written.push(Buffer.from(data.subarray(0, toWrite)));
				mock.totalBytesWritten += toWrite;
			}
			return toWrite;
		},
		end(): void {
			mock.ended = true;
		},
	};
	return mock;
}

function getFullOutput(socket: ReturnType<typeof createMockSocket>): string {
	return Buffer.concat(socket.written).toString("utf-8");
}

beforeEach(() => {
	pendingWrites.clear();
});

describe("flushAndEnd", () => {
	it("writes small data in one shot and ends immediately", () => {
		const socket = createMockSocket();
		flushAndEnd(socket, '{"ok":true}\n');

		expect(socket.ended).toBe(true);
		expect(getFullOutput(socket)).toBe('{"ok":true}\n');
		expect(pendingWrites.size).toBe(0);
	});

	it("buffers remainder on partial write (does not end)", () => {
		// Socket accepts only 10 bytes per write — simulates backpressure
		const socket = createMockSocket(10);
		const data = '{"id":"abc","ok":true,"data":"hello world"}\n';

		flushAndEnd(socket, data);

		// Should NOT have ended — there's still data to flush
		expect(socket.ended).toBe(false);
		// Should have buffered the remainder
		expect(pendingWrites.has(socket)).toBe(true);
		const pending = pendingWrites.get(socket)!;
		expect(pending.shouldEnd).toBe(true);
		// First write was 10 bytes
		expect(socket.totalBytesWritten).toBe(10);
		// Remaining bytes should match
		const totalBytes = Buffer.from(data, "utf-8").length;
		expect(pending.buffer.length).toBe(totalBytes - 10);
	});

	it("handles zero-byte write (full backpressure)", () => {
		const socket = createMockSocket(0);
		const data = '{"ok":true}\n';

		flushAndEnd(socket, data);

		expect(socket.ended).toBe(false);
		expect(pendingWrites.has(socket)).toBe(true);
		expect(socket.totalBytesWritten).toBe(0);
		const pending = pendingWrites.get(socket)!;
		expect(pending.buffer.length).toBe(Buffer.from(data, "utf-8").length);
	});

	it("handles multi-byte UTF-8 data correctly", () => {
		const socket = createMockSocket();
		// Russian text — each Cyrillic char is 2 bytes in UTF-8
		const data = '{"title":"Привет мир"}\n';

		flushAndEnd(socket, data);

		expect(socket.ended).toBe(true);
		expect(getFullOutput(socket)).toBe(data);
	});

	it("buffers correctly when partial write splits multi-byte character", () => {
		// "Привет" in UTF-8 is 12 bytes (6 chars × 2 bytes each)
		// Split at byte 15 to land mid-character
		const socket = createMockSocket(15);
		const data = '{"title":"Привет мир"}\n';

		flushAndEnd(socket, data);

		expect(socket.ended).toBe(false);
		expect(pendingWrites.has(socket)).toBe(true);
		// The pending buffer should contain the rest
		const pending = pendingWrites.get(socket)!;
		const totalBytes = Buffer.from(data, "utf-8").length;
		expect(pending.buffer.length).toBe(totalBytes - 15);
	});
});

describe("drainSocket", () => {
	it("does nothing when no pending write exists", () => {
		const socket = createMockSocket();

		drainSocket(socket);

		expect(socket.ended).toBe(false);
		expect(socket.totalBytesWritten).toBe(0);
	});

	it("flushes remaining data and ends socket", () => {
		// First: partial write of 10 bytes
		const socket = createMockSocket(10);
		const data = '{"id":"abc","ok":true,"data":"hello"}\n';
		flushAndEnd(socket, data);

		expect(socket.ended).toBe(false);
		expect(pendingWrites.has(socket)).toBe(true);

		// Now simulate drain: allow unlimited writes
		Object.defineProperty(socket, "write", {
			value: (buf: Buffer) => {
				socket.written.push(Buffer.from(buf));
				socket.totalBytesWritten += buf.length;
				return buf.length;
			},
		});

		drainSocket(socket);

		expect(socket.ended).toBe(true);
		expect(pendingWrites.has(socket)).toBe(false);
		// All data should be present
		expect(getFullOutput(socket)).toBe(data);
	});

	it("handles another partial write during drain", () => {
		// Initial partial write: 5 bytes
		const socket = createMockSocket(5);
		const data = '{"data":"some longer content here"}\n';
		flushAndEnd(socket, data);

		expect(socket.totalBytesWritten).toBe(5);
		expect(socket.ended).toBe(false);

		// First drain: still limited to 5 bytes
		drainSocket(socket);
		expect(socket.totalBytesWritten).toBe(10);
		expect(socket.ended).toBe(false);
		expect(pendingWrites.has(socket)).toBe(true);

		// Keep draining until done
		let maxIterations = 100;
		while (pendingWrites.has(socket) && maxIterations-- > 0) {
			drainSocket(socket);
		}

		expect(socket.ended).toBe(true);
		expect(pendingWrites.has(socket)).toBe(false);
		expect(getFullOutput(socket)).toBe(data);
	});

	it("reproduces the original bug: large tasks.list response", () => {
		// Generate a response similar to what tasks.list returns
		const tasks = Array.from({ length: 50 }, (_, i) => ({
			id: `task-${String(i).padStart(4, "0")}`,
			seq: i + 1,
			title: `Задача номер ${i + 1}: ${"описание на русском ".repeat(5)}`,
			status: "in-progress",
			description: `Подробное описание задачи ${i + 1} ${"с деталями ".repeat(10)}`,
		}));
		const response = JSON.stringify({ id: "req-1", ok: true, data: tasks }) + "\n";
		const responseBytes = Buffer.from(response, "utf-8").length;

		// Simulate Bun's ~8KB socket write limit
		const socket = createMockSocket(8192);

		flushAndEnd(socket, response);

		// With the old code (no drain), the server would call socket.end()
		// immediately after partial write, losing the rest of the data.
		// Verify the fix: socket should NOT have ended yet.
		expect(socket.ended).toBe(false);
		expect(pendingWrites.has(socket)).toBe(true);
		expect(socket.totalBytesWritten).toBe(8192);
		expect(responseBytes).toBeGreaterThan(8192);

		// Now simulate drain events until all data is flushed
		let iterations = 0;
		while (pendingWrites.has(socket) && iterations < 100) {
			drainSocket(socket);
			iterations++;
		}

		expect(socket.ended).toBe(true);
		expect(pendingWrites.has(socket)).toBe(false);

		// Reconstruct the full output and verify it's valid JSON
		const fullOutput = getFullOutput(socket);
		expect(fullOutput).toBe(response);
		const parsed = JSON.parse(fullOutput.trim());
		expect(parsed.ok).toBe(true);
		expect(parsed.data.length).toBe(50);
	});
});
