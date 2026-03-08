import { render, act } from "@testing-library/react";
import TerminalView from "../TerminalView";
import { api } from "../rpc";
import { KEYMAP_LS_KEY } from "../terminal-keymaps";

// ── Hoisted mocks (must be before vi.mock factories) ─────────────────────────

const { mockFocus, mockInput, mockTermInstance } = vi.hoisted(() => {
	const mockFocus = vi.fn();
	const mockInput = vi.fn();
	// Plain object — avoids document.createElement at hoist time
	const mockCanvas = {
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
	};
	const mockTermInstance = {
		loadAddon: vi.fn(),
		open: vi.fn(),
		focus: mockFocus,
		input: mockInput,
		onData: vi.fn(),
		onResize: vi.fn(),
		attachCustomKeyEventHandler: vi.fn(),
		attachCustomWheelEventHandler: vi.fn(),
		hasMouseTracking: vi.fn(() => false),
		renderer: {
			getCanvas: () => mockCanvas,
			charWidth: 8,
			charHeight: 16,
			remeasureFont: vi.fn(),
		},
		write: vi.fn(),
		writeln: vi.fn(),
		reset: vi.fn(),
		dispose: vi.fn(),
		cols: 80,
		rows: 24,
		options: {} as Record<string, unknown>,
	};
	return { mockFocus, mockInput, mockCanvas, mockTermInstance };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("ghostty-web", () => ({
	// Must use `function` (not arrow) so vitest allows calling with `new`
	// eslint-disable-next-line prefer-arrow-callback
	Terminal: vi.fn(function MockTerminal() { return mockTermInstance; }),
	// eslint-disable-next-line prefer-arrow-callback
	FitAddon: vi.fn(function MockFitAddon() {
		return {
			fit: vi.fn(),
			observeResize: vi.fn(),
			proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
			dispose: vi.fn(),
		};
	}),
}));

vi.mock("../rpc", () => ({
	api: { request: { resolveFilename: vi.fn(), tmuxAction: vi.fn() } },
}));

vi.mock("../zoom", () => ({
	getZoom: () => 1,
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
class MockWebSocket {
	readyState = 0;
	send = vi.fn();
	close = vi.fn();
	onopen: ((e: Event) => void) | null = null;
	onmessage: ((e: MessageEvent) => void) | null = null;
	onclose: ((e: CloseEvent) => void) | null = null;
	onerror: ((e: Event) => void) | null = null;
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

	// document.fonts.load must resolve immediately so setup() runs in tests
	Object.defineProperty(document, "fonts", {
		configurable: true,
		value: { load: vi.fn().mockReturnValue(Promise.resolve([])) },
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
		result = render(<TerminalView ptyUrl="ws://localhost:1234" taskId="t1" projectId="p1" />);
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

/** Focus a child element inside the terminal container so the keymap guard passes. */
function focusInsideTerminal(): HTMLElement {
	const container = document.querySelector("[data-terminal='true']")!;
	const target = document.createElement("div");
	target.tabIndex = 0;
	container.appendChild(target);
	target.focus();
	return target;
}

describe("TerminalView – keymap shortcuts", () => {
	beforeEach(() => {
		localStorage.clear();
		mockedTmuxAction.mockClear();
		mockedTmuxAction.mockResolvedValue(undefined as any);
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

	it("dev3 mode: Cmd+W does NOT call tmuxAction", async () => {
		// dev3 is the default — no localStorage entry needed
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
