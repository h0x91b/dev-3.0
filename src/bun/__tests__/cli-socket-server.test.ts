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
	it("writes data that fits, ASCII or multi-byte UTF-8, in one shot and ends immediately", () => {
		// Russian text — each Cyrillic char is 2 bytes in UTF-8
		for (const data of ['{"ok":true}\n', '{"title":"Привет мир"}\n']) {
			pendingWrites.clear();
			const socket = createMockSocket();
			flushAndEnd(socket, data);

			expect(socket.ended, data).toBe(true);
			expect(getFullOutput(socket)).toBe(data);
			expect(pendingWrites.size).toBe(0);
		}
	});

	it("buffers the remainder on a partial, zero-byte, or mid-character write and does not end", () => {
		const cases: Array<[number, string]> = [
			[10, '{"id":"abc","ok":true,"data":"hello world"}\n'],
			// Full backpressure.
			[0, '{"ok":true}\n'],
			// Byte 15 lands in the middle of a 2-byte Cyrillic character.
			[15, '{"title":"Привет мир"}\n'],
		];
		for (const [accepts, data] of cases) {
			const socket = createMockSocket(accepts);
			flushAndEnd(socket, data);

			expect(socket.ended, `accepts ${accepts}`).toBe(false);
			expect(pendingWrites.has(socket)).toBe(true);
			const pending = pendingWrites.get(socket)!;
			expect(pending.shouldEnd).toBe(true);
			expect(socket.totalBytesWritten).toBe(accepts);
			expect(pending.buffer.length).toBe(Buffer.from(data, "utf-8").length - accepts);
		}
	});
});

describe("drainSocket", () => {
	it("does nothing with nothing pending, and otherwise flushes remaining data and ends the socket", () => {
		// Nothing pending: drain does nothing.
		const idle = createMockSocket();
		drainSocket(idle);
		expect(idle.ended).toBe(false);
		expect(idle.totalBytesWritten).toBe(0);

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
