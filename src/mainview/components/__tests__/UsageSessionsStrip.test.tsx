import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import UsageSessionsStrip from "../UsageSessionsStrip";
import { NOW, session, warmFor } from "./session-test-fixtures";

function renderStrip(sessions: Parameters<typeof UsageSessionsStrip>[0]["sessions"], onOpenAll?: () => void) {
	return render(
		<I18nProvider>
			<UsageSessionsStrip sessions={sessions} onOpenAll={onOpenAll} />
		</I18nProvider>,
	);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("UsageSessionsStrip", () => {
	it("renders nothing without sessions", () => {
		const { container } = renderStrip([]);
		expect(container.firstChild).toBeNull();
	});

	it("summarizes every session but lists only those needing attention, at most three", () => {
		const sessions = [
			...Array.from({ length: 40 }, (_, i) => session(`calm${i}`, { costUsd: 0.5 })),
			session("a", { taskTitle: "Expiring cache", awaitingUser: true, cache: warmFor(2 * 60_000) }),
			session("b", { taskTitle: "Full context", contextPercent: 91 }),
			session("c", { taskTitle: "Fuller context", contextPercent: 96 }),
			session("d", { taskTitle: "Also full", contextPercent: 88 }),
		];
		renderStrip(sessions);
		expect(screen.getByText(/44 sessions/)).toBeTruthy();
		expect(screen.getByText(/\$20\.00/)).toBeTruthy();
		expect(screen.getAllByRole("listitem")).toHaveLength(3);
		expect(screen.getByText("Expiring cache")).toBeTruthy();
		expect(screen.getByText("cache expires in 2m")).toBeTruthy();
		expect(screen.getByText("Fuller context")).toBeTruthy();
		expect(screen.queryByText("Also full")).toBeNull();
	});

	it("does not blur task titles - the board shows them unblurred", () => {
		renderStrip([session("a", { taskTitle: "Visible title", contextPercent: 90 })]);
		expect(screen.getByText("Visible title").className).not.toContain("streamer-private");
	});

	it("lets a cache go cold while the panel stays open, with no push", () => {
		renderStrip([session("a", { taskTitle: "Waiting task", awaitingUser: true, cache: warmFor(10_000) })]);
		expect(screen.getByText("Waiting task")).toBeTruthy();
		act(() => {
			vi.advanceTimersByTime(30_000);
		});
		expect(screen.queryByText("Waiting task")).toBeNull();
	});

	it("shows the All sessions link only when there is somewhere to go", () => {
		const onOpenAll = vi.fn();
		const view = renderStrip([session("a")]);
		expect(screen.queryByRole("button", { name: "All sessions" })).toBeNull();
		view.unmount();
		renderStrip([session("a")], onOpenAll);
		act(() => screen.getByRole("button", { name: "All sessions" }).click());
		expect(onOpenAll).toHaveBeenCalledTimes(1);
	});
});
