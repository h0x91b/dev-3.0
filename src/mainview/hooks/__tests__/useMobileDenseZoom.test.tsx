import { renderHook } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Route } from "../../state";
import { isTerminalRoute, useMobileDenseZoom } from "../useMobileDenseZoom";
import { retainDenseZoom } from "../../zoom";

const { releaseMock, retainMock } = vi.hoisted(() => {
	const releaseMock = vi.fn();
	return { releaseMock, retainMock: vi.fn(() => releaseMock) };
});

vi.mock("../../zoom", () => ({
	retainDenseZoom: retainMock,
}));

const mockedRetain = vi.mocked(retainDenseZoom);

describe("isTerminalRoute", () => {
	it("matches the full-screen task view", () => {
		expect(isTerminalRoute({ screen: "task", projectId: "p1", taskId: "t1" })).toBe(true);
	});

	it("matches the standalone project terminal", () => {
		expect(isTerminalRoute({ screen: "project-terminal", projectId: "p1" })).toBe(true);
	});

	it("matches the board with an open task", () => {
		expect(isTerminalRoute({ screen: "project", projectId: "p1", activeTaskId: "t1" })).toBe(true);
		expect(isTerminalRoute({ screen: "project", projectId: "p1", taskView: true })).toBe(true);
	});

	it("does not match board, dashboard, or settings", () => {
		expect(isTerminalRoute({ screen: "project", projectId: "p1" })).toBe(false);
		expect(isTerminalRoute({ screen: "dashboard" })).toBe(false);
		expect(isTerminalRoute({ screen: "settings" })).toBe(false);
		expect(isTerminalRoute({ screen: "stats" })).toBe(false);
	});
});

describe("useMobileDenseZoom", () => {
	beforeEach(() => {
		mockedRetain.mockClear();
		releaseMock.mockClear();
	});

	it("does not retain on non-terminal routes", () => {
		renderHook((route: Route) => useMobileDenseZoom(route), {
			initialProps: { screen: "dashboard" } as Route,
		});
		expect(mockedRetain).not.toHaveBeenCalled();
	});

	it("retains on a terminal route and releases on leave", () => {
		const { rerender } = renderHook((route: Route) => useMobileDenseZoom(route), {
			initialProps: { screen: "dashboard" } as Route,
		});
		rerender({ screen: "task", projectId: "p1", taskId: "t1" });
		expect(mockedRetain).toHaveBeenCalledTimes(1);
		expect(releaseMock).not.toHaveBeenCalled();
		rerender({ screen: "dashboard" });
		expect(releaseMock).toHaveBeenCalledTimes(1);
	});

	it("keeps a single retain when moving between terminal routes", () => {
		const { rerender } = renderHook((route: Route) => useMobileDenseZoom(route), {
			initialProps: { screen: "task", projectId: "p1", taskId: "t1" } as Route,
		});
		rerender({ screen: "project", projectId: "p1", activeTaskId: "t2" });
		expect(mockedRetain).toHaveBeenCalledTimes(1);
		expect(releaseMock).not.toHaveBeenCalled();
	});

	it("releases on unmount", () => {
		const { unmount } = renderHook((route: Route) => useMobileDenseZoom(route), {
			initialProps: { screen: "task", projectId: "p1", taskId: "t1" } as Route,
		});
		unmount();
		expect(releaseMock).toHaveBeenCalledTimes(1);
	});
});
