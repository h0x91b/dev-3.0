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

export async function startTunnel(localPort: number): Promise<string | null> {
	if (tunnelState === "starting" || tunnelState === "connected") {
		log.warn("Tunnel already active", { state: tunnelState });
		return tunnelUrl;
	}

	tunnelState = "starting";
	tunnelUrl = null;

	try {
		tunnelProcess = spawn(
			[
				"cloudflared",
				"tunnel",
				"--url",
				`http://localhost:${localPort}`,
				"--metrics",
				"localhost:20241",
			],
			{ stdout: "ignore", stderr: "ignore" },
		);

		tunnelProcess.exited.then(() => {
			log.info("Tunnel process exited");
			tunnelProcess = null;
			tunnelUrl = null;
			tunnelState = "idle";
		});

		const url = await pollForUrl(30_000, 500);
		if (url) {
			tunnelUrl = url;
			tunnelState = "connected";
			log.info("Tunnel connected", { url });
			return url;
		}

		log.warn("Tunnel URL poll timed out");
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

async function pollForUrl(timeoutMs: number, intervalMs: number): Promise<string | null> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		try {
			const res = await fetch("http://127.0.0.1:20241/quicktunnel");
			if (res.ok) {
				const data = (await res.json()) as { hostname?: string };
				if (data.hostname) {
					return `https://${data.hostname}`;
				}
			}
		} catch {
			// cloudflared not ready yet
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
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
