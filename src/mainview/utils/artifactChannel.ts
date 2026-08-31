/**
 * The one message channel between the viewer and the artifact document it renders.
 *
 * Two transports, because the viewer renders the artifact two different ways:
 *
 *  - `frame` — a sandboxed `srcdoc` iframe. Both directions are `postMessage`.
 *    Used in remote (browser) mode, and on any desktop platform where the
 *    Electrobun webview tag is not proven to work.
 *  - `webview` — an `<electrobun-webview>`, which is a whole separate WebContent
 *    process, so a runaway artifact cannot freeze the app window. Out goes
 *    through Electrobun's event bridge; in arrives as an `executeJavascript`
 *    call on {@link ArtifactChannel.receive}.
 *
 * Everything above this module — the find protocol, save-image, `window.dev3` —
 * speaks the same messages either way and never learns which transport it got.
 *
 * Authored as a real function rather than a script string so its behaviour is
 * directly testable; {@link artifactChannelScript} serializes it. That makes the
 * function's isolation load-bearing: it may reference nothing outside its own
 * body except the two arguments it is handed.
 */

export type ArtifactTransport = "frame" | "webview";

/** Where the channel installs itself; the host addresses it by this name. */
export const ARTIFACT_CHANNEL_GLOBAL = "__dev3ArtifactChannel";

export interface ArtifactChannel {
	/** Is anything listening at the other end? `window.dev3` gates on this. */
	connected: boolean;
	send(message: unknown): void;
	subscribe(listener: (message: unknown) => void): void;
	/** Host→child entry point under the `webview` transport. */
	receive(json: string): void;
}

export interface ArtifactChannelWindow {
	parent?: unknown;
	addEventListener?(type: string, listener: (event: never) => void, capture?: boolean): void;
	postMessage?(message: unknown, targetOrigin: string): void;
	__dev3ArtifactChannel?: ArtifactChannel;
}

/**
 * Install the channel into `win`. Runs inside the artifact document itself, so
 * everything it needs — the parent window, Electrobun's bridge — comes from there.
 */
export function installArtifactChannel(win: ArtifactChannelWindow, transport: ArtifactTransport): void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const w = win as any;
	const listeners: Array<(message: unknown) => void> = [];

	function dispatch(message: unknown): void {
		if (!message) return;
		for (let i = 0; i < listeners.length; i++) listeners[i](message);
	}

	let connected = false;
	let send: (message: unknown) => void = function () {};

	// Every artifact already on disk listens for the theme with a plain
	// `window.addEventListener("message")` — that is what the shipped template's
	// app.js does, and those files are never rewritten. Under the iframe transport
	// the viewer posted straight at that window; under the webview transport it
	// calls `receive`, so the message has to be re-posted into the document or the
	// theme silently stops following for every report ever published.
	let republish: (message: unknown) => void = function () {};

	if (transport === "webview") {
		// A sandboxed child never gets `__electrobunSendToHost` — only the trusted
		// preload defines it — but it does get the event bridge, and this envelope
		// is what the host tag's `host-message` listener is fed. Verified against
		// electrobun 1.18.1; see the decision record.
		const bridge = w.__electrobunEventBridge;
		connected = Boolean(bridge);
		send = function (message: unknown) {
			if (!bridge) return;
			bridge.postMessage(JSON.stringify({
				id: "webviewEvent",
				type: "message",
				payload: {
					id: w.__electrobunWebviewId,
					eventName: "host-message",
					detail: JSON.stringify(message),
				},
			}));
		};
		republish = function (message: unknown) {
			// A top-level window posting to itself: the child never listens for
			// window messages as a channel, so this cannot feed back in.
			if (w.postMessage) w.postMessage(message, "*");
		};
	} else {
		const parentWindow = w.parent;
		// No distinct parent frame → this copy was opened on its own (a browser tab,
		// a downloaded file). Nothing is listening, so the channel is honestly dead.
		connected = Boolean(parentWindow) && parentWindow !== w;
		send = function (message: unknown) {
			if (connected) parentWindow.postMessage(message, "*");
		};
		if (w.addEventListener) {
			w.addEventListener("message", function (event: { data?: unknown }) {
				dispatch(event && event.data);
			}, false);
		}
	}

	w.__dev3ArtifactChannel = {
		connected: connected,
		send: send,
		subscribe: function (listener: (message: unknown) => void) {
			listeners.push(listener);
		},
		receive: function (json: string) {
			try {
				const message = JSON.parse(json);
				dispatch(message);
				republish(message);
			} catch (error) {
				// A malformed delivery is the host's bug, and throwing here would land
				// inside the artifact's own scripts. Drop it.
			}
		},
	};
}

/** The injected `<script>` that installs the channel inside the artifact document. */
export function artifactChannelScript(transport: ArtifactTransport): string {
	return `<script data-dev3-artifact-channel>(${installArtifactChannel.toString()})(window,${JSON.stringify(transport)});</script>`;
}

/**
 * Host→child delivery under the `webview` transport. The tag has no postMessage;
 * `executeJavascript` runs source text in the child's world, so the message rides
 * in as a JSON string literal.
 */
export function artifactChannelDeliveryScript(message: unknown): string {
	const payload = JSON.stringify(JSON.stringify(message));
	return `window.${ARTIFACT_CHANNEL_GLOBAL}&&window.${ARTIFACT_CHANNEL_GLOBAL}.receive(${payload})`;
}
