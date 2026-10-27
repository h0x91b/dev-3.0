import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/shared-media-stream`);

vi.mock("../paths", () => ({
	DEV3_HOME: TEST_HOME,
	OPS_DIR: `${TEST_HOME}/ops`,
}));

import { MAX_RANGE_RESPONSE_BYTES, isStoredSharedMediaPath, parseByteRange, resetSharedMediaTokens, serveFileBytes, serveSharedMedia, sharedMediaUrlPath } from "../shared-media-stream";

const STORE = `${TEST_HOME}/worktrees/my-project/shared-images`;
const CLIP = `${STORE}/shared-1-abcd.mp4`;
const BYTES = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));

function get(path: string, range?: string, method = "GET"): Promise<Response> {
	return serveSharedMedia(new Request(`http://x${path}`, { method, headers: range ? { range } : {} }), path);
}

beforeEach(() => {
	resetSharedMediaTokens();
	mkdirSync(STORE, { recursive: true });
	writeFileSync(CLIP, BYTES);
});

afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }));

describe("isStoredSharedMediaPath", () => {
	it("accepts only a clip directly inside a project's shared-images store", () => {
		expect(isStoredSharedMediaPath(CLIP)).toBe(true);
		expect(isStoredSharedMediaPath(`${STORE}/shot.png`)).toBe(false);
		expect(isStoredSharedMediaPath(`${STORE}/nested/x.mp4`)).toBe(false);
		expect(isStoredSharedMediaPath(`${TEST_HOME}/worktrees/my-project/uploads/x.mp4`)).toBe(false);
		expect(isStoredSharedMediaPath(`${STORE}/../../other/shared-images/x.mp4`)).toBe(false);
		expect(isStoredSharedMediaPath("/etc/passwd.mp4")).toBe(false);
		expect(isStoredSharedMediaPath("relative/shared-images/x.mp4")).toBe(false);
	});

	it("accepts every show-media container, audio included, and nothing outside the list", () => {
		for (const ext of ["mp4", "webm", "mp3", "m4a", "wav", "ogg"]) expect(isStoredSharedMediaPath(`${STORE}/shared-1-abcd.${ext}`)).toBe(true);
		for (const ext of ["flac", "mov", "html", "png"]) expect(isStoredSharedMediaPath(`${STORE}/shared-1-abcd.${ext}`)).toBe(false);
	});
});

describe("sharedMediaUrlPath", () => {
	it("mints one unguessable token per clip and refuses anything else", () => {
		const path = sharedMediaUrlPath(CLIP);
		expect(path).toMatch(/^\/shared-media\/[A-Za-z0-9_-]{32}$/);
		expect(sharedMediaUrlPath(CLIP)).toBe(path);
		expect(sharedMediaUrlPath(`${STORE}/missing.mp4`)).toBeNull();
		expect(sharedMediaUrlPath("/etc/hosts")).toBeNull();
	});
});

