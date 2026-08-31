import {
	ARTIFACT_BRIDGE_DRAFT_MS,
	ARTIFACT_BRIDGE_GESTURE_MS,
	ARTIFACT_BRIDGE_TIMEOUT_MS,
	artifactBridgeScript,
	installArtifactBridge,
	type ArtifactBridgeWindow,
} from "../artifactBridge";

interface Sent { type: string; id: number; text: string }

interface FakeWindow extends ArtifactBridgeWindow {
	dev3?: { canSendToAgent: boolean; sendToAgent(text: unknown): Promise<void> };
	sent: Sent[];
	fire(type: string, event: unknown): void;
	gesture(): void;
	reply(payload: Record<string, unknown>): void;
}

/**
 * The bridge runs inside the artifact's own frame, so the test hands it a window
 * instead of driving a real one — that keeps the gesture and reply timing exact.
 */
function fakeWindow(opts: { framed?: boolean } = {}): FakeWindow {
	const listeners = new Map<string, Array<(event: unknown) => void>>();
	const win = {
		sent: [] as Sent[],
		addEventListener(type: string, listener: (event: never) => void) {
			const list = listeners.get(type) ?? [];
			list.push(listener as (event: unknown) => void);
			listeners.set(type, list);
		},
		fire(type: string, event: unknown) {
			for (const listener of listeners.get(type) ?? []) listener(event);
		},
		gesture() {
			win.fire("click", { isTrusted: true });
		},
		reply(payload: Record<string, unknown>) {
			win.fire("message", { data: { type: "dev3-artifact-send-result", ...payload } });
		},
	} as unknown as FakeWindow;
	// The viewer's frame: a distinct parent that collects what the bridge posts.
	const parent = { postMessage: (message: Sent) => win.sent.push(message) };
	(win as { parent?: unknown }).parent = opts.framed === false ? win : parent;
	return win;
}

function install(opts: { canSend?: boolean; framed?: boolean } = {}): FakeWindow {
	const win = fakeWindow({ framed: opts.framed });
	installArtifactBridge(win, {
		canSend: opts.canSend ?? true,
		gestureMs: ARTIFACT_BRIDGE_GESTURE_MS,
		timeoutMs: ARTIFACT_BRIDGE_TIMEOUT_MS,
		draftMs: ARTIFACT_BRIDGE_DRAFT_MS,
	});
	return win;
}

