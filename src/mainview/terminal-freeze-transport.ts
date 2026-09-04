import type { TerminalFreezeTraceEvent } from "./terminal-freeze-trace";

interface NativeDiagnosticBridge {
	postMessage(packet: string): void;
}

/** The regular desktop RPC awaits encryption, which a wedged JS thread cannot finish. */
export function sendTerminalFreezeTrace(
	event: TerminalFreezeTraceEvent,
	fallback: () => void,
	bridge: NativeDiagnosticBridge | undefined = (globalThis as unknown as {
		__electrobunBunBridge?: NativeDiagnosticBridge;
	}).__electrobunBunBridge,
): void {
	try {
		if (bridge) {
			bridge.postMessage(JSON.stringify({ type: "message", id: "terminalFreezeTrace", payload: event }));
			return;
		}
	} catch { /* Try the ordinary diagnostic sink if the native bridge is unavailable. */ }
	try { fallback(); } catch { /* Diagnostics cannot interrupt terminal work. */ }
}
