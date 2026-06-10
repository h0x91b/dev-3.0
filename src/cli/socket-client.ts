import { connect } from "node:net";
import type { CliRequest, CliResponse } from "../shared/types";

const DEFAULT_TIMEOUT_MS = 30_000;

export async function sendRequest(
	socketPath: string,
	method: string,
	params: Record<string, unknown> = {},
	opts: { timeoutMs?: number } = {},
): Promise<CliResponse> {
	const req: CliRequest = {
		id: crypto.randomUUID(),
		method,
		params,
	};

	return new Promise((resolve, reject) => {
		const socket = connect({ path: socketPath });
		// Accumulate raw buffers to avoid corrupting multi-byte UTF-8
		// characters that may be split across data events.
		const chunks: Buffer[] = [];

		socket.on("connect", () => {
			socket.write(JSON.stringify(req) + "\n");
		});

		socket.on("data", (data) => {
			chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
		});

		socket.on("end", () => {
			const buffer = Buffer.concat(chunks).toString("utf-8");
			const lines = buffer.split("\n").filter((l) => l.trim());
			if (lines.length === 0) {
				reject(new Error("Empty response from server"));
				return;
			}
			try {
				resolve(JSON.parse(lines[0]) as CliResponse);
			} catch {
				reject(new Error(`Invalid JSON response: ${lines[0]}`));
			}
		});

		socket.on("error", (err) => {
			socket.destroy();
			if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED" ||
				(err as NodeJS.ErrnoException).code === "ENOENT") {
				reject(new Error("APP_NOT_RUNNING"));
			} else {
				reject(err);
			}
		});

		const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		socket.setTimeout(timeoutMs, () => {
			socket.destroy();
			reject(new Error(`Socket timeout (${Math.round(timeoutMs / 1000)}s)`));
		});
	});
}
