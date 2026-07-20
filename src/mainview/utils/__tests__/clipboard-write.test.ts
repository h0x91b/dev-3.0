import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeClipboardText } from "../clipboard-write";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalExecCommand = document.execCommand;

function stubClipboard(value: unknown): void {
	Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

beforeEach(() => {
	document.body.innerHTML = "";
});

afterEach(() => {
	if (originalClipboard) {
		Object.defineProperty(navigator, "clipboard", originalClipboard);
	} else {
		Reflect.deleteProperty(navigator, "clipboard");
	}
	document.execCommand = originalExecCommand;
	vi.restoreAllMocks();
});

describe("writeClipboardText", () => {
	it("uses the async clipboard API when available", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		stubClipboard({ writeText });
		const execCommand = vi.fn();
		document.execCommand = execCommand as unknown as typeof document.execCommand;

		await expect(writeClipboardText("hello")).resolves.toBe("clipboard-api");
		expect(writeText).toHaveBeenCalledWith("hello");
		expect(execCommand).not.toHaveBeenCalled();
	});

	it("falls back to execCommand when writeText rejects", async () => {
		stubClipboard({ writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")) });
		document.execCommand = vi.fn().mockReturnValue(true) as unknown as typeof document.execCommand;

		await expect(writeClipboardText("hello")).resolves.toBe("exec-command");
		expect(document.execCommand).toHaveBeenCalledWith("copy");
	});

	it("falls back to execCommand when navigator.clipboard is unavailable", async () => {
		stubClipboard(undefined);
		document.execCommand = vi.fn().mockReturnValue(true) as unknown as typeof document.execCommand;

		await expect(writeClipboardText("insecure context")).resolves.toBe("exec-command");
	});

	it("copies through a temporary textarea holding the text", async () => {
		stubClipboard(undefined);
		let seenValue: string | null = null;
		document.execCommand = vi.fn(() => {
			seenValue = document.querySelector("textarea")?.value ?? null;
			return true;
		}) as unknown as typeof document.execCommand;

		await writeClipboardText("payload text");
		expect(seenValue).toBe("payload text");
		expect(document.querySelector("textarea")).toBeNull();
	});

	it("reports failed when execCommand returns false", async () => {
		stubClipboard(undefined);
		document.execCommand = vi.fn().mockReturnValue(false) as unknown as typeof document.execCommand;

		await expect(writeClipboardText("hello")).resolves.toBe("failed");
		expect(document.querySelector("textarea")).toBeNull();
	});

	it("reports failed when execCommand throws", async () => {
		stubClipboard(undefined);
		document.execCommand = vi.fn(() => {
			throw new Error("denied");
		}) as unknown as typeof document.execCommand;

		await expect(writeClipboardText("hello")).resolves.toBe("failed");
		expect(document.querySelector("textarea")).toBeNull();
	});

	it("reports failed when execCommand is not a function", async () => {
		stubClipboard(undefined);
		document.execCommand = undefined as unknown as typeof document.execCommand;

		await expect(writeClipboardText("hello")).resolves.toBe("failed");
	});

	it("restores focus to the previously focused element", async () => {
		stubClipboard(undefined);
		document.execCommand = vi.fn().mockReturnValue(true) as unknown as typeof document.execCommand;
		const button = document.createElement("button");
		document.body.appendChild(button);
		button.focus();

		await writeClipboardText("hello");
		expect(document.activeElement).toBe(button);
	});
});
