import { renderHook } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Route } from "../../state";

const { isElectrobunMock, isMobileMock } = vi.hoisted(() => ({
	isElectrobunMock: { value: true },
	isMobileMock: vi.fn(() => false),
}));

vi.mock("../../rpc", () => ({
	get isElectrobun() {
		return isElectrobunMock.value;
	},
}));
vi.mock("../useMobile", () => ({ useMobile: isMobileMock }));

const { useViewport } = await import("../useViewport");

function renderWith(route: Route): string {
	renderHook(() => useViewport(route));
	return document.querySelector<HTMLMetaElement>('meta[name="viewport"]')?.content ?? "";
}

describe("useViewport", () => {
	beforeEach(() => {
		document.head.innerHTML = '<meta name="viewport" content="">';
		isElectrobunMock.value = true;
		isMobileMock.mockReturnValue(false);
	});

	it("serves device-width to a browser remote session", () => {
		isElectrobunMock.value = false;
		expect(renderWith({ screen: "dashboard" })).toContain("width=device-width");
	});

	// The zoom cap on browser remote is a product decision, not an oversight: the
	// surface underneath is a live terminal and pinch-zoom fights its geometry. Locked
	// here so an accessibility sweep does not quietly remove it again.
	it("caps pinch-zoom on browser remote, on every route", () => {
		isElectrobunMock.value = false;
		for (const route of [{ screen: "dashboard" } as Route, { screen: "task", projectId: "p1", taskId: "t1" } as Route]) {
			document.head.innerHTML = '<meta name="viewport" content="">';
			const content = renderWith(route);
			expect(content).toContain("user-scalable=no");
			expect(content).toContain("maximum-scale=1");
		}
	});

	it("keeps the desktop width for the Electrobun shell", () => {
		expect(renderWith({ screen: "dashboard" })).toBe("width=1280");
	});

	it("gives a mobile device the terminal width only on terminal routes", () => {
		isMobileMock.mockReturnValue(true);
		expect(renderWith({ screen: "task", projectId: "p1", taskId: "t1" })).toBe("width=1280");
		document.head.innerHTML = '<meta name="viewport" content="">';
		expect(renderWith({ screen: "dashboard" })).toContain("width=device-width");
	});
});
