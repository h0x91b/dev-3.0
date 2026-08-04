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

	// WCAG 1.4.4: capping zoom is banned on every transport, and the browser remote
	// session is the one that renders on a real phone.
	it.each([
		["browser remote", false, { screen: "dashboard" } as Route],
		["browser remote, terminal route", false, { screen: "task", projectId: "p1", taskId: "t1" } as Route],
		["electrobun desktop", true, { screen: "dashboard" } as Route],
	])("never blocks zoom (%s)", (_label, electrobun, route) => {
		isElectrobunMock.value = electrobun;
		const content = renderWith(route);
		expect(content).not.toContain("user-scalable=no");
		expect(content).not.toContain("maximum-scale");
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
