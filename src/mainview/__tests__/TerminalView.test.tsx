import { render, act, fireEvent, waitFor } from "@testing-library/react";
import TerminalView, { type TerminalHandle, TERMINAL_SYNC_GATE_TIMEOUT_MS, buildResizeDance, buildCursorMoveSequence, clearStaleSelectionOnWrite, normalizePastedText } from "../TerminalView";
import { I18nProvider } from "../i18n";
import { api } from "../rpc";
import { Terminal } from "ghostty-web";
import { toast } from "../toast";
import type { NativeStreamRole } from "../../shared/native-terminal-stream";
import {
	resetTerminalBidiForTests,
	syncTerminalBidiFromGlobalSettings,
} from "../terminal-bidi/flag";
import { isBidiRenderInstalled, uninstallBidiRender } from "../terminal-bidi/proxy";

// ── Hoisted mocks (must be before vi.mock factories) ─────────────────────────

const {
	mockFocus,
	mockInput,
	mockPaste,
	mockTermInstance,
	mockBufferActive,
	mockOnDataDispose,
	mockOnResizeDispose,
	mockOnSelectionChangeDispose,
	mockVendorRender,
	fitAddonHolder,
} = vi.hoisted(() => {
	const mockFocus = vi.fn();
	const mockInput = vi.fn();
	const mockPaste = vi.fn();
	const mockOnDataDispose = vi.fn();
	const mockOnResizeDispose = vi.fn();
	const mockOnSelectionChangeDispose = vi.fn();
	// The renderer's own paint. Held separately because TerminalView wraps
	// `renderer.render` (cursor-visibility gate, bidi view) at mount.
	const mockVendorRender = vi.fn();
	// Holds the last-constructed FitAddon so tests can drive proposeDimensions.
	const fitAddonHolder: { current: null | { proposeDimensions: ReturnType<typeof vi.fn> } } = { current: null };
	// Plain object — avoids document.createElement at hoist time
	const mockCanvas = {
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
	};
	// Mutable cursor for the alt-click tests (ghostty buffer API surface).
	const mockBufferActive = { cursorX: 0, cursorY: 0 };
	const mockTermInstance = {
		loadAddon: vi.fn(),
		open: vi.fn(),
		focus: mockFocus,
		input: mockInput,
		paste: mockPaste,
		buffer: { active: mockBufferActive },
		onData: vi.fn(() => ({ dispose: mockOnDataDispose })),
		onResize: vi.fn(() => ({ dispose: mockOnResizeDispose })),
		onSelectionChange: vi.fn(() => ({ dispose: mockOnSelectionChangeDispose })),
		onRender: vi.fn(() => ({ dispose: vi.fn() })),
		onScroll: vi.fn(() => ({ dispose: vi.fn() })),
		registerLinkProvider: vi.fn(),
		attachCustomKeyEventHandler: vi.fn(),
		attachCustomWheelEventHandler: vi.fn(),
		hasMouseTracking: vi.fn(() => false),
		hasSelection: vi.fn(() => false),
		isAlternateScreen: vi.fn(() => false),
		getSelection: vi.fn(() => ""),
		renderer: {
			getCanvas: () => mockCanvas,
			charWidth: 8,
			charHeight: 16,
			remeasureFont: vi.fn(),
			render: mockVendorRender,
		},
		wasmTerm: {},
		viewportY: 0,
		write: vi.fn(),
		writeln: vi.fn(),
		reset: vi.fn(),
		resize: vi.fn(),
		dispose: vi.fn(),
		cols: 80,
		rows: 24,
		options: {} as Record<string, unknown>,
	};
	return {
		mockFocus,
		mockInput,
		mockPaste,
		mockCanvas,
		mockTermInstance,
		mockBufferActive,
		mockOnDataDispose,
		mockOnResizeDispose,
		mockOnSelectionChangeDispose,
		mockVendorRender,
		fitAddonHolder,
	};
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("ghostty-web", () => ({
	// Must use `function` (not arrow) so vitest allows calling with `new`
	// eslint-disable-next-line prefer-arrow-callback
	Terminal: vi.fn(function MockTerminal() { return mockTermInstance; }),
	// eslint-disable-next-line prefer-arrow-callback
	FitAddon: vi.fn(function MockFitAddon() {
		const inst = {
			fit: vi.fn(),
			observeResize: vi.fn(),
			proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
			dispose: vi.fn(),
		};
		fitAddonHolder.current = inst;
		return inst;
	}),
}));

vi.mock("../rpc", () => ({
	isElectrobun: false,
	api: {
		request: {
			uploadFileBase64: vi.fn(),
			pasteClipboardImage: vi.fn(),
			taskPaneAction: vi.fn(),
			tmuxNewWindow: vi.fn(),
			tmuxAltClickMoveCursor: vi.fn().mockResolvedValue({ moved: true }),
			exitCopyModeAllPanes: vi.fn().mockResolvedValue({ panesExited: 1 }),
			logRendererDiagnostic: vi.fn().mockResolvedValue(undefined),
			copyTerminalSelection: vi.fn().mockResolvedValue({ ok: true, tool: "pbcopy" }),
			resolveTerminalPaths: vi.fn().mockResolvedValue({ resolved: {} }),
		},
	},
}));

vi.mock("../toast", () => ({
	toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock("../zoom", () => ({
	getEffectiveZoom: () => 1,
	ZOOM_CHANGED_EVENT: "dev3-zoom-changed",
}));

vi.mock("../shift-key-sequences", () => ({
	getShiftKeySequence: () => null,
}));

// ── Infrastructure stubs ──────────────────────────────────────────────────────

// Synchronous requestAnimationFrame so the rAF callback in setup() runs inline
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
	cb(0);
	return 1;
});

// Minimal WebSocket stub (just needs to not throw during connectPty)
let lastWebSocket: MockWebSocket | null = null;
let webSockets: MockWebSocket[] = [];
let clipboardWriteTextMock: ReturnType<typeof vi.fn>;

class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readyState = MockWebSocket.OPEN;
	send = vi.fn();
	close = vi.fn();
	onopen: ((e: Event) => void) | null = null;
	onmessage: ((e: MessageEvent) => void) | null = null;
	onclose: ((e: CloseEvent) => void) | null = null;
	onerror: ((e: Event) => void) | null = null;

	readonly url: string;

	constructor(url = "") {
		this.url = url;
		lastWebSocket = this;
		webSockets.push(this);
	}
}
vi.stubGlobal("WebSocket", class extends MockWebSocket {});

// ResizeObserver — capture the callback so tests can fire it manually
type ROCallback = (entries: ResizeObserverEntry[], observer: ResizeObserver) => void;
let fireResize: (() => void) | null = null;
vi.stubGlobal(
	"ResizeObserver",
	class {
		constructor(cb: ROCallback) {
			fireResize = () => cb([], this as unknown as ResizeObserver);
		}
		observe = vi.fn();
		disconnect = vi.fn();
		unobserve = vi.fn();
	},
);

// Give every HTMLElement non-zero layout dimensions so the ResizeObserver
// branch (`el.clientWidth > 0 && el.clientHeight > 0`) runs.
beforeAll(() => {
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get: () => 800,
	});
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get: () => 600,
	});
});

beforeEach(() => {
	vi.clearAllMocks();
	fireResize = null;
	lastWebSocket = null;
	webSockets = [];
	Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });

	// document.fonts.load must resolve immediately so setup() runs in tests
	Object.defineProperty(document, "fonts", {
		configurable: true,
		value: { load: vi.fn().mockReturnValue(Promise.resolve([])) },
	});
	clipboardWriteTextMock = vi.fn().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText: clipboardWriteTextMock,
		},
	});
});

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Render TerminalView and drive the full async setup chain:
 *   fonts.load() resolves → setup() → ResizeObserver fires → rAF → term.focus()
 */
async function renderAndSetup() {
	let result!: ReturnType<typeof render>;
	await act(async () => {
		result = render(<I18nProvider><TerminalView ptyUrl="ws://localhost:1234" taskId="t1" projectId="p1" /></I18nProvider>);
		// Flush the microtask queue so the fonts.load() .then() runs → setup()
		await Promise.resolve();
		await Promise.resolve();
	});
	// Trigger the ResizeObserver callback → rAF runs synchronously → term.focus()
	await act(async () => {
		fireResize?.();
	});
	return result;
}

