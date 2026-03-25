import { spawn, spawnSync } from "./spawn";
import { createLogger } from "./logger";

const log = createLogger("cf-tunnel");

type TunnelState = "idle" | "starting" | "connected" | "failed";

let tunnelProcess: ReturnType<typeof spawn> | null = null;
let tunnelUrl: string | null = null;
let tunnelState: TunnelState = "idle";

export function isCloudflaredAvailable(): boolean {
	const result = spawnSync(["which", "cloudflared"]);
	return result.exitCode === 0;
}

/**
 * Parse a Cloudflare Tunnel URL from a line of cloudflared stderr output.
 * cloudflared prints lines like:
 *   INF |  https://something-random.trycloudflare.com
 *   or: ... https://something.trycloudflare.com ...
 * Returns the full URL or null.
 */
export function parseTunnelUrl(line: string): string | null {
	const match = line.match(/https:\/\/[a-zA-Z0-9_-]+\.trycloudflare\.com/);
	return match ? match[0] : null;
}

export async function startTunnel(localPort: number): Promise<string | null> {
	if (tunnelState === "starting" || tunnelState === "connected") {
		log.warn("Tunnel already active", { state: tunnelState });
		return tunnelUrl;
	}

	tunnelState = "starting";
	tunnelUrl = null;

	try {
		tunnelProcess = spawn(
			["cloudflared", "tunnel", "--url", `http://localhost:${localPort}`],
			{ stdout: "ignore", stderr: "pipe" },
		);

		tunnelProcess.exited.then(() => {
			log.info("Tunnel process exited");
			tunnelProcess = null;
			tunnelUrl = null;
			tunnelState = "idle";
		});

		const url = await waitForUrl(tunnelProcess.stderr!, 30_000);
		if (url) {
			tunnelUrl = url;
			tunnelState = "connected";
			log.info("Tunnel connected", { url });
			return url;
		}

		log.warn("Tunnel URL not found in stderr within timeout");
		tunnelState = "failed";
		stopTunnel();
		return null;
	} catch (err) {
		log.error("Failed to start tunnel", { error: String(err) });
		tunnelState = "failed";
		stopTunnel();
		return null;
	}
}

async function waitForUrl(stderr: ReadableStream, timeoutMs: number): Promise<string | null> {
	const reader = stderr.getReader();
	const decoder = new TextDecoder();
	const deadline = Date.now() + timeoutMs;
	let buffer = "";

	try {
		while (Date.now() < deadline) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;

			const result = await Promise.race([
				reader.read(),
				new Promise<{ done: true; value: undefined }>((resolve) =>
					setTimeout(() => resolve({ done: true, value: undefined }), remaining),
				),
			]);

			if (result.done) break;

			buffer += decoder.decode(result.value, { stream: true });

			// Process complete lines
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const url = parseTunnelUrl(line);
				if (url) {
					reader.releaseLock();
					return url;
				}
			}
		}

		// Check remaining buffer
		if (buffer) {
			const url = parseTunnelUrl(buffer);
			if (url) return url;
		}
	} finally {
		try { reader.releaseLock(); } catch { /* already released */ }
	}

	return null;
}

export function stopTunnel(): void {
	if (tunnelProcess) {
		try {
			tunnelProcess.kill();
		} catch {
			// process may already be dead
		}
		tunnelProcess = null;
	}
	tunnelUrl = null;
	tunnelState = "idle";
}

export function getTunnelUrl(): string | null {
	return tunnelUrl;
}

export function getTunnelState(): TunnelState {
	return tunnelState;
}

/** Reset module state — only for tests */
export function _resetState(): void {
	tunnelProcess = null;
	tunnelUrl = null;
	tunnelState = "idle";
}
