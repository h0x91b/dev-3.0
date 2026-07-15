import { Buffer } from "node:buffer";

/** Read all UTF-8 text from a CLI input stream without changing its contents. */
export async function readStdin(
	input: AsyncIterable<Uint8Array | string> = process.stdin,
): Promise<string> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of input) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString("utf-8");
}
