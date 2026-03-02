import { connect } from "node:net";
import type { CliRequest, CliResponse } from "../shared/types";

export async function sendRequest(
	socketPath: string,
	method: string,
	params: Record<string, unknown> = {},
): Promise<CliResponse> {
	const req: CliRequest = {
		id: crypto.randomUUID(),
		method,
		params,
	};

	return new Promise((resolve, reject) => {
		const socket = connect({ path: socketPath });
		let buffer = "";

		socket.on("connect", () => {
			socket.write(JSON.stringify(req) + "\n");
		});

		socket.on("data", (data) => {
			buffer += data.toString();
		});

		socket.on("end", () => {
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
			if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED" ||
				(err as NodeJS.ErrnoException).code === "ENOENT") {
				reject(new Error("APP_NOT_RUNNING"));
			} else {
				reject(err);
			}
		});

		socket.setTimeout(30_000, () => {
			socket.destroy();
			reject(new Error("Socket timeout (30s)"));
		});
	});
}
