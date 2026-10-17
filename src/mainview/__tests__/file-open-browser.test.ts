import { PopupBlockedError, downloadFile, isLoopbackHostname, openFileInBrowser, openFileInNewTab, opensSafelyOnWindows, opensInBrowserTab, resetWindowsHostOpenCache, windowsHostOpenAvailable } from "../file-open-browser";

const request = vi.hoisted(() => ({
	createFileLink: vi.fn(async (params: { path: string; download?: boolean }) => ({ url: params.download ? "/file/dl/spec.md?download=1" : "/file/tok/spec.md" })),
	getWindowsHostOpen: vi.fn(async () => ({ available: true })),
}));
vi.mock("../rpc", () => ({ api: { request } }));

beforeEach(() => {
	vi.clearAllMocks();
	resetWindowsHostOpenCache();
});

describe("isLoopbackHostname", () => {
	it("counts localhost, *.localhost, 127/8 and ::1 as this machine", () => {
		for (const host of ["localhost", "dev3.localhost", "127.0.0.1", "127.1.2.3", "[::1]"]) expect(isLoopbackHostname(host)).toBe(true);
		for (const host of ["dev3.pavlenko.co.uk", "192.168.1.5", "localhost.example.com", "127.0.0.1.nip.io"]) expect(isLoopbackHostname(host)).toBe(false);
	});
});

describe("windowsHostOpenAvailable", () => {
	it("never asks the server from a remote hostname, where it would open a window at home", async () => {
		expect(await windowsHostOpenAvailable("dev3.pavlenko.co.uk")).toBe(false);
		expect(request.getWindowsHostOpen).not.toHaveBeenCalled();
	});

	it("asks once from a loopback hostname and caches the answer", async () => {
		expect(await windowsHostOpenAvailable("dev3.localhost")).toBe(true);
		expect(await windowsHostOpenAvailable("dev3.localhost")).toBe(true);
		expect(request.getWindowsHostOpen).toHaveBeenCalledTimes(1);
	});
});

describe("opensInBrowserTab", () => {
	it("follows the preview for text and images, and the extension past its cap", () => {
		expect(opensInBrowserTab("/a/Makefile", { kind: "text", content: "", truncated: false, size: 0 })).toBe(true);
		expect(opensInBrowserTab("/a/big.log", { kind: "too-large", size: 9e9 })).toBe(true);
		expect(opensInBrowserTab("/a/doc.pdf", { kind: "binary", size: 10 })).toBe(false);
		expect(opensInBrowserTab("/a/doc.pdf", { kind: "text", content: "%PDF-1.4", truncated: false, size: 8 })).toBe(false);
		expect(opensInBrowserTab("/a/app.bin", { kind: "binary", size: 10 })).toBe(false);
	});
});

describe("openFileInNewTab", () => {
	it("opens the tab inside the click, cuts its opener, then points it at the link", async () => {
		const tab = { opener: window as unknown, location: { replace: vi.fn() }, close: vi.fn() };
		const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
		const pending = openFileInNewTab("/wt/spec.md");
		expect(open).toHaveBeenCalledWith("", "_blank");
		await pending;
		expect(tab.opener).toBeNull();
		expect(tab.location.replace).toHaveBeenCalledWith(new URL("/file/tok/spec.md", window.location.href).href);
		open.mockRestore();
	});

	it("reports a blocked popup instead of silently doing nothing, before asking for a link", async () => {
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		await expect(openFileInNewTab("/wt/spec.md")).rejects.toBeInstanceOf(PopupBlockedError);
		expect(open).toHaveBeenCalledTimes(1);
		expect(request.createFileLink).not.toHaveBeenCalled();
		open.mockRestore();
	});

	it("closes the blank tab when the link cannot be made", async () => {
		const tab = { opener: null, location: { replace: vi.fn() }, close: vi.fn() };
		const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
		request.createFileLink.mockRejectedValueOnce(new Error("File not found"));
		await expect(openFileInNewTab("/wt/gone.md")).rejects.toThrow("File not found");
		expect(tab.close).toHaveBeenCalled();
		open.mockRestore();
	});
});

describe("downloadFile", () => {
	it("follows the download link with an anchor", async () => {
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		await downloadFile("/wt/spec.md");
		expect(click).toHaveBeenCalledTimes(1);
		const anchor = click.mock.contexts[0] as HTMLAnchorElement;
		expect(anchor.getAttribute("href")).toBe("/file/dl/spec.md?download=1");
		expect(request.createFileLink).toHaveBeenCalledWith({ path: "/wt/spec.md", download: true });
		expect(anchor.isConnected).toBe(false);
		click.mockRestore();
	});
});

describe("openFileInBrowser", () => {
	it("opens what a tab can show and downloads the rest", async () => {
		const tab = { opener: null, location: { replace: vi.fn() }, close: vi.fn() };
		const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		await openFileInBrowser("/wt/shared-images/clip.mp4");
		expect(open).toHaveBeenCalledTimes(1);
		expect(click).not.toHaveBeenCalled();
		await openFileInBrowser("/wt/uploads/archive.zip");
		expect(open).toHaveBeenCalledTimes(1);
		expect(click).toHaveBeenCalledTimes(1);
		open.mockRestore();
		click.mockRestore();
	});
});

describe("opensSafelyOnWindows", () => {
	it("allows documents and media, never scripts or programs", () => {
		for (const path of ["/a/report.html", "/a/spec.MD", "/a/clip.mp4", "C:\\a\\shot.png"]) expect(opensSafelyOnWindows(path)).toBe(true);
		for (const path of ["/a/build.js", "/a/run.bat", "/a/setup.exe", "/a/link.lnk", "/a/x.ps1", "/a/Makefile", "/a/.bashrc", "/a/data.csv", "/a/doc.pdf"]) expect(opensSafelyOnWindows(path)).toBe(false);
	});
});
