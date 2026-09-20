import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InterfaceOnboardingRequest, InterfaceOnboardingResponse } from "../../shared/interface-onboarding";
import type { Route } from "../state";
import { __resetBackLayersForTests, registerBackLayer } from "../back-navigation";
import { registerOverlayLayer } from "../utils/overlay-layers";
import { artifactActivity } from "../artifact-activity";

vi.mock("../rpc", () => ({ api: { request: { interfaceOnboarding: vi.fn() } } }));
vi.mock("../i18n", () => ({ useT: () => (key: string) => key }));

import { api } from "../rpc";
import { useInterfaceOnboarding } from "../hooks/useInterfaceOnboarding";
import InterfaceOnboarding from "../components/InterfaceOnboarding";

const rpc = vi.mocked(api.request.interfaceOnboarding);
const dashboard: Route = { screen: "dashboard" };
const project: Route = { screen: "project", projectId: "project" };
const response = (prompt: InterfaceOnboardingResponse["prompt"] = "invite"): InterfaceOnboardingResponse => ({
	enabled: prompt !== "lesson", source: "fresh", activeMs: 10_800_000,
	postponements: 0, dueAt: 0, lessonPending: prompt === "lesson", prompt,
});
function deferred() {
	let resolve!: (value: InterfaceOnboardingResponse) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<InterfaceOnboardingResponse>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
async function flush() { await act(async () => { await Promise.resolve(); }); }
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000_000);
	vi.spyOn(document, "hasFocus").mockReturnValue(true);
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	rpc.mockReset();
	rpc.mockImplementation(async (request) => response(request.calm ? "invite" : null));
	__resetBackLayersForTests();
	artifactActivity.open = 0;
});
afterEach(() => {
	cleanup();
	__resetBackLayersForTests();
	artifactActivity.open = 0;
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("interface onboarding eligibility", () => {
	it.each([
		{ screen: "settings" },
		{ ...project, activeTaskId: "task" },
		{ ...project, taskDetailId: "task" },
		{ ...project, diff: {} },
	] as Route[])("does not invite on an occupied route: %j", async (route) => {
		const { result } = renderHook(() => useInterfaceOnboarding(route, false));
		await flush();
		expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ calm: false }));
		expect(result.current.prompt).toBeNull();
	});

	it.each(["field", "terminal", "dialog", "portal", "artifact", "help", "background"])("defers while %s is active", async (kind) => {
		const element = document.createElement(kind === "field" ? "input" : "div");
		document.body.append(element);
		let release = () => {};
		if (kind === "field") element.focus();
		if (kind === "terminal") {
			element.dataset.terminal = "true";
			element.tabIndex = 0;
			element.focus();
		}
		if (kind === "dialog") release = registerBackLayer(() => {});
		if (kind === "portal") release = registerOverlayLayer(element, () => {});
		if (kind === "artifact") artifactActivity.open = 1;
		if (kind === "background") vi.mocked(document.hasFocus).mockReturnValue(false);
		const { result, unmount } = renderHook(() => useInterfaceOnboarding(dashboard, kind === "help"));
		await flush();
		expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ calm: false }));
		expect(result.current.prompt).toBeNull();
		unmount();
		release();
		element.remove();
	});

	it("rejects a response when the user starts typing while the request travels", async () => {
		const pending = deferred();
		rpc.mockReturnValueOnce(pending.promise);
		const { result } = renderHook(() => useInterfaceOnboarding(dashboard, false));
		const field = document.createElement("textarea");
		document.body.append(field);
		field.focus();
		await act(async () => { pending.resolve(response()); });
		expect(result.current.prompt).toBeNull();
		field.remove();
	});

	it("rejects a response after navigation into a task", async () => {
		const pending = deferred();
		rpc.mockReturnValueOnce(pending.promise);
		const { result, rerender } = renderHook(({ route }) => useInterfaceOnboarding(route, false), { initialProps: { route: dashboard as Route } });
		rerender({ route: { ...project, activeTaskId: "task" } });
		await act(async () => { pending.resolve(response()); });
		expect(result.current.prompt).toBeNull();
	});

	it("does not count synthetic test or script input as active use", async () => {
		renderHook(() => useInterfaceOnboarding(dashboard, false));
		await flush();
		fireEvent.keyDown(window, { key: "a" });
		fireEvent.pointerMove(window);
		await tick(15_000);
		expect(rpc).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }));
	});
});

