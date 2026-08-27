/**
 * Renderer debug channels: chatty setup traces that are load-bearing when a terminal
 * refuses to attach, and pure noise the rest of the time.
 *
 * They stay ON in the app (that is what they were written for) and OFF under vitest,
 * where they buried the actual test output. Either default is overridable from
 * devtools: `localStorage["dev3-debug"] = "terminal,rpc"`, `"*"`, or `"off"`.
 */

export type DebugChannel = "terminal" | "rpc" | "boot";

export function underTest(): boolean {
	if (import.meta.env?.MODE === "test") return true;
	return typeof process !== "undefined" && !!process.env?.VITEST;
}

function readOverride(): string | null {
	try {
		return globalThis.localStorage?.getItem("dev3-debug") ?? null;
	} catch {
		return null;
	}
}

/** Resolved per call: the flag is set from devtools mid-session, not at boot. */
export function debugEnabled(channel: DebugChannel): boolean {
	const override = readOverride();
	if (override === null) return !underTest();
	if (override === "off") return false;
	const wanted = override.split(",").map((part) => part.trim());
	return wanted.includes("*") || wanted.includes(channel);
}

export function debugLog(channel: DebugChannel, ...args: unknown[]): void {
	if (!debugEnabled(channel)) return;
	console.log(...args);
}
