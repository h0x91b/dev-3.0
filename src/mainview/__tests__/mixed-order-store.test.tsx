import { act, renderHook } from "@testing-library/react";
import { _resetMixedOrderStore, commitMixedOrder, useMixedPending, withPendingMixedOrder } from "../mixed-order-store";
import type { SpacesFile } from "../../shared/types";

vi.mock("../rpc", () => ({
	api: { request: { reorderMixedOrder: vi.fn() } },
}));
vi.mock("../toast", () => ({ toast: { error: vi.fn() } }));

import { api } from "../rpc";
import { toast } from "../toast";

const write = vi.mocked(api.request.reorderMixedOrder);
const file = (mixedOrder?: string[]): SpacesFile => ({ version: 1, spaces: [], order: [], ...(mixedOrder ? { mixedOrder } : {}) });

/** One write the test settles by hand, in any order. */
function deferred() {
	let resolve!: (value: SpacesFile) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<SpacesFile>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flush() {
	await act(async () => {
		await Promise.resolve();
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	_resetMixedOrderStore();
});

describe("mixed order store", () => {
	it("shows a move at once and retires it when its own write comes back", async () => {
		const first = deferred();
		write.mockReturnValueOnce(first.promise);
		const { result } = renderHook(() => useMixedPending());
		act(() => commitMixedOrder(["b", "a", "c"]));
		expect(result.current).toEqual(["b", "a", "c"]);
		await act(async () => first.resolve(file(["b", "a", "c"])));
		expect(result.current).toBeNull();
	});

	it("runs one write at a time and coalesces moves made meanwhile into one follow-up", async () => {
		const first = deferred();
		const second = deferred();
		write.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const { result } = renderHook(() => useMixedPending());
		act(() => commitMixedOrder(["b", "a", "c"]));
		act(() => commitMixedOrder(["b", "c", "a"]));
		act(() => commitMixedOrder(["c", "b", "a"]));
		expect(write).toHaveBeenCalledTimes(1);
		await act(async () => first.resolve(file()));
		await flush();
		// The newest order goes out next; the middle one never does.
		expect(write).toHaveBeenCalledTimes(2);
		expect(write).toHaveBeenLastCalledWith({ ids: ["c", "b", "a"] });
		expect(result.current).toEqual(["c", "b", "a"]);
		await act(async () => second.resolve(file(["c", "b", "a"])));
		expect(result.current).toBeNull();
	});

	it("keeps the newest order shown while an older write is still out", async () => {
		const first = deferred();
		write.mockReturnValueOnce(first.promise).mockResolvedValue(file());
		const { result } = renderHook(() => useMixedPending());
		act(() => commitMixedOrder(["b", "a", "c"]));
		act(() => commitMixedOrder(["b", "c", "a"]));
		expect(result.current).toEqual(["b", "c", "a"]);
		await act(async () => first.resolve(file(["b", "a", "c"])));
		await flush();
		expect(write).toHaveBeenLastCalledWith({ ids: ["b", "c", "a"] });
	});

	it("is not retired by an unrelated spaces push", async () => {
		const first = deferred();
		write.mockReturnValueOnce(first.promise);
		const { result } = renderHook(() => useMixedPending());
		act(() => commitMixedOrder(["b", "a", "c"]));
		act(() => {
			window.dispatchEvent(new CustomEvent("rpc:spacesUpdated", { detail: { file: file() } }));
		});
		expect(result.current).toEqual(["b", "a", "c"]);
		await act(async () => first.resolve(file(["b", "a", "c"])));
	});

	it("reverts to the stored order, drops queued moves and toasts when a write fails", async () => {
		const first = deferred();
		write.mockReturnValueOnce(first.promise);
		const { result } = renderHook(() => useMixedPending());
		act(() => commitMixedOrder(["b", "a", "c"]));
		act(() => commitMixedOrder(["b", "c", "a"]));
		await act(async () => first.reject(new Error("boom")));
		expect(result.current).toBeNull();
		expect(write).toHaveBeenCalledTimes(1);
		expect(toast.error).toHaveBeenCalledTimes(1);
	});

	it("accepts a new move after a failure", async () => {
		write.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(file());
		renderHook(() => useMixedPending());
		await act(async () => commitMixedOrder(["b", "a"]));
		await act(async () => commitMixedOrder(["a", "b"]));
		expect(write).toHaveBeenCalledTimes(2);
	});
});

describe("withPendingMixedOrder", () => {
	it("lays the pending order over the stored one, and leaves the file alone without one", () => {
		const stored = file(["a", "b"]);
		expect(withPendingMixedOrder(stored, ["b", "a"]).mixedOrder).toEqual(["b", "a"]);
		expect(withPendingMixedOrder(stored, null)).toBe(stored);
	});
});
