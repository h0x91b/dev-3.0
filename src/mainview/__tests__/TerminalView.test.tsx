import { render, act } from "@testing-library/react";

// ─── Mock module registration (bare vi.fn, no implementations) ──
vi.mock("ghostty-web", () => ({
	Terminal: vi.fn(),
	FitAddon: vi.fn(),
}));

vi.mock("../rpc", () => ({
	api: { request: { resolveFilename: vi.fn() } },
}));

// ─── Imports ────────────────────────────────────────────────────
import TerminalView from "../TerminalView";
import { Terminal, FitAddon } from "ghostty-web";

const MockedTerminal = vi.mocked(Terminal);
const MockedFitAddon = vi.mocked(FitAddon);

// ─── Shared mock state ─────────────────────────────────────────
// Populated by mock implementations in setupMocks(), consumed by tests.
const m = {
	term: null as any,
	fitAddon: null as any,
	onDataCb: null as ((data: string) => void) | null,
	onResizeCb: null as ((dims: { cols: number; rows: number }) => void) | null,
	ws: null as any,
	roCallback: null as ((entries: any[]) => void) | null,
};

// ─── WebSocket mock (class — unaffected by clearAllMocks) ──────
class MockWebSocket {
	static OPEN = 1;
	static CLOSED = 3;
	static CONNECTING = 0;
	static CLOSING = 2;
	url: string;
	readyState = 1;
	send = vi.fn();
	close = vi.fn();
	onopen: ((ev: any) => void) | null = null;
	onmessage: ((ev: any) => void) | null = null;
	onclose: ((ev: any) => void) | null = null;
	onerror: ((ev: any) => void) | null = null;
	constructor(url: string) {
		this.url = url;
		m.ws = this;
	}
}

// ─── ResizeObserver mock (class) ────────────────────────────────
class MockResizeObserver {
	constructor(cb: any) {
		m.roCallback = cb;
	}
	observe = vi.fn();
	disconnect = vi.fn();
	unobserve = vi.fn();
}

// ─── Global overrides (once) ────────────────────────────────────
const savedWS = globalThis.WebSocket;
const savedRO = globalThis.ResizeObserver;

beforeAll(() => {
	(globalThis as any).WebSocket = MockWebSocket;
	(globalThis as any).ResizeObserver = MockResizeObserver;
	// document.fonts must exist for the component
	Object.defineProperty(document, "fonts", {
		value: { load: vi.fn() },
		configurable: true,
		writable: true,
	});
});

afterAll(() => {
	(globalThis as any).WebSocket = savedWS;
	(globalThis as any).ResizeObserver = savedRO;
});

// ─── Re-creates all mock implementations (called every beforeEach) ─
function setupMocks() {
	MockedTerminal.mockImplementation(function (this: any) {
		m.onDataCb = null;
		m.onResizeCb = null;
		m.term = {
			open: vi.fn(),
			loadAddon: vi.fn(),
			write: vi.fn(),
			writeln: vi.fn(),
			focus: vi.fn(),
			dispose: vi.fn(),
			reset: vi.fn(),
			input: vi.fn(),
			cols: 80,
			rows: 24,
			options: {} as any,
			onData: vi.fn((cb: any) => {
				m.onDataCb = cb;
			}),
			onResize: vi.fn((cb: any) => {
				m.onResizeCb = cb;
			}),
			hasMouseTracking: vi.fn(() => false),
			renderer: {
				getCanvas: vi.fn(() => document.createElement("canvas")),
				charWidth: 8,
				charHeight: 16,
				remeasureFont: vi.fn(),
			},
			attachCustomWheelEventHandler: vi.fn(),
		};
		return m.term;
	});

	MockedFitAddon.mockImplementation(function (this: any) {
		m.fitAddon = {
			fit: vi.fn(),
			dispose: vi.fn(),
			observeResize: vi.fn(),
			proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
		};
		return m.fitAddon;
	});

	// Synchronous rAF so the ResizeObserver → rAF → connectPty chain completes inline
	vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(
		(cb) => {
			cb(0);
			return 0;
		},
	);

	// Font preload resolves instantly by default
	(document.fonts as any).load = vi.fn().mockResolvedValue([]);
}

// ─── Helpers ────────────────────────────────────────────────────
const PROPS = {
	ptyUrl: "ws://localhost:9999/pty",
	taskId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
};

/**
 * Full terminal init: render → font preload → setup → layout → connectPty.
 * Returns refs to all major mock objects for assertions.
 */
async function init(props = PROPS) {
	const result = render(<TerminalView {...props} />);

	// Flush font preload promise → setup()
	await act(async () => {});

	// Give container non-zero dimensions (happy-dom returns 0)
	const el = result.container.querySelector(
		"[data-terminal]",
	)! as HTMLElement;
	Object.defineProperty(el, "clientWidth", {
		value: 800,
		configurable: true,
	});
	Object.defineProperty(el, "clientHeight", {
		value: 600,
		configurable: true,
	});

	// Trigger ResizeObserver → rAF (sync) → connectPty → WebSocket created
	await act(async () => {
		m.roCallback?.([{ target: el }]);
	});

	return { result, el, ws: m.ws! as MockWebSocket };
}

