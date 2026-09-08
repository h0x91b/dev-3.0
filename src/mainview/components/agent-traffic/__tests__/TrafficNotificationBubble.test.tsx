import { describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { NotificationLogRow } from "../../../../shared/notification-log";
import { I18nProvider } from "../../../i18n";
import { notificationEvents } from "../notification-event";
import TrafficNotificationBubble, { cloudSenderEndpoint } from "../TrafficNotificationBubble";
import { CLOUD_TEXT_MAX_WIDTH } from "../traffic-cloud";

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

	it("says no task was recorded rather than guessing one", () => {
		show(notification({ taskId: null, taskSeq: null, taskTitle: undefined, projectId: null, sourceTaskId: null, sourceSeq: null }));
		expect(screen.getByText("No task recorded")).toBeTruthy();
	});

	it("says the SENDER was not recorded, never that there was no worktree", () => {
		show(notification({ sourceTaskId: null, sourceSeq: null, sourceTitle: undefined, sourceProjectId: undefined }));
		expect(screen.getByText("Sender not recorded")).toBeTruthy();
		// The subject is still named, because that part the archive did record.
		expect(screen.getByText("About #11")).toBeTruthy();
	});

	it("names both ends when the notification was addressed at another card", () => {
		show(notification({ taskId: "task-b", taskSeq: 22, sourceTaskId: "task-a", sourceSeq: 11 }));
		expect(screen.getByText("About #22")).toBeTruthy();
		expect(screen.getByText("Sent from #11")).toBeTruthy();
	});

	it("names the sender once and does not repeat it as the subject", () => {
		show(notification());
		expect(screen.getByText("Sent from #11")).toBeTruthy();
		expect(screen.queryByText("About #11")).toBeNull();
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

	it("says an anchor is not on the shown board, without claiming it was deleted", () => {
		show(notification({ taskId: "gone", taskSeq: 99, sourceTaskId: "gone", sourceSeq: 99 }), { onKnownTask: () => false });
		expect(screen.getByText("Not on the board being shown")).toBeTruthy();
		// The anchor is kept and named, not reassigned to a card that is present.
		expect(screen.getByText("Sent from #99")).toBeTruthy();
	});

	it("draws a cloud silhouette with a rim behind it, both from one geometry", () => {
		const bubble = show(notification());
		// A rim path and a body path, and the rim is first so the body covers it.
		const paths = [...bubble.querySelectorAll(".traffic-cloud path")];
		expect(paths.length).toBeGreaterThanOrEqual(2);
		expect(paths[0].classList.contains("traffic-cloud-rim")).toBe(true);
		// Arcs, not a rounded rectangle: the lobes are what make it a cloud.
		expect(paths[0].getAttribute("d")).toContain("A");
	});

	it("renders in flow with no thought trail when no anchor is given", () => {
		const bubble = show(notification());
		expect(bubble.classList.contains("is-anchored")).toBe(false);
		// Two paths only — silhouette and rim, no puffs to point at a card.
		expect(bubble.querySelectorAll(".traffic-cloud path")).toHaveLength(2);
	});

	it("grows a thought trail and positions itself when anchored to a card", () => {
		const bubble = show(notification(), { anchor: { x: 400, y: 300 }, width: 1000, height: 600 });
		expect(bubble.classList.contains("is-anchored")).toBe(true);
		expect(bubble.querySelectorAll(".traffic-cloud path")).toHaveLength(4);
		expect(bubble.style.left).toBeTruthy();
	});

	it("hangs ABOVE the card, and flips below only when there is no room overhead", () => {
		const roomy = show(notification(), { anchor: { x: 400, y: 500 }, width: 1000, height: 600 });
		expect(roomy.classList.contains("is-below")).toBe(false);
		expect(Number.parseFloat(roomy.style.top)).toBeLessThan(500);
		const cramped = show(notification(), { anchor: { x: 400, y: 8 }, width: 1000, height: 600 });
		expect(cramped.classList.contains("is-below")).toBe(true);
		expect(Number.parseFloat(cramped.style.top)).toBeGreaterThan(8);
	});

	it("hangs below on request, because only the stage knows the space above is taken", () => {
		// Reported from the shared stage: a cloud anchored to a lower-band card was
		// drawn upward across the card above it. Room on the CANVAS is all this
		// component can measure; whether that room is empty is the layout's answer.
		const forced = show(notification(), { anchor: { x: 400, y: 500 }, width: 1000, height: 600, placement: "below" });
		expect(forced.classList.contains("is-below")).toBe(true);
		expect(Number.parseFloat(forced.style.top)).toBeGreaterThan(500);
	});

	it("clears the card's own height when it hangs below, so the trail misses its title", () => {
		// The first `below` render drew the puffs across the sender card's own title,
		// because `anchor.y` is the card's TOP and the cloud started 14px under it.
		const card = { x: 400, y: 500, height: 58 };
		const clearing = show(notification(), { anchor: card, width: 1000, height: 900, placement: "below" });
		expect(Number.parseFloat(clearing.style.top)).toBeGreaterThan(card.y + card.height);
	});

	it("obeys an explicit `above` even where it would have flipped on its own", () => {
		const forced = show(notification(), { anchor: { x: 400, y: 8 }, width: 1000, height: 600, placement: "above" });
		expect(forced.classList.contains("is-below")).toBe(false);
	});

	it("hides an anchor that sits off the canvas rather than drawing it at the edge", () => {
		const bubble = show(notification(), { anchor: { x: -50, y: 300 }, width: 1000, height: 600 });
		expect(bubble.style.visibility).toBe("hidden");
	});

	describe("which card the cloud hangs over", () => {
		it("hangs over the SENDER, even when the notification is about another card", () => {
			const [event] = notificationEvents([notification({ taskId: "task-b", taskSeq: 22, sourceTaskId: "task-a", sourceSeq: 11 })]);
			expect(cloudSenderEndpoint(event)?.taskId).toBe("task-a");
		});

		it("stays UNANCHORED when no sender was recorded, rather than using the target", () => {
			// A thought over a card that never sent it would invent a sender out of a
			// missing field. The target is still named in words, which is a different
			// claim and reads as one.
			const [event] = notificationEvents([notification({ sourceTaskId: null, sourceSeq: null, sourceProjectId: undefined })]);
			expect(event.target?.taskId).toBe("task-a");
			expect(cloudSenderEndpoint(event)).toBeNull();
		});

		it("has nowhere to hang when the archive recorded neither end", () => {
			const [event] = notificationEvents([notification({
				taskId: null, taskSeq: null, projectId: null, taskTitle: undefined,
				sourceTaskId: null, sourceSeq: null, sourceProjectId: undefined,
			})]);
			expect(cloudSenderEndpoint(event)).toBeNull();
		});
	});

	describe("the measured box", () => {
		// happy-dom reports every offsetWidth as 0, so the layout itself cannot be
		// asserted here — but the ONE rule that broke it in a real render can be. The
		// cloud is drawn around the measured content box, so capping the BOX while a
		// line inside it cannot wrap leaves the measurement at the cap and paints that
		// line outside the silhouette. Measured in a browser: the head's clock and the
		// outcome pill both sat outside the cloud until the cap moved to the lines.
		it("caps the wrapping lines, never the box the cloud is measured from", () => {
			const bubble = show(notification({ outcome: "queued", suppressedBy: ["focusMode"] }));
			const box = bubble.querySelector<HTMLElement>(".traffic-notification-content")!;
			expect(box.style.maxWidth).toBe("");
			for (const selector of [".traffic-notification-body", ".traffic-notification-foot"]) {
				const line = bubble.querySelector<HTMLElement>(selector)!;
				expect(line.style.maxWidth).toBe(`${CLOUD_TEXT_MAX_WIDTH}px`);
			}
		});
	});
});
