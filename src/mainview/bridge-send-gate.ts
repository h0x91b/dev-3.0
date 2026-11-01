/**
 * Holds renderer→bun RPC messages until the Electrobun socket is open.
 *
 * Electroview sends a message over its WebSocket when that socket is OPEN and
 * otherwise through the native `postMessage` bridge. On macOS that bridge copies
 * the message, queues a threadsafe callback onto the bun thread, and frees the
 * copy one second later (`MyScriptMessageHandler` in electrobun's
 * nativeWrapper.mm). A bun thread busy for more than a second reads freed memory
 * and drops the request without a trace. The window that matters is startup,
 * before the socket has opened — which is exactly when the first requests go out.
 *
 * So a message is held while a socket is still connecting, sent through the
 * socket once it opens, and only handed to the fallback if no socket opens
 * within `fallbackMs` — the fallback stays for a webview that genuinely has none.
 * See decisions/2026/11/01/hold-startup-rpc-until-bridge-socket-opens.md.
 */

export interface BridgeSendGateOptions {
	/** True when the bridge socket can carry a message right now. */
	isSocketOpen: () => boolean;
	/** True while a socket exists that may still open (CONNECTING). */
	isSocketPending: () => boolean;
	/** The original Electroview send: socket when open, native bridge otherwise. */
	send: (message: string) => void;
	fallbackMs: number;
	onFallback?: (held: number) => void;
	setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimeoutFn?: (id: ReturnType<typeof setTimeout>) => void;
}

export interface BridgeSendGate {
	send(message: string): void;
	/** Call whenever a bridge socket opens. */
	socketOpened(): void;
	/** Messages currently waiting for a socket (tests/diagnostics). */
	heldCount(): number;
}

export function createBridgeSendGate(opts: BridgeSendGateOptions): BridgeSendGate {
	const setTimeoutFn = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
	const clearTimeoutFn = opts.clearTimeoutFn ?? ((id: ReturnType<typeof setTimeout>) => clearTimeout(id));
	const held: string[] = [];
	let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

	function flush(): void {
		if (fallbackTimer !== null) {
			clearTimeoutFn(fallbackTimer);
			fallbackTimer = null;
		}
		const batch = held.splice(0, held.length);
		for (const message of batch) opts.send(message);
	}

	return {
		send(message) {
			if (held.length === 0 && (opts.isSocketOpen() || !opts.isSocketPending())) {
				opts.send(message);
				return;
			}
			held.push(message);
			if (fallbackTimer === null) {
				fallbackTimer = setTimeoutFn(() => {
					fallbackTimer = null;
					if (held.length === 0) return;
					opts.onFallback?.(held.length);
					flush();
				}, opts.fallbackMs);
			}
		},
		socketOpened() {
			if (held.length > 0) flush();
		},
		heldCount() {
			return held.length;
		},
	};
}
