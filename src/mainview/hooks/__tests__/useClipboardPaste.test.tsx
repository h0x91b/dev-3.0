import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("../../rpc", () => ({ api: { request: { pasteClipboardImage: vi.fn(), uploadFileBase64: vi.fn() } } }));
vi.mock("../../toast", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));

import { api } from "../../rpc";
import { toast } from "../../toast";
import { useClipboardPaste } from "../useClipboardPaste";

const mockedRead = vi.mocked(api.request.pasteClipboardImage);
const realNavigator = globalThis.navigator;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function emptyPaste(trusted = true): any {
	return {
		isTrusted: trusted,
		preventDefault: vi.fn(),
		clipboardData: { getData: () => "", items: [], files: [] },
	};
}

// h0x91b/dev-3.0#2041: the text fields (CreateTaskModal, TaskDetailModal, notes,
// scheduled messages) share this hook, so they need the same WebKitGTK fallback.
describe("useClipboardPaste – Linux desktop paste with an empty payload", () => {
	beforeEach(() => {
		mockedRead.mockReset();
		vi.mocked(toast.error).mockClear();
		Object.defineProperty(globalThis, "navigator", {
			value: { platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" },
			writable: true,
			configurable: true,
		});
		(window as unknown as Record<string, unknown>).__electrobunWebviewId = 1;
	});
	afterEach(() => {
		Object.defineProperty(globalThis, "navigator", { value: realNavigator, writable: true, configurable: true });
		delete (window as unknown as Record<string, unknown>).__electrobunWebviewId;
	});

	it("inserts the host clipboard image path", async () => {
		mockedRead.mockResolvedValue({ path: "/u/upload-1-abcd.png" });
		const onPath = vi.fn();
		const { result } = renderHook(() => useClipboardPaste("p1", onPath));
		const event = emptyPaste();

		act(() => result.current.handlePaste(event));

		expect(event.preventDefault).toHaveBeenCalled();
		expect(result.current.pasteKind).toBe("image");
		await waitFor(() => expect(onPath, "cause: an empty WebKitGTK paste never reached the host clipboard. fix: shouldReadHostClipboardImage branch in useClipboardPaste").toHaveBeenCalledWith("/u/upload-1-abcd.png"));
		expect(onPath).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(result.current.pasteKind).toBeNull());
	});

	it("stays quiet when there is nothing to paste, and reports a real failure", async () => {
		mockedRead.mockResolvedValueOnce(null);
		const onPath = vi.fn();
		const { result } = renderHook(() => useClipboardPaste("p1", onPath));

		act(() => result.current.handlePaste(emptyPaste()));
		await waitFor(() => expect(result.current.isPasting).toBe(false));
		expect(toast.error).not.toHaveBeenCalled();

		mockedRead.mockRejectedValueOnce(new Error("unreadable"));
		act(() => result.current.handlePaste(emptyPaste()));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("imagePaste.failed", { projectId: "p1" }));
		expect(onPath).not.toHaveBeenCalled();
	});

	it("does nothing for a script-dispatched or remote empty paste", () => {
		const { result } = renderHook(() => useClipboardPaste("p1", vi.fn()));
		const untrusted = emptyPaste(false);
		act(() => result.current.handlePaste(untrusted));
		delete (window as unknown as Record<string, unknown>).__electrobunWebviewId;
		const remote = emptyPaste();
		act(() => result.current.handlePaste(remote));

		expect(mockedRead).not.toHaveBeenCalled();
		expect(untrusted.preventDefault).not.toHaveBeenCalled();
		expect(remote.preventDefault).not.toHaveBeenCalled();
	});
});