describe("TerminalView – PTY reconnect", () => {
	it("ignores initial pageshow but reconnects after a bfcache restore", async () => {
		await renderAndSetup();
		const initialPageShow = new Event("pageshow");
		Object.defineProperty(initialPageShow, "persisted", { value: false });
		window.dispatchEvent(initialPageShow);
		expect(webSockets).toHaveLength(1);

		const restoredPageShow = new Event("pageshow");
		Object.defineProperty(restoredPageShow, "persisted", { value: true });
		window.dispatchEvent(restoredPageShow);
		expect(webSockets).toHaveLength(2);
	});

	it("replaces an apparently-open PTY socket after a mobile background cycle", async () => {
		await renderAndSetup();
		expect(webSockets).toHaveLength(1);

		Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
		document.dispatchEvent(new Event("visibilitychange"));
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		document.dispatchEvent(new Event("visibilitychange"));

		expect(webSockets).toHaveLength(2);
		expect(webSockets[0].close).toHaveBeenCalledTimes(1);
	});

	it("reconnects the PTY when a dropped mobile connection returns to the foreground", async () => {
		await renderAndSetup();
		expect(webSockets).toHaveLength(1);

		await act(async () => {
			webSockets[0].readyState = WebSocket.CLOSED;
			webSockets[0].onclose?.({ code: 1006, reason: "network gone", wasClean: false } as CloseEvent);
			document.dispatchEvent(new Event("visibilitychange"));
		});

		expect(webSockets).toHaveLength(2);
	});

	// The server accepts the upgrade before rejecting the session, so `onopen`
	// resets the backoff — retrying a final verdict reconnected once a second
	// forever and buried the app log in "WS connection to unknown session".
	it("stops reconnecting when the app says the session does not exist", async () => {
		await renderAndSetup();
		expect(webSockets).toHaveLength(1);

		vi.useFakeTimers();
		try {
			await act(async () => {
				webSockets[0].readyState = WebSocket.CLOSED;
				webSockets[0].onclose?.({ code: 4001, reason: "Unknown session", wasClean: false } as CloseEvent);
			});
			await act(async () => { vi.advanceTimersByTime(60_000); });
		} finally {
			vi.useRealTimers();
		}

		expect(webSockets).toHaveLength(1);
	});
});

describe("TerminalView – resilient re-fit on late layout growth", () => {
	it("resizes the terminal when the container grows after the initial fit", async () => {
		await renderAndSetup();
		const fit = fitAddonHolder.current!;
		// The container settles taller AFTER the first fit — this is the browser
		// first-load race that used to leave the terminal stuck at a small size
		// (ghostty's observeResize drops the growth callback in fit()'s 50ms window).
		// TerminalView swaps in its own proposeDimensions override at setup, so we
		// reassign it here to drive the resilient re-fit deterministically.
		fit.proposeDimensions = vi.fn(() => ({ cols: 80, rows: 50 }));
		mockTermInstance.resize.mockClear();

		vi.useFakeTimers();
		try {
			await act(async () => { fireResize?.(); });
			await act(async () => { vi.advanceTimersByTime(150); });
		} finally {
			vi.useRealTimers();
		}

		// Applied via term.resize (no 50ms drop window) rather than fitAddon.fit,
		// so a late growth is never swallowed.
		expect(mockTermInstance.resize).toHaveBeenCalledWith(80, 50);
	});

	it("re-fits only once per debounce window across a burst of resize events", async () => {
		await renderAndSetup();
		const fit = fitAddonHolder.current!;
		fit.proposeDimensions = vi.fn(() => ({ cols: 80, rows: 42 }));
		mockTermInstance.resize.mockClear();

		vi.useFakeTimers();
		try {
			await act(async () => {
				fireResize?.();
				fireResize?.();
				fireResize?.();
			});
			await act(async () => { vi.advanceTimersByTime(150); });
		} finally {
			vi.useRealTimers();
		}

		expect(mockTermInstance.resize).toHaveBeenCalledTimes(1);
		expect(mockTermInstance.resize).toHaveBeenCalledWith(80, 42);
	});
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TerminalView – focus-on-type", () => {
	it("focuses the terminal and feeds the key when body is active and a printable key is pressed", async () => {
		await renderAndSetup();

		// Clear the focus() call that happened during setup
		mockFocus.mockClear();
		mockInput.mockClear();

		// Default state: nothing focused → document.activeElement === document.body
		expect(document.activeElement).toBe(document.body);

		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
		});

		expect(mockFocus).toHaveBeenCalledTimes(1);
		expect(mockInput).toHaveBeenCalledWith("a", true);
	});

	it("does nothing when an <input> has focus", async () => {
		await renderAndSetup();
		mockFocus.mockClear();
		mockInput.mockClear();

		const input = document.createElement("input");
		document.body.appendChild(input);
		input.focus();

		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
		});

		expect(mockFocus).not.toHaveBeenCalled();
		expect(mockInput).not.toHaveBeenCalled();

		input.remove();
	});

	it("does nothing when a <textarea> has focus", async () => {
		await renderAndSetup();
		mockFocus.mockClear();
		mockInput.mockClear();

		const textarea = document.createElement("textarea");
		document.body.appendChild(textarea);
		textarea.focus();

		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
		});

		expect(mockFocus).not.toHaveBeenCalled();
		expect(mockInput).not.toHaveBeenCalled();

		textarea.remove();
	});

	it("does nothing for non-printable keys (Escape)", async () => {
		await renderAndSetup();
		mockFocus.mockClear();
		mockInput.mockClear();

		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});

		expect(mockFocus).not.toHaveBeenCalled();
		expect(mockInput).not.toHaveBeenCalled();
	});

	it("does nothing for non-printable keys (ArrowDown)", async () => {
		await renderAndSetup();
		mockFocus.mockClear();
		mockInput.mockClear();

		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		});

		expect(mockFocus).not.toHaveBeenCalled();
		expect(mockInput).not.toHaveBeenCalled();
	});

	it("does nothing for Ctrl+key combos", async () => {
		await renderAndSetup();
		mockFocus.mockClear();
		mockInput.mockClear();

		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
		});

		expect(mockFocus).not.toHaveBeenCalled();
		expect(mockInput).not.toHaveBeenCalled();
	});

	it("does nothing for Meta+key combos", async () => {
		await renderAndSetup();
		mockFocus.mockClear();
		mockInput.mockClear();

		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
		});

		expect(mockFocus).not.toHaveBeenCalled();
		expect(mockInput).not.toHaveBeenCalled();
	});

	it("handles space as a printable key", async () => {
		await renderAndSetup();
		mockFocus.mockClear();
		mockInput.mockClear();

		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
		});

		expect(mockFocus).toHaveBeenCalledTimes(1);
		expect(mockInput).toHaveBeenCalledWith(" ", true);
	});
});

// ── Terminal keymap shortcuts ─────────────────────────────────────────────────

const mockedTaskPaneAction = vi.mocked(api.request.taskPaneAction);
const mockedUploadFileBase64 = vi.mocked(api.request.uploadFileBase64);
const mockedCopyTerminalSelection = vi.mocked(api.request.copyTerminalSelection);
const mockedExitCopyModeAllPanes = vi.mocked(api.request.exitCopyModeAllPanes);

/** Focus a child element inside the terminal container so the keymap guard passes. */
function focusInsideTerminal(): HTMLElement {
	const container = document.querySelector("[data-terminal='true']")!;
	const target = document.createElement("div");
	target.tabIndex = 0;
	container.appendChild(target);
	target.focus();
	return target;
}

function makeFileList(files: File[]): FileList {
	return {
		length: files.length,
		item: (index: number) => files[index] ?? null,
		...Object.fromEntries(files.map((file, index) => [index, file])),
	} as unknown as FileList;
}

function dispatchDrop(target: Element, files: File[]) {
	const event = new MouseEvent("drop", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "dataTransfer", {
		value: {
			files: makeFileList(files),
		},
	});
	act(() => {
		target.dispatchEvent(event);
	});
}

const realNavigator = globalThis.navigator;