describe("parseByteRange", () => {
	it("reads open, closed and suffix ranges and clamps the end", () => {
		expect(parseByteRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
		expect(parseByteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
		expect(parseByteRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
		expect(parseByteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
		expect(parseByteRange(null, 100)).toBeNull();
		expect(parseByteRange("bytes=0-1,5-6", 100)).toBeNull();
	});

	it("marks an unsatisfiable range", () => {
		expect(parseByteRange("bytes=100-", 100)).toBe("invalid");
		expect(parseByteRange("bytes=20-10", 100)).toBe("invalid");
		expect(parseByteRange("bytes=-0", 100)).toBe("invalid");
		expect(parseByteRange("bytes=-", 100)).toBe("invalid");
	});
});

describe("serveSharedMedia", () => {
	it("serves the whole clip with its type and range support", async () => {
		const res = await get(sharedMediaUrlPath(CLIP)!);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("video/mp4");
		expect(res.headers.get("accept-ranges")).toBe("bytes");
		expect(res.headers.get("content-length")).toBe("5000");
		expect(Buffer.from(await res.arrayBuffer()).equals(BYTES)).toBe(true);
	});

	it.each([["mp3", "audio/mpeg"], ["m4a", "audio/mp4"], ["wav", "audio/wav"], ["ogg", "audio/ogg"], ["webm", "video/webm"]])("serves a .%s clip as %s with ranges", async (ext, mime) => {
		const track = `${STORE}/shared-2-abcd.${ext}`;
		writeFileSync(track, BYTES);
		const res = await get(sharedMediaUrlPath(track)!, "bytes=0-99");
		expect(res.status).toBe(206);
		expect(res.headers.get("content-type")).toBe(mime);
		expect(res.headers.get("content-range")).toBe("bytes 0-99/5000");
	});

	it("answers a range with 206 and exactly those bytes", async () => {
		const res = await get(sharedMediaUrlPath(CLIP)!, "bytes=1000-1999");
		expect(res.status).toBe(206);
		expect(res.headers.get("content-range")).toBe("bytes 1000-1999/5000");
		expect(res.headers.get("content-length")).toBe("1000");
		expect(Buffer.from(await res.arrayBuffer()).equals(BYTES.subarray(1000, 2000))).toBe(true);
	});

	it("answers an unsatisfiable range with 416", async () => {
		const res = await get(sharedMediaUrlPath(CLIP)!, "bytes=5000-");
		expect(res.status).toBe(416);
		expect(res.headers.get("content-range")).toBe("bytes */5000");
	});

	it("streams a 300 MB clip's tail without reading the file into memory", async () => {
		truncateSync(CLIP, 300 * 1024 * 1024);
		const res = await get(sharedMediaUrlPath(CLIP)!, "bytes=-16");
		expect(res.status).toBe(206);
		expect(res.headers.get("content-range")).toBe(`bytes ${300 * 1024 * 1024 - 16}-${300 * 1024 * 1024 - 1}/${300 * 1024 * 1024}`);
		expect((await res.arrayBuffer()).byteLength).toBe(16);
	});

	it("caps an open-ended range on a 300 MB clip to one bounded slice with an exact length", async () => {
		const size = 300 * 1024 * 1024;
		truncateSync(CLIP, size);
		const res = await get(sharedMediaUrlPath(CLIP)!, "bytes=0-");
		expect(res.status).toBe(206);
		expect(res.headers.get("content-range")).toBe(`bytes 0-${MAX_RANGE_RESPONSE_BYTES - 1}/${size}`);
		expect(res.headers.get("content-length")).toBe(String(MAX_RANGE_RESPONSE_BYTES));
		expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5000).equals(BYTES)).toBe(true);
	});

	it("sends headers only for HEAD and 404s an unknown token", async () => {
		const head = await get(sharedMediaUrlPath(CLIP)!, undefined, "HEAD");
		expect(head.status).toBe(200);
		expect(head.headers.get("content-length")).toBe("5000");
		expect((await get("/shared-media/not-a-token")).status).toBe(404);
		expect((await get(sharedMediaUrlPath(CLIP)!, undefined, "POST")).status).toBe(405);
	});

	it("passes the caller's extra headers through", async () => {
		const path = sharedMediaUrlPath(CLIP)!;
		const res = await serveSharedMedia(new Request(`http://x${path}`), path, { "Access-Control-Allow-Origin": "*" });
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
	});
});

describe("serveFileBytes with a caller's handle", () => {
	/** A handle whose reads resolve only when the test says so, recording when it was closed. */
	function slowHandle(size: number) {
		const events: string[] = [];
		let release: () => void = () => {};
		const handle = {
			stat: async () => ({ size }),
			read: (buf: Uint8Array) => new Promise<{ bytesRead: number }>((resolve) => {
				release = () => {
					events.push("read settled");
					resolve({ bytesRead: buf.length });
				};
			}),
			close: async () => {
				events.push("closed");
			},
		};
		return { handle, events, settle: () => release() };
	}

	// Closing a Bun FileHandle during a pending read leaks the OS descriptor, so an
	// aborted download must not close until that read has settled.
	it("closes the file only after the in-flight read settles when the client aborts", async () => {
		const { handle, events, settle } = slowHandle(4 * 1024 * 1024);
		const onDone = vi.fn();
		const res = await serveFileBytes(new Request("http://x/f"), handle as never, { "Content-Type": "text/plain" }, { onDone });
		const reader = res.body!.getReader();
		void reader.read();
		await new Promise((r) => setTimeout(r, 0));
		const cancelled = reader.cancel();
		await new Promise((r) => setTimeout(r, 0));
		expect(events).toEqual([]);
		settle();
		await cancelled;
		expect(events).toEqual(["read settled", "closed"]);
		expect(onDone).toHaveBeenCalledTimes(1);
	});

	it("buffers a capped range, so the wire keeps its Content-Length, and reports done at once", async () => {
		const path = `${TEST_HOME}/ten.txt`;
		mkdirSync(TEST_HOME, { recursive: true });
		writeFileSync(path, "0123456789");
		const onDone = vi.fn();
		const res = await serveFileBytes(new Request("http://x/f", { headers: { range: "bytes=2-" } }), path, { "Content-Type": "text/plain" }, { maxRangeBytes: 4, onDone });
		expect(res.status).toBe(206);
		expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
		expect(res.headers.get("content-length")).toBe("4");
		expect(res.body).not.toBeInstanceOf(Uint8Array);
		expect(await res.text()).toBe("2345");
		expect(onDone).toHaveBeenCalledTimes(1);
	});

	// Bun never cancels the body of a client that left before reading it; the request signal does fire.
	it("releases a streamed body that is never read once the client disconnects", async () => {
		const path = `${TEST_HOME}/big.bin`;
		writeFileSync(path, Buffer.alloc(3 * 1024 * 1024));
		const client = new AbortController();
		const onDone = vi.fn();
		await serveFileBytes(new Request("http://x/f", { signal: client.signal }), path, { "Content-Type": "application/octet-stream" }, { onDone, signal: client.signal });
		expect(onDone).not.toHaveBeenCalled();
		client.abort();
		await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
	});

	it("releases at once when the client already left before the body existed", async () => {
		const path = `${TEST_HOME}/big.bin`;
		writeFileSync(path, Buffer.alloc(3 * 1024 * 1024));
		const client = new AbortController();
		client.abort();
		const onDone = vi.fn();
		await serveFileBytes(new Request("http://x/f"), path, { "Content-Type": "application/octet-stream" }, { onDone, signal: client.signal });
		await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
	});

	it("reports done at once for a bodiless reply", async () => {
		const path = `${TEST_HOME}/ten.txt`;
		writeFileSync(path, "0123456789");
		const onDone = vi.fn();
		await serveFileBytes(new Request("http://x/f", { method: "HEAD" }), path, { "Content-Type": "text/plain" }, { onDone });
		expect(onDone).toHaveBeenCalledTimes(1);
	});
});
