import { renderHook, act } from "@testing-library/react";
import { useColumnCollapse } from "../useColumnCollapse";

beforeEach(() => {
	localStorage.clear();
});

describe("useColumnCollapse", () => {
	it("defaults completed, cancelled to collapsed", () => {
		const { result } = renderHook(() => useColumnCollapse("proj-1"));
		expect(result.current.isCollapsed("completed")).toBe(true);
		expect(result.current.isCollapsed("cancelled")).toBe(true);
	});

	it("todo and active statuses are expanded by default", () => {
		const { result } = renderHook(() => useColumnCollapse("proj-1"));
		expect(result.current.isCollapsed("todo")).toBe(false);
		expect(result.current.isCollapsed("in-progress")).toBe(false);
		expect(result.current.isCollapsed("user-questions")).toBe(false);
		expect(result.current.isCollapsed("review-by-user")).toBe(false);
	});

	it("toggle: expanded → collapsed", () => {
		const { result } = renderHook(() => useColumnCollapse("proj-1"));
		expect(result.current.isCollapsed("todo")).toBe(false);
		act(() => result.current.toggle("todo"));
		expect(result.current.isCollapsed("todo")).toBe(true);
	});

	it("toggle: collapsed → expanded → re-collapsed", () => {
		const { result } = renderHook(() => useColumnCollapse("proj-1"));
		act(() => result.current.toggle("todo")); // collapse
		act(() => result.current.toggle("todo")); // expand again
		expect(result.current.isCollapsed("todo")).toBe(false);
	});

	it("persists collapse state in localStorage", () => {
		const { result, unmount } = renderHook(() => useColumnCollapse("proj-1"));
		act(() => result.current.toggle("todo")); // collapse todo
		unmount();

		// Re-mount and check persisted state
		const { result: result2 } = renderHook(() => useColumnCollapse("proj-1"));
		expect(result2.current.isCollapsed("todo")).toBe(true); // persisted as collapsed
		expect(result2.current.isCollapsed("completed")).toBe(true); // still collapsed
	});

	it("per-project isolation", () => {
		const { result: r1 } = renderHook(() => useColumnCollapse("proj-1"));
		act(() => r1.current.toggle("todo")); // collapse in proj-1

		const { result: r2 } = renderHook(() => useColumnCollapse("proj-2"));
		expect(r2.current.isCollapsed("todo")).toBe(false); // proj-2 has defaults (expanded)
	});

	it("toggle on expanded column collapses it", () => {
		const { result } = renderHook(() => useColumnCollapse("proj-1"));
		expect(result.current.isCollapsed("in-progress")).toBe(false);
		act(() => result.current.toggle("in-progress"));
		expect(result.current.isCollapsed("in-progress")).toBe(true);
	});
});