/** The pane combos are the macOS keymap (`Mod` = ⌘) — happy-dom is not a Mac. */
function fakeMacPlatform() {
	Object.defineProperty(globalThis, "navigator", {
		value: { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
		writable: true,
		configurable: true,
	});
}

describe("TerminalView – keymap shortcuts", () => {
	beforeEach(() => {
		localStorage.clear();
		fakeMacPlatform();
		mockedTaskPaneAction.mockClear();
		mockedTaskPaneAction.mockResolvedValue(undefined as any);
		mockedUploadFileBase64.mockReset();
		lastWebSocket = null;
	});

	afterEach(() => {
		Object.defineProperty(globalThis, "navigator", { value: realNavigator, writable: true, configurable: true });
	});

	it("Cmd+W closes the pane in the desktop shell", async () => {
		// `desktopOnly`: in a browser tab this combo closes the TAB and the page
		// cannot cancel it, so the binding only exists in the desktop shell.
		(window as Window & { __electrobunWebviewId?: number }).__electrobunWebviewId = 1;
		try {
			await renderAndSetup();
			const target = focusInsideTerminal();

			await act(async () => {
				window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", metaKey: true, bubbles: true }));
			});

			expect(mockedTaskPaneAction).toHaveBeenCalledWith({ taskId: "t1", action: { kind: "close" } });
			target.remove();
		} finally {
			Reflect.deleteProperty(window, "__electrobunWebviewId");
		}
	});

	it("Cmd+W is left to the browser in remote mode — it would close the session's tab", async () => {
		await renderAndSetup();
		const target = focusInsideTerminal();

		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", metaKey: true, bubbles: true }));
		});

		expect(mockedTaskPaneAction).not.toHaveBeenCalled();
		target.remove();
	});

	it("Cmd+D (no shift) calls splitV", async () => {
		await renderAndSetup();
		const target = focusInsideTerminal();

		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD", metaKey: true, shiftKey: false, bubbles: true }));
		});

		expect(mockedTaskPaneAction).toHaveBeenCalledWith({ taskId: "t1", action: { kind: "splitV" } });
		target.remove();
	});

	it("Shift+Cmd+D calls splitH", async () => {
		await renderAndSetup();
		const target = focusInsideTerminal();

		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD", metaKey: true, shiftKey: true, bubbles: true }));
		});

		expect(mockedTaskPaneAction).toHaveBeenCalledWith({ taskId: "t1", action: { kind: "splitH" } });
		target.remove();
	});

	it("does NOT fire when terminal container does not have focus", async () => {
		await renderAndSetup();
		// Do NOT focus inside the container — activeElement remains document.body

		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", metaKey: true, bubbles: true }));
		});

		expect(mockedTaskPaneAction).not.toHaveBeenCalled();
	});
});

describe("TerminalView – drag-and-drop", () => {
	it("uploads dropped files and pastes the returned worktree path", async () => {
		mockedUploadFileBase64.mockResolvedValue({ path: "/tmp/uploads/notes.txt" } as any);

		await renderAndSetup();
		const terminal = document.querySelector("[data-terminal='true']")!;
		const file = new File(["notes"], "notes.txt", {
			type: "text/plain",
			lastModified: 1711600000000,
		});

		dispatchDrop(terminal, [file]);

		await waitFor(() => {
			expect(mockedUploadFileBase64).toHaveBeenCalledWith({
				projectId: "p1",
				base64: "bm90ZXM=",
				filename: "notes.txt",
				mimeType: "text/plain",
			});
		});
		await waitFor(() => {
			expect(lastWebSocket?.send).toHaveBeenCalledWith("/tmp/uploads/notes.txt");
		});
	});
});

describe("TerminalView – OSC 52 clipboard", () => {
	it("writes OSC 52 payloads for the active terminal to navigator.clipboard", async () => {
		await renderAndSetup();

		await act(async () => {
			window.dispatchEvent(
				new CustomEvent("rpc:osc52Clipboard", {
					detail: { taskId: "t1", text: "copied from osc52", len: 17 },
				}),
			);
		});

		expect(clipboardWriteTextMock).toHaveBeenCalledWith("copied from osc52");
	});

	it("ignores OSC 52 payloads for other terminals", async () => {
		await renderAndSetup();

		await act(async () => {
			window.dispatchEvent(
				new CustomEvent("rpc:osc52Clipboard", {
					detail: { taskId: "someone-else", text: "nope", len: 4 },
				}),
			);
		});

		expect(clipboardWriteTextMock).not.toHaveBeenCalled();
	});
});

describe("TerminalView – selection clipboard bridge", () => {
	beforeEach(() => {
		mockedCopyTerminalSelection.mockClear();
		mockedCopyTerminalSelection.mockResolvedValue({ ok: true, tool: "pbcopy" });
	});

	it("copies native terminal selections through the backend on mouseup", async () => {
		mockTermInstance.hasSelection.mockReturnValue(true);
		mockTermInstance.getSelection.mockReturnValue("line 1\nline 2\nline 3");
		mockTermInstance.hasMouseTracking.mockReturnValue(false);

		await renderAndSetup();
		const terminal = document.querySelector("[data-terminal='true']")!;

		await act(async () => {
			terminal.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
		});

		expect(mockedCopyTerminalSelection).toHaveBeenCalledWith({
			text: "line 1\nline 2\nline 3",
			taskId: "t1",
			mouseTracking: false,
		});
	});

	it("shows the select-to-copy hint toast only on the first auto-copy", async () => {
		const { toast } = await import("../toast");
		const infoToast = vi.mocked(toast.info);
		localStorage.removeItem("dev3-terminal-copy-hint-seen");
		infoToast.mockClear();
		mockTermInstance.hasSelection.mockReturnValue(true);
		mockTermInstance.getSelection.mockReturnValue("hello");
		mockTermInstance.hasMouseTracking.mockReturnValue(false);

		await renderAndSetup();
		const terminal = document.querySelector("[data-terminal='true']")!;

		// First selection → hint fires once.
		await act(async () => {
			terminal.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
		});
		await act(async () => { await Promise.resolve(); });
		expect(infoToast).toHaveBeenCalledTimes(1);

		// Second selection → no repeat (localStorage flag set).
		await act(async () => {
			terminal.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
		});
		await act(async () => { await Promise.resolve(); });
		expect(infoToast).toHaveBeenCalledTimes(1);
	});

	it("does not use the backend bridge when tmux mouse tracking owns the drag", async () => {
		mockTermInstance.hasSelection.mockReturnValue(true);
		mockTermInstance.getSelection.mockReturnValue("tmux-owned selection");
		mockTermInstance.hasMouseTracking.mockReturnValue(true);

		await renderAndSetup();
		const terminal = document.querySelector("[data-terminal='true']")!;

		await act(async () => {
			terminal.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
		});

		expect(mockedCopyTerminalSelection).not.toHaveBeenCalled();
	});
});

describe("TerminalView – tmux copy-mode focus recovery", () => {
	afterEach(() => {
		mockTermInstance.hasMouseTracking.mockReturnValue(false);
	});

	it("exits retained copy mode when the user next clicks the terminal", async () => {
		mockTermInstance.hasMouseTracking.mockReturnValue(true);
		const { container } = await renderAndSetup();
		const terminal = container.querySelector('[data-terminal="true"]') as HTMLElement;
		const wheelHandler = mockTermInstance.attachCustomWheelEventHandler.mock.calls[0]?.[0] as
			| ((event: WheelEvent) => boolean)
			| undefined;

		// Scrolling upward through a tmux-owned terminal enters copy mode.
		act(() => {
			wheelHandler?.({ deltaY: -100, clientX: 20, clientY: 20 } as WheelEvent);
		});
		mockedExitCopyModeAllPanes.mockClear();

		fireEvent.click(terminal);

		expect(mockFocus).toHaveBeenCalled();
		expect(mockedExitCopyModeAllPanes).toHaveBeenCalledWith({ taskId: "t1" });
	});

	it("keeps copy mode after a drag and exits it on the following plain click", async () => {
		mockTermInstance.hasMouseTracking.mockReturnValue(true);
		const { container } = await renderAndSetup();
		const terminal = container.querySelector('[data-terminal="true"]') as HTMLElement;
		const canvasListeners = mockTermInstance.renderer.getCanvas().addEventListener.mock.calls;
		const mouseDown = canvasListeners.find((call: unknown[]) => call[0] === "mousedown")?.[1] as (event: MouseEvent) => void;
		const mouseMove = canvasListeners.find((call: unknown[]) => call[0] === "mousemove")?.[1] as (event: MouseEvent) => void;
		const event = (x: number, y: number) => ({
			button: 0,
			clientX: x,
			clientY: y,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		}) as unknown as MouseEvent;

		mockedExitCopyModeAllPanes.mockClear();
		act(() => {
			mouseDown(event(20, 20));
			mouseMove(event(80, 40));
			document.dispatchEvent(new MouseEvent("mouseup", { clientX: 80, clientY: 40 }));
		});
		// Browsers may emit click after a drag. That synthetic click must not
		// cancel the copy mode that intentionally preserves the viewport.
		fireEvent.click(terminal);
		expect(mockedExitCopyModeAllPanes).not.toHaveBeenCalled();

		act(() => {
			mouseDown(event(40, 40));
			document.dispatchEvent(new MouseEvent("mouseup", { clientX: 40, clientY: 40 }));
		});
		fireEvent.click(terminal);

		expect(mockedExitCopyModeAllPanes).toHaveBeenCalledTimes(1);
		expect(mockedExitCopyModeAllPanes).toHaveBeenCalledWith({ taskId: "t1" });
	});
});

// ── Mouse-report flood control (decision 175) ─────────────────────────────────

