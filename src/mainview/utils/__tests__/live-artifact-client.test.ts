import { describe, expect, it, vi } from "vitest";
import { installArtifactChannel } from "../artifactChannel";
import {
	installLiveClient,
	LIVE_CLIENT_GESTURE_MS,
	LIVE_CLIENT_TIMEOUT_MS,
	liveArtifactClientScript,
} from "../../../shared/live-artifact-client";

interface Posted { type: string; id: number; op: string; args: Record<string, unknown> }

/** A framed document: the REAL channel, a parent that records what the client posts. */
function framedWindow() {
	const listeners = new Map<string, Array<(event: unknown) => void>>();
	const posted: Posted[] = [];
	const win = {
		addEventListener(type: string, listener: (event: unknown) => void) {
			listeners.set(type, [...(listeners.get(type) ?? []), listener]);
		},
		fire(type: string, event: unknown) {
			for (const listener of listeners.get(type) ?? []) listener(event);
		},
		reply(id: number, payload: Record<string, unknown>) {
			win.fire("message", { data: { type: "dev3-live-result", id, ...payload } });
		},
		parent: { postMessage: (message: Posted) => posted.push(message) },
		console,
	} as Record<string, unknown> & { fire(type: string, event: unknown): void; reply(id: number, payload: Record<string, unknown>): void };
	installArtifactChannel(win as never);
	return { win, posted };
}

