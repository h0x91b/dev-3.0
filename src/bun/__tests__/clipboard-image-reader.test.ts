import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../logger", () => ({
	createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));
vi.mock("bun:ffi", () => ({ suffix: "so" }));
const inlineFormats = vi.fn(() => ["image"]);
const inlineImage = vi.fn(() => new Uint8Array([9, 9]));
vi.mock("../electrobun-platform", () => ({
	Utils: { clipboardAvailableFormats: () => inlineFormats(), clipboardReadImage: () => inlineImage() },
}));

import { configureClipboardImageWorker, readHostClipboardImage } from "../clipboard-image-reader";

const origPlatform = process.platform;
let dir: string;

/** A worker script standing in for the bundled one; `block(ms)` holds the thread like a GTK wait. */
function worker(name: string, body: string): string {
	const path = join(dir, name);
	writeFileSync(path, [
		`const { parentPort, workerData } = require("node:worker_threads");`,
		`const block = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);`,
		body,
	].join("\n"));
	return path;
}

function watchEventLoop() {
	let last = performance.now();
	let maxGap = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		maxGap = Math.max(maxGap, now - last);
		last = now;
	}, 5);
	return () => { clearInterval(timer); return maxGap; };
}

const waitFor = async (check: () => boolean, ms = 3000) => {
	const end = Date.now() + ms;
	while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "clipboard-reader-"));
	Object.defineProperty(process, "platform", { value: "linux", writable: true });
	inlineFormats.mockClear();
	inlineImage.mockClear();
});

afterEach(() => {
	Object.defineProperty(process, "platform", { value: origPlatform, writable: true });
	configureClipboardImageWorker(null);
	rmSync(dir, { recursive: true, force: true });
});