describe("TerminalView – mouse report pacing", () => {
	afterEach(() => {
		mockTermInstance.hasMouseTracking.mockReturnValue(false);
	});

	const countReports = () =>
		mockInput.mock.calls.reduce(
			(sum, [data]) => sum + (String(data).match(/\x1b\[</g)?.length ?? 0),
			0,
		);

	it("caps a single violent flick and keeps every write far below 1 KB", async () => {
		mockTermInstance.hasMouseTracking.mockReturnValue(true);
		await renderAndSetup();
		const wheelHandler = mockTermInstance.attachCustomWheelEventHandler.mock.calls[0]?.[0] as
			| ((event: WheelEvent) => boolean)
			| undefined;

		mockInput.mockClear();
		act(() => {
			wheelHandler?.({ deltaY: 100_000, clientX: 20, clientY: 20 } as WheelEvent);
		});

		expect(countReports()).toBeLessThanOrEqual(16);
		for (const [data] of mockInput.mock.calls) {
			expect(String(data).length).toBeLessThan(1022);
		}
	});

	it("drops sustained excess instead of queueing it", async () => {
		mockTermInstance.hasMouseTracking.mockReturnValue(true);
		await renderAndSetup();
		const wheelHandler = mockTermInstance.attachCustomWheelEventHandler.mock.calls[0]?.[0] as
			| ((event: WheelEvent) => boolean)
			| undefined;

		mockInput.mockClear();
		act(() => {
			for (let i = 0; i < 50; i++) {
				wheelHandler?.({ deltaY: 5_000, clientX: 20, clientY: 20 } as WheelEvent);
			}
		});

		// 50 events × 5000px would be thousands of reports unpaced; the bucket
		// only refills with elapsed time, and these all land in the same tick.
		expect(countReports()).toBeLessThanOrEqual(20);
	});

	it("reports a drag once per cell, not once per pixel", async () => {
		mockTermInstance.hasMouseTracking.mockReturnValue(true);
		await renderAndSetup();
		const canvasListeners = mockTermInstance.renderer.getCanvas().addEventListener.mock.calls;
		const mouseDown = canvasListeners.find((call: unknown[]) => call[0] === "mousedown")?.[1] as (event: MouseEvent) => void;
		const mouseMove = canvasListeners.find((call: unknown[]) => call[0] === "mousemove")?.[1] as (event: MouseEvent) => void;
		const event = (x: number, y: number) => ({
			button: 0,
			clientX: x,
			clientY: y,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		}) as unknown as MouseEvent;

		act(() => {
			mouseDown(event(20, 20));
		});
		mockInput.mockClear();
		act(() => {
			// charWidth is 8, so x 16–23 is one cell: only the jump to 33 counts.
			for (const x of [17, 18, 19, 20, 21, 22, 23, 33]) mouseMove(event(x, 20));
		});

		expect(countReports()).toBe(1);
	});
});

// ── Terminal disposal safety ──────────────────────────────────────────────────

describe("TerminalView – disposal safety (no 'Terminal has been disposed' errors)", () => {
	it("disposes onData and onResize subscriptions on unmount", async () => {
		const { unmount } = await renderAndSetup();

		expect(mockTermInstance.onData).toHaveBeenCalledTimes(1);
		expect(mockTermInstance.onResize).toHaveBeenCalledTimes(1);

		await act(async () => {
			unmount();
		});

		expect(mockOnDataDispose).toHaveBeenCalledTimes(1);
		expect(mockOnResizeDispose).toHaveBeenCalledTimes(1);
		expect(mockOnSelectionChangeDispose).toHaveBeenCalledTimes(1);
	});

	it("does not throw when mouse events fire after unmount", async () => {
		mockTermInstance.hasMouseTracking.mockReturnValue(true);
		const { unmount } = await renderAndSetup();

		// Capture the mouse event handlers registered on the canvas
		const canvasAddEventListener = mockTermInstance.renderer.getCanvas().addEventListener;
		const mousedownHandler = canvasAddEventListener.mock.calls.find(
			(c: unknown[]) => c[0] === "mousedown",
		)?.[1] as ((e: MouseEvent) => void) | undefined;
		const mousemoveHandler = canvasAddEventListener.mock.calls.find(
			(c: unknown[]) => c[0] === "mousemove",
		)?.[1] as ((e: MouseEvent) => void) | undefined;

		// Unmount to trigger disposal
		await act(async () => {
			unmount();
		});

		// Simulate terminal methods throwing after disposal
		mockTermInstance.hasMouseTracking.mockImplementation(() => {
			throw new Error("Terminal has been disposed");
		});
		mockInput.mockImplementation(() => {
			throw new Error("Terminal has been disposed");
		});

		// These should NOT throw — the disposed guard should prevent it
		expect(() => mousedownHandler?.({ button: 0, clientX: 50, clientY: 50, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as MouseEvent)).not.toThrow();
		expect(() => mousemoveHandler?.({ button: 0, clientX: 60, clientY: 60, stopPropagation: vi.fn() } as unknown as MouseEvent)).not.toThrow();

		// Restore normal behavior
		mockTermInstance.hasMouseTracking.mockReturnValue(false);
		mockInput.mockReset();
	});

	it("does not throw when wheel handler fires after unmount", async () => {
		mockTermInstance.hasMouseTracking.mockReturnValue(true);
		const { unmount } = await renderAndSetup();

		// Capture the wheel handler
		const wheelHandler = mockTermInstance.attachCustomWheelEventHandler.mock.calls[0]?.[0] as
			| ((e: WheelEvent) => boolean)
			| undefined;

		await act(async () => {
			unmount();
		});

		// Simulate terminal methods throwing after disposal
		mockTermInstance.hasMouseTracking.mockImplementation(() => {
			throw new Error("Terminal has been disposed");
		});

		// Should return false (not throw) after disposal
		expect(wheelHandler?.({ deltaY: 100, clientX: 50, clientY: 50 } as WheelEvent)).toBe(false);

		mockTermInstance.hasMouseTracking.mockReturnValue(false);
	});

	it("does not throw when onData callback fires after unmount", async () => {
		const { unmount } = await renderAndSetup();

		// Capture the onData callback
		const onDataCallback = (mockTermInstance.onData.mock.calls as unknown[][])[0]?.[0] as
			| ((data: string) => void)
			| undefined;

		await act(async () => {
			unmount();
		});

		// Should silently return — disposed guard prevents WS send
		expect(() => onDataCallback?.("hello")).not.toThrow();
	});

	it("does not throw when onResize callback fires after unmount", async () => {
		const { unmount } = await renderAndSetup();

		// Capture the onResize callback
		const onResizeCallback = (mockTermInstance.onResize.mock.calls as unknown[][])[0]?.[0] as
			| ((dims: { cols: number; rows: number }) => void)
			| undefined;

		await act(async () => {
			unmount();
		});

		// Should silently return — disposed guard prevents WS send
		expect(() => onResizeCallback?.({ cols: 100, rows: 30 })).not.toThrow();
	});

	it("does not throw when focus-on-type keydown fires after unmount", async () => {
		const { unmount } = await renderAndSetup();

		// Make focus throw to simulate disposed terminal
		mockFocus.mockImplementation(() => {
			throw new Error("Terminal has been disposed");
		});

		await act(async () => {
			unmount();
		});

		// keydown on body should not propagate the error
		expect(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
		}).not.toThrow();

		mockFocus.mockReset();
	});
});

// ── Paste routing — always bracketed, never raw CRLF (remote/Windows) ────────

const mockedPasteClipboardImage = vi.mocked(api.request.pasteClipboardImage);

function dispatchPaste(
	target: Element,
	text: string,
	items: Array<{ type: string }> = [],
	files: File[] = [],
) {
	const event = new Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "clipboardData", {
		value: {
			getData: (type: string) => (type === "text/plain" ? text : ""),
			items,
			files,
		},
	});
	const preventDefault = vi.spyOn(event, "preventDefault");
	const stopImmediate = vi.spyOn(event, "stopImmediatePropagation");
	act(() => {
		target.dispatchEvent(event);
	});
	return { event, preventDefault, stopImmediate };
}

