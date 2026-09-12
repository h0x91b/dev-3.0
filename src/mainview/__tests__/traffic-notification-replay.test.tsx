import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NotificationLogPage, NotificationLogRow } from "../../shared/notification-log";
import { I18nProvider } from "../i18n";
import { resetTrafficStore } from "../agent-traffic";
import { setAgentTrafficEnabledForTests } from "../agent-traffic-flag";
import { resetNotificationTrafficStore } from "../notification-traffic";
import AgentTrafficScreen from "../components/agent-traffic/AgentTrafficScreen";

vi.mock("../components/agent-traffic/TrafficOrbit", () => ({
	default: () => <div aria-label="Project traffic map" />,
}));
vi.mock("../components/agent-traffic/TrafficNodes", () => ({
	default: () => <div data-testid="traffic-nodes" />,
}));

const notificationPage: { value: NotificationLogPage } = {
	value: { rows: [], oldestDay: null, newestDay: null, retentionDays: 30, hasMore: false },
};
/** Typed with its query, so a test can assert WHICH projects the read asked for. */
const readNotificationLog = vi.fn(
	(_query: { limit?: number; projectIds?: string[] } | undefined) =>
		Promise.resolve(notificationPage.value),
);

vi.mock("../rpc", () => ({
	api: {
		request: {
			readAgentMessageLog: vi.fn(() =>
				Promise.resolve({ rows: [], oldestDay: null, retentionDays: 30, hasMore: false }),
			),
			readNotificationLog: (query: unknown) =>
				readNotificationLog(query as { limit?: number; projectIds?: string[] } | undefined),
			getGlobalSettings: vi.fn(() => Promise.resolve({})),
			saveGlobalSettings: vi.fn(() => Promise.resolve()),
			getProjects: vi.fn(() => Promise.resolve([{ id: "proj-1", name: "Project One" }])),
			getTasks: vi.fn(() => Promise.resolve([])),
		},
	},
}));

const NOW = Date.now();
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function notification(over: Partial<NotificationLogRow> = {}): NotificationLogRow {
	return {
		v: 1,
		at: minutesAgo(10),
		mode: "toast",
		level: "error",
		message: "the backfill died halfway through, nothing was written",
		taskId: "task-b",
		taskSeq: 22,
		taskTitle: "Worker",
		projectId: "proj-1",
		sourceTaskId: "task-a",
		sourceSeq: 11,
		sourceTitle: "Coordinator",
		outcome: "delivered",
		...over,
	};
}

function setNotifications(rows: NotificationLogRow[]) {
	notificationPage.value = {
		rows,
		oldestDay: rows.length ? "2026-09-01" : null,
		newestDay: rows.length ? "2026-09-10" : null,
		retentionDays: 30,
		hasMore: false,
	};
}

function renderScreen() {
	return render(
		<I18nProvider>
			<AgentTrafficScreen projectId="proj-1" onOpenTask={vi.fn()} />
		</I18nProvider>,
	);
}

/**
 * Put the cursor on a named step, and never assume where entry left it.
 *
 * What the screen does on arrival — park on Live, or replay the entry window — is
 * not this suite's subject and is deliberately not asserted anywhere in it: every
 * test that depends on the cursor moves it first. Otherwise these tests quietly
 * become tests of the entry default, and they break the day it changes.
 */
/**
 * The transport's own slider, named rather than taken by role alone: the time
 * ruler beside it carries sliders too, and a bare role query would pick whichever
 * came first in the DOM.
 */
function transport() {
	return screen.getByRole("slider", { name: "Message timeline" });
}
function seekTo(index: number) {
	const slider = transport() as HTMLInputElement;
	fireEvent.change(slider, { target: { value: String(index) } });
}
function seekToEnd() {
	const slider = transport() as HTMLInputElement;
	fireEvent.change(slider, { target: { value: slider.max } });
}

beforeEach(() => {
	vi.clearAllMocks();
	resetTrafficStore();
	resetNotificationTrafficStore();
	setNotifications([]);
	setAgentTrafficEnabledForTests(true);
});

afterEach(() => {
	setAgentTrafficEnabledForTests(false);
});