const config = { transport: "frame" as const, pageRev: 3, gestureMs: LIVE_CLIENT_GESTURE_MS, timeoutMs: LIVE_CLIENT_TIMEOUT_MS };
const snapshot = { schema: 1, rev: 2, collections: { cards: { c1: { id: "c1", data: { title: "one" }, rev: 2, updatedAt: 1, updatedBy: "agent" } } }, events: [], nextEventId: 1 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Live = any;

async function readyFramed() {
	const { win, posted } = framedWindow();
	installLiveClient(win, config);
	const live: Live = (win.dev3 as { live: Live }).live;
	expect(posted[0]).toMatchObject({ type: "dev3-live-request", op: "state" });
	win.reply(posted[0].id, { ok: true, result: structuredClone(snapshot) });
	await live.ready;
	return { win, posted, live };
}

describe("live client — frame transport", () => {
	it("loads the store through the viewer and reads synchronously after", async () => {
		const { live } = await readyFramed();
		expect(live.get("cards", "c1")).toEqual({ title: "one" });
		expect(live.list("cards")).toHaveLength(1);
		expect(live.rev).toBe(2);
	});

	it("applies pushed changes and tells listeners", async () => {
		const { win, live } = await readyFramed();
		const seen = vi.fn();
		live.on("change", seen);
		win.fire("message", { data: { type: "dev3-live-change", changes: [{ rev: 3, kind: "set", collection: "cards", docId: "c2", doc: { id: "c2", data: 2, rev: 3 }, by: "agent" }] } });
		expect(live.get("cards", "c2")).toBe(2);
		expect(seen).toHaveBeenCalledWith(expect.objectContaining({ docId: "c2" }));
		win.fire("message", { data: { type: "dev3-live-change", changes: [{ rev: 4, kind: "delete", collection: "cards", docId: "c1", doc: null, by: "agent" }] } });
		expect(live.get("cards", "c1")).toBeUndefined();
	});

	it("writes through the viewer and folds the answer into the local copy", async () => {
		const { win, posted, live } = await readyFramed();
		const pending = live.patch("cards", "c1", { answer: "approve" }, { ifRev: 2 });
		const request = posted[posted.length - 1];
		expect(request).toMatchObject({ op: "patch", args: { collection: "cards", id: "c1", patch: { answer: "approve" }, ifRev: 2 } });
		win.reply(request.id, { ok: true, result: { rev: 5, kind: "patch", collection: "cards", docId: "c1", doc: { id: "c1", data: { title: "one", answer: "approve" }, rev: 5 }, by: "user" } });
		await pending;
		expect(live.get("cards", "c1")).toEqual({ title: "one", answer: "approve" });
	});

	it("surfaces the viewer's refusal reason", async () => {
		const { win, posted, live } = await readyFramed();
		const pending = live.set("cards", "c1", 1, { ifRev: 0 });
		win.reply(posted[posted.length - 1].id, { ok: false, reason: "conflict", error: "document is at rev 2" });
		await expect(pending).rejects.toMatchObject({ reason: "conflict" });
	});

	it("wakes the agent only straight after a real click", async () => {
		const { win, posted, live } = await readyFramed();
		await expect(live.send("hi")).rejects.toMatchObject({ reason: "no-gesture" });
		win.fire("pointerdown", { isTrusted: false });
		await expect(live.send("hi")).rejects.toMatchObject({ reason: "no-gesture" });
		win.fire("pointerdown", { isTrusted: true });
		const pending = live.send("hi");
		expect(posted[posted.length - 1]).toMatchObject({ op: "send", args: { text: "hi" } });
		win.reply(posted[posted.length - 1].id, { ok: true, result: { sent: true } });
		await expect(pending).resolves.toEqual({ sent: true });
	});

	it("keeps the viewer's existing window.dev3 and only adds live to it", () => {
		const { win } = framedWindow();
		const bridge = { canSendToAgent: true, sendToAgent: vi.fn() };
		win.dev3 = bridge;
		installLiveClient(win, config);
		expect(win.dev3).toBe(bridge);
		expect((win.dev3 as { live?: unknown }).live).toBeDefined();
	});
});

describe("live client — http transport", () => {
	function httpWindow() {
		const streams: Array<{ url: string; handlers: Record<string, (event: { data: string }) => void> }> = [];
		const storage = new Map<string, string>();
		const reload = vi.fn();
		const win = {
			addEventListener() {},
			console,
			fetch: vi.fn(async () => ({ ok: true, json: async () => ({ result: { rev: 1, collection: "cards", docId: "x", doc: { id: "x", data: 1, rev: 1 } } }) })),
			EventSource: class {
				handlers: Record<string, (event: { data: string }) => void> = {};
				constructor(url: string) { streams.push({ url, handlers: this.handlers }); }
				addEventListener(type: string, handler: (event: { data: string }) => void) { this.handlers[type] = handler; }
			},
			sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
			document: { readyState: "complete", querySelectorAll: () => [], addEventListener() {} },
			location: { reload },
			scrollY: 0,
			scrollTo() {},
			Event: class {},
		} as Record<string, unknown>;
		installLiveClient(win, { ...config, transport: "http", base: "/tok/" });
		return { win, streams, storage, reload, live: (win.dev3 as { live: Live }).live };
	}

	it("streams from the token base and stands in for sendToAgent in a plain tab", async () => {
		const { win, streams, live } = httpWindow();
		expect(streams[0].url).toBe("/tok/api/stream");
		expect((win.dev3 as { canSendToAgent: boolean }).canSendToAgent).toBe(true);
		streams[0].handlers.snapshot({ data: JSON.stringify(snapshot) });
		await live.ready;
		expect(live.get("cards", "c1")).toEqual({ title: "one" });
		await live.set("cards", "x", 1);
		expect(win.fetch).toHaveBeenCalledWith("/tok/api/set", expect.objectContaining({ method: "POST", headers: { "content-type": "application/json" } }));
	});

	it("reloads on a new page revision, saving input first, and ignores its own", () => {
		const { streams, storage, reload } = httpWindow();
		streams[0].handlers.page({ data: JSON.stringify({ pageRev: 3 }) });
		expect(reload).not.toHaveBeenCalled();
		streams[0].handlers.page({ data: JSON.stringify({ pageRev: 4 }) });
		expect(reload).toHaveBeenCalledOnce();
		expect(storage.get("dev3-live-draft:/tok/")).toContain("fields");
	});
});

describe("liveArtifactClientScript", () => {
	it("serializes into a script that installs the client on its own", async () => {
		const html = liveArtifactClientScript(config);
		const body = html.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
		const { win } = framedWindow();
		new Function("window", body)(win);
		expect((win.dev3 as { live?: { pageRev: number } }).live?.pageRev).toBe(3);
	});

	it("cannot be broken out of by config text", () => {
		expect(liveArtifactClientScript({ ...config, transport: "http", base: "/</script><b>/" })).not.toContain("</script><b>");
	});
});