async function reason(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "resolved";
	} catch (err) {
		return (err as { reason?: string }).reason ?? "no-reason";
	}
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("artifact bridge", () => {
	it("posts the text out and resolves on the viewer's matching reply", async () => {
		const win = install();
		win.gesture();
		const sent = win.dev3!.sendToAgent("ship option B");
		expect(win.sent).toEqual([{ type: "dev3-artifact-send", id: 1, text: "ship option B" }]);

		win.reply({ id: 1, ok: true });
		await expect(sent).resolves.toBeUndefined();
	});

	it("ignores a reply for another id and times out instead of hanging", async () => {
		const win = install();
		win.gesture();
		const sent = win.dev3!.sendToAgent("hello");
		win.reply({ id: 99, ok: true });

		vi.advanceTimersByTime(ARTIFACT_BRIDGE_TIMEOUT_MS + 1);
		expect(await reason(sent)).toBe("timeout");
	});

	it("rejects a delivery failure with the reason the viewer sent", async () => {
		const win = install();
		win.gesture();
		const sent = win.dev3!.sendToAgent("hello");
		win.reply({ id: 1, ok: false, reason: "failed", message: "no live agent" });
		expect(await reason(sent)).toBe("failed");
	});

	it("rejects a second call while one is still in flight, then accepts the next", async () => {
		const win = install();
		win.gesture();
		const first = win.dev3!.sendToAgent("one");
		expect(await reason(win.dev3!.sendToAgent("two"))).toBe("busy");
		expect(win.sent).toHaveLength(1);

		win.reply({ id: 1, ok: true });
		await first;
		win.gesture();
		void win.dev3!.sendToAgent("three").catch(() => {});
		expect(win.sent).toHaveLength(2);
	});

	it("reports the capability as false with no distinct parent frame", async () => {
		const win = install({ framed: false });
		expect(win.dev3!.canSendToAgent).toBe(false);
		win.gesture();
		expect(await reason(win.dev3!.sendToAgent("hello"))).toBe("unavailable");
		expect(win.sent).toEqual([]);
	});

	it("reports the capability as false when the viewer says so", () => {
		expect(install({ canSend: false }).dev3!.canSendToAgent).toBe(false);
	});

	it("refuses a call that no trusted input precedes, and one that trails too far behind", async () => {
		const win = install();
		expect(await reason(win.dev3!.sendToAgent("unattended"))).toBe("no-gesture");

		// An untrusted (synthetic) event must not unlock it either.
		win.fire("click", { isTrusted: false });
		expect(await reason(win.dev3!.sendToAgent("synthetic"))).toBe("no-gesture");

		win.gesture();
		vi.advanceTimersByTime(ARTIFACT_BRIDGE_GESTURE_MS + 1);
		expect(await reason(win.dev3!.sendToAgent("stale"))).toBe("no-gesture");
		expect(win.sent).toEqual([]);
	});

	it("rejects an empty or non-string body", async () => {
		const win = install();
		win.gesture();
		expect(await reason(win.dev3!.sendToAgent("   "))).toBe("empty");
		expect(await reason(win.dev3!.sendToAgent(42))).toBe("empty");
	});

	it("serializes into a script carrying the capability flag", () => {
		expect(artifactBridgeScript(true)).toContain('"canSend":true');
		expect(artifactBridgeScript(false)).toContain('"canSend":false');
		expect(artifactBridgeScript(true)).toContain("data-dev3-artifact-bridge");
	});

	describe("unsent input", () => {
		function form(html: string): FakeWindow {
			document.body.innerHTML = html;
			const win = fakeWindow();
			// A real document, because the snapshot reads defaultValue/defaultChecked
			// off live controls — the whole point is that it needs no author help.
			Object.assign(win, { document, Event: window.Event, CustomEvent: window.CustomEvent, dispatchEvent: () => true });
			installArtifactBridge(win, {
				canSend: true,
				gestureMs: ARTIFACT_BRIDGE_GESTURE_MS,
				timeoutMs: ARTIFACT_BRIDGE_TIMEOUT_MS,
				draftMs: ARTIFACT_BRIDGE_DRAFT_MS,
			});
			return win;
		}

		function drafts(win: FakeWindow): Array<{ fields: Array<{ key: string; value?: string; checked?: boolean }> }> {
			return (win.sent as unknown as Array<{ type: string }>)
				.filter((message) => message.type === "dev3-artifact-draft") as never;
		}

		function settle(win: FakeWindow): void {
			win.fire("input", {});
			vi.advanceTimersByTime(ARTIFACT_BRIDGE_DRAFT_MS + 1);
		}

		it("reports every edited control and stays silent about untouched ones", () => {
			const win = form(`
				<input id="who" value="">
				<textarea name="answer"></textarea>
				<input id="untouched" value="keep me">
				<input id="agree" type="checkbox">
			`);
			(document.getElementById("who") as HTMLInputElement).value = "Evgeny";
			(document.querySelector("textarea") as HTMLTextAreaElement).value = "a long answer";
			(document.getElementById("agree") as HTMLInputElement).checked = true;
			settle(win);

			expect(drafts(win)).toHaveLength(1);
			expect(drafts(win)[0].fields).toEqual([
				{ key: "who", value: "Evgeny" },
				{ key: "answer", value: "a long answer" },
				{ key: "agree", checked: true },
			]);
		});

		it("never lets a password out of the frame", () => {
			const win = form(`<input id="secret" type="password"><input id="plain" value="">`);
			(document.getElementById("secret") as HTMLInputElement).value = "hunter2";
			(document.getElementById("plain") as HTMLInputElement).value = "fine";
			settle(win);

			expect(drafts(win)[0].fields).toEqual([{ key: "plain", value: "fine" }]);
		});

		it("reports an empty draft once the form matches its defaults again", () => {
			const win = form(`<input id="who" value="">`);
			const field = document.getElementById("who") as HTMLInputElement;
			field.value = "typed";
			settle(win);
			field.value = "";
			settle(win);

			expect(drafts(win)[1].fields).toEqual([]);
		});

		it("puts the values back when the viewer hands the draft in", () => {
			const win = form(`<input id="who" value=""><textarea name="answer"></textarea><input id="agree" type="checkbox">`);
			win.fire("message", { data: { type: "dev3-artifact-draft-restore", draft: { fields: [
				{ key: "who", value: "Evgeny" },
				{ key: "answer", value: "a long answer" },
				{ key: "agree", checked: true },
			] } } });

			expect((document.getElementById("who") as HTMLInputElement).value).toBe("Evgeny");
			expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("a long answer");
			expect((document.getElementById("agree") as HTMLInputElement).checked).toBe(true);
		});

		it("carries whatever the report saved itself, and hands it back on restore", () => {
			const win = form(`<div id="canvas"></div>`);
			const seen: unknown[] = [];
			Object.assign(win, { dispatchEvent: (event: CustomEvent) => { seen.push(event.detail); return true; } });
			(win.dev3 as unknown as { saveDraft(value: unknown): void }).saveDraft({ picked: 3 });
			vi.advanceTimersByTime(ARTIFACT_BRIDGE_DRAFT_MS + 1);
			const posts = win.sent as unknown as Array<{ custom?: unknown }>;
			expect(posts[posts.length - 1]?.custom).toEqual({ picked: 3 });

			win.fire("message", { data: { type: "dev3-artifact-draft-restore", draft: { fields: [], custom: { picked: 3 } } } });
			expect(seen).toEqual([{ picked: 3 }]);
		});

		it("takes the capability back and grants it again without being rebuilt", async () => {
			const win = install({ canSend: false });
			expect(win.dev3!.canSendToAgent).toBe(false);

			win.fire("message", { data: { type: "dev3-artifact-can-send", canSend: true } });
			expect(win.dev3!.canSendToAgent).toBe(true);
			win.gesture();
			void win.dev3!.sendToAgent("now allowed").catch(() => {});
			expect(win.sent).toHaveLength(1);

			win.fire("message", { data: { type: "dev3-artifact-can-send", canSend: false } });
			expect(win.dev3!.canSendToAgent).toBe(false);
		});
	});

	// The serializer is `Function.prototype.toString`, so the function may reference
	// nothing outside its own body — running the serialized text is what proves it.
	it("installs a working bridge when the serialized script is executed", async () => {
		const body = artifactBridgeScript(true)
			.replace(/^<script data-dev3-artifact-bridge>/, "")
			.replace(/<\/script>$/, "");
		const win = fakeWindow();
		new Function("window", body)(win);

		expect(win.dev3!.canSendToAgent).toBe(true);
		win.gesture();
		const sent = win.dev3!.sendToAgent("from the serialized copy");
		expect(win.sent).toEqual([{ type: "dev3-artifact-send", id: 1, text: "from the serialized copy" }]);
		win.reply({ id: 1, ok: true });
		await expect(sent).resolves.toBeUndefined();
	});
});