describe("notifications on the replay timeline", () => {
	it("replays an hour whose ONLY recorded event is a notification", async () => {
		setNotifications([notification()]);
		renderScreen();
		// No messages and no task movements at all: before the notification arm, this
		// window had zero steps and the transport had nothing to walk.
		const row = await screen.findByTestId("traffic-notification-row");
		expect(row.textContent).toContain("the backfill died halfway through");
		// The transport walks it: the cursor's readout names this notification.
		await waitFor(() =>
			expect(transport().getAttribute("aria-valuetext")).toContain(
				"the backfill died halfway through",
			),
		);
	});

	it("shows the notification text in full, not clipped to a subject", async () => {
		const long = "a".repeat(180);
		setNotifications([notification({ message: long })]);
		renderScreen();
		const row = await screen.findByTestId("traffic-notification-row");
		expect(row.textContent).toContain(long);
	});

	it("names an unrecorded sender instead of borrowing the target's identity", async () => {
		setNotifications([
			notification({ sourceTaskId: null, sourceSeq: null, sourceTitle: undefined }),
		]);
		renderScreen();
		const row = await screen.findByTestId("traffic-notification-row");
		expect(row.textContent).toContain("Sender not recorded");
		expect(row.textContent).not.toContain("#11");
		expect(row.textContent).toContain("#22");
	});

	it("keeps the request and its fate apart: a held notification says it was held", async () => {
		setNotifications([
			notification({ outcome: "queued", suppressedBy: ["focusMode"] }),
		]);
		renderScreen();
		const row = await screen.findByTestId("traffic-notification-row");
		expect(row.getAttribute("data-outcome")).toBe("queued");
		expect(row.textContent).toContain("Held back");
	});

	it("reads the archive only for the projects the user can see", async () => {
		setNotifications([notification()]);
		renderScreen();
		await screen.findByTestId("traffic-notification-row");
		expect(readNotificationLog).toHaveBeenCalled();
		for (const [query] of readNotificationLog.mock.calls)
			expect(query?.projectIds).toEqual(["proj-1"]);
	});

	it("drops notifications from the timeline when the kind is filtered off", async () => {
		setNotifications([notification()]);
		renderScreen();
		await screen.findByTestId("traffic-notification-row");
		// The kind axis only appears once the window can carry more than one kind, so
		// a notification-only window offers no toggle to turn it off — which is the
		// documented rule: availability is a property of the window.
		expect(screen.queryByTestId("traffic-kind-notification")).toBeNull();
	});

	it("leaves the archive unread until the visible projects are known", async () => {
		setNotifications([notification()]);
		renderScreen();
		await screen.findByTestId("traffic-notification-row");
		// Never an unscoped read: that would put a sensitive project's notification
		// text on the wire before anyone could filter it.
		expect(
			readNotificationLog.mock.calls.some(
				([query]) => query?.projectIds === undefined,
			),
		).toBe(false);
	});

	it("re-reads the archive when a live notification is appended, without disturbing the running replay", async () => {
		setNotifications([notification()]);
		renderScreen();
		await screen.findByTestId("traffic-notification-row");
		const before = readNotificationLog.mock.calls.length;
		setNotifications([
			notification({ at: minutesAgo(1), message: "second one" }),
			notification(),
		]);
		window.dispatchEvent(new CustomEvent("rpc:notificationLogChanged", { detail: {} }));
		await waitFor(() =>
			expect(readNotificationLog.mock.calls.length).toBeGreaterThan(before),
		);
		// The replay walks a SNAPSHOT: an append must not stretch the timeline under
		// the cursor. Restarting takes the new snapshot, and the new row is in it.
		await userEvent.click(screen.getByText("Replay"));
		await waitFor(() => {
			seekToEnd();
			expect(screen.getAllByTestId("traffic-notification-row")).toHaveLength(2);
		});
	});

	it("orders one list newest first, whichever kind each row is", async () => {
		setNotifications([
			notification({ at: minutesAgo(2), message: "newer notification" }),
			notification({ at: minutesAgo(30), message: "older notification" }),
		]);
		renderScreen();
		await screen.findAllByTestId("traffic-notification-row");
		await waitFor(() => {
			seekToEnd();
			expect(screen.getAllByTestId("traffic-notification-row")).toHaveLength(2);
		});
		const rows = screen.getAllByTestId("traffic-notification-row");
		expect(rows[0].textContent).toContain("newer notification");
		expect(rows[1].textContent).toContain("older notification");
	});

	it("marks the row the replay cursor is standing on", async () => {
		setNotifications([
			notification({ at: minutesAgo(30), message: "first" }),
			notification({ at: minutesAgo(2), message: "second" }),
		]);
		renderScreen();
		await screen.findAllByTestId("traffic-notification-row");
		// Put the cursor on a named step rather than reading whatever entry chose.
		// Step 0 and not the last one: the slider already SITS on its maximum with no
		// cursor at all, so seeking there fires no change and would prove nothing.
		await waitFor(() => {
			seekTo(0);
			const current = screen
				.getAllByTestId("traffic-notification-row")
				.filter((row) => row.getAttribute("aria-current") === "true");
			expect(current).toHaveLength(1);
			expect(current[0].textContent).toContain("first");
		});
	});

	it("steps backwards through a notification-only window without losing the row", async () => {
		setNotifications([
			notification({ at: minutesAgo(30), message: "first" }),
			notification({ at: minutesAgo(2), message: "second" }),
		]);
		renderScreen();
		await screen.findAllByTestId("traffic-notification-row");
		// Seek back to the first event: the list must then show only what has happened
		// by then, and never empty out from under the cursor.
		await waitFor(() => {
			seekTo(0);
			const rows = screen.getAllByTestId("traffic-notification-row");
			expect(rows).toHaveLength(1);
			expect(rows[0].textContent).toContain("first");
		});
		seekTo(1);
		await waitFor(() =>
			expect(screen.getAllByTestId("traffic-notification-row")).toHaveLength(2),
		);
	});
});
