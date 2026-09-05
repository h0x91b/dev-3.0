import {
	artifactChannelScript,
	installArtifactChannel,
	type ArtifactChannel,
} from "../artifactChannel";

interface FakeWindow {
	parent?: unknown;
	addEventListener(type: string, listener: (event: never) => void, capture?: boolean): void;
	fire(type: string, event: unknown): void;
	__dev3ArtifactChannel?: ArtifactChannel;
	postMessage(message: unknown, targetOrigin: string): void;
	parentPosts: unknown[];
}

function fakeWindow(opts: { framed?: boolean } = {}): FakeWindow {
	const listeners = new Map<string, Array<(event: unknown) => void>>();
	const win = {
		parentPosts: [] as unknown[],
		postMessage() {},
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
	return win;
}

describe("artifact channel", () => {
	it("posts to the parent frame and dispatches what the parent posts back", () => {
		const win = fakeWindow();
		installArtifactChannel(win);
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
		installArtifactChannel(win);
		const channel = win.__dev3ArtifactChannel!;
		expect(channel.connected).toBe(false);
		channel.send({ type: "hello" });
		expect(win.parentPosts).toEqual([]);
	});

	it("ignores an empty message event instead of dispatching it", () => {
		const win = fakeWindow();
		installArtifactChannel(win);
		const seen: unknown[] = [];
		win.__dev3ArtifactChannel!.subscribe((message) => seen.push(message));
		win.fire("message", { data: undefined });
		win.fire("message", undefined);
		expect(seen).toEqual([]);
	});
});

describe("serialization", () => {
	// The serializer is `Function.prototype.toString`, so the function may reference
	// nothing outside its own body — running the serialized text is what proves it.
	it("installs a working channel when the serialized script is executed", () => {
		const body = artifactChannelScript()
			.replace(/^<script data-dev3-artifact-channel>/, "")
			.replace(/<\/script>$/, "");
		const win = fakeWindow();
		new Function("window", body)(win);

		win.__dev3ArtifactChannel!.send({ type: "from the serialized copy" });
		expect(win.parentPosts).toEqual([{ type: "from the serialized copy" }]);
	});
});
