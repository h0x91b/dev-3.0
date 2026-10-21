/**
 * `window.dev3.live` — the page-side API of a Live Artifact, injected into the
 * live page in both places it can be shown:
 *
 *  - `frame`: inside the dev3 viewer. The frame is opaque-origin, so every call
 *    goes through the viewer over `window.__dev3ArtifactChannel` and changes
 *    come back the same way. The viewer reloads the frame on a new page and
 *    puts unsent input back itself.
 *  - `http`: a browser tab on the app's loopback live server. Calls are `fetch`,
 *    changes arrive over server-sent events, and a new page reloads the tab
 *    with form input kept in `sessionStorage` (a real origin here).
 *
 * Authored as a real function and serialized by {@link liveArtifactClientScript},
 * like `artifactBridge.ts`: it may reference nothing outside its own body except
 * the two arguments it is handed.
 */

export interface LiveClientConfig {
	transport: "frame" | "http";
	/** `http` only: the page's base path, `/<token>/`. */
	base?: string;
	/** The page revision this document was built from. */
	pageRev: number;
	/** How long a trusted click or key press keeps `send` unlocked. */
	gestureMs: number;
	/** How long a call waits for an answer. */
	timeoutMs: number;
}

export const LIVE_CLIENT_GESTURE_MS = 5_000;
export const LIVE_CLIENT_TIMEOUT_MS = 15_000;

