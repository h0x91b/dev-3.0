import { downloadFile, isLoopbackHostname, openFileInNewTab, opensInBrowserTab, resetWindowsHostOpenCache, windowsHostOpenAvailable } from "../file-open-browser";

const request = vi.hoisted(() => ({
	createFileLink: vi.fn(async (_params: { path: string }) => ({ viewUrl: "/file/tok/spec.md", downloadUrl: "/file/tok/spec.md?download=1" })),
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
		expect(opensInBrowserTab("/a/doc.pdf", { kind: "binary", size: 10 })).toBe(true);
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
		expect(anchor.getAttribute("href")).toBe("/file/tok/spec.md?download=1");
		expect(anchor.isConnected).toBe(false);
		click.mockRestore();
	});
});
