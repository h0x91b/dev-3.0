import type { RendererLogLevel } from "../shared/types";

// TEMP DIAGNOSTIC: this entire file exists only to localize the macOS terminal
// copy bug. Remove the file and its call sites after the root cause is fixed.
type TerminalClipboardSource = "selection" | "cmd-c" | "osc52";

interface PendingClipboardContext {
	source: TerminalClipboardSource;
	createdAt: number;
	selectionLength: number;
	mouseTracking: boolean;
}

interface TerminalCopyDiagnosticContext {
	id: string;
	taskId: string;
	log: (
		level: RendererLogLevel,
		message: string,
		extra?: Record<string, string | number | boolean | null>,
	) => void;
	pending: PendingClipboardContext | null;
	lastMouseTrackingLogAt: number;
}

interface InstallTerminalCopyDiagnosticsParams {
	id: string;
	taskId: string;
	log: (
		level: RendererLogLevel,
		message: string,
		extra?: Record<string, string | number | boolean | null>,
	) => void;
}

interface ClipboardLike {
	writeText?: (text: string) => Promise<void>;
}

const CONTEXT_WINDOW_MS = 1500;
const MOUSE_TRACKING_LOG_WINDOW_MS = 2000;

const activeContexts = new Map<string, TerminalCopyDiagnosticContext>();

let clipboardPatched = false;
let execCommandPatched = false;
let originalClipboardWriteText: ClipboardLike["writeText"] | null = null;
let originalExecCommand: typeof document.execCommand | null = null;

function now(): number {
	return Date.now();
}

function getClipboard(): ClipboardLike | null {
	try {
		return navigator.clipboard as ClipboardLike;
	} catch {
		return null;
	}
}

function getActiveContext(): TerminalCopyDiagnosticContext | null {
	const ts = now();
	let selected: TerminalCopyDiagnosticContext | null = null;
	for (const ctx of activeContexts.values()) {
		if (!ctx.pending) continue;
		if (ts - ctx.pending.createdAt > CONTEXT_WINDOW_MS) continue;
		if (!selected || selected.pending!.createdAt < ctx.pending.createdAt) {
			selected = ctx;
		}
	}
	return selected;
}

function clearPendingContext(ctx: TerminalCopyDiagnosticContext): void {
	ctx.pending = null;
}

function installClipboardPatch(): void {
	if (clipboardPatched) return;
	const clipboard = getClipboard();
	if (!clipboard?.writeText) {
		for (const ctx of activeContexts.values()) {
			ctx.log("warn", "navigator.clipboard.writeText unavailable", {});
		}
		return;
	}

	originalClipboardWriteText = clipboard.writeText.bind(clipboard);
	const wrappedWriteText: ClipboardLike["writeText"] = async (text: string) => {
		const ctx = getActiveContext();
		if (!ctx || !originalClipboardWriteText) {
			if (!originalClipboardWriteText) return;
			return originalClipboardWriteText(text);
		}

		const pending = ctx.pending;
		ctx.log("info", "clipboard.writeText attempt", {
			source: pending?.source ?? "unknown",
			len: text.length,
			selectionLen: pending?.selectionLength ?? 0,
			mouseTracking: pending?.mouseTracking ?? false,
		});
		try {
			await originalClipboardWriteText(text);
			ctx.log("info", "clipboard.writeText success", {
				source: pending?.source ?? "unknown",
				len: text.length,
			});
			clearPendingContext(ctx);
		} catch (err) {
			ctx.log("warn", "clipboard.writeText failed", {
				source: pending?.source ?? "unknown",
				len: text.length,
				mouseTracking: pending?.mouseTracking ?? false,
				error: String(err),
			});
			throw err;
		}
	};

	try {
		clipboard.writeText = wrappedWriteText;
		clipboardPatched = true;
	} catch {
		for (const ctx of activeContexts.values()) {
			ctx.log("warn", "failed to patch navigator.clipboard.writeText", {});
		}
	}
}

function restoreClipboardPatch(): void {
	if (!clipboardPatched) return;
	const clipboard = getClipboard();
	if (!clipboard || !originalClipboardWriteText) return;
	try {
		clipboard.writeText = originalClipboardWriteText;
	} catch {
		// Best effort restore.
	}
	clipboardPatched = false;
	originalClipboardWriteText = null;
}

