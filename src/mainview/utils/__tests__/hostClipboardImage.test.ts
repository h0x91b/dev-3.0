import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../rpc", () => ({ api: { request: { pasteClipboardImage: vi.fn() } } }));

import { api } from "../../rpc";
import { readHostClipboardImage, shouldReadHostClipboardImage } from "../hostClipboardImage";

const mockedRead = vi.mocked(api.request.pasteClipboardImage);
const realNavigator = globalThis.navigator;

function setPlatform(platform: string, userAgent: string) {
	Object.defineProperty(globalThis, "navigator", { value: { platform, userAgent }, writable: true, configurable: true });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function paste(opts: { trusted?: boolean; text?: string; items?: unknown[]; files?: File[]; noClip?: boolean } = {}): any {
	return {
		isTrusted: opts.trusted ?? true,
		clipboardData: opts.noClip ? null : {
			getData: (type: string) => (type === "text/plain" ? opts.text ?? "" : ""),
			items: opts.items ?? [],
			files: opts.files ?? [],
		},
	};
}

describe("shouldReadHostClipboardImage", () => {
	beforeEach(() => {
		setPlatform("Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15");
		(window as unknown as Record<string, unknown>).__electrobunWebviewId = 1;
	});
	afterEach(() => {
		Object.defineProperty(globalThis, "navigator", { value: realNavigator, writable: true, configurable: true });
		delete (window as unknown as Record<string, unknown>).__electrobunWebviewId;
	});

	it("asks the host for a trusted empty paste in the Linux desktop shell (what WebKitGTK delivers)", () => {
		expect(
			shouldReadHostClipboardImage(paste()),
			"cause: WebKitGTK's empty clipboard-image paste was ignored. fix: read the host clipboard for a trusted, empty Linux desktop paste",
		).toBe(true);
		expect(shouldReadHostClipboardImage(paste({ noClip: true }))).toBe(true);
	});

	it("never for a script-dispatched paste", () => {
		expect(shouldReadHostClipboardImage(paste({ trusted: false })), "cause: untrusted paste read the clipboard. fix: require isTrusted").toBe(false);
	});

	it("never when the event already carries text or an image", () => {
		expect(shouldReadHostClipboardImage(paste({ text: "hi" }))).toBe(false);
		expect(shouldReadHostClipboardImage(paste({ items: [{ kind: "string", type: "image/png" }] }))).toBe(false);
		const png = new File([new Uint8Array([0x89])], "a.png", { type: "image/png" });
		expect(shouldReadHostClipboardImage(paste({ files: [png] })), "cause: the image would paste twice. fix: skip when the event has image files").toBe(false);
	});

	it("never in a browser tab, whose host clipboard belongs to another machine", () => {
		delete (window as unknown as Record<string, unknown>).__electrobunWebviewId;
		expect(shouldReadHostClipboardImage(paste()), "cause: remote mode read the dev3 host's clipboard. fix: gate on !isRemote()").toBe(false);
	});

	it("leaves macOS, Windows and Android untouched", () => {
		setPlatform("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
		expect(shouldReadHostClipboardImage(paste())).toBe(false);
		setPlatform("Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
		expect(shouldReadHostClipboardImage(paste())).toBe(false);
		setPlatform("Linux armv8l", "Mozilla/5.0 (Linux; Android 14)");
		expect(shouldReadHostClipboardImage(paste())).toBe(false);
	});
});

describe("readHostClipboardImage", () => {
	beforeEach(() => mockedRead.mockReset());
	afterEach(() => vi.useRealTimers());

	it("maps the RPC reply to image / none / failed", async () => {
		mockedRead.mockResolvedValueOnce({ path: "/u/a.png" });
		expect(await readHostClipboardImage("p1")).toEqual({ kind: "image", path: "/u/a.png" });
		mockedRead.mockResolvedValueOnce(null);
		expect(await readHostClipboardImage("p1")).toEqual({ kind: "none" });
		const error = new Error("boom");
		mockedRead.mockRejectedValueOnce(error);
		expect(await readHostClipboardImage("p1")).toEqual({ kind: "failed", error });
		expect(mockedRead).toHaveBeenCalledWith({ projectId: "p1" });
	});

	it("times out instead of hanging, and a late reply is discarded", async () => {
		vi.useFakeTimers();
		let reply!: (v: { path: string }) => void;
		mockedRead.mockReturnValue(new Promise((r) => { reply = r; }));
		const pending = readHostClipboardImage("p1", 1000);
		await vi.advanceTimersByTimeAsync(1000);
		expect(await pending, "cause: a stuck clipboard owner left the paste hanging. fix: settle as timeout").toEqual({ kind: "timeout" });
		reply({ path: "/u/late.png" });
		expect(await pending).toEqual({ kind: "timeout" });
	});
});
