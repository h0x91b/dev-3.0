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
 *
 * It talks through `window.__dev3ArtifactChannel` (see `artifactChannel.ts`) and
 * never learns whether the document sits in an iframe or in its own webview
 * process.
 */

export interface ArtifactBridgeConfig {
	/** Compose-time half of the gate: newest version, task still alive. */
	canSend: boolean;
	/** How long a trusted input event keeps `sendToAgent` unlocked. */
	gestureMs: number;
	/** How long a send waits for the viewer's reply before giving up. */
	timeoutMs: number;
	/** Debounce before an edited form is reported to the viewer. */
	draftMs: number;
}

export const ARTIFACT_BRIDGE_GESTURE_MS = 5_000;
export const ARTIFACT_BRIDGE_TIMEOUT_MS = 15_000;
/** Coalesces a burst of keystrokes into one snapshot post. */
export const ARTIFACT_BRIDGE_DRAFT_MS = 250;

/**
 * One control's unsent value. The key is the field's `id`, else its `name`, else
 * its tag and position — positional is safe because a draft is only ever restored
 * into the version it was captured from, whose form is the same form.
 */
export interface ArtifactDraftField {
	key: string;
	value?: string;
	checked?: boolean;
}

/** What the frame posts out whenever its controls stop matching their defaults. */
export interface ArtifactDraft {
	fields: ArtifactDraftField[];
	/** Whatever the report handed to `dev3.saveDraft()`, if anything. */
	custom?: unknown;
}

/** Reason codes an author can branch on; also the rejected Error's `.reason`. */
export type ArtifactBridgeReason =
	| "unavailable"
	| "empty"
	| "busy"
	| "no-gesture"
	| "timeout"
	| "failed";

export interface ArtifactBridgeWindow {
	addEventListener(type: string, listener: (event: never) => void, capture?: boolean): void;
	/** Installed by `artifactChannel.ts`, whose script is injected before this one. */
	__dev3ArtifactChannel?: {
		connected: boolean;
		send(message: unknown): void;
		subscribe(listener: (message: unknown) => void): void;
	};
	dev3?: unknown;
	/** Absent in unit tests, which hand the bridge a bare object as its window. */
	document?: { querySelectorAll?(selector: string): unknown } | null;
}

/**
 * Install the bridge into `win`. Runs inside the artifact's own document, so
 * everything it needs — the channel, timers, `Date` — comes from there. It never
 * learns whether that document sits in an iframe or in its own webview process.
 */
