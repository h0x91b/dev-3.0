import { act, renderHook } from "@testing-library/react";
import { useTerminalPreview } from "../useTerminalPreview";

vi.mock("../../utils/ansi-to-html", () => ({ ansiToHtml: (s: string) => s }));

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getTerminalPreview: vi.fn().mockResolvedValue("hello"),
		},
	},
}));

import { api } from "../../rpc";

const mockedApi = vi.mocked(api, true);

function makeAnchor() {
	const el = document.createElement("div");
	document.body.appendChild(el);
	return el;
}

describe("useTerminalPreview — drag-and-drop interaction", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		document.body.innerHTML = "";
	});

	it("blocks new previews while a drag is in progress", async () => {
		const { result } = renderHook(() => useTerminalPreview());
		const anchor = makeAnchor();

		act(() => {
			window.dispatchEvent(new Event("dragstart"));
		});

		act(() => {
			result.current.handlers.onMouseEnter("task-1", anchor);
		});

		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});

		expect(result.current.state.open).toBe(false);
		expect(mockedApi.request.getTerminalPreview).not.toHaveBeenCalled();
	});

	it("closes an open preview immediately on dragstart", async () => {
		const { result } = renderHook(() => useTerminalPreview());
		const anchor = makeAnchor();

		act(() => {
			result.current.handlers.onMouseEnter("task-1", anchor);
		});

		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});

		expect(result.current.state.open).toBe(true);

		act(() => {
			window.dispatchEvent(new Event("dragstart"));
		});

		expect(result.current.state.open).toBe(false);
		expect(result.current.state.activeTaskId).toBeNull();
	});

	it("re-enables previews after dragend", async () => {
		const { result } = renderHook(() => useTerminalPreview());
		const anchor = makeAnchor();

		act(() => {
			window.dispatchEvent(new Event("dragstart"));
		});
		act(() => {
			window.dispatchEvent(new Event("dragend"));
		});

		act(() => {
			result.current.handlers.onMouseEnter("task-1", anchor);
		});

		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});

		expect(result.current.state.open).toBe(true);
		expect(result.current.state.activeTaskId).toBe("task-1");
	});
});

describe("useTerminalPreview — narrow/mobile viewport", () => {
	const originalInnerWidth = window.innerWidth;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		document.body.innerHTML = "";
		Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
	});

	it("does not open a hover preview when the viewport is narrow (carousel mode)", async () => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
		const { result } = renderHook(() => useTerminalPreview());
		const anchor = makeAnchor();

		act(() => {
			result.current.handlers.onMouseEnter("task-1", anchor);
		});

		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});

		expect(result.current.state.open).toBe(false);
		expect(mockedApi.request.getTerminalPreview).not.toHaveBeenCalled();
	});
});