describe("TerminalView – paste routing", () => {
	beforeEach(() => {
		mockPaste.mockClear();
		mockedPasteClipboardImage.mockReset();
		mockedUploadFileBase64.mockReset();
	});

	it("routes a multi-line CRLF paste through bracketed term.paste with CR line endings", async () => {
		const { container } = await renderAndSetup();
		const terminal = container.querySelector('[data-terminal="true"]')!;

		const { preventDefault, stopImmediate } = dispatchPaste(terminal, "line1\r\nline2\r\nline3");

		// Fix: single bracketed path, newlines collapsed to CR — never the raw
		// container path that would submit after "line1".
		expect(mockPaste).toHaveBeenCalledWith("line1\rline2\rline3");
		expect(preventDefault).toHaveBeenCalled();
		// Must pre-empt BOTH ghostty paste handlers on the same/child node.
		expect(stopImmediate).toHaveBeenCalled();
	});

	it("normalizes lone LF newlines to CR too", async () => {
		const { container } = await renderAndSetup();
		const terminal = container.querySelector('[data-terminal="true"]')!;

		dispatchPaste(terminal, "a\nb\nc");

		expect(mockPaste).toHaveBeenCalledWith("a\rb\rc");
	});

	it("routes ordinary single-line text through term.paste", async () => {
		const { container } = await renderAndSetup();
		const terminal = container.querySelector('[data-terminal="true"]')!;

		dispatchPaste(terminal, "hello world");

		expect(mockPaste).toHaveBeenCalledWith("hello world");
	});

	it("ignores an empty text paste (no image, no text) without swallowing it", async () => {
		const { container } = await renderAndSetup();
		const terminal = container.querySelector('[data-terminal="true"]')!;

		const { preventDefault } = dispatchPaste(terminal, "");

		expect(mockPaste).not.toHaveBeenCalled();
		expect(preventDefault).not.toHaveBeenCalled();
	});

	it("does not swallow a paste while the terminal is still initializing (no term yet)", async () => {
		// Never resolve fonts.load() → setup() never runs → termRef stays null,
		// but the capture-phase paste listener is already attached on mount. This
		// mirrors the brief PTY-recreation gap; the event must NOT be swallowed.
		Object.defineProperty(document, "fonts", {
			configurable: true,
			value: { load: vi.fn().mockReturnValue(new Promise(() => {})) },
		});

		let result!: ReturnType<typeof render>;
		await act(async () => {
			result = render(
				<I18nProvider>
					<TerminalView ptyUrl="ws://localhost:1234" taskId="t1" projectId="p1" />
				</I18nProvider>,
			);
		});
		const terminal = result.container.querySelector('[data-terminal="true"]')!;

		const { preventDefault } = dispatchPaste(terminal, "hello");

		expect(mockPaste).not.toHaveBeenCalled();
		expect(preventDefault).not.toHaveBeenCalled();
	});

	it("tells the user when the host clipboard yields no usable image, instead of failing silently", async () => {
		// This is the Windows symptom: electrobun's clipboardReadImage returns nothing
		// usable, the handler returned null, and absolutely nothing appeared on screen.
		const { toast } = await import("../toast");
		const errorToast = vi.mocked(toast.error);
		errorToast.mockClear();
		mockedPasteClipboardImage.mockResolvedValue(null);
		const { container } = await renderAndSetup();
		const terminal = container.querySelector('[data-terminal="true"]')!;

		dispatchPaste(terminal, "", [{ type: "image/png" }]);

		await waitFor(() => {
			expect(
				errorToast,
				"cause: a failed image paste produced no user-visible feedback. fix: toast.error(t(\"imagePaste.failed\")) when pasteClipboardImage resolves null or rejects",
			).toHaveBeenCalled();
		});
	});

	it("still diverts image pastes to the attachment uploader (not term.paste)", async () => {
		mockedPasteClipboardImage.mockResolvedValue({ path: "/tmp/uploads/pic.png" } as any);
		const { container } = await renderAndSetup();
		const terminal = container.querySelector('[data-terminal="true"]')!;

		dispatchPaste(terminal, "", [{ type: "image/png" }]);

		await waitFor(() => {
			expect(mockedPasteClipboardImage).toHaveBeenCalledWith({ projectId: "p1" });
		});
		expect(mockPaste).not.toHaveBeenCalled();
	});

	it("uploads an image carried by the paste event itself, without reading the host clipboard", async () => {
		// The webview already decoded the clipboard bitmap into real PNG bytes. Going
		// through the host clipboard instead is what breaks on Windows, where
		// electrobun returns raw CF_DIB bytes (or nothing at all).
		mockedUploadFileBase64.mockResolvedValue({ path: "/tmp/uploads/image.png" } as any);
		const { container } = await renderAndSetup();
		const terminal = container.querySelector('[data-terminal="true"]')!;
		const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", { type: "image/png" });

		dispatchPaste(terminal, "", [{ type: "image/png" }], [file]);

		await waitFor(() => {
			expect(mockedUploadFileBase64).toHaveBeenCalled();
		});
		expect(
			mockedPasteClipboardImage,
			"cause: the paste went through the host-clipboard RPC even though the event carried the image. fix: check imageFilesFromClipboard before the pasteClipboardImage fallback",
		).not.toHaveBeenCalled();
		expect(
			mockPaste,
			"cause: an image paste was also typed into the terminal as text. fix: preventDefault and return after the upload branch",
		).not.toHaveBeenCalled();
	});

	it("leaves ordinary text pastes on the bracketed path when a non-image file is attached", async () => {
		const { container } = await renderAndSetup();
		const terminal = container.querySelector('[data-terminal="true"]')!;
		const file = new File(["hello"], "notes.txt", { type: "text/plain" });

		dispatchPaste(terminal, "hello world", [], [file]);

		expect(
			mockPaste,
			'cause: a text paste was diverted to the uploader because a non-image file was attached. fix: filter clipboard files on type.startsWith("image/")',
		).toHaveBeenCalledWith("hello world");
		expect(mockedUploadFileBase64).not.toHaveBeenCalled();
	});

	it("still diverts large text pastes to the .txt uploader (not term.paste)", async () => {
		mockedUploadFileBase64.mockResolvedValue({ path: "/tmp/uploads/pasted-text.txt" } as any);
		const { container } = await renderAndSetup();
		const terminal = container.querySelector('[data-terminal="true"]')!;

		const huge = "x".repeat(9000); // > LARGE_TEXT_PASTE_THRESHOLD (8192)
		dispatchPaste(terminal, huge);

		await waitFor(() => {
			expect(mockedUploadFileBase64).toHaveBeenCalled();
		});
		expect(mockPaste).not.toHaveBeenCalled();
	});
});

describe("normalizePastedText", () => {
	it("collapses CRLF to a single CR", () => {
		expect(normalizePastedText("a\r\nb")).toBe("a\rb");
	});
	it("converts lone LF to CR", () => {
		expect(normalizePastedText("a\nb\nc")).toBe("a\rb\rc");
	});
	it("leaves lone CR untouched", () => {
		expect(normalizePastedText("a\rb")).toBe("a\rb");
	});
	it("handles mixed and trailing newlines", () => {
		expect(normalizePastedText("a\r\nb\nc\r")).toBe("a\rb\rc\r");
	});
	it("returns plain text unchanged", () => {
		expect(normalizePastedText("no newlines here")).toBe("no newlines here");
	});
});

// ── buildResizeDance — pins the nudge axis (decision 041) ────────────────────

describe("buildResizeDance", () => {
	it("nudges rows, not columns, so text wrapping is stable between paints", () => {
		const [nudge, correct] = buildResizeDance(120, 30);
		// If a future refactor swaps this back to a column nudge, the
		// "refresh / realign" task-switch flicker from issue cb75af7b
		// will return. Keep the nudge on rows.
		expect(nudge).toBe("\x1b]resize;120;31\x07");
		expect(correct).toBe("\x1b]resize;120;30\x07");
	});

	it("uses the same column count for both messages", () => {
		const [nudge, correct] = buildResizeDance(200, 60);
		const nudgeCols = nudge.match(/resize;(\d+);/)![1];
		const correctCols = correct.match(/resize;(\d+);/)![1];
		expect(nudgeCols).toBe(correctCols);
		expect(nudgeCols).toBe("200");
	});

	it("differs by exactly one row between nudge and correct", () => {
		const [nudge, correct] = buildResizeDance(80, 24);
		const nudgeRows = Number(nudge.match(/resize;\d+;(\d+)/)![1]);
		const correctRows = Number(correct.match(/resize;\d+;(\d+)/)![1]);
		expect(nudgeRows - correctRows).toBe(1);
	});
});

// ── Alt/Option-click gesture wiring ──────────────────────────────────────────

