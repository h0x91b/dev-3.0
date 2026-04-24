import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTerminalCopyDiagnostics } from "../terminal-copy-diagnostics";

// TEMP DIAGNOSTIC: remove with terminal-copy-diagnostics.ts after the copy bug is fixed.
type LogEntry = {
	level: string;
	message: string;
	extra?: Record<string, string | number | boolean | null>;
};

describe("terminal-copy-diagnostics", () => {
	let clipboardWriteText: ReturnType<typeof vi.fn>;
	let execCommand: ReturnType<typeof vi.fn>;
	const disposables: Array<{ dispose(): void }> = [];
	let logs: LogEntry[] = [];

	beforeEach(() => {
		logs = [];
		clipboardWriteText = vi.fn().mockResolvedValue(undefined);
		execCommand = vi.fn(() => true);

		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: clipboardWriteText,
			},
		});
		Object.defineProperty(document, "execCommand", {
			configurable: true,
			writable: true,
			value: execCommand,
		});
	});

	afterEach(() => {
		for (const disposable of disposables.splice(0)) {
			disposable.dispose();
		}
		vi.restoreAllMocks();
	});

	function install() {
		const diagnostics = installTerminalCopyDiagnostics({
			id: `diag-${Math.random().toString(36).slice(2, 8)}`,
			taskId: "task-1234",
			log: (level, message, extra) => {
				logs.push({ level, message, extra });
			},
		});
		disposables.push(diagnostics);
		return diagnostics;
	}

	it("logs selection-driven clipboard writes", async () => {
		const diagnostics = install();
		diagnostics.markSelection(12, false);

		await navigator.clipboard.writeText("hello world");

		expect(clipboardWriteText).toHaveBeenCalledWith("hello world");
		expect(logs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					level: "info",
					message: "clipboard context armed",
					extra: expect.objectContaining({ source: "selection", selectionLen: 12 }),
				}),
				expect.objectContaining({
					level: "info",
					message: "clipboard.writeText attempt",
					extra: expect.objectContaining({ source: "selection", len: 11 }),
				}),
				expect.objectContaining({
					level: "info",
					message: "clipboard.writeText success",
					extra: expect.objectContaining({ source: "selection", len: 11 }),
				}),
			]),
		);
	});

	it("logs clipboard failure and execCommand fallback", async () => {
		clipboardWriteText.mockRejectedValueOnce(new Error("clipboard denied"));
		const diagnostics = install();
		diagnostics.markSelection(8, true);

		await expect(navigator.clipboard.writeText("fallback")).rejects.toThrow("clipboard denied");
		document.execCommand("copy");

		expect(execCommand).toHaveBeenCalledWith("copy", undefined, undefined);
		expect(logs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					level: "warn",
					message: "clipboard.writeText failed",
					extra: expect.objectContaining({
						source: "selection",
						error: "Error: clipboard denied",
						mouseTracking: true,
					}),
				}),
				expect.objectContaining({
					level: "info",
					message: "document.execCommand copy attempt",
					extra: expect.objectContaining({ source: "selection", mouseTracking: true }),
				}),
				expect.objectContaining({
					level: "info",
					message: "document.execCommand copy result",
					extra: expect.objectContaining({ source: "selection", result: true }),
				}),
			]),
		);
	});
});