// ─── Tests ──────────────────────────────────────────────────────
describe("TerminalView", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		Object.assign(m, {
			term: null,
			fitAddon: null,
			onDataCb: null,
			onResizeCb: null,
			ws: null,
			roCallback: null,
		});
		setupMocks();
		document.documentElement.dataset.theme = "dark";
	});

	// ── Rendering ────────────────────────────────────────────────
	describe("rendering", () => {
		it("renders container with data-terminal attribute", () => {
			const { container } = render(<TerminalView {...PROPS} />);
			const el = container.querySelector("[data-terminal]");
			expect(el).toBeInTheDocument();
			expect(el).toHaveClass("w-full", "h-full");
		});

		it("applies dark theme background by default", () => {
			const { container } = render(<TerminalView {...PROPS} />);
			const el = container.querySelector(
				"[data-terminal]",
			) as HTMLElement;
			expect(el.style.backgroundColor).toBe("#1a1b26");
		});

		it("applies light theme background", () => {
			document.documentElement.dataset.theme = "light";
			const { container } = render(<TerminalView {...PROPS} />);
			const el = container.querySelector(
				"[data-terminal]",
			) as HTMLElement;
			expect(el.style.backgroundColor).toBe("#ffffff");
		});
	});

	// ── Initialization ──────────────────────────────────────────
	describe("initialization", () => {
		it("preloads font before creating Terminal", () => {
			render(<TerminalView {...PROPS} />);
			expect(document.fonts.load).toHaveBeenCalledWith(
				expect.stringContaining("14px"),
			);
		});

		it("creates Terminal with correct options", async () => {
			render(<TerminalView {...PROPS} />);
			await act(async () => {});
			expect(MockedTerminal).toHaveBeenCalledWith(
				expect.objectContaining({
					fontSize: 14,
					cursorBlink: true,
					cursorStyle: "bar",
				}),
			);
		});

		it("uses dark theme in Terminal config by default", async () => {
			render(<TerminalView {...PROPS} />);
			await act(async () => {});
			expect(MockedTerminal).toHaveBeenCalledWith(
				expect.objectContaining({
					theme: expect.objectContaining({ background: "#1a1b26" }),
				}),
			);
		});

		it("uses light theme in Terminal config when theme is light", async () => {
			document.documentElement.dataset.theme = "light";
			render(<TerminalView {...PROPS} />);
			await act(async () => {});
			expect(MockedTerminal).toHaveBeenCalledWith(
				expect.objectContaining({
					theme: expect.objectContaining({ background: "#ffffff" }),
				}),
			);
		});

		it("still initializes when font preload fails", async () => {
			(document.fonts as any).load = vi
				.fn()
				.mockRejectedValue(new Error("font fail"));
			render(<TerminalView {...PROPS} />);
			await act(async () => {});
			expect(MockedTerminal).toHaveBeenCalled();
		});

		it("does not init if unmounted before font preload resolves", async () => {
			let resolve!: (v: any) => void;
			(document.fonts as any).load = vi.fn().mockReturnValue(
				new Promise((r) => {
					resolve = r;
				}),
			);

			const result = render(<TerminalView {...PROPS} />);
			result.unmount();
			await act(async () => {
				resolve([]);
			});

			expect(MockedTerminal).not.toHaveBeenCalled();
		});
	});

	// ── Full init (proves init() helper works after clearAllMocks) ──
	describe("full initialization via init()", () => {
		it("creates WebSocket with correct ptyUrl", async () => {
			const { ws } = await init();
			expect(ws.url).toBe("ws://localhost:9999/pty");
		});

		it("loads FitAddon into Terminal", async () => {
			await init();
			expect(m.term.loadAddon).toHaveBeenCalledWith(m.fitAddon);
		});

		it("opens Terminal in the container DOM element", async () => {
			await init();
			expect(m.term.open).toHaveBeenCalledWith(
				expect.any(HTMLElement),
			);
		});

		it("fits terminal and observes resize after layout", async () => {
			await init();
			expect(m.fitAddon.fit).toHaveBeenCalled();
			expect(m.fitAddon.observeResize).toHaveBeenCalled();
		});

		it("focuses terminal after setup", async () => {
			await init();
			expect(m.term.focus).toHaveBeenCalled();
		});
	});

	// ── Drag & drop (dragover — no full init needed) ────────────
	describe("drag and drop", () => {
		it("prevents default on dragover", () => {
			const { container } = render(<TerminalView {...PROPS} />);
			const el = container.querySelector(
				"[data-terminal]",
			) as HTMLElement;
			const event = new Event("dragover", {
				bubbles: true,
				cancelable: true,
			});
			el.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(true);
		});
	});
});