describe("TerminalView – alt-click cursor move", () => {
	afterEach(() => {
		mockTermInstance.hasMouseTracking.mockReturnValue(false);
		mockBufferActive.cursorX = 0;
		mockBufferActive.cursorY = 0;
	});

	function altClick(container: HTMLElement, clientX: number, clientY: number): boolean {
		// canvas rect is mocked at (0,0), charWidth 8, charHeight 16
		// → col = floor(x/8)+1, row = floor(y/16)+1
		return container.dispatchEvent(
			new MouseEvent("mousedown", {
				altKey: true,
				button: 0,
				clientX,
				clientY,
				bubbles: true,
				cancelable: true,
			}),
		);
	}

	it("delegates to the backend when mouse tracking is on (tmux) and does NOT swallow the click", async () => {
		mockTermInstance.hasMouseTracking.mockReturnValue(true);
		const { container } = await renderAndSetup();
		const termEl = container.querySelector('[data-terminal="true"]') as HTMLElement;

		// clientX 20 → col 3, clientY 10 → row 1
		const notPrevented = altClick(termEl, 20, 10);

		expect(api.request.tmuxAltClickMoveCursor).toHaveBeenCalledWith({ taskId: "t1", col: 3, row: 1 });
		// Not swallowed — the SGR mouse path must still deliver the alt-click
		// to mouse-owning apps (Claude Code's built-in alt-click).
		expect(notPrevented).toBe(true);
		// No local arrows over the WS in this mode.
		expect(lastWebSocket!.send).not.toHaveBeenCalled();
	});

	it("moves locally via CSI arrows and swallows the click when tracking is off (bare PTY)", async () => {
		mockBufferActive.cursorX = 0; // cursor col 1
		mockBufferActive.cursorY = 0; // cursor row 1
		const { container } = await renderAndSetup();
		const termEl = container.querySelector('[data-terminal="true"]') as HTMLElement;

		const notPrevented = altClick(termEl, 20, 10); // col 3, row 1 → 2 × Right

		expect(lastWebSocket!.send).toHaveBeenCalledWith("\x1b[C\x1b[C");
		expect(notPrevented).toBe(false); // swallowed
		expect(api.request.tmuxAltClickMoveCursor).not.toHaveBeenCalled();
	});

	it("is a no-op for a cross-row click when tracking is off, but still swallows it", async () => {
		mockBufferActive.cursorX = 0;
		mockBufferActive.cursorY = 0; // cursor row 1
		const { container } = await renderAndSetup();
		const termEl = container.querySelector('[data-terminal="true"]') as HTMLElement;

		const notPrevented = altClick(termEl, 20, 30); // row 2 ≠ cursor row 1

		expect(lastWebSocket!.send).not.toHaveBeenCalled();
		expect(notPrevented).toBe(false); // still swallowed — no stray selection
	});

	it("ignores non-alt clicks entirely", async () => {
		const { container } = await renderAndSetup();
		const termEl = container.querySelector('[data-terminal="true"]') as HTMLElement;

		const notPrevented = termEl.dispatchEvent(
			new MouseEvent("mousedown", { button: 0, clientX: 20, clientY: 10, bubbles: true, cancelable: true }),
		);

		expect(notPrevented).toBe(true);
		expect(lastWebSocket!.send).not.toHaveBeenCalled();
		expect(api.request.tmuxAltClickMoveCursor).not.toHaveBeenCalled();
	});
});

// ── buildCursorMoveSequence — Alt/Option-click cursor move (horizontal only) ──

describe("buildCursorMoveSequence", () => {
	const RIGHT = "\x1b[C";
	const LEFT = "\x1b[D";

	it("emits right-arrows when the target is to the right on the same row", () => {
		// cursor at col 3, click col 7 → 4 × right
		expect(buildCursorMoveSequence(3, 10, 7, 10)).toBe(RIGHT.repeat(4));
	});

	it("emits left-arrows when the target is to the left on the same row", () => {
		// cursor at col 20, click col 5 → 15 × left
		expect(buildCursorMoveSequence(20, 10, 5, 10)).toBe(LEFT.repeat(15));
	});

	it("emits nothing when the click lands on the cursor cell", () => {
		expect(buildCursorMoveSequence(12, 4, 12, 4)).toBe("");
	});

	it("is a no-op for any cross-row click (vertical = shell history, not motion)", () => {
		// Same column, different row — must NOT emit history-walking up/down arrows.
		expect(buildCursorMoveSequence(8, 5, 8, 9)).toBe("");
		// Different column AND row — still skipped (ambiguous pane / wrap).
		expect(buildCursorMoveSequence(8, 5, 30, 6)).toBe("");
	});

	it("never emits Alt+Arrow (plain CSI only) so tmux pane-switch is untouched", () => {
		const seq = buildCursorMoveSequence(1, 1, 4, 1);
		// Plain CSI C/D, not the M-Left/Right \x1b\x1b[ or \x1b[1;3 forms.
		expect(seq).toBe(RIGHT.repeat(3));
		expect(seq).not.toContain("\x1b\x1b");
		expect(seq).not.toContain(";3");
	});

	it("scales the move by the exact column delta (one arrow per column)", () => {
		expect(buildCursorMoveSequence(1, 7, 101, 7)).toBe(RIGHT.repeat(100));
		expect(buildCursorMoveSequence(1, 7, 101, 7).length).toBe(100 * RIGHT.length);
	});
});

describe("clearStaleSelectionOnWrite", () => {
	function makeTerm(over: {
		alt: boolean;
		hasSelection: boolean;
		mouseTracking?: boolean;
	}) {
		const clearSelection = vi.fn();
		return {
			term: {
				isAlternateScreen: vi.fn(() => over.alt),
				hasMouseTracking: vi.fn(() => over.mouseTracking ?? false),
				hasSelection: vi.fn(() => over.hasSelection),
				clearSelection,
			},
			clearSelection,
		};
	}

	// Repro: the floating-selection bug. On the alternate screen a TUI repaints
	// the same cells, so a selection made over them must be dropped on write.
	it("clears the selection on alt-screen when one exists", () => {
		const { term, clearSelection } = makeTerm({ alt: true, hasSelection: true });
		clearStaleSelectionOnWrite(term);
		expect(clearSelection).toHaveBeenCalledTimes(1);
	});

	// Repro: the decision-077 regression. Claude Code renders inline on the
	// PRIMARY screen (alt:false) with mouse tracking on and repaints the same
	// rows in place, so a selection over it goes stale and must be dropped too.
	it("clears the selection on the primary screen when mouse tracking is on", () => {
		const { term, clearSelection } = makeTerm({
			alt: false,
			hasSelection: true,
			mouseTracking: true,
		});
		clearStaleSelectionOnWrite(term);
		expect(clearSelection).toHaveBeenCalledTimes(1);
	});

	it("does NOT clear selection on the primary screen without mouse tracking (scrollback stays anchored)", () => {
		const { term, clearSelection } = makeTerm({ alt: false, hasSelection: true });
		clearStaleSelectionOnWrite(term);
		expect(clearSelection).not.toHaveBeenCalled();
	});

	it("does nothing on alt-screen when there is no selection", () => {
		const { term, clearSelection } = makeTerm({ alt: true, hasSelection: false });
		clearStaleSelectionOnWrite(term);
		expect(clearSelection).not.toHaveBeenCalled();
	});

	it("does nothing with mouse tracking on but no selection", () => {
		const { term, clearSelection } = makeTerm({
			alt: false,
			hasSelection: false,
			mouseTracking: true,
		});
		clearStaleSelectionOnWrite(term);
		expect(clearSelection).not.toHaveBeenCalled();
	});

	it("never throws if the terminal is disposed / lacks the APIs", () => {
		expect(() => clearStaleSelectionOnWrite({})).not.toThrow();
		const throwing = {
			isAlternateScreen: () => {
				throw new Error("disposed");
			},
		};
		expect(() => clearStaleSelectionOnWrite(throwing)).not.toThrow();
	});
});

/**
 * Native backend: the PTY socket carries framed messages with a watermark, so a
 * reconnect resumes instead of rebuilding, and the writer/observer role reaches
 * the UI. A tmux session must be completely unaffected by all of it.
 */
