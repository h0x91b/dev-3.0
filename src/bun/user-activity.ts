import { spawn } from "./spawn";

/**
 * Seconds since the user last touched the keyboard/mouse, i.e. how long the
 * machine has been idle from a human-input standpoint. Lets `dev3 ui state`
 * tell an agent whether the user is even at the computer before it pings.
 *
 * macOS: read `HIDIdleTime` (nanoseconds) from IOKit via `ioreg`.
 * Other platforms: returns null (unknown) — no portable, dependency-free probe.
 * Any failure also yields null so callers degrade gracefully.
 */
export async function getUserIdleSeconds(): Promise<number | null> {
	if (process.platform !== "darwin") return null;
	try {
		const proc = spawn(["ioreg", "-c", "IOHIDSystem"], { stdout: "pipe", stderr: "pipe" });
		const out = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		if (exitCode !== 0) return null;
		// "HIDIdleTime" = 12345678 (nanoseconds since last HID event)
		const match = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
		if (!match) return null;
		const ns = Number(match[1]);
		if (!Number.isFinite(ns)) return null;
		return Math.round(ns / 1_000_000_000);
	} catch {
		return null;
	}
}