export function installArtifactBridge(win: ArtifactBridgeWindow, config: ArtifactBridgeConfig): void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const w = win as any;
	const channel = w.__dev3ArtifactChannel;
	// Nothing at the other end → this copy was opened on its own (a browser tab, a
	// downloaded file). Nothing is listening, so the capability is honestly false.
	const connected = Boolean(channel) && Boolean(channel.connected);
	// Mutable, not compose-time: the viewer re-states the capability when the task's
	// newest version moves, so a document already on screen is never re-rendered
	// just to flip this flag — re-rendering it is what destroys unsent input.
	let canSend = Boolean(config.canSend) && connected;
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

	// --- Unsent input, kept outside this frame -------------------------------
	// Storage inside an artifact is impossible: the viewer sandboxes it without
	// `allow-same-origin`, so its origin is opaque and sessionStorage, localStorage
	// and cookies all throw SecurityError. The draft therefore lives in the viewer,
	// and this half only reports and re-applies it.
	let custom: unknown;
	let draftTimer: ReturnType<typeof setTimeout> | null = null;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function controls(): any[] {
		const doc = w.document;
		if (!doc || !doc.querySelectorAll) return [];
		return [].slice.call(doc.querySelectorAll("input,textarea,select"));
	}

	/**
	 * One key per control, in document order. A radio group and a checkbox group
	 * share a single `name`, so a name alone is not an identity: every member would
	 * match the same draft entry and the last one written would win — the user's
	 * second option comes back as the fifth. Repeats get an occurrence suffix.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function fieldKeys(list: any[]): string[] {
		const seen: Record<string, number> = Object.create(null);
		return list.map(function (el, index) {
			const base = String(el.id || el.name || String(el.tagName) + ":" + index);
			const nth = (seen[base] = (seen[base] || 0) + 1);
			return nth === 1 ? base : base + "#" + nth;
		});
	}

	/** The value the control would have had if nobody had touched it. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function pristine(el: any): string {
		if (el.tagName !== "SELECT") return el.defaultValue == null ? "" : String(el.defaultValue);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const options: any[] = [].slice.call(el.options || []);
		for (let i = 0; i < options.length; i++) if (options[i].defaultSelected) return String(options[i].value);
		return options.length ? String(options[0].value) : "";
	}

	function snapshot(): ArtifactDraftField[] {
		const fields: ArtifactDraftField[] = [];
		const list = controls();
		const keys = fieldKeys(list);
		list.forEach(function (el, index) {
			const type = String(el.type || "").toLowerCase();
			// A password never leaves the frame, and a file input cannot be restored.
			if (type === "password" || type === "file" || type === "hidden") return;
			if (type === "checkbox" || type === "radio") {
				if (Boolean(el.checked) === Boolean(el.defaultChecked)) return;
				fields.push({ key: keys[index], checked: Boolean(el.checked) });
				return;
			}
			const value = el.value == null ? "" : String(el.value);
			if (value === pristine(el)) return;
			fields.push({ key: keys[index], value: value });
		});
		return fields;
	}

	function reportDraft(): void {
		if (!connected) return;
		const fields = snapshot();
		// Posted even when empty: that is how the viewer learns the form went clean
		// again and drops its offer to restore.
		try {
			channel.send({ type: "dev3-artifact-draft", fields: fields, custom: custom });
		} catch {
			// `custom` is the author's own value, so it may not survive a structured
			// clone. Losing it must not take the automatic half — which needs no
			// author cooperation at all — down with it.
			custom = undefined;
			channel.send({ type: "dev3-artifact-draft", fields: fields });
		}
	}

	function scheduleDraft(): void {
		if (draftTimer !== null) clearTimeout(draftTimer);
		draftTimer = setTimeout(function () {
			draftTimer = null;
			reportDraft();
		}, config.draftMs);
	}

	["input", "change"].forEach(function (type) {
		w.addEventListener(type, scheduleDraft, true);
	});

	function restoreDraft(draft: ArtifactDraft): void {
		// Null-prototype: a control with `id="constructor"` would otherwise find an
		// inherited value here and be treated as a draft entry it never had.
		const byKey: Record<string, ArtifactDraftField> = Object.create(null);
		(draft.fields || []).forEach(function (field) { byKey[field.key] = field; });
		const list = controls();
		const keys = fieldKeys(list);
		list.forEach(function (el, index) {
			const field = byKey[keys[index]];
			if (!field) return;
			if (typeof field.checked === "boolean") el.checked = field.checked;
			else if (typeof field.value === "string") el.value = field.value;
			// Report code that mirrors its own state only hears about a change through
			// these — setting `.value` alone fires nothing.
			["input", "change"].forEach(function (type) {
				if (el.dispatchEvent && w.Event) el.dispatchEvent(new w.Event(type, { bubbles: true }));
			});
		});
		custom = draft.custom;
		if (draft.custom !== undefined && w.dispatchEvent && w.CustomEvent) {
			w.dispatchEvent(new w.CustomEvent("dev3:draft-restore", { detail: draft.custom }));
		}
	}

	if (channel) channel.subscribe(function (message: { type?: string; id?: number; ok?: boolean; reason?: string; message?: string; canSend?: boolean; draft?: ArtifactDraft }) {
		const data = message;
		if (!data) return;
		if (data.type === "dev3-artifact-can-send") {
			canSend = Boolean(data.canSend) && connected;
			return;
		}
		if (data.type === "dev3-artifact-draft-restore") {
			if (data.draft) restoreDraft(data.draft);
			return;
		}
		if (data.type !== "dev3-artifact-send-result" || data.id !== pendingId) return;
		const settled = pending;
		settle();
		if (!settled) return;
		if (data.ok) settled.resolve();
		else settled.reject(fail(data.reason || "failed", data.message || "Could not send the message to the agent."));
	});

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
			channel.send({ type: "dev3-artifact-send", id: id, text: text });
		});
	}

	function saveDraft(value: unknown): void {
		custom = value;
		scheduleDraft();
	}

	w.dev3 = {
		// A getter, not a snapshot: the viewer can revoke or grant this mid-life.
		get canSendToAgent() { return canSend; },
		sendToAgent: sendToAgent,
		saveDraft: saveDraft,
	};
}

/** The injected `<script>` that installs the bridge inside the artifact document. */
export function artifactBridgeScript(canSend: boolean): string {
	const config: ArtifactBridgeConfig = {
		canSend,
		gestureMs: ARTIFACT_BRIDGE_GESTURE_MS,
		timeoutMs: ARTIFACT_BRIDGE_TIMEOUT_MS,
		draftMs: ARTIFACT_BRIDGE_DRAFT_MS,
	};
	return `<script data-dev3-artifact-bridge>(${installArtifactBridge.toString()})(window,${JSON.stringify(config)});</script>`;
}
