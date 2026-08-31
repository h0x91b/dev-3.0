import {
	ARTIFACT_CHANNEL_GLOBAL,
	artifactChannelDeliveryScript,
	artifactChannelScript,
	installArtifactChannel,
	type ArtifactChannel,
} from "../artifactChannel";

interface FakeWindow {
	parent?: unknown;
	addEventListener(type: string, listener: (event: never) => void, capture?: boolean): void;
	fire(type: string, event: unknown): void;
	__dev3ArtifactChannel?: ArtifactChannel;
	__electrobunEventBridge?: { postMessage(message: string): void };
	__electrobunWebviewId?: number;
	postMessage(message: unknown, targetOrigin: string): void;
	posted: string[];
	parentPosts: unknown[];
	selfPosts: unknown[];
}

function fakeWindow(opts: { framed?: boolean; bridge?: boolean } = {}): FakeWindow {
	const listeners = new Map<string, Array<(event: unknown) => void>>();
	const win = {
		posted: [] as string[],
		parentPosts: [] as unknown[],
		selfPosts: [] as unknown[],
		postMessage(message: unknown) {
			win.selfPosts.push(message);
			// A real window delivers its own postMessage as a message event.
			win.fire("message", { data: message });
		},
		addEventListener(type: string, listener: (event: never) => void) {
			const list = listeners.get(type) ?? [];
			list.push(listener as (event: unknown) => void);
			listeners.set(type, list);
		},
		fire(type: string, event: unknown) {
			for (const listener of listeners.get(type) ?? []) listener(event);
		},
	} as unknown as FakeWindow;
	win.parent = opts.framed === false ? win : { postMessage: (message: unknown) => win.parentPosts.push(message) };
	if (opts.bridge !== false) {
		win.__electrobunWebviewId = 7;
		win.__electrobunEventBridge = { postMessage: (message: string) => win.posted.push(message) };
	}
	return win;
}

describe("artifact channel — frame transport", () => {
	it("posts to the parent frame and dispatches what the parent posts back", () => {
		const win = fakeWindow();
		installArtifactChannel(win, "frame");
		const channel = win.__dev3ArtifactChannel!;
		expect(channel.connected).toBe(true);

		channel.send({ type: "hello" });
		expect(win.parentPosts).toEqual([{ type: "hello" }]);

		const seen: unknown[] = [];
		channel.subscribe((message) => seen.push(message));
		win.fire("message", { data: { type: "dev3-artifact-theme", theme: "light" } });
		expect(seen).toEqual([{ type: "dev3-artifact-theme", theme: "light" }]);
	});

	it("is disconnected and silent with no distinct parent — a standalone copy", () => {
		const win = fakeWindow({ framed: false });
		installArtifactChannel(win, "frame");
		const channel = win.__dev3ArtifactChannel!;
		expect(channel.connected).toBe(false);
		channel.send({ type: "hello" });
		expect(win.parentPosts).toEqual([]);
	});
});

describe("artifact channel — webview transport", () => {
	it("wraps the message in the host-message envelope Electrobun's tag listens for", () => {
		const win = fakeWindow();
		installArtifactChannel(win, "webview");
		const channel = win.__dev3ArtifactChannel!;
		expect(channel.connected).toBe(true);

		channel.send({ type: "dev3-artifact-find-open" });
		expect(win.posted).toHaveLength(1);
		expect(JSON.parse(win.posted[0])).toEqual({
			id: "webviewEvent",
			type: "message",
			payload: {
				id: 7,
				eventName: "host-message",
				// The detail is a STRING — the host parses it back. Sending the object
				// itself is what the native bridge cannot carry.
				detail: JSON.stringify({ type: "dev3-artifact-find-open" }),
			},
		});
	});

	it("never listens for window messages — nothing posts them in a webview", () => {
		const win = fakeWindow();
		installArtifactChannel(win, "webview");
		const seen: unknown[] = [];
		win.__dev3ArtifactChannel!.subscribe((message) => seen.push(message));
		win.fire("message", { data: { type: "dev3-artifact-theme" } });
		expect(seen).toEqual([]);
	});

	it("dispatches what the host delivers through receive(), and survives a malformed one", () => {
		const win = fakeWindow();
		installArtifactChannel(win, "webview");
		const channel = win.__dev3ArtifactChannel!;
		const seen: unknown[] = [];
		channel.subscribe((message) => seen.push(message));

		channel.receive(JSON.stringify({ type: "dev3-artifact-find", query: "x" }));
		expect(() => channel.receive("{not json")).not.toThrow();
		expect(seen).toEqual([{ type: "dev3-artifact-find", query: "x" }]);
	});

	// Every artifact ever published listens for the theme with a plain
	// window.addEventListener("message") — the shipped template's app.js does — and
	// those files on disk are never rewritten.
	it("re-posts what the host delivers into the document, so old artifacts keep theming", () => {
		const win = fakeWindow();
		installArtifactChannel(win, "webview");
		const heardAsWindowMessage: unknown[] = [];
		win.addEventListener("message", ((event: { data?: unknown }) => heardAsWindowMessage.push(event.data)) as never);

		win.__dev3ArtifactChannel!.receive(JSON.stringify({ type: "dev3-artifact-theme", theme: "light" }));

		expect(heardAsWindowMessage).toEqual([{ type: "dev3-artifact-theme", theme: "light" }]);
	});

	it("does not feed a re-post back into its own subscribers", () => {
		const win = fakeWindow();
		installArtifactChannel(win, "webview");
		const seen: unknown[] = [];
		win.__dev3ArtifactChannel!.subscribe((message) => seen.push(message));
		win.__dev3ArtifactChannel!.receive(JSON.stringify({ type: "dev3-artifact-find", query: "x" }));
		expect(seen).toHaveLength(1);
	});

	it("is disconnected without the event bridge — a sandboxed child that lost its host", () => {
		const win = fakeWindow({ bridge: false });
		installArtifactChannel(win, "webview");
		expect(win.__dev3ArtifactChannel!.connected).toBe(false);
		expect(() => win.__dev3ArtifactChannel!.send({ type: "x" })).not.toThrow();
		expect(win.posted).toEqual([]);
	});
});

describe("serialization", () => {
	// The serializer is `Function.prototype.toString`, so the function may reference
	// nothing outside its own body — running the serialized text is what proves it.
	it("installs a working channel when the serialized script is executed", () => {
		const body = artifactChannelScript("webview")
			.replace(/^<script data-dev3-artifact-channel>/, "")
			.replace(/<\/script>$/, "");
		const win = fakeWindow();
		new Function("window", body)(win);

		win.__dev3ArtifactChannel!.send({ type: "from the serialized copy" });
		expect(JSON.parse(win.posted[0]).payload.detail).toBe(JSON.stringify({ type: "from the serialized copy" }));
	});

	it("carries the transport it was asked for", () => {
		expect(artifactChannelScript("frame")).toContain('(window,"frame")');
		expect(artifactChannelScript("webview")).toContain('(window,"webview")');
	});

	it("delivers host→child as a JS string literal that survives quotes and newlines", () => {
		const script = artifactChannelDeliveryScript({ type: "t", text: "he said \"hi\"\n</script>" });
		expect(script).toContain(ARTIFACT_CHANNEL_GLOBAL);

		const win = fakeWindow();
		installArtifactChannel(win, "webview");
		const seen: unknown[] = [];
		win.__dev3ArtifactChannel!.subscribe((message) => seen.push(message));
		new Function("window", script)(win);
		expect(seen).toEqual([{ type: "t", text: "he said \"hi\"\n</script>" }]);
	});
});
