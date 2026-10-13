import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/shared-video-stream`);

vi.mock("../paths", () => ({
	DEV3_HOME: TEST_HOME,
	OPS_DIR: `${TEST_HOME}/ops`,
}));

import { MAX_RANGE_RESPONSE_BYTES, isStoredSharedVideoPath, parseByteRange, resetSharedVideoTokens, serveSharedVideo, sharedVideoUrlPath } from "../shared-video-stream";

const STORE = `${TEST_HOME}/worktrees/my-project/shared-images`;
const CLIP = `${STORE}/shared-1-abcd.mp4`;
const BYTES = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));

function get(path: string, range?: string, method = "GET"): Promise<Response> {
	return serveSharedVideo(new Request(`http://x${path}`, { method, headers: range ? { range } : {} }), path);
}

beforeEach(() => {
	resetSharedVideoTokens();
	mkdirSync(STORE, { recursive: true });
	writeFileSync(CLIP, BYTES);
});

afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }));

describe("isStoredSharedVideoPath", () => {
	it("accepts only a clip directly inside a project's shared-images store", () => {
		expect(isStoredSharedVideoPath(CLIP)).toBe(true);
		expect(isStoredSharedVideoPath(`${STORE}/shot.png`)).toBe(false);
		expect(isStoredSharedVideoPath(`${STORE}/nested/x.mp4`)).toBe(false);
		expect(isStoredSharedVideoPath(`${TEST_HOME}/worktrees/my-project/uploads/x.mp4`)).toBe(false);
		expect(isStoredSharedVideoPath(`${STORE}/../../other/shared-images/x.mp4`)).toBe(false);
		expect(isStoredSharedVideoPath("/etc/passwd.mp4")).toBe(false);
		expect(isStoredSharedVideoPath("relative/shared-images/x.mp4")).toBe(false);
	});
});

describe("sharedVideoUrlPath", () => {
	it("mints one unguessable token per clip and refuses anything else", () => {
		const path = sharedVideoUrlPath(CLIP);
		expect(path).toMatch(/^\/shared-video\/[A-Za-z0-9_-]{32}$/);
		expect(sharedVideoUrlPath(CLIP)).toBe(path);
		expect(sharedVideoUrlPath(`${STORE}/missing.mp4`)).toBeNull();
		expect(sharedVideoUrlPath("/etc/hosts")).toBeNull();
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

describe("serveSharedVideo", () => {
	it("serves the whole clip with its type and range support", async () => {
		const res = await get(sharedVideoUrlPath(CLIP)!);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("video/mp4");
		expect(res.headers.get("accept-ranges")).toBe("bytes");
		expect(res.headers.get("content-length")).toBe("5000");
		expect(Buffer.from(await res.arrayBuffer()).equals(BYTES)).toBe(true);
	});

	it("answers a range with 206 and exactly those bytes", async () => {
		const res = await get(sharedVideoUrlPath(CLIP)!, "bytes=1000-1999");
		expect(res.status).toBe(206);
		expect(res.headers.get("content-range")).toBe("bytes 1000-1999/5000");
		expect(res.headers.get("content-length")).toBe("1000");
		expect(Buffer.from(await res.arrayBuffer()).equals(BYTES.subarray(1000, 2000))).toBe(true);
	});

	it("answers an unsatisfiable range with 416", async () => {
		const res = await get(sharedVideoUrlPath(CLIP)!, "bytes=5000-");
		expect(res.status).toBe(416);
		expect(res.headers.get("content-range")).toBe("bytes */5000");
	});

	it("streams a 300 MB clip's tail without reading the file into memory", async () => {
		truncateSync(CLIP, 300 * 1024 * 1024);
		const res = await get(sharedVideoUrlPath(CLIP)!, "bytes=-16");
		expect(res.status).toBe(206);
		expect(res.headers.get("content-range")).toBe(`bytes ${300 * 1024 * 1024 - 16}-${300 * 1024 * 1024 - 1}/${300 * 1024 * 1024}`);
		expect((await res.arrayBuffer()).byteLength).toBe(16);
	});

	it("caps an open-ended range on a 300 MB clip to one bounded slice with an exact length", async () => {
		const size = 300 * 1024 * 1024;
		truncateSync(CLIP, size);
		const res = await get(sharedVideoUrlPath(CLIP)!, "bytes=0-");
		expect(res.status).toBe(206);
		expect(res.headers.get("content-range")).toBe(`bytes 0-${MAX_RANGE_RESPONSE_BYTES - 1}/${size}`);
		expect(res.headers.get("content-length")).toBe(String(MAX_RANGE_RESPONSE_BYTES));
		expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5000).equals(BYTES)).toBe(true);
	});

	it("sends headers only for HEAD and 404s an unknown token", async () => {
		const head = await get(sharedVideoUrlPath(CLIP)!, undefined, "HEAD");
		expect(head.status).toBe(200);
		expect(head.headers.get("content-length")).toBe("5000");
		expect((await get("/shared-video/not-a-token")).status).toBe(404);
		expect((await get(sharedVideoUrlPath(CLIP)!, undefined, "POST")).status).toBe(405);
	});

	it("passes the caller's extra headers through", async () => {
		const path = sharedVideoUrlPath(CLIP)!;
		const res = await serveSharedVideo(new Request(`http://x${path}`), path, { "Access-Control-Allow-Origin": "*" });
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
	});
});
