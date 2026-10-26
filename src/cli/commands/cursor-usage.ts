import { recordCursorHookUsage } from "../../bun/usage-collectors/cursor";

/** Internal local accounting hook; failures must never interrupt the agent. */
export function handleCursorUsage(rawInput: string, storeRoot?: string): void {
	try {
		recordCursorHookUsage(JSON.parse(rawInput), Date.now(), storeRoot);
	} catch { /* Malformed input and unavailable storage are deliberately silent. */ }
}