export type LiveClientOp = "state" | "set" | "patch" | "delete" | "emit" | "send";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function installLiveClient(win: any, config: LiveClientConfig): void {
	const w = win;
	const listeners: Record<string, Array<(payload: unknown) => void>> = { ready: [], change: [] };
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let snapshot: any = null;
	let lastGesture = 0;
	let resolveReady: (value: unknown) => void = () => {};
	const ready = new Promise(function (resolve) { resolveReady = resolve; });
	const draftKey = "dev3-live-draft:" + (config.base || "");

	function failure(reason: string, message?: string) {
		const error = new Error(message || "dev3.live: " + reason) as Error & { reason?: string };
		error.reason = reason;
		return error;
	}

	function fire(kind: string, payload: unknown) {
		const list = (listeners[kind] || []).slice();
		for (let i = 0; i < list.length; i++) {
			try { list[i](payload); } catch (error) { if (w.console) w.console.error(error); }
		}
	}

	function takeSnapshot(state: unknown) {
		const first = snapshot === null;
		snapshot = state;
		resolveReady(snapshot);
		fire(first ? "ready" : "change", { kind: "reset", rev: snapshot.rev });
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function applyChanges(changes: any[]) {
		if (!snapshot || !changes) return;
		for (let i = 0; i < changes.length; i++) {
			const change = changes[i];
			if (change.rev <= (snapshot.collections[change.collection]?.[change.docId]?.rev ?? -1) && change.doc) continue;
			const docs = snapshot.collections[change.collection] || (snapshot.collections[change.collection] = {});
			if (change.doc) docs[change.docId] = change.doc;
			else delete docs[change.docId];
			if (change.rev > snapshot.rev) snapshot.rev = change.rev;
			fire("change", change);
		}
	}

	if (w.addEventListener) {
		const mark = function (event: { isTrusted?: boolean }) { if (event && event.isTrusted) lastGesture = Date.now(); };
		w.addEventListener("pointerdown", mark, true);
		w.addEventListener("keydown", mark, true);
	}

	let call: (op: string, args: unknown) => Promise<unknown>;

	if (config.transport === "frame") {
		const channel = w.__dev3ArtifactChannel;
		const pending: Record<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: unknown }> = {};
		let nextId = 1;
		call = function (op, args) {
			return new Promise(function (resolve, reject) {
				if (!channel || !channel.connected) { reject(failure("unavailable")); return; }
				const id = nextId++;
				const timer = setTimeout(function () { delete pending[id]; reject(failure("timeout")); }, config.timeoutMs);
				pending[id] = { resolve: resolve, reject: reject, timer: timer };
				channel.send({ type: "dev3-live-request", id: id, op: op, args: args });
			});
		};
		if (channel) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			channel.subscribe(function (message: any) {
				if (!message || typeof message !== "object") return;
				if (message.type === "dev3-live-result") {
					const entry = pending[message.id];
					if (!entry) return;
					delete pending[message.id];
					clearTimeout(entry.timer as number);
					if (message.ok) entry.resolve(message.result);
					else entry.reject(failure(message.reason || "failed", message.error));
				} else if (message.type === "dev3-live-change") {
					applyChanges(message.changes);
				}
			});
		}
		call("state", {}).then(takeSnapshot, function () { /* no viewer: stays unready */ });
	} else {
		const base = config.base || "/";
		call = function (op, args) {
			return w.fetch(base + "api/" + op, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(args || {}),
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			}).then(function (response: any) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				return response.json().catch(function () { return {}; }).then(function (body: any) {
					if (!response.ok) throw failure(body.reason || "failed", body.error);
					return body.result;
				});
			});
		};
		const saveDraft = function () {
			const fields: Array<{ key: string; value?: string; checked?: boolean }> = [];
			const controls = w.document.querySelectorAll("input, textarea, select");
			for (let i = 0; i < controls.length; i++) {
				const el = controls[i];
				if (el.type === "password" || el.type === "file" || el.type === "hidden") continue;
				const key = el.id ? "#" + el.id : el.name ? el.name + (el.type === "radio" || el.type === "checkbox" ? "=" + el.value : "") : el.tagName + ":" + i;
				fields.push(el.type === "radio" || el.type === "checkbox" ? { key: key, checked: el.checked } : { key: key, value: el.value });
			}
			try { w.sessionStorage.setItem(draftKey, JSON.stringify({ fields: fields, scrollY: w.scrollY })); } catch (error) { /* storage blocked: reload anyway */ }
		};
		const restoreDraft = function () {
			let saved = null;
			try { saved = JSON.parse(w.sessionStorage.getItem(draftKey) || "null"); w.sessionStorage.removeItem(draftKey); } catch (error) { return; }
			if (!saved) return;
			const byKey: Record<string, { value?: string; checked?: boolean }> = {};
			for (let i = 0; i < saved.fields.length; i++) byKey[saved.fields[i].key] = saved.fields[i];
			const controls = w.document.querySelectorAll("input, textarea, select");
			for (let i = 0; i < controls.length; i++) {
				const el = controls[i];
				const key = el.id ? "#" + el.id : el.name ? el.name + (el.type === "radio" || el.type === "checkbox" ? "=" + el.value : "") : el.tagName + ":" + i;
				const field = byKey[key];
				if (!field) continue;
				if (field.checked !== undefined) el.checked = field.checked;
				else if (field.value !== undefined) el.value = field.value;
				el.dispatchEvent(new w.Event("input", { bubbles: true }));
				el.dispatchEvent(new w.Event("change", { bubbles: true }));
			}
			if (typeof saved.scrollY === "number") w.scrollTo(0, saved.scrollY);
		};
		if (w.document.readyState === "loading") w.document.addEventListener("DOMContentLoaded", restoreDraft);
		else setTimeout(restoreDraft, 0);

		const stream = new w.EventSource(base + "api/stream");
		stream.addEventListener("snapshot", function (event: { data: string }) { takeSnapshot(JSON.parse(event.data)); });
		stream.addEventListener("change", function (event: { data: string }) { applyChanges(JSON.parse(event.data).changes); });
		stream.addEventListener("page", function (event: { data: string }) {
			if (JSON.parse(event.data).pageRev === config.pageRev) return;
			saveDraft();
			w.location.reload();
		});
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function write(op: string, args: any) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return call(op, args).then(function (change: any) {
			if (change && change.collection) applyChanges([change]);
			return change;
		});
	}

	const live = {
		transport: config.transport,
		pageRev: config.pageRev,
		ready: ready,
		get rev() { return snapshot ? snapshot.rev : 0; },
		get(collection: string, id: string) {
			const doc = snapshot && snapshot.collections[collection] && snapshot.collections[collection][id];
			return doc ? doc.data : undefined;
		},
		doc(collection: string, id: string) {
			return (snapshot && snapshot.collections[collection] && snapshot.collections[collection][id]) || undefined;
		},
		list(collection: string) {
			const docs = (snapshot && snapshot.collections[collection]) || {};
			return Object.keys(docs).map(function (key) { return docs[key]; });
		},
		collections() {
			return snapshot ? Object.keys(snapshot.collections) : [];
		},
		set(collection: string, id: string, data: unknown, options?: { ifRev?: number }) {
			return write("set", { collection: collection, id: id, data: data, ifRev: options && options.ifRev });
		},
		patch(collection: string, id: string, patch: unknown, options?: { ifRev?: number }) {
			return write("patch", { collection: collection, id: id, patch: patch, ifRev: options && options.ifRev });
		},
		delete(collection: string, id: string, options?: { ifRev?: number }) {
			return write("delete", { collection: collection, id: id, ifRev: options && options.ifRev });
		},
		emit(name: string, payload?: unknown) {
			return call("emit", { name: name, payload: payload });
		},
		// Wakes the agent, so only straight after a real click or key press.
		send(text: string) {
			if (typeof text !== "string" || !text.trim()) return Promise.reject(failure("empty"));
			if (Date.now() - lastGesture > config.gestureMs) return Promise.reject(failure("no-gesture"));
			lastGesture = 0;
			return call("send", { text: text });
		},
		on(kind: string, listener: (payload: unknown) => void) {
			(listeners[kind] = listeners[kind] || []).push(listener);
			if (kind === "ready" && snapshot) setTimeout(function () { listener({ kind: "reset", rev: snapshot.rev }); }, 0);
			return function () {
				const list = listeners[kind] || [];
				const at = list.indexOf(listener);
				if (at >= 0) list.splice(at, 1);
			};
		},
	};

	// Inside the viewer `window.dev3` already exists (the agent-message bridge);
	// a browser tab has none, so the live channel stands in for `sendToAgent`.
	if (!w.dev3) {
		w.dev3 = {
			canSendToAgent: true,
			sendToAgent: function (text: string) { return live.send(text); },
			saveDraft: function () {},
		};
	}
	w.dev3.live = live;
}

export function liveArtifactClientScript(config: LiveClientConfig): string {
	return `<script data-dev3-live-client>(${installLiveClient.toString()})(window,${JSON.stringify(config).replace(/</g, "\\u003c")});</script>`;
}