describe("interface onboarding request ownership", () => {
	it("queues a user switch behind an in-flight poll instead of losing the click", async () => {
		const poll = deferred();
		rpc.mockReturnValueOnce(poll.promise).mockResolvedValueOnce(response("lesson"));
		const { result } = renderHook(() => useInterfaceOnboarding(dashboard, false));
		let switching!: Promise<boolean>;
		act(() => { switching = result.current.request("disable"); });
		expect(result.current.busy).toBe(true);
		expect(rpc).toHaveBeenCalledTimes(1);
		await act(async () => { poll.resolve(response()); await switching; });
		expect(rpc.mock.calls.map(([request]) => request.action)).toEqual(["poll", "disable"]);
		expect(result.current.prompt).toBe("lesson");
		expect(result.current.busy).toBe(false);
	});

	it("removes a displayed invitation when renewal fails", async () => {
		rpc.mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error("offline"));
		const { result } = renderHook(() => useInterfaceOnboarding(dashboard, false));
		await flush();
		expect(result.current.prompt).toBe("invite");
		await tick(15_000);
		expect(result.current.prompt).toBeNull();
	});

	it("expires the displayed invitation while renewal hangs beyond the local lease", async () => {
		const renewal = deferred();
		rpc.mockResolvedValueOnce(response()).mockReturnValueOnce(renewal.promise);
		const { result } = renderHook(() => useInterfaceOnboarding(dashboard, false));
		await flush();
		expect(result.current.prompt).toBe("invite");
		await tick(30_001);
		expect(result.current.prompt).toBeNull();
	});

	it("does not display an initial response that arrives after its local lease", async () => {
		const pending = deferred();
		rpc.mockReturnValueOnce(pending.promise);
		const { result } = renderHook(() => useInterfaceOnboarding(dashboard, false));
		await tick(30_001);
		await act(async () => { pending.resolve(response()); });
		expect(result.current.prompt).toBeNull();
	});
});

describe("interface onboarding consent", () => {
	it("switches only on explicit consent, then shows the lesson in the same dialog", async () => {
		rpc.mockImplementation(async (request: InterfaceOnboardingRequest) => response(request.action === "disable" ? "lesson" : request.action === "acknowledge" ? null : "invite"));
		render(<InterfaceOnboarding route={dashboard} blocked={false} />);
		await flush();
		const dialog = screen.getByRole("dialog");
		expect(rpc.mock.calls.every(([request]) => request.action === "poll")).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "settings.fullInterfaceSwitch" }));
		await flush();
		expect(screen.getByRole("dialog")).toBe(dialog);
		expect(screen.getByRole("heading", { name: "settings.fullInterfaceLessonTitle" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "settings.fullInterfaceLessonDone" }));
		await flush();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("Escape postpones, restores sibling interactivity, then restores keyboard focus", async () => {
		const trigger = document.createElement("button");
		document.body.append(trigger);
		trigger.focus();
		const originalFocus = trigger.focus.bind(trigger);
		const restore = vi.spyOn(trigger, "focus").mockImplementation(() => {
			expect(trigger.inert).not.toBe(true);
			originalFocus();
		});
		rpc.mockResolvedValueOnce(response()).mockResolvedValueOnce(response(null));
		render(<InterfaceOnboarding route={dashboard} blocked={false} />);
		await flush();
		expect(trigger.inert).toBe(true);
		fireEvent.keyDown(window, { key: "Escape" });
		await flush();
		expect(rpc).toHaveBeenLastCalledWith(expect.objectContaining({ action: "postpone" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(restore).toHaveBeenCalled();
		expect(document.activeElement).toBe(trigger);
		trigger.remove();
	});
});
