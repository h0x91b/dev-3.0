import { act, renderHook } from "@testing-library/react";
import { useTerminalPreview } from "../useTerminalPreview";

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
