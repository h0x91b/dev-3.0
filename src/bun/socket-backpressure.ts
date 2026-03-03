// Backpressure handling for Bun's socket.write() partial writes.
// Bun's socket.write() can return fewer bytes than requested when the
// send buffer is full. This module buffers the remainder and provides
// a drain function to flush it incrementally.

interface PendingWrite {
	buffer: Buffer;
	shouldEnd: boolean;
}

export interface FlushableSocket {
	write(data: Buffer): number;
	end(): void;
}

// biome-ignore lint: Bun socket type is opaque, no public generic we can import
export const pendingWrites = new Map<any, PendingWrite>();

export function flushAndEnd(socket: FlushableSocket, data: string): void {
	const bytes = Buffer.from(data, "utf-8");
	const written = socket.write(bytes);
	if (written < bytes.length) {
		pendingWrites.set(socket, { buffer: bytes.subarray(written), shouldEnd: true });
	} else {
		socket.end();
	}
}

export function drainSocket(socket: FlushableSocket): void {
	const pending = pendingWrites.get(socket);
	if (!pending) return;

	const written = socket.write(pending.buffer);
	if (written < pending.buffer.length) {
		pending.buffer = pending.buffer.subarray(written);
	} else {
		pendingWrites.delete(socket);
		if (pending.shouldEnd) {
			socket.end();
		}
	}
}
