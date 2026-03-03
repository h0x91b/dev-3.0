import { render, act } from "@testing-library/react";

// ─── Hoisted mock state shared between mock factories and tests ─────
const m = vi.hoisted(() => ({
	term: null as any,
	fitAddon: null as any,
	onDataCb: null as ((data: string) => void) | null,
	onResizeCb: null as ((dims: { cols: number; rows: number }) => void) | null,
	ws: null as any,
	roCallback: null as ((entries: any[]) => void) | null,
}));

// ─── ghostty-web mock ───────────────────────────────────────────────
vi.mock("ghostty-web", () => ({
	Terminal: vi.fn().mockImplementation(function () {
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
	}),
	FitAddon: vi.fn().mockImplementation(function () {
		m.fitAddon = {
			fit: vi.fn(),
			dispose: vi.fn(),
			observeResize: vi.fn(),
			proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
		};
		return m.fitAddon;
	}),
}));

// ─── rpc mock ───────────────────────────────────────────────────────
vi.mock("../rpc", () => ({
	api: { request: { resolveFilename: vi.fn() } },
}));

// ─── ResizeObserver mock ────────────────────────────────────────────
class MockResizeObserver {
	constructor(cb: any) {
		m.roCallback = cb;
	}
	observe = vi.fn();
	disconnect = vi.fn();
	unobserve = vi.fn();
}

// ─── Global setup ───────────────────────────────────────────────────
const savedRO = globalThis.ResizeObserver;

beforeAll(() => {
	(globalThis as any).ResizeObserver = MockResizeObserver;
	Object.defineProperty(document, "fonts", {
		value: { load: vi.fn() },
		configurable: true,
		writable: true,
	});
});

afterAll(() => {
	(globalThis as any).ResizeObserver = savedRO;
});

// ─── Component under test ───────────────────────────────────────────
import TerminalView from "../TerminalView";

// ─── Helpers ────────────────────────────────────────────────────────
const PROPS = {
	ptyUrl: "ws://localhost:9999/pty",
	taskId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
};

function mockFontsLoad() {
	(document.fonts.load as ReturnType<typeof vi.fn>).mockResolvedValue([]);
}

// ─── Tests ──────────────────────────────────────────────────────────
describe("TerminalView", () => {
	beforeEach(() => {
		Object.assign(m, {
			term: null,
			fitAddon: null,
			onDataCb: null,
			onResizeCb: null,
			ws: null,
			roCallback: null,
		});
		document.documentElement.dataset.theme = "dark";
	});

	// ── Rendering ────────────────────────────────────────────────
	describe("rendering", () => {
		it("renders container with data-terminal attribute", () => {
			mockFontsLoad();
			const { container } = render(<TerminalView {...PROPS} />);
			const el = container.querySelector("[data-terminal]");
			expect(el).toBeInTheDocument();
			expect(el).toHaveClass("w-full", "h-full");
		});

		it("applies dark theme background by default", () => {
			mockFontsLoad();
			const { container } = render(<TerminalView {...PROPS} />);
			const el = container.querySelector(
				"[data-terminal]",
			) as HTMLElement;
			expect(el.style.backgroundColor).toBe("#1a1b26");
		});

		it("applies light theme background", () => {
			document.documentElement.dataset.theme = "light";
			mockFontsLoad();
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
			mockFontsLoad();
			render(<TerminalView {...PROPS} />);
			expect(document.fonts.load).toHaveBeenCalledWith(
				expect.stringContaining("14px"),
			);
		});

		it("creates Terminal with correct options", async () => {
			mockFontsLoad();
			render(<TerminalView {...PROPS} />);
			await act(async () => {});
			const { Terminal } = await import("ghostty-web");
			expect(Terminal).toHaveBeenCalledWith(
				expect.objectContaining({
					fontSize: 14,
					cursorBlink: true,
					cursorStyle: "bar",
				}),
			);
		});

		it("uses dark theme in Terminal config by default", async () => {
			mockFontsLoad();
			render(<TerminalView {...PROPS} />);
			await act(async () => {});
			const { Terminal } = await import("ghostty-web");
			expect(Terminal).toHaveBeenCalledWith(
				expect.objectContaining({
					theme: expect.objectContaining({ background: "#1a1b26" }),
				}),
			);
		});

		it("uses light theme in Terminal config when theme is light", async () => {
			document.documentElement.dataset.theme = "light";
			mockFontsLoad();
			render(<TerminalView {...PROPS} />);
			await act(async () => {});
			const { Terminal } = await import("ghostty-web");
			expect(Terminal).toHaveBeenCalledWith(
				expect.objectContaining({
					theme: expect.objectContaining({ background: "#ffffff" }),
				}),
			);
		});

		it("still initializes when font preload fails", async () => {
			(document.fonts.load as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error("font fail"),
			);
			render(<TerminalView {...PROPS} />);
			await act(async () => {});

			const { Terminal } = await import("ghostty-web");
			expect(Terminal).toHaveBeenCalled();
		});

		it("does not init if unmounted before font preload resolves", async () => {
			let resolve!: (v: any) => void;
			(document.fonts.load as ReturnType<typeof vi.fn>).mockReturnValue(
				new Promise((r) => {
					resolve = r;
				}),
			);

			const { Terminal } = await import("ghostty-web");
			(Terminal as ReturnType<typeof vi.fn>).mockClear();

			const result = render(<TerminalView {...PROPS} />);
			result.unmount();
			await act(async () => {
				resolve([]);
			});

			expect(Terminal).not.toHaveBeenCalled();
		});
	});

	// ── Drag & drop (dragover only — no init needed) ────────────
	describe("drag and drop", () => {
		it("prevents default on dragover", () => {
			mockFontsLoad();
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
