import { render, act, fireEvent, waitFor } from "@testing-library/react";
import TerminalView, { buildResizeDance, buildCursorMoveSequence, clearStaleSelectionOnWrite, normalizePastedText } from "../TerminalView";
import { I18nProvider } from "../i18n";
import { api } from "../rpc";
import { KEYMAP_LS_KEY } from "../terminal-keymaps";

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
	fitAddonHolder,
} = vi.hoisted(() => {
	const mockFocus = vi.fn();
	const mockInput = vi.fn();
	const mockPaste = vi.fn();
	const mockOnDataDispose = vi.fn();
	const mockOnResizeDispose = vi.fn();
	const mockOnSelectionChangeDispose = vi.fn();
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
		},
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
			tmuxAction: vi.fn(),
			tmuxAltClickMoveCursor: vi.fn().mockResolvedValue({ moved: true }),
			exitCopyModeAllPanes: vi.fn().mockResolvedValue({ panesExited: 1 }),
			logRendererEvent: vi.fn().mockResolvedValue(undefined),
			copyTerminalSelection: vi.fn().mockResolvedValue({ ok: true, tool: "pbcopy" }),
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

	constructor() {
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

const mockedTmuxAction = vi.mocked(api.request.tmuxAction);
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

describe("TerminalView – keymap shortcuts", () => {
	beforeEach(() => {
		localStorage.clear();
		mockedTmuxAction.mockClear();
		mockedTmuxAction.mockResolvedValue(undefined as any);
		mockedUploadFileBase64.mockReset();
		lastWebSocket = null;
	});

	it("iterm2 mode: Cmd+W calls tmuxAction with killPane", async () => {
		localStorage.setItem(KEYMAP_LS_KEY, "iterm2");
		await renderAndSetup();
		const target = focusInsideTerminal();

		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", metaKey: true, bubbles: true }));
		});

		expect(mockedTmuxAction).toHaveBeenCalledWith({ taskId: "t1", action: "killPane" });
		target.remove();
	});

	it("iterm2 mode: Cmd+D (no shift) calls splitV", async () => {
		localStorage.setItem(KEYMAP_LS_KEY, "iterm2");
		await renderAndSetup();
		const target = focusInsideTerminal();

		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD", metaKey: true, shiftKey: false, bubbles: true }));
		});

		expect(mockedTmuxAction).toHaveBeenCalledWith({ taskId: "t1", action: "splitV" });
		target.remove();
	});

	it("iterm2 mode: Shift+Cmd+D calls splitH", async () => {
		localStorage.setItem(KEYMAP_LS_KEY, "iterm2");
		await renderAndSetup();
		const target = focusInsideTerminal();

		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD", metaKey: true, shiftKey: true, bubbles: true }));
		});

		expect(mockedTmuxAction).toHaveBeenCalledWith({ taskId: "t1", action: "splitH" });
		target.remove();
	});

	it("default preset (nothing stored): Cmd+W calls tmuxAction (iTerm2 is the default)", async () => {
		// No localStorage entry — iTerm2 hotkeys ship on by default.
		await renderAndSetup();
		const target = focusInsideTerminal();

		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", metaKey: true, bubbles: true }));
		});

		expect(mockedTmuxAction).toHaveBeenCalledWith({ taskId: "t1", action: "killPane" });
		target.remove();
	});

	it("default mode (explicit opt-out): Cmd+W does NOT call tmuxAction", async () => {
		localStorage.setItem(KEYMAP_LS_KEY, "default");
		await renderAndSetup();
		const target = focusInsideTerminal();

		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", metaKey: true, bubbles: true }));
		});

		expect(mockedTmuxAction).not.toHaveBeenCalled();
		target.remove();
	});

	it("tmux-native mode: Cmd+W does NOT call tmuxAction", async () => {
		localStorage.setItem(KEYMAP_LS_KEY, "tmux-native");
		await renderAndSetup();
		const target = focusInsideTerminal();

		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", metaKey: true, bubbles: true }));
		});

		expect(mockedTmuxAction).not.toHaveBeenCalled();
		target.remove();
	});

	it("does NOT fire when terminal container does not have focus", async () => {
		localStorage.setItem(KEYMAP_LS_KEY, "iterm2");
		await renderAndSetup();
		// Do NOT focus inside the container — activeElement remains document.body

		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", metaKey: true, bubbles: true }));
		});

		expect(mockedTmuxAction).not.toHaveBeenCalled();
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
) {
	const event = new Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "clipboardData", {
		value: {
			getData: (type: string) => (type === "text/plain" ? text : ""),
			items,
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