describe("TerminalView – native stream framing", () => {
	const PTY_URL = "ws://localhost:1234/pty?session=t1";

	async function renderNative(onNativeStatus?: (status: { role: NativeStreamRole; refused: boolean }) => void) {
		await act(async () => {
			render(
				<I18nProvider>
					<TerminalView ptyUrl={PTY_URL} taskId="t1" projectId="p1" onNativeStatus={onNativeStatus} />
				</I18nProvider>,
			);
			await Promise.resolve();
			await Promise.resolve();
		});
		await act(async () => {
			fireResize?.();
		});
	}

	function deliver(text: string) {
		act(() => {
			lastWebSocket?.onmessage?.({ data: text } as MessageEvent);
		});
	}

	function frame(header: Record<string, unknown>, payload = ""): string {
		return `\x1b_dev3nt;${JSON.stringify({ v: 1, ...header })}\x1b\\${payload}`;
	}

	it("connects without a watermark and resumes from one after a drop", async () => {
		const onNativeStatus = vi.fn();
		await renderNative(onNativeStatus);
		expect(webSockets[0].url).toBe(PTY_URL);

		deliver(frame({
			t: "attach",
			seq: 4,
			role: "writer",
			sessionId: "dev3-task-t1",
			paneId: "dev3-task-t1:0",
			hostPid: 1,
			shellPid: 2,
			resumed: false,
			reset: "fresh",
		}, "screen"));
		deliver(frame({ t: "o", seq: 9 }, "live"));

		await act(async () => {
			webSockets[0].readyState = WebSocket.CLOSED;
			webSockets[0].onclose?.({ code: 1006, reason: "network gone", wasClean: false } as CloseEvent);
			document.dispatchEvent(new Event("visibilitychange"));
		});

		expect(webSockets).toHaveLength(2);
		expect(webSockets[1].url).toBe(`${PTY_URL}&since=9`);
	});

	it("replaces the screen in one write when the server rebuilt it", async () => {
		await renderNative();
		mockTermInstance.write.mockClear();

		deliver(frame({
			t: "attach",
			seq: 2,
			role: "writer",
			sessionId: "s",
			paneId: "s:0",
			hostPid: 1,
			shellPid: 2,
			resumed: false,
			reset: "pressure",
		}, "rebuilt"));

		expect(mockTermInstance.write).toHaveBeenCalledWith("\x1bcrebuilt");
	});

	it("appends a resumed delta without resetting the screen", async () => {
		await renderNative();
		mockTermInstance.write.mockClear();

		deliver(frame({
			t: "attach",
			seq: 3,
			role: "writer",
			sessionId: "s",
			paneId: "s:0",
			hostPid: 1,
			shellPid: 2,
			resumed: true,
		}, "delta"));

		expect(mockTermInstance.write).toHaveBeenCalledWith("delta");
	});

	it("reports the role, and a refusal, to the surrounding UI", async () => {
		const onNativeStatus = vi.fn();
		await renderNative(onNativeStatus);

		deliver(frame({
			t: "attach",
			seq: 0,
			role: "observer",
			sessionId: "s",
			paneId: "s:0",
			hostPid: 1,
			shellPid: 2,
			resumed: true,
		}));
		expect(onNativeStatus).toHaveBeenCalledWith({ role: "observer", refused: false });

		deliver(frame({ t: "role", role: "observer", refused: true }));
		expect(onNativeStatus).toHaveBeenLastCalledWith({ role: "observer", refused: true });

		deliver(frame({ t: "role", role: "writer" }));
		expect(onNativeStatus).toHaveBeenLastCalledWith({ role: "writer", refused: false });
	});

	// An observer does not own the PTY. Reflowing the writer's bytes to its own
	// container width wraps every long line in the wrong place — the garbled
	// bottom rows a second window actually showed.
	it("renders an observer at the PTY's geometry, not its own container's", async () => {
		await renderNative();
		mockTermInstance.resize.mockClear();

		deliver(frame({
			t: "attach", seq: 1, role: "observer", sessionId: "s", paneId: "s:0",
			hostPid: 1, shellPid: 2, resumed: true, cols: 200, rows: 50,
		}));

		expect(mockTermInstance.resize).toHaveBeenCalledWith(200, 50);
	});

	it("follows the writer when it reshapes the PTY mid-session", async () => {
		await renderNative();
		deliver(frame({
			t: "attach", seq: 1, role: "observer", sessionId: "s", paneId: "s:0",
			hostPid: 1, shellPid: 2, resumed: true, cols: 200, rows: 50,
		}));
		mockTermInstance.resize.mockClear();

		deliver(frame({ t: "role", role: "observer", cols: 120, rows: 30 }));

		expect(mockTermInstance.resize).toHaveBeenCalledWith(120, 30);
	});

	it("goes back to fitting its own container once it becomes the writer", async () => {
		await renderNative();
		deliver(frame({
			t: "attach", seq: 1, role: "observer", sessionId: "s", paneId: "s:0",
			hostPid: 1, shellPid: 2, resumed: true, cols: 200, rows: 50,
		}));
		fitAddonHolder.current!.proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
		mockTermInstance.resize.mockClear();

		deliver(frame({ t: "role", role: "writer", cols: 200, rows: 50 }));

		expect(mockTermInstance.resize).toHaveBeenCalledWith(80, 24);
	});

	it("keeps a writer on its own container even when told the PTY geometry", async () => {
		await renderNative();
		fitAddonHolder.current!.proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
		mockTermInstance.resize.mockClear();

		deliver(frame({
			t: "attach", seq: 1, role: "writer", sessionId: "s", paneId: "s:0",
			hostPid: 1, shellPid: 2, resumed: true, cols: 200, rows: 50,
		}));

		expect(mockTermInstance.resize).not.toHaveBeenCalledWith(200, 50);
	});

	it("sends a claim through the handle so a viewer can take over", async () => {
		let handle: TerminalHandle | null = null;
		await act(async () => {
			render(
				<I18nProvider>
					<TerminalView ptyUrl={PTY_URL} taskId="t1" projectId="p1" onReady={(h) => { handle = h; }} />
				</I18nProvider>,
			);
			await Promise.resolve();
			await Promise.resolve();
		});
		await act(async () => {
			fireResize?.();
		});

		handle!.claimWriter();

		expect(lastWebSocket?.send).toHaveBeenCalledWith(`\x1b_dev3nt;${JSON.stringify({ t: "claim", v: 1 })}\x1b\\`);
	});

	it("leaves a tmux session's plain text and reconnect URL untouched", async () => {
		const onNativeStatus = vi.fn();
		await renderNative(onNativeStatus);
		mockTermInstance.write.mockClear();

		deliver("$ ls -la\r\n");

		expect(mockTermInstance.write).toHaveBeenCalledWith("$ ls -la\r\n");
		expect(onNativeStatus).not.toHaveBeenCalled();

		await act(async () => {
			webSockets[0].readyState = WebSocket.CLOSED;
			webSockets[0].onclose?.({ code: 1006, reason: "gone", wasClean: false } as CloseEvent);
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(webSockets[1].url).toBe(PTY_URL);
	});
});

describe("TerminalView – right-to-left reordering (beta flag)", () => {
	afterEach(() => {
		uninstallBidiRender(mockTermInstance.renderer);
		resetTerminalBidiForTests();
	});

	it("leaves the vendor renderer alone when the flag is off", async () => {
		await renderAndSetup();
		expect(isBidiRenderInstalled(mockTermInstance.renderer)).toBe(false);
	});

	it("installs the visual-order view when the flag is already on at mount", async () => {
		syncTerminalBidiFromGlobalSettings({ experimentalTerminalBidi: true });
		await renderAndSetup();
		expect(isBidiRenderInstalled(mockTermInstance.renderer)).toBe(true);
	});

	it("installs and removes it live, repainting every row each time", async () => {
		await renderAndSetup();
		// Installing replaces the property, so use the vendor's own spy.
		const vendorRender = mockVendorRender;
		vendorRender.mockClear();

		await act(async () => {
			syncTerminalBidiFromGlobalSettings({ experimentalTerminalBidi: true });
		});
		expect(isBidiRenderInstalled(mockTermInstance.renderer)).toBe(true);
		// forceAll = true so already-printed output flips without reopening the task;
		// opacity 0 keeps the scrollbar from flashing on a forced frame.
		expect(vendorRender).toHaveBeenCalledTimes(1);
		expect(vendorRender.mock.calls[0].slice(1)).toEqual([true, 0, expect.anything(), 0]);
		// What it received is the visual-order view: `beginFrame` is the bidi view's
		// own marker. Plain identity against wasmTerm no longer separates the two —
		// the cursor-visibility gate also hands the vendor a pass-through view while
		// the terminal is unfocused, which it is in a test with no real focus.
		expect(vendorRender.mock.calls[0][0]).toHaveProperty("beginFrame");

		await act(async () => {
			syncTerminalBidiFromGlobalSettings({ experimentalTerminalBidi: false });
		});
		expect(isBidiRenderInstalled(mockTermInstance.renderer)).toBe(false);
		expect(vendorRender).toHaveBeenCalledTimes(2);
		expect(vendorRender.mock.calls[1][0]).not.toHaveProperty("beginFrame");
	});
});

describe("TerminalView – cleanup markers are durable", () => {
	it("emits both cleanup markers at a level the production logger keeps", async () => {
		vi.mocked(api.request.logRendererDiagnostic).mockClear();
		const view = render(
			<I18nProvider>
				<TerminalView ptyUrl="ws://localhost:1234" taskId="t1" projectId="p1" />
			</I18nProvider>,
		);
		await waitFor(() => expect(mockTermInstance.open).toHaveBeenCalled());
		view.unmount();

		const disposeLines = vi
			.mocked(api.request.logRendererDiagnostic)
			.mock.calls.map(([p]) => p)
			.filter((p) => p.tag === "terminal-dispose");
		const started = disposeLines.find((p) => p.message === "cleanup started");
		const finished = disposeLines.find((p) => p.message === "cleanup finished");
		expect(started).toBeDefined();
		expect(finished).toBeDefined();
		// debug is dropped below the prod/staging/canary minimum of info, so a marker
		// at debug would not be durable at all.
		expect(started!.level).toBe("info");
		expect(finished!.level).toBe("info");
		expect(finished!.extra).toHaveProperty("disposeMs");
	});
});

describe("TerminalView – diagnostics must never break cleanup", () => {
	it("runs every disposer even when the diagnostic sink throws synchronously", async () => {
		// The cleanup emits its "started" marker FIRST, so a synchronous throw there
		// used to abort the terminal, socket and listener teardown behind it (seq 1407).
		// Scoped to the cleanup marker: throwing for every tag would also break setup,
		// and the seam under test is the one cleanup reaches first.
		vi.mocked(api.request.logRendererDiagnostic).mockImplementation((params: { tag: string }) => {
			if (params.tag === "terminal-dispose") throw new Error("sink exploded");
			return Promise.resolve();
		});
		mockTermInstance.dispose.mockClear();

		const view = render(
			<I18nProvider>
				<TerminalView ptyUrl="ws://localhost:1234" taskId="t1" projectId="p1" />
			</I18nProvider>,
		);
		await waitFor(() => expect(mockTermInstance.open).toHaveBeenCalled());

		expect(() => view.unmount()).not.toThrow();

		// term.dispose() is the LAST statement in the cleanup, so reaching it proves
		// every disposer between the throwing marker and the end still ran.
		expect(mockTermInstance.dispose).toHaveBeenCalled();
	});
});

// The gate that hides a not-yet-repainted canvas in remote mode. Tests run with
// no `__electrobunWebviewId`, so `isRemote()` is true unless a test sets one.
describe("TerminalView – remote sync gate", () => {
	afterEach(() => {
		delete (window as unknown as Record<string, unknown>).__electrobunWebviewId;
	});

	it("clears the screen the previous terminal instance left behind", async () => {
		await renderAndSetup();
		// ghostty-web hands a new Terminal the old one's screen, so the reset has to
		// land at open — before any socket output can be written on top of it.
		// RIS is the first thing written, before any PTY byte can land on top of it.
		expect(mockTermInstance.write.mock.calls[0][0]).toBe("\x1bc");
	});

	it("covers the canvas until the socket delivers output", async () => {
		const view = await renderAndSetup();
		expect(view.queryByTestId("terminal-sync-gate")).not.toBeNull();

		await act(async () => {
			lastWebSocket?.onmessage?.({ data: "fresh output" } as MessageEvent);
		});

		expect(view.queryByTestId("terminal-sync-gate")).toBeNull();
	});

	it("never arms on the desktop shell, where the redraw is one frame away", async () => {
		(window as unknown as Record<string, unknown>).__electrobunWebviewId = 1;
		const view = await renderAndSetup();
		expect(view.queryByTestId("terminal-sync-gate")).toBeNull();
	});

	it("lifts itself when nothing ever repaints", async () => {
		// Fake timers before the render: the gate's deadline is scheduled during
		// mount, so a timer installed afterwards would never own it.
		vi.useFakeTimers();
		try {
			const view = await renderAndSetup();
			expect(view.queryByTestId("terminal-sync-gate")).not.toBeNull();

			// The PTY connect itself is deferred by a timer, and that socket re-arms the
			// gate — so the deadline only starts once this advance has run the connect.
			await act(async () => { await vi.advanceTimersByTimeAsync(TERMINAL_SYNC_GATE_TIMEOUT_MS); });
			await act(async () => { await vi.advanceTimersByTimeAsync(TERMINAL_SYNC_GATE_TIMEOUT_MS); });

			expect(view.queryByTestId("terminal-sync-gate")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("re-arms for the socket that replaces a backgrounded one", async () => {
		const view = await renderAndSetup();
		await act(async () => {
			lastWebSocket?.onmessage?.({ data: "fresh output" } as MessageEvent);
		});
		expect(view.queryByTestId("terminal-sync-gate")).toBeNull();

		// Returning to a suspended mobile tab reattaches to the screen it left, so
		// the stale-screen window opens again.
		await act(async () => {
			Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
			document.dispatchEvent(new Event("visibilitychange"));
			Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
			document.dispatchEvent(new Event("visibilitychange"));
		});

		expect(view.queryByTestId("terminal-sync-gate")).not.toBeNull();
	});

	it("lifts when the app refuses the session instead of blurring a dead canvas", async () => {
		const view = await renderAndSetup();
		await act(async () => {
			webSockets[0].readyState = WebSocket.CLOSED;
			webSockets[0].onclose?.({ code: 4001, reason: "Unknown session", wasClean: false } as CloseEvent);
		});
		expect(view.queryByTestId("terminal-sync-gate")).toBeNull();
	});
});

describe("TerminalView – renderer crash recovery", () => {
	/**
	 * ghostty-web's render loop reschedules only after a successful render and is
	 * private, so one throw out of `term.resize` blanks the pane for good. These
	 * cover the only cure available from outside: rebuild the terminal.
	 */
	const REFIT_DEBOUNCE_MS = 150;

	/**
	 * TerminalView replaces the addon's `proposeDimensions` with the real
	 * scrollbar-free measurement, which needs live layout metrics and returns
	 * undefined in happy-dom — so a refit would never reach `term.resize`. Put a
	 * fixed geometry back on the very object TerminalView calls.
	 */
	function makeRefitsMeasurable() {
		const addon = fitAddonHolder.current as unknown as { proposeDimensions: () => { cols: number; rows: number } };
		addon.proposeDimensions = () => ({ cols: 80, rows: 24 });
	}

	async function settleObserver() {
		makeRefitsMeasurable();
		await act(async () => {
			fireResize?.();
			await new Promise((resolve) => setTimeout(resolve, REFIT_DEBOUNCE_MS));
		});
	}

	async function crashOnNextRefit(error: Error) {
		// A rebuilt terminal spends its first observer callback on the initial fit
		// (fitAddon.fit(), which never reaches term.resize), so spend that one first.
		await settleObserver();
		mockTermInstance.resize.mockImplementationOnce(() => {
			throw error;
		});
		await settleObserver();
	}

	it("rebuilds the terminal when a resize throws a WASM trap", async () => {
		await renderAndSetup();
		const builtBefore = vi.mocked(Terminal).mock.calls.length;

		await crashOnNextRefit(new Error("RuntimeError: Out of bounds memory access"));

		expect(vi.mocked(Terminal).mock.calls.length).toBeGreaterThan(builtBefore);
	});

	it("rebuilds it for the out-of-range codepoint crash too", async () => {
		await renderAndSetup();
		const builtBefore = vi.mocked(Terminal).mock.calls.length;

		await crashOnNextRefit(new RangeError("Arguments contain a value that is out of range of code points"));

		expect(vi.mocked(Terminal).mock.calls.length).toBeGreaterThan(builtBefore);
	});

	it("reports the crash to the backend log with the geometry it died on", async () => {
		await renderAndSetup();
		vi.mocked(api.request.logRendererDiagnostic).mockClear();

		await crashOnNextRefit(new Error("RuntimeError: Out of bounds memory access"));

		const tags = vi.mocked(api.request.logRendererDiagnostic).mock.calls.map((c) => (c[0] as { tag: string }).tag);
		expect(tags).toContain("refit");
		expect(tags).toContain("terminal-recover");
	});

	it("leaves a healthy terminal alone", async () => {
		await renderAndSetup();
		const builtBefore = vi.mocked(Terminal).mock.calls.length;
		makeRefitsMeasurable();

		await act(async () => {
			fireResize?.();
			await new Promise((resolve) => setTimeout(resolve, REFIT_DEBOUNCE_MS));
		});

		expect(mockTermInstance.resize).toHaveBeenCalled();
		expect(vi.mocked(Terminal).mock.calls.length).toBe(builtBefore);
		expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
	});

	it("stops rebuilding after the budget and offers a window reload instead", async () => {
		await renderAndSetup();

		for (let i = 0; i < 4; i++) {
			await crashOnNextRefit(new Error("RuntimeError: Out of bounds memory access"));
		}
		const builtAfterBudget = vi.mocked(Terminal).mock.calls.length;
		await crashOnNextRefit(new Error("RuntimeError: Out of bounds memory access"));

		expect(vi.mocked(toast.error)).toHaveBeenCalled();
		expect(vi.mocked(Terminal).mock.calls.length).toBe(builtAfterBudget);
	});

	it("earns the budget back after a stretch of health", async () => {
		await renderAndSetup();
		for (let i = 0; i < 4; i++) {
			await crashOnNextRefit(new Error("RuntimeError: Out of bounds memory access"));
		}
		expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);

		const realNow = Date.now;
		Date.now = () => realNow() + 10 * 60_000;
		try {
			const builtBefore = vi.mocked(Terminal).mock.calls.length;
			await crashOnNextRefit(new Error("RuntimeError: Out of bounds memory access"));
			expect(vi.mocked(Terminal).mock.calls.length).toBeGreaterThan(builtBefore);
		} finally {
			Date.now = realNow;
		}
	});
});
