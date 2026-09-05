/**
 * The one message channel between the viewer and the artifact document it renders.
 *
 * The artifact lives in a sandboxed `srcdoc` iframe — in the desktop shell and in
 * remote (browser) mode alike — so both directions are `postMessage`. The find
 * protocol, save-image and `window.dev3` all speak these messages.
 *
 * Authored as a real function rather than a script string so its behaviour is
 * directly testable; {@link artifactChannelScript} serializes it. That makes the
 * function's isolation load-bearing: it may reference nothing outside its own
 * body except the argument it is handed.
 */

/** Where the channel installs itself; the host addresses it by this name. */
export const ARTIFACT_CHANNEL_GLOBAL = "__dev3ArtifactChannel";

export interface ArtifactChannel {
	/** Is anything listening at the other end? `window.dev3` gates on this. */
	connected: boolean;
	send(message: unknown): void;
	subscribe(listener: (message: unknown) => void): void;
}

export interface ArtifactChannelWindow {
	parent?: unknown;
	addEventListener?(type: string, listener: (event: never) => void, capture?: boolean): void;
	postMessage?(message: unknown, targetOrigin: string): void;
	__dev3ArtifactChannel?: ArtifactChannel;
}

/**
 * Install the channel into `win`. Runs inside the artifact document itself, so
 * the parent window it talks to comes from there.
 */
export function installArtifactChannel(win: ArtifactChannelWindow): void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const w = win as any;
	const listeners: Array<(message: unknown) => void> = [];

	const parentWindow = w.parent;
	// No distinct parent frame → this copy was opened on its own (a browser tab,
	// a downloaded file). Nothing is listening, so the channel is honestly dead.
	const connected = Boolean(parentWindow) && parentWindow !== w;

	if (w.addEventListener) {
		w.addEventListener("message", function (event: { data?: unknown }) {
			const message = event && event.data;
			if (!message) return;
			for (let i = 0; i < listeners.length; i++) listeners[i](message);
		}, false);
	}

	w.__dev3ArtifactChannel = {
		connected: connected,
		send: function (message: unknown) {
			if (connected) parentWindow.postMessage(message, "*");
		},
		subscribe: function (listener: (message: unknown) => void) {
			listeners.push(listener);
		},
	};
}

/** The injected `<script>` that installs the channel inside the artifact document. */
export function artifactChannelScript(): string {
	return `<script data-dev3-artifact-channel>(${installArtifactChannel.toString()})(window);</script>`;
}
