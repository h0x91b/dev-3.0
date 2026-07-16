import type { AgentRateLimitSnapshot } from "../shared/rate-limits";
import { parseCodexAppServerRateLimits } from "../shared/rate-limits";
import { createLogger } from "./logger";
import { spawn } from "./spawn";

const log = createLogger("codex-rate-limits");
const RATE_LIMITS_REQUEST_ID = 7;
const DEFAULT_TIMEOUT_MS = 5_000;

type SpawnProcess = typeof spawn;

/**
 * Read the authenticated Codex account limit snapshot through the stable local
 * app-server protocol. Returns null for missing binaries, auth/network errors,
 * timeouts, or protocol drift so rollout parsing remains a complete fallback.
 */
export async function fetchCodexRateLimitSnapshot(
	spawnProcess: SpawnProcess = spawn,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
	capturedAt: number = Date.now(),
	env?: Record<string, string>,
): Promise<AgentRateLimitSnapshot | null> {
	let proc: ReturnType<SpawnProcess> | null = null;
	let stdin: import("bun").FileSink | null = null;
	let timeout: ReturnType<typeof setTimeout> | null = null;
	try {
		proc = spawnProcess(["codex", "app-server", "--stdio"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			...(env ? { env } : {}),
		});
		stdin = proc.stdin as unknown as import("bun").FileSink;
		stdin.write(
			`${JSON.stringify({ method: "initialize", id: 0, params: { clientInfo: { name: "dev3", title: "dev-3.0", version: "1" } } })}\n`,
		);
		stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
		stdin.write(`${JSON.stringify({ method: "account/rateLimits/read", id: RATE_LIMITS_REQUEST_ID, params: {} })}\n`);

		// Drain stderr so a verbose child cannot block on a full pipe. Its contents
		// may include account diagnostics, so never copy them into logs.
		void new Response(proc.stderr as unknown as ReadableStream<Uint8Array>).text().catch(() => {});
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeout = setTimeout(() => {
				proc?.kill();
				reject(new Error("Codex app-server rate-limit request timed out"));
			}, timeoutMs);
		});
		const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let buffered = "";
		while (true) {
			const chunk = await Promise.race([reader.read(), timeoutPromise]);
			buffered += chunk.value ? decoder.decode(chunk.value, { stream: !chunk.done }) : "";
			const lines = buffered.split("\n");
			buffered = chunk.done ? "" : lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const message = JSON.parse(line) as { id?: number; result?: { rateLimits?: unknown } };
					if (message.id !== RATE_LIMITS_REQUEST_ID) continue;
					return message.result?.rateLimits
						? parseCodexAppServerRateLimits(message.result.rateLimits, capturedAt)
						: null;
				} catch {
					// Ignore notifications and malformed diagnostic lines.
				}
			}
			if (chunk.done) break;
		}
		return null;
	} catch (error) {
		log.warn("Codex live rate limits unavailable; using rollout fallback", { error: String(error) });
		return null;
	} finally {
		if (timeout) clearTimeout(timeout);
		stdin?.end();
		proc?.kill();
	}
}