describe("useTerminalPreview — poll lifecycle", () => {
	const get = mockedApi.request.getTerminalPreview;
	const advance = (ms: number) =>
		act(async () => {
			await vi.advanceTimersByTimeAsync(ms);
		});

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		get.mockImplementation(async ({ taskId }: { taskId: string }) => `screen-${taskId}`);
	});

	afterEach(() => {
		vi.useRealTimers();
		document.body.innerHTML = "";
	});

	it("re-entering the same card keeps a single poll and close stops it", async () => {
		const { result } = renderHook(() => useTerminalPreview());
		const anchor = makeAnchor();
		act(() => result.current.handlers.onMouseEnter("t1", anchor));
		await advance(500);
		act(() => result.current.handlers.onMouseLeave());
		act(() => result.current.handlers.onMouseEnter("t1", anchor));
		await advance(500);
		get.mockClear();
		await advance(3000);
		expect(get).toHaveBeenCalledTimes(3);
		act(() => result.current.close());
		get.mockClear();
		await advance(3000);
		expect(get).not.toHaveBeenCalled();
	});

	it("re-entering the same card does not flash the loading state", async () => {
		const { result } = renderHook(() => useTerminalPreview());
		const anchor = makeAnchor();
		act(() => result.current.handlers.onMouseEnter("t1", anchor));
		await advance(500);
		act(() => result.current.handlers.onMouseLeave());
		get.mockImplementationOnce(() => new Promise<string>(() => {}));
		act(() => result.current.handlers.onMouseEnter("t1", anchor));
		await advance(400);
		expect(result.current.state.loading).toBe(false);
	});

	it("a double scheduleClose does not orphan a timer that closes after a quick return", async () => {
		const { result } = renderHook(() => useTerminalPreview());
		const anchor = makeAnchor();
		act(() => result.current.handlers.onMouseEnter("t1", anchor));
		await advance(500);
		act(() => {
			result.current.state.scheduleClose();
			result.current.handlers.onMouseLeave();
		});
		await advance(100);
		act(() => result.current.handlers.onMouseEnter("t1", anchor));
		await advance(500);
		expect(result.current.state.open).toBe(true);
	});

	it("leaving before the open delay and re-entering opens once", async () => {
		const { result } = renderHook(() => useTerminalPreview());
		const anchor = makeAnchor();
		act(() => result.current.handlers.onMouseEnter("t1", anchor));
		await advance(200);
		act(() => result.current.handlers.onMouseLeave());
		act(() => result.current.handlers.onMouseEnter("t1", anchor));
		await advance(500);
		expect(result.current.state.open).toBe(true);
		expect(get).toHaveBeenCalledTimes(1);
	});

	it("the same task on a different anchor restarts the preview", async () => {
		const { result } = renderHook(() => useTerminalPreview());
		act(() => result.current.handlers.onMouseEnter("t1", makeAnchor()));
		await advance(500);
		get.mockClear();
		act(() => result.current.handlers.onMouseEnter("t1", makeAnchor()));
		await advance(500);
		expect(result.current.state.open).toBe(true);
		expect(get).toHaveBeenCalledTimes(1);
	});

	it("leaving while the first capture is in flight writes no state and stops polling", async () => {
		let resolveFirst: (v: string) => void = () => {};
		get.mockImplementationOnce(() => new Promise<string>((r) => { resolveFirst = r; }));
		const { result } = renderHook(() => useTerminalPreview());
		act(() => result.current.handlers.onMouseEnter("t1", makeAnchor()));
		await advance(500);
		act(() => result.current.handlers.onMouseLeave());
		await advance(300);
		expect(result.current.state.open).toBe(false);
		await act(async () => resolveFirst("late"));
		expect(result.current.state.html).toBeNull();
		expect(result.current.state.open).toBe(false);
		get.mockClear();
		await advance(3000);
		expect(get).not.toHaveBeenCalled();
	});

	it("switching A to B while A's first capture is in flight never shows A in B and polls only B", async () => {
		let resolveA: (v: string) => void = () => {};
		get.mockImplementationOnce(() => new Promise<string>((r) => { resolveA = r; }));
		const { result } = renderHook(() => useTerminalPreview());
		act(() => result.current.handlers.onMouseEnter("A", makeAnchor()));
		await advance(500);
		act(() => result.current.handlers.onMouseEnter("B", makeAnchor()));
		await advance(500);
		await act(async () => resolveA("screen-A"));
		expect(result.current.state.activeTaskId).toBe("B");
		expect(result.current.state.html).toBe("screen-B");
		get.mockClear();
		await advance(3000);
		expect(get).toHaveBeenCalledTimes(3);
		expect(get.mock.calls.every(([arg]) => arg.taskId === "B")).toBe(true);
		expect(result.current.state.html).toBe("screen-B");
	});

	it("does not start a second capture until the slow one resolved", async () => {
		let resolveSlow: (v: string) => void = () => {};
		const { result } = renderHook(() => useTerminalPreview());
		act(() => result.current.handlers.onMouseEnter("t1", makeAnchor()));
		await advance(500);
		get.mockClear();
		get.mockImplementationOnce(() => new Promise<string>((r) => { resolveSlow = r; }));
		await advance(1000);
		expect(get).toHaveBeenCalledTimes(1);
		await advance(3500);
		expect(get).toHaveBeenCalledTimes(1);
		await act(async () => resolveSlow("slow"));
		await advance(1000);
		expect(get).toHaveBeenCalledTimes(2);
	});
});

describe("useTerminalPreview - portaled children", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		document.body.innerHTML = "";
	});

	it("ignores a mouseenter whose target sits outside the anchor (context menu portal)", async () => {
		const { result } = renderHook(() => useTerminalPreview());
		const anchor = makeAnchor();
		const menuItem = makeAnchor();
		act(() => result.current.handlers.onMouseEnter("task-1", anchor, menuItem));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});
		expect(result.current.state.open).toBe(false);
		expect(mockedApi.request.getTerminalPreview).not.toHaveBeenCalled();
	});

	it("opens when the target is inside the anchor", async () => {
		const { result } = renderHook(() => useTerminalPreview());
		const anchor = makeAnchor();
		const child = document.createElement("span");
		anchor.appendChild(child);
		act(() => result.current.handlers.onMouseEnter("task-1", anchor, child));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});
		expect(result.current.state.open).toBe(true);
	});

	it("does not open while a menu is open elsewhere (menu covering a neighbouring row)", async () => {
		const { result } = renderHook(() => useTerminalPreview());
		const menu = makeAnchor();
		menu.setAttribute("role", "menu");
		const anchor = makeAnchor();
		act(() => result.current.handlers.onMouseEnter("task-2", anchor, anchor));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});
		expect(result.current.state.open).toBe(false);
		expect(mockedApi.request.getTerminalPreview).not.toHaveBeenCalled();
	});

	it("drops a pending open when a menu appears during the open delay", async () => {
		const { result } = renderHook(() => useTerminalPreview());
		const anchor = makeAnchor();
		act(() => result.current.handlers.onMouseEnter("task-1", anchor, anchor));
		makeAnchor().setAttribute("role", "menu");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});
		expect(result.current.state.open).toBe(false);
		expect(mockedApi.request.getTerminalPreview).not.toHaveBeenCalled();
	});
});