describe("readHostClipboardImage on Linux (worker)", () => {
	it("reads off the host thread and hands the worker Electrobun's own library path", async () => {
		configureClipboardImageWorker(worker("ok.cjs", `block(300); parentPort.postMessage({ ok: true, formats: ["image"], image: new Uint8Array([1, 2, 3]), lib: workerData.libraryPath });`));
		const stop = watchEventLoop();
		const result = await readHostClipboardImage();
		const maxGap = stop();
		expect(result.formats).toEqual(["image"]);
		expect(Array.from(result.image!)).toEqual([1, 2, 3]);
		expect(maxGap, "cause: the GTK wait blocked the host event loop. fix: run the FFI read in the clipboard worker").toBeLessThan(150);
		expect(inlineFormats).not.toHaveBeenCalled();
	});

	it("passes the library path Electrobun resolves against the cwd", async () => {
		const out = join(dir, "lib.txt");
		configureClipboardImageWorker(worker("lib.cjs", `require("node:fs").writeFileSync(${JSON.stringify(out)}, workerData.libraryPath); parentPort.postMessage({ ok: true, formats: [], image: null });`));
		await readHostClipboardImage();
		expect(require("node:fs").readFileSync(out, "utf-8")).toBe(join(process.cwd(), "libNativeWrapper.so"));
	});

	it("times out, stays busy until the wedged thread exits, drops the late reply, then recovers", async () => {
		const path = worker("wedged.cjs", `block(600); parentPort.postMessage({ ok: true, formats: ["image"], image: new Uint8Array([7]) });`);
		configureClipboardImageWorker(path);
		const started = Date.now();
		await expect(
			readHostClipboardImage(100),
			"cause: a stalled clipboard owner left the paste hanging. fix: reject after the host-side deadline",
		).rejects.toThrow(/timed out/);
		expect(Date.now() - started).toBeLessThan(400);

		await expect(
			readHostClipboardImage(100),
			"cause: a second read started while a worker was still wedged in GTK. fix: keep the single-flight slot until the worker exits",
		).rejects.toThrow(/still in progress/);

		// The wedged worker finishes; its late reply is ignored and frees the slot.
		configureClipboardImageWorker(worker("ok2.cjs", `parentPort.postMessage({ ok: true, formats: [], image: null });`));
		await waitFor(() => false, 700);
		expect(await readHostClipboardImage(1000)).toEqual({ formats: [], image: null });
	});

	it("recovers after a genuine worker crash", async () => {
		configureClipboardImageWorker(worker("throws.cjs", `throw new Error("boom");`));
		await expect(readHostClipboardImage(1000)).rejects.toThrow(/Clipboard worker failed/);
		configureClipboardImageWorker(worker("ok.cjs", `parentPort.postMessage({ ok: true, formats: ["text"], image: null });`));
		expect(await readHostClipboardImage(1000), "cause: a crashed worker kept the single-flight slot. fix: release it on the worker's exit").toEqual({ formats: ["text"], image: null });
	});

	it("rejects when the worker exits without replying, and when it reports an error", async () => {
		configureClipboardImageWorker(worker("exit.cjs", `process.exit(3);`));
		await expect(readHostClipboardImage(1000)).rejects.toThrow(/exited with code 3/);
		configureClipboardImageWorker(worker("err.cjs", `parentPort.postMessage({ ok: false, error: "dlopen failed" });`));
		await expect(readHostClipboardImage(1000)).rejects.toThrow(/dlopen failed/);
	});

	it("frees the slot as soon as the FFI call returns, so back-to-back pastes both work", async () => {
		configureClipboardImageWorker(worker("ok.cjs", `parentPort.postMessage({ ok: true, formats: [], image: null }); block(300);`));
		await readHostClipboardImage(1000);
		await expect(
			readHostClipboardImage(1000),
			"cause: a paste right after a finished one was refused as busy. fix: release the slot on the worker's reply, not only on exit",
		).resolves.toEqual({ formats: [], image: null });
	});

	it("a finished worker exiting late never frees the slot of the read that followed it", async () => {
		configureClipboardImageWorker(worker("linger.cjs", `parentPort.postMessage({ ok: true, formats: [], image: null }); block(200);`));
		await readHostClipboardImage(1000);
		configureClipboardImageWorker(worker("slow.cjs", `block(600); parentPort.postMessage({ ok: true, formats: [], image: null });`));
		const second = readHostClipboardImage(2000);
		await waitFor(() => false, 350); // the first worker has exited by now
		await expect(
			readHostClipboardImage(2000),
			"cause: an earlier worker's exit released a later read's slot, so two GTK reads ran at once. fix: release only the slot the exiting worker owns",
		).rejects.toThrow(/still in progress/);
		await second;
	});

	it.each([
		["missing", () => join(dir, "missing.js")],
		["unconfigured", () => null],
	])("fails closed when the bundle is %s, never calling the FFI on the host thread", async (_label, path) => {
		configureClipboardImageWorker(path());
		await expect(
			readHostClipboardImage(),
			"cause: a Linux build without the worker read the clipboard on the host thread, which a stalled owner froze for ~125 s. fix: reject instead of falling back to the direct call",
		).rejects.toThrow(/missing from this build/);
		expect(inlineFormats).not.toHaveBeenCalled();
		expect(inlineImage).not.toHaveBeenCalled();
	});

	it("fails closed when the worker cannot start, frees the slot, and recovers once configured correctly", async () => {
		configureClipboardImageWorker(dir); // exists, but a directory is not a loadable script
		await expect(readHostClipboardImage(1000)).rejects.toThrow(/Clipboard worker/);
		expect(inlineFormats).not.toHaveBeenCalled();

		configureClipboardImageWorker(worker("ok.cjs", `parentPort.postMessage({ ok: true, formats: ["image"], image: new Uint8Array([5]) });`));
		const result = await readHostClipboardImage(1000);
		expect(result.formats, "cause: a failed worker start kept the slot or the bad path. fix: release on startup failure and use the newly configured bundle").toEqual(["image"]);
		expect(inlineFormats).not.toHaveBeenCalled();
	});
});

describe("readHostClipboardImage on other platforms", () => {
	it.each(["darwin", "win32"])("%s keeps the direct Electrobun call and never starts the worker", async (platform) => {
		Object.defineProperty(process, "platform", { value: platform, writable: true });
		const marker = join(dir, "started");
		configureClipboardImageWorker(worker("marker.cjs", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1"); parentPort.postMessage({ ok: true, formats: [], image: null });`));
		const result = await readHostClipboardImage();
		expect(result.formats).toEqual(["image"]);
		await waitFor(() => existsSync(marker), 200);
		expect(existsSync(marker), "cause: a non-Linux paste went through the Linux clipboard worker. fix: gate readInWorker on process.platform === \"linux\"").toBe(false);
	});

	it("skips reading image bytes when the clipboard has no image", async () => {
		Object.defineProperty(process, "platform", { value: "darwin", writable: true });
		inlineFormats.mockReturnValueOnce(["text"]);
		expect(await readHostClipboardImage()).toEqual({ formats: ["text"], image: null });
		expect(inlineImage).not.toHaveBeenCalled();
	});
});
