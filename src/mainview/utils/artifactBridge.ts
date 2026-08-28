/**
 * `window.dev3` — the artifact→agent message bridge injected into every artifact
 * the viewer renders.
 *
 * It cannot live on the starter template's `window.dev3Artifact`: that object is
 * built and `Object.freeze`d by `app.js`, which runs AFTER this injection and
 * would drop the bridge on the floor. See
 * `decisions/2026/08/28/artifact-to-agent-message-channel.md`.
 *
 * Authored as a real function rather than a hand-written script string so its
 * behaviour is directly testable; {@link artifactBridgeScript} serializes it.
 * That makes the function's isolation load-bearing: it may reference nothing
 * outside its own body except the two arguments it is handed.
 */

export interface ArtifactBridgeConfig {
	/** Compose-time half of the gate: newest version, task still alive. */
	canSend: boolean;
	/** How long a trusted input event keeps `sendToAgent` unlocked. */
	gestureMs: number;
	/** How long a send waits for the viewer's reply before giving up. */
	timeoutMs: number;
}

export const ARTIFACT_BRIDGE_GESTURE_MS = 5_000;
export const ARTIFACT_BRIDGE_TIMEOUT_MS = 15_000;

/** Reason codes an author can branch on; also the rejected Error's `.reason`. */
export type ArtifactBridgeReason =
	| "unavailable"
	| "empty"
	| "busy"
	| "no-gesture"
	| "timeout"
	| "failed";

export interface ArtifactBridgeWindow {
	parent?: unknown;
	addEventListener(type: string, listener: (event: never) => void, capture?: boolean): void;
	postMessage?(message: unknown, targetOrigin: string): void;
	dev3?: unknown;
}

/**
 * Install the bridge into `win`. Runs inside the artifact's own sandboxed frame,
 * so everything it needs — the parent window, timers, `Date` — comes from there.
 */
export function installArtifactBridge(win: ArtifactBridgeWindow, config: ArtifactBridgeConfig): void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const w = win as any;
	const parentWindow = w.parent;
	// No distinct parent frame → this copy was opened on its own (a browser tab, a
	// downloaded file). Nothing is listening, so the capability is honestly false.
	const framed = Boolean(parentWindow) && parentWindow !== w;
	const canSend = Boolean(config.canSend) && framed;
	let lastGesture = -Infinity;
	let pendingId: number | null = null;
	let pending: { resolve: () => void; reject: (error: Error) => void } | null = null;
	let counter = 0;

	function fail(reason: string, message: string): Error {
		const error = new Error(message);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(error as any).reason = reason;
		return error;
	}

	function settle(): void {
		pendingId = null;
		pending = null;
	}

	["pointerdown", "keydown", "click", "touchstart"].forEach(function (type) {
		w.addEventListener(type, function (event: { isTrusted?: boolean }) {
			if (event && event.isTrusted) lastGesture = Date.now();
		}, true);
	});

	w.addEventListener("message", function (event: { data?: { type?: string; id?: number; ok?: boolean; reason?: string; message?: string } }) {
		const data = event && event.data;
		if (!data || data.type !== "dev3-artifact-send-result" || data.id !== pendingId) return;
		const settled = pending;
		settle();
		if (!settled) return;
		if (data.ok) settled.resolve();
		else settled.reject(fail(data.reason || "failed", data.message || "Could not send the message to the agent."));
	}, false);

	function sendToAgent(text: unknown): Promise<void> {
		return new Promise(function (resolve, reject) {
			if (!canSend) {
				reject(fail("unavailable", "This artifact cannot message the agent."));
				return;
			}
			if (typeof text !== "string" || !text.trim()) {
				reject(fail("empty", "sendToAgent(text) needs a non-empty string."));
				return;
			}
			if (pending) {
				reject(fail("busy", "A message is already on its way."));
				return;
			}
			// A gesture guard, not an access control: it stops a stray timer and a
			// script the report pulled in from driving the agent unattended.
			if (Date.now() - lastGesture > config.gestureMs) {
				reject(fail("no-gesture", "sendToAgent() must be called from a click or key press."));
				return;
			}
			const id = ++counter;
			pendingId = id;
			pending = { resolve, reject };
			setTimeout(function () {
				if (pendingId !== id) return;
				const timedOut = pending;
				settle();
				if (timedOut) timedOut.reject(fail("timeout", "The viewer did not answer."));
			}, config.timeoutMs);
			parentWindow.postMessage({ type: "dev3-artifact-send", id: id, text: text }, "*");
		});
	}

	w.dev3 = { canSendToAgent: canSend, sendToAgent: sendToAgent };
}

/** The injected `<script>` that installs the bridge inside the artifact document. */
export function artifactBridgeScript(canSend: boolean): string {
	const config: ArtifactBridgeConfig = {
		canSend,
		gestureMs: ARTIFACT_BRIDGE_GESTURE_MS,
		timeoutMs: ARTIFACT_BRIDGE_TIMEOUT_MS,
	};
	return `<script data-dev3-artifact-bridge>(${installArtifactBridge.toString()})(window,${JSON.stringify(config)});</script>`;
}