function installExecCommandPatch(): void {
	if (execCommandPatched) return;
	if (typeof document.execCommand !== "function") {
		for (const ctx of activeContexts.values()) {
			ctx.log("warn", "document.execCommand unavailable", {});
		}
		return;
	}
	originalExecCommand = document.execCommand.bind(document);
	const wrappedExecCommand: typeof document.execCommand = ((commandId: string, showUI?: boolean, value?: string) => {
		const ctx = getActiveContext();
		if (!ctx || !originalExecCommand) {
			return originalExecCommand?.(commandId, showUI, value) ?? false;
		}

		const normalized = commandId.toLowerCase();
		const pending = ctx.pending;
		if (normalized !== "copy") {
			return originalExecCommand(commandId, showUI, value);
		}

		ctx.log("info", "document.execCommand copy attempt", {
			source: pending?.source ?? "unknown",
			selectionLen: pending?.selectionLength ?? 0,
			mouseTracking: pending?.mouseTracking ?? false,
		});
		try {
			const result = originalExecCommand(commandId, showUI, value);
			ctx.log(result ? "info" : "warn", "document.execCommand copy result", {
				source: pending?.source ?? "unknown",
				result,
			});
			clearPendingContext(ctx);
			return result;
		} catch (err) {
			ctx.log("error", "document.execCommand copy threw", {
				source: pending?.source ?? "unknown",
				error: String(err),
			});
			clearPendingContext(ctx);
			throw err;
		}
	}) as typeof document.execCommand;

	try {
		document.execCommand = wrappedExecCommand;
		execCommandPatched = true;
	} catch {
		for (const ctx of activeContexts.values()) {
			ctx.log("warn", "failed to patch document.execCommand", {});
		}
	}
}

function restoreExecCommandPatch(): void {
	if (!execCommandPatched || !originalExecCommand) return;
	try {
		document.execCommand = originalExecCommand;
	} catch {
		// Best effort restore.
	}
	execCommandPatched = false;
	originalExecCommand = null;
}

function installPatches(): void {
	installClipboardPatch();
	installExecCommandPatch();
}

function maybeRestorePatches(): void {
	if (activeContexts.size > 0) return;
	restoreClipboardPatch();
	restoreExecCommandPatch();
}

export interface TerminalCopyDiagnostics {
	markSelection(textLength: number, mouseTracking: boolean): void;
	markShortcutCopy(selectionLength: number, mouseTracking: boolean): void;
	markOsc52Copy(textLength: number): void;
	markMouseTrackingIntercept(button: number): void;
	clearSelection(): void;
	dispose(): void;
}

export function installTerminalCopyDiagnostics(
	params: InstallTerminalCopyDiagnosticsParams,
): TerminalCopyDiagnostics {
	const ctx: TerminalCopyDiagnosticContext = {
		id: params.id,
		taskId: params.taskId,
		log: params.log,
		pending: null,
		lastMouseTrackingLogAt: 0,
	};
	activeContexts.set(ctx.id, ctx);
	installPatches();
	ctx.log("info", "terminal copy diagnostics installed", {
		taskId: ctx.taskId,
	});

	function markPending(
		source: TerminalClipboardSource,
		textLength: number,
		mouseTracking: boolean,
	): void {
		ctx.pending = {
			source,
			createdAt: now(),
			selectionLength: textLength,
			mouseTracking,
		};
		ctx.log("info", "clipboard context armed", {
			source,
			selectionLen: textLength,
			mouseTracking,
		});
	}

	return {
		markSelection(textLength, mouseTracking) {
			if (textLength <= 0) {
				clearPendingContext(ctx);
				return;
			}
			markPending("selection", textLength, mouseTracking);
		},
		markShortcutCopy(selectionLength, mouseTracking) {
			markPending("cmd-c", selectionLength, mouseTracking);
		},
		markOsc52Copy(textLength) {
			markPending("osc52", textLength, false);
		},
		markMouseTrackingIntercept(button) {
			const ts = now();
			if (ts - ctx.lastMouseTrackingLogAt < MOUSE_TRACKING_LOG_WINDOW_MS) return;
			ctx.lastMouseTrackingLogAt = ts;
			ctx.log("warn", "mouse tracking intercepted terminal mouse event", {
				button,
			});
		},
		clearSelection() {
			clearPendingContext(ctx);
		},
		dispose() {
			ctx.log("info", "terminal copy diagnostics disposed", {
				taskId: ctx.taskId,
			});
			activeContexts.delete(ctx.id);
			maybeRestorePatches();
		},
	};
}
