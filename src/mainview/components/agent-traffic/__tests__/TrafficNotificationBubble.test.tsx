import { describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { NotificationLogRow } from "../../../../shared/notification-log";
import { I18nProvider } from "../../../i18n";
import { notificationEvents } from "../notification-event";
import TrafficNotificationBubble from "../TrafficNotificationBubble";

function notification(overrides: Partial<NotificationLogRow> = {}): NotificationLogRow {
	return {
		v: 1,
		at: "2026-09-07T10:00:00.000Z",
		mode: "toast",
		level: "info",
		message: "build green",
		taskId: "task-a",
		taskSeq: 11,
		taskTitle: "Task A",
		projectId: "proj-1",
		sourceTaskId: "task-a",
		sourceSeq: 11,
		sourceProjectId: "proj-1",
		outcome: "delivered",
		...overrides,
	};
}

function show(row: NotificationLogRow, props: Partial<Parameters<typeof TrafficNotificationBubble>[0]> = {}) {
	// One bubble on screen per call: a loop over levels would otherwise stack
	// renders and every `getByText` would find several.
	cleanup();
	const [event] = notificationEvents([row]);
	render(
		<I18nProvider>
			<TrafficNotificationBubble event={event} {...props} />
		</I18nProvider>,
	);
	return screen.getByTestId("traffic-notification");
}

describe("TrafficNotificationBubble", () => {
	it("carries the level and the outcome as data attributes, not as a colour literal", () => {
		for (const level of ["info", "success", "error"] as const) {
			const bubble = show(notification({ level }));
			expect(bubble.dataset.level).toBe(level);
			expect(bubble.getAttribute("style") ?? "").not.toMatch(/color|#[0-9a-f]{3}/i);
		}
	});

	it("names the level and the mode in words", () => {
		show(notification({ level: "success", mode: "desktop" }));
		expect(screen.getByText(/success/)).toBeTruthy();
		expect(screen.getByText(/desktop/)).toBeTruthy();
	});

	it("renders a message that looks like markup as text", () => {
		const nasty = "<img src=x onerror=alert('xss')> and <script>alert(1)</script>";
		const bubble = show(notification({ message: nasty }));
		expect(bubble.querySelector("img")).toBeNull();
		expect(bubble.querySelector("script")).toBeNull();
		expect(bubble.textContent).toContain(nasty);
	});

	it("keeps a long message whole in the title while the visible text is clamped", () => {
		const long = "x".repeat(900);
		const bubble = show(notification({ message: long }));
		expect(bubble.querySelector(".traffic-notification-body")?.getAttribute("title")).toBe(long);
	});

	it("says a notification had no task instead of guessing one", () => {
		show(notification({ taskId: null, taskSeq: null, taskTitle: undefined, projectId: null, sourceTaskId: null, sourceSeq: null }));
		expect(screen.getByText("Sent without a task")).toBeTruthy();
	});

	it("names both ends when the notification was addressed at another card", () => {
		show(notification({ taskId: "task-b", taskSeq: 22, sourceTaskId: "task-a", sourceSeq: 11 }));
		expect(screen.getByText("About #22")).toBeTruthy();
		expect(screen.getByText("Sent from #11")).toBeTruthy();
	});

	it("does not repeat the sender when it is the same card", () => {
		show(notification());
		expect(screen.queryByText("Sent from #11")).toBeNull();
	});

	it("says a queued notification may never have been seen, and why", () => {
		show(notification({ outcome: "queued", suppressedBy: ["focusMode", "terminalImmersive"] }));
		const pill = screen.getByText(/Held back/);
		expect(pill.textContent).toContain("Focus mode");
		expect(pill.textContent).toContain("Full-screen terminal");
	});

	it("says nothing appeared when there was no window", () => {
		show(notification({ outcome: "no-window" }));
		expect(screen.getByText(/No window was open/)).toBeTruthy();
	});

	it("adds no outcome pill to a delivered notification", () => {
		const bubble = show(notification({ outcome: "delivered" }));
		expect(bubble.querySelector(".traffic-notification-outcome")).toBeNull();
	});

	it("flags a target the board no longer has without moving the anchor", () => {
		show(notification({ taskId: "gone", taskSeq: 99 }), { onKnownTask: () => false });
		expect(screen.getByText(/no longer on the board/)).toBeTruthy();
		expect(screen.getByText("About #99")).toBeTruthy();
	});

	it("renders inline with no tail when no anchor is given", () => {
		const bubble = show(notification());
		expect(bubble.classList.contains("is-anchored")).toBe(false);
		expect(bubble.querySelector(".traffic-notification-tail")).toBeNull();
	});

	it("positions and grows a tail when anchored to a node", () => {
		const bubble = show(notification(), { anchor: { x: 400, y: 300 }, width: 1000, height: 600 });
		expect(bubble.classList.contains("is-anchored")).toBe(true);
		expect(bubble.querySelector(".traffic-notification-tail")).toBeTruthy();
		expect(bubble.style.left).toBeTruthy();
	});

	it("never widens itself past the stylesheet cap on a wide canvas", () => {
		// An inline maxWidth taken from the canvas would beat the CSS cap and let a
		// long message run the full width, overlapping the next bubble.
		const wide = show(notification(), { anchor: { x: 400, y: 300 }, width: 4000, height: 600 });
		expect(wide.style.maxWidth).toBe("320px");
		const narrow = show(notification(), { anchor: { x: 100, y: 300 }, width: 200, height: 600 });
		expect(narrow.style.maxWidth).toBe("176px");
	});

	it("hides an anchor that sits off the canvas rather than drawing it at the edge", () => {
		const bubble = show(notification(), { anchor: { x: -50, y: 300 }, width: 1000, height: 600 });
		expect(bubble.style.visibility).toBe("hidden");
	});
});
