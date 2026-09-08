import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type {
	AgentMessageLogPage,
	AgentMessageLogRow,
} from "../../shared/agent-message-log";
import { I18nProvider } from "../i18n";
import {
	noteTrafficArrival,
	resetTrafficSeen,
	resetTrafficStore,
} from "../agent-traffic";
import { setAgentTrafficEnabledForTests } from "../agent-traffic-flag";
import AgentTrafficIndicator from "../components/agent-traffic/AgentTrafficIndicator";
import AgentTrafficScreen, {
	availableKinds,
	FilterAxes,
} from "../components/agent-traffic/AgentTrafficScreen";
import { api } from "../rpc";

vi.mock("../components/agent-traffic/TrafficOrbit", () => ({
	default: () => <div aria-label="Project traffic map" />,
}));

const page: { value: AgentMessageLogPage } = {
	value: { rows: [], oldestDay: null, retentionDays: 30, hasMore: false },
};

const projectFixtures = { value: [{ id: "proj-1", name: "Project One" }] };
const additionalTasks: { value: Record<string, unknown>[] } = { value: [] };
const projectPages: { value: Record<string, AgentMessageLogPage> } = { value: {} };

const knownTaskIds: { value: string[] } = {
	value: ["task-a", "task-b", "task-c"],
};
/** Per-task extras a test needs on top of the default fixture (status, hibernated). */
const taskExtras: { value: Record<string, Record<string, unknown>> } = {
	value: {},
};

/** Stands in for the settings file: what a fresh install has is an empty object. */
const settings: { value: Record<string, unknown> } = { value: {} };

vi.mock("../rpc", () => ({
	api: {
		request: {
			readAgentMessageLog: vi.fn(({ projectId }: { projectId: string }) => Promise.resolve(projectPages.value[projectId] ?? page.value)),
			getGlobalSettings: vi.fn(() => Promise.resolve(settings.value)),
			saveGlobalSettings: vi.fn((next: Record<string, unknown>) => {
				settings.value = next;
				return Promise.resolve();
			}),
			getProjects: vi.fn(() =>
				Promise.resolve(projectFixtures.value),
			),
			getTasks: vi.fn(({ projectId }: { projectId: string }) =>
				Promise.resolve(
					projectId !== "proj-1" ? additionalTasks.value.filter(task => task.projectId === projectId) : knownTaskIds.value.map((id, index) => ({
						id,
						projectId: "proj-1",
						seq: (index + 1) * 11,
						title:
							id === "task-a"
								? "Coordinator"
								: id === "task-b"
									? "Worker"
									: "Other worker",
						status: "in-progress",
						taskType: id === "task-a" ? "coordinator" : null,
						overview: "Current task overview",
						...(taskExtras.value[id] ?? {}),
					})),
				),
			),
		},
	},
}));

function row(over: Partial<AgentMessageLogRow> = {}): AgentMessageLogRow {
	return {
		v: 1,
		at: new Date().toISOString(),
		fromTaskId: "task-a",
		fromSeq: 11,
		fromTitle: "Coordinator",
		toTaskId: "task-b",
		toSeq: 22,
		toTitle: "Worker",
		toProjectId: "proj-1",
		kind: "immediate",
		body: "rebase before you push",
		bodyKind: "text",
		status: "delivered",
		...over,
	};
}

function setPage(
	rows: AgentMessageLogRow[],
	over: Partial<AgentMessageLogPage> = {},
) {
	page.value = {
		rows,
		oldestDay: rows.length ? "2026-08-01" : null,
		retentionDays: 30,
		hasMore: false,
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	projectFixtures.value = [{ id: "proj-1", name: "Project One" }];
	additionalTasks.value = [];
	projectPages.value = {};
	resetTrafficStore();
	resetTrafficSeen();
	setPage([]);
	settings.value = {};
	knownTaskIds.value = ["task-a", "task-b", "task-c"];
	taskExtras.value = {};
	// The feature ships off; these tests describe it switched on. The off state has
	// its own suite in agent-traffic-flag.test.tsx.
	setAgentTrafficEnabledForTests(true);
});

afterEach(() => {
	setAgentTrafficEnabledForTests(false);
});

/** Put the last look an hour back so the seeded rows read as unread. */
function withUnread() {
	resetTrafficSeen();
	localStorage.setItem(
		"dev3-agent-traffic-seen",
		String(Date.now() - 60 * 60 * 1000),
	);
}

function renderIndicator() {
	return render(
		<I18nProvider>
			<AgentTrafficIndicator projectId="proj-1" onOpenLog={vi.fn()} />
		</I18nProvider>,
	);
}

describe("AgentTrafficIndicator (bar)", () => {
	// Presence follows the data: a project whose agents never messaged each other
	// has nothing to open, so it gets no pill.
	it("renders nothing while the project has no traffic at all", async () => {
		setPage([]);
		renderIndicator();
		await waitFor(() => expect(page.value.rows).toHaveLength(0));
		expect(screen.queryByTestId("agent-traffic-indicator")).toBeNull();
	});

	// The first shipped rule tied presence to the unread count, so hovering the pill
	// retired it under the pointer. Traffic already read still keeps the pill.
	it("stays on the bar with everything read, carrying no badge", async () => {
		setPage([row()]);
		renderIndicator();
		const pill = await screen.findByTestId("agent-traffic-indicator");
		expect(pill.textContent).not.toContain("0");
	});

	it("appears with the unread count once messages land", async () => {
		withUnread();
		setPage([row(), row({ toTaskId: "task-c", toSeq: 33 })]);
		renderIndicator();
		const pill = await screen.findByTestId("agent-traffic-indicator");
		expect(pill.textContent).toContain("2");
		// Never colour-and-number only: the count needs a name a screen reader reads.
		expect(pill.getAttribute("aria-label")).toContain("2");
	});

	it("opens the live surface directly and clears only the unread badge", async () => {
		withUnread();
		setPage([row()]);
		const onOpenLog = vi.fn();
		render(
			<I18nProvider>
				<AgentTrafficIndicator projectId="proj-1" onOpenLog={onOpenLog} />
			</I18nProvider>,
		);
		const pill = await screen.findByTestId("agent-traffic-indicator");
		expect(pill.textContent).toContain("1");
		await userEvent.click(pill);
		expect(onOpenLog).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId("agent-traffic-popover")).toBeNull();
		expect(
			screen.getByTestId("agent-traffic-indicator").textContent,
		).not.toContain("1");
		expect(pill.getAttribute("aria-haspopup")).toBe("dialog");
		expect(pill.getAttribute("title")).toBe("Open agent traffic");
	});
});

describe("AgentTrafficIndicator (kebab row)", () => {
	function renderRow(variant: "menu" | "sheet" = "menu") {
		return render(
			<I18nProvider>
				<AgentTrafficIndicator
					projectId="proj-1"
					onOpenLog={vi.fn()}
					variant={variant}
				/>
			</I18nProvider>,
		);
	}

	// The control's home, and on a phone the only way in — so it is always present
	// and always carries its label, never a bare glyph among numbers.
	it("is always present and labelled, even with no traffic at all", async () => {
		renderRow();
		const rowButton = await screen.findByTestId("agent-traffic-menu-row");
		expect(rowButton.textContent).toContain("Agent traffic");
		expect(screen.queryByTestId("agent-traffic-menu-badge")).toBeNull();
	});

	it("carries the unread count as a badge beside its label", async () => {
		withUnread();
		setPage([row(), row({ toTaskId: "task-c", toSeq: 33 })]);
		renderRow();
		expect(
			(await screen.findByTestId("agent-traffic-menu-badge")).textContent,
		).toBe("2");
	});

	// The phone's action sheet is a stack of plain full-width text buttons. This row
	// used to be the only one with a leading glyph and tighter padding, which is
	// exactly what made it read as foreign.
	it("takes the sheet's own row shape on the phone", async () => {
		withUnread();
		setPage([row()]);
		renderRow("sheet");
		const sheetRow = await screen.findByTestId("agent-traffic-sheet-row");
		expect(sheetRow.querySelector("svg")).toBeNull();
		expect(sheetRow.className).toContain("px-2");
		expect(sheetRow.className).toContain("py-3");
		expect(sheetRow.className).toContain("rounded-lg");
		expect(sheetRow.className).toContain("text-sm");
		// `.touch-actions` centres these rows itself; laying the row out by hand is
		// what left it the one left-aligned item in a column of centred ones.
		expect(sheetRow.className).not.toContain("flex-1");
		expect(sheetRow.className).not.toMatch(/\bflex\b/);
		expect(sheetRow.className).not.toContain("text-left");
	});

	// Ten unread messages and forty are the same decision, so the badge stops
	// counting rather than growing into the label.
	it("caps the badge instead of widening the row", async () => {
		withUnread();
		setPage(Array.from({ length: 14 }, (_, i) => row({ body: `msg ${i}` })));
		renderRow();
		expect(
			(await screen.findByTestId("agent-traffic-menu-badge")).textContent,
		).toBe("9+");
	});
});

function renderLog(onOpenTask = vi.fn(), projectId: string | null = "proj-1") {
	return render(
		<I18nProvider>
			<AgentTrafficScreen projectId={projectId} onOpenTask={onOpenTask} />
		</I18nProvider>,
	);
}

async function choose(label: string, option: string) {
	await userEvent.click(screen.getByRole("combobox", { name: label }));
	await userEvent.click(await screen.findByRole("option", { name: option }));
}

async function messageRows(count: number) {
	const inspector = document.querySelector(".traffic-inspector");
	if (inspector?.hasAttribute("hidden"))
		await userEvent.click(screen.getByRole("button", { name: "Messages" }));
	await waitFor(() =>
		expect(screen.getAllByTestId("traffic-message-row")).toHaveLength(count),
	);
	return screen.getAllByTestId("traffic-message-row");
}

describe("AgentTrafficScreen live orbit", () => {
	it("shows persisted traffic from the last 24 hours immediately, with older history available", async () => {
		setPage([
			row({
				at: new Date(Date.now() - 5 * 86400000).toISOString(),
				subject: "Five days ago",
			}),
			row({
				at: new Date(Date.now() - 20 * 3600000).toISOString(),
				subject: "Earlier today",
			}),
		]);
		renderLog();
		// Entry lands on the trailing hour, so neither of these rows is in the
		// window yet — widening is what brings them back.
		expect(
			screen.getByRole("button", { name: "Time window: Last hour" }).textContent,
		).toContain("Last hour");
		await userEvent.click(
			screen.getByRole("button", { name: "Time window: Last hour" }),
		);
		await userEvent.click(screen.getByRole("button", { name: "Last 24 hours" }));
		expect((await messageRows(1))[0].textContent).toContain("Earlier today");
		await userEvent.click(
			screen.getByRole("button", { name: "Time window: Last 24 hours" }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Loaded history" }),
		);
		expect(
			(await messageRows(2)).some((element) =>
				element.textContent?.includes("Five days ago"),
			),
		).toBe(true);
	});

	it.each([
		["delivered", "Delivered"],
		["held", "Held"],
		["unconfirmed", "Unconfirmed"],
		["not-delivered", "Not delivered"],
	] as const)(
		"retains and filters the %s delivery verdict",
		async (status, label) => {
			setPage(
				["delivered", "held", "unconfirmed", "not-delivered"].map((value) =>
					row({
						status: value as AgentMessageLogRow["status"],
						subject: `${value} attempt`,
					}),
				),
			);
			renderLog();
			await messageRows(4);
			await choose("Delivery status", label);
			const [message] = await messageRows(1);
			expect(message.textContent).toContain(`${status} attempt`);
			await userEvent.click(message);
			const inspector = screen.getByRole("complementary", {
				name: "Task and message details",
			});
			expect(within(inspector).getByText(label)).toBeTruthy();
			if (status === "delivered")
				expect(inspector.textContent).toContain("not a read receipt");
			if (status === "held")
				expect(inspector.textContent).toContain(
					"does not show whether it is still queued",
				);
		},
	);

	it("selects one pair from message details and clears the filter", async () => {
		setPage([
			row({ subject: "First pair" }),
			row({ toTaskId: "task-c", toSeq: 33, subject: "Other pair" }),
		]);
		renderLog();
		await userEvent.click((await messageRows(2))[0]);
		await userEvent.click(
			screen.getByRole("button", { name: "Show this pair" }),
		);
		expect(await messageRows(1)).toHaveLength(1);
		await userEvent.click(
			screen.getByRole("button", { name: "Clear selection" }),
		);
		await messageRows(2);
	});

	it("states retention and the oldest stored day, including partial-page evidence", async () => {
		setPage([row()], { hasMore: true });
		renderLog();
		expect(await screen.findByText(/2026-08-01/)).toBeTruthy();
		expect(screen.getByText(/30 days/)).toBeTruthy();
		expect(screen.getByText(/Older rows remain to be loaded/)).toBeTruthy();
		await userEvent.click(
			screen.getByRole("button", { name: "Load older messages" }),
		);
		await waitFor(() =>
			expect(api.request.readAgentMessageLog).toHaveBeenCalledWith({
				projectId: "proj-1",
				limit: 1000,
			}),
		);
	});

	it("leads with the full subject and reveals the full stored body on selection", async () => {
		const subject =
			"A complete subject that must remain readable without an ellipsis";
		const body = "The complete stored body. ".repeat(80);
		setPage([row({ subject, body })]);
		renderLog();
		const [message] = await messageRows(1);
		expect(message.textContent).toContain(subject);
		await userEvent.click(message);
		expect(screen.getByRole("heading", { name: subject })).toBeTruthy();
		expect(document.querySelector("pre")?.textContent).toBe(body);
	});

	it("falls back to the body for pre-subject rows", async () => {
		setPage([row({ body: "Legacy message body" })]);
		renderLog();
		expect((await messageRows(1))[0].textContent).toContain(
			"Legacy message body",
		);
	});

	it("exposes spilled body evidence in message details", async () => {
		setPage([
			row({
				subject: "Large report",
				bodyKind: "spill-pointer",
				body: "Read the report file",
				spillPath: "/tmp/spill.txt",
			}),
		]);
		renderLog();
		await userEvent.click((await messageRows(1))[0]);
		expect(screen.getByText(/written to a file/i)).toBeTruthy();
		expect(screen.getByText("/tmp/spill.txt")).toBeTruthy();
	});

	it("keeps removed task messages inspectable without promising navigation", async () => {
		knownTaskIds.value = ["task-a"];
		setPage([row()]);
		const onOpenTask = vi.fn();
		renderLog(onOpenTask);
		await userEvent.click((await messageRows(1))[0]);
		expect(screen.getByText(/This task no longer exists/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Open task" })).toBeNull();
		expect(document.querySelector("pre")?.textContent).toBe(
			"rebase before you push",
		);
		expect(onOpenTask).not.toHaveBeenCalled();
	});

	it("opens the receiver only from its explicit action, not message selection", async () => {
		setPage([row()]);
		const onOpenTask = vi.fn();
		renderLog(onOpenTask);
		await userEvent.click((await messageRows(1))[0]);
		expect(onOpenTask).not.toHaveBeenCalled();
		await userEvent.click(
			await screen.findByRole("button", { name: "Open task" }),
		);
		expect(onOpenTask).toHaveBeenCalledWith("task-b", "proj-1");
	});

	it("offers task inspection and navigation without WebGL", async () => {
		setPage([row()]);
		const onOpenTask = vi.fn();
		renderLog(onOpenTask);
		await messageRows(1);
		await userEvent.click(screen.getByRole("button", { name: "Tasks" }));
		// Scoped to the inspector: the stage renders its own card for the same task.
		const inspector = within(screen.getByRole("complementary"));
		await userEvent.click(
			await inspector.findByRole("button", { name: /#22 Worker/ }),
		);
		expect(inspector.getByText("Current task overview")).toBeTruthy();
		expect(onOpenTask).not.toHaveBeenCalled();
		await userEvent.click(inspector.getByRole("button", { name: "Open task" }));
		expect(onOpenTask).toHaveBeenCalledWith("task-b", "proj-1");
	});

	it("adds pushed durable traffic without reopening or losing the search", async () => {
		setPage([row({ subject: "Report baseline" })]);
		renderLog();
		await messageRows(1);
		await userEvent.type(screen.getByRole("searchbox"), "Report");
		setPage([...page.value.rows, row({ subject: "Report arrived" })]);
		act(() => noteTrafficArrival("proj-1"));
		await messageRows(2);
		expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe(
			"Report",
		);
	});

	it("shows a load error and recovers on retry", async () => {
		vi.mocked(api.request.getProjects).mockRejectedValueOnce(
			new Error("offline"),
		);
		setPage([row({ subject: "Recovered report" })]);
		renderLog();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Some traffic data could not be loaded",
		);
		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect((await messageRows(1))[0].textContent).toContain("Recovered report");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("removes navigation when a task is deleted while its details stay open", async () => {
		setPage([row()]);
		renderLog();
		await userEvent.click((await messageRows(1))[0]);
		expect(
			await screen.findByRole("button", { name: "Open task" }),
		).toBeTruthy();
		act(() =>
			window.dispatchEvent(
				new CustomEvent("rpc:taskRemoved", {
					detail: { projectId: "proj-1", taskId: "task-b" },
				}),
			),
		);
		expect(screen.queryByRole("button", { name: "Open task" })).toBeNull();
		expect(screen.getByText(/This task no longer exists/)).toBeTruthy();
	});
});

// Two presentations, one feature. The picker chooses between them; the Settings
// toggle still decides whether any of it exists (agent-traffic-flag.test.tsx).
/**
 * Entering the screen is its own contract: the trailing hour, the cursor at that
 * hour's start, and the replay started exactly once. What these guard is the
 * "once" — the window's start slides with the clock and a live message can land
 * at any moment, so a naive effect restarts the replay under the user's hands.
 */
describe("AgentTrafficScreen entry replay", () => {
	/** The tests' default is reduced-motion; motion has to be asked for. */
	function allowMotion() {
		return vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
			matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {},
			addListener() {}, removeListener() {}, dispatchEvent: () => false,
		}) as unknown as MediaQueryList);
	}

	const counter = () => document.querySelector(".traffic-event-counter")?.textContent;
	const playLabel = () => screen.getByTestId("traffic-play").getAttribute("aria-label");

	it("starts the trailing hour from its first message, playing", async () => {
		const media = allowMotion();
		try {
			setPage([
				row({ at: new Date(Date.now() - 50 * 60000).toISOString(), subject: "Oldest in the hour" }),
				row({ at: new Date(Date.now() - 20 * 60000).toISOString(), subject: "Middle" }),
				row({ subject: "Newest" }),
			]);
			renderLog();
			await waitFor(() => expect(playLabel()).toBe("Pause replay"));
			expect(counter()).toBe("1 / 3");
			expect(document.querySelector(".traffic-event-subject")?.textContent).toContain("Oldest in the hour");
		} finally {
			media.mockRestore();
		}
	});

	it("does not restart when a live message arrives mid-replay", async () => {
		const media = allowMotion();
		try {
			setPage([
				row({ at: new Date(Date.now() - 30 * 60000).toISOString(), subject: "First" }),
				row({ at: new Date(Date.now() - 10 * 60000).toISOString(), subject: "Second" }),
			]);
			renderLog();
			await waitFor(() => expect(playLabel()).toBe("Pause replay"));
			fireEvent.click(screen.getByRole("button", { name: "Next message" }));
			expect(counter()).toBe("2 / 2");
			setPage([...page.value.rows, row({ subject: "Arrived while watching" })]);
			act(() => noteTrafficArrival("proj-1"));
			// The replay's event list is frozen, so the cursor stays where the user
			// left it and the arrival does not extend the run under them.
			await act(async () => { await Promise.resolve(); });
			expect(counter()).toBe("2 / 2");
			expect(playLabel()).toBe("Play replay");
			// It did land in the data, though — Live shows all three.
			await userEvent.click(screen.getByRole("button", { name: "Live" }));
			expect(counter()).toBe("3 / 3");
		} finally {
			media.mockRestore();
		}
	});

	it("leaves an empty hour parked, and keeps it parked when a message lands", async () => {
		const media = allowMotion();
		try {
			setPage([row({ at: new Date(Date.now() - 5 * 3600000).toISOString(), subject: "Hours ago" })]);
			renderLog();
			await waitFor(() => expect(counter()).toBe("0 / 0"));
			expect(playLabel()).toBe("Play replay");
			setPage([...page.value.rows, row({ subject: "Just now" })]);
			act(() => noteTrafficArrival("proj-1"));
			await waitFor(() => expect(counter()).toBe("1 / 1"));
			expect(playLabel()).toBe("Play replay");
		} finally {
			media.mockRestore();
		}
	});

	// "Nothing matches this filter" was the only empty copy, so a quiet hour with no
	// filter at all accused a filter that was not there.
	it("says the window is empty when nothing is filtered, and blames the filter when something is", async () => {
		setPage([row({ at: new Date(Date.now() - 5 * 3600000).toISOString(), subject: "Hours ago" })]);
		renderLog();
		await waitFor(() =>
			expect(document.querySelector(".traffic-event-subject")?.textContent).toContain(
				"No messages in this window yet.",
			),
		);
		await userEvent.type(screen.getByRole("searchbox"), "nothing like this");
		await waitFor(() =>
			expect(document.querySelector(".traffic-event-subject")?.textContent).toContain(
				"Nothing matches this filter.",
			),
		);
	});

	it("parks the cursor at the start instead of playing under reduced motion", async () => {
		setPage([
			row({ at: new Date(Date.now() - 40 * 60000).toISOString(), subject: "Oldest in the hour" }),
			row({ subject: "Newest" }),
		]);
		renderLog();
		await waitFor(() => expect(counter()).toBe("1 / 2"));
		expect(playLabel()).toBe("Play replay");
		expect(document.querySelector(".traffic-event-subject")?.textContent).toContain("Oldest in the hour");
	});
});

/**
 * The kind axis exists ahead of the events it governs (Seq 1823's union timeline
 * and Seq 1825's notifications). What is testable today is the gate: while
 * messages are the only kind the timeline can carry, neither the toggles nor the
 * per-kind counts may appear — a control over a kind that cannot occur is dead
 * UI, and a one-option group is noise. The toggles' visible behaviour cannot be
 * exercised until those events exist.
 */
/**
 * The filter axes: what a reader can turn off must never depend on what they have
 * already turned off. The trap this guards is a control that removes itself —
 * narrow to one kind, watch the group collapse, and the way back is gone.
 */
describe("traffic filter axes", () => {
	it("derives availability from the window, never from the selection", () => {
		// The signature carries the rule: nothing about the current selection can
		// reach it. Messages are the only kind the timeline offers today.
		expect([...availableKinds(true)]).toEqual(["message"]);
		expect([...availableKinds(false)]).toEqual([]);
	});

	it("keeps every option on screen after one is switched off", async () => {
		function Harness() {
			const [selected, setSelected] = useState<ReadonlySet<string>>(
				() => new Set(["message", "task"]),
			);
			return (
				<FilterAxes
					axes={[
						{
							id: "kind",
							label: "Event kinds",
							values: ["message", "task"],
							labelKey: () => "traffic.orbit.messages",
							selected,
							onChange: setSelected,
						},
					]}
				/>
			);
		}
		render(
			<I18nProvider>
				<Harness />
			</I18nProvider>,
		);
		await userEvent.click(screen.getByTestId("traffic-kind-task"));
		expect(screen.getByTestId("traffic-kind-task")).toHaveAttribute("aria-pressed", "false");
		// Both controls are still there — including the one that undoes this.
		expect(screen.getByTestId("traffic-kind-message")).toHaveAttribute("aria-pressed", "true");
	});

	it("refuses to empty an axis, and lays out nothing for a single-value one", () => {
		const onChange = vi.fn();
		const { unmount } = render(
			<I18nProvider>
				<FilterAxes
					axes={[
						{
							id: "kind",
							label: "Event kinds",
							values: ["message", "task"],
							labelKey: () => "traffic.orbit.messages",
							selected: new Set(["message"]),
							onChange,
						},
					]}
				/>
			</I18nProvider>,
		);
		// The last enabled value is not a way to show nothing at all.
		expect(screen.getByTestId("traffic-kind-message")).toBeDisabled();
		unmount();

		render(
			<I18nProvider>
				<FilterAxes
					axes={[
						{
							id: "level",
							label: "Notification levels",
							values: ["error"],
							labelKey: () => "traffic.orbit.messages",
							selected: null,
							onChange,
						},
					]}
				/>
			</I18nProvider>,
		);
		expect(screen.queryByTestId("traffic-level-error")).toBeNull();
	});
});

describe("AgentTrafficScreen kind filter gate", () => {
	it("shows no kind toggles and no per-kind counts while messages are the only kind", async () => {
		setPage([row({ subject: "Only messages here" })]);
		renderLog();
		await messageRows(1);
		expect(screen.queryByTestId("traffic-kind-message")).toBeNull();
		expect(screen.queryByTestId("traffic-kind-task")).toBeNull();
		expect(screen.queryByTestId("traffic-kind-notification")).toBeNull();
		expect(screen.queryByTestId("traffic-count-message")).toBeNull();
		// The window's own Attempts stat is untouched by the gate.
		expect(document.querySelector(".traffic-summary")?.textContent).toContain("Attempts");
	});

	it("keeps the group hidden when the window is empty", async () => {
		setPage([]);
		renderLog();
		await waitFor(() =>
			expect(document.querySelector(".traffic-event-counter")?.textContent).toBe("0 / 0"),
		);
		expect(screen.queryByTestId("traffic-kind-message")).toBeNull();
	});
});

describe("AgentTrafficScreen presentation picker", () => {
	const nodeCards = () => screen.queryAllByTestId("traffic-node-card");
	const orbit = () => screen.queryByLabelText("Project traffic map");

	it("renders Experiment 2 when no preference was ever recorded", async () => {
		setPage([row()]);
		renderLog();
		await messageRows(1);
		expect(screen.getByTestId("traffic-experiment-2")).toHaveAttribute(
			"aria-checked",
			"true",
		);
		expect(nodeCards().length).toBeGreaterThan(0);
		expect(orbit()).toBeNull();
	});

	// An install that turned the feature on before the picker existed never chose a
	// presentation, so the old flag alone must not pin it to Experiment 1.
	it("keeps the default for an upgrade that only has the feature flag", async () => {
		settings.value = { experimentalAgentTraffic: true };
		setPage([row()]);
		renderLog();
		await messageRows(1);
		await waitFor(() =>
			expect(screen.getByTestId("traffic-experiment-2")).toHaveAttribute(
				"aria-checked",
				"true",
			),
		);
		expect(nodeCards().length).toBeGreaterThan(0);
	});

	it("honours a recorded pick of Experiment 1", async () => {
		settings.value = { agentTrafficExperiment: "1" };
		setPage([row()]);
		renderLog();
		await waitFor(() => expect(orbit()).not.toBeNull());
		expect(screen.getByTestId("traffic-experiment-1")).toHaveAttribute(
			"aria-checked",
			"true",
		);
		expect(nodeCards()).toHaveLength(0);
	});

	it("switches both ways and persists each pick, one stage mounted at a time", async () => {
		setPage([row()]);
		renderLog();
		await messageRows(1);
		await userEvent.click(screen.getByTestId("traffic-experiment-1"));
		expect(orbit()).not.toBeNull();
		expect(nodeCards()).toHaveLength(0);
		await waitFor(() =>
			expect(vi.mocked(api.request.saveGlobalSettings)).toHaveBeenCalledWith(
				expect.objectContaining({ agentTrafficExperiment: "1" }),
			),
		);
		await userEvent.click(screen.getByTestId("traffic-experiment-2"));
		expect(orbit()).toBeNull();
		expect(nodeCards().length).toBeGreaterThan(0);
		await waitFor(() =>
			expect(
				vi.mocked(api.request.saveGlobalSettings),
			).toHaveBeenLastCalledWith(
				expect.objectContaining({ agentTrafficExperiment: "2" }),
			),
		);
	});

	// Both stages read the same records, so a message that reaches one reaches the
	// other — and the message list stays the same in both.
	it("shows the same real traffic under either presentation", async () => {
		setPage([row({ subject: "Report baseline" })]);
		renderLog();
		expect((await messageRows(1))[0].textContent).toContain("Report baseline");
		expect(screen.getAllByText("Worker").length).toBeGreaterThan(0);
		await userEvent.click(screen.getByTestId("traffic-experiment-1"));
		expect((await messageRows(1))[0].textContent).toContain("Report baseline");
	});

	// A graph that re-arranges under the pointer is unreadable, so filtering and
	// selection change what is lit, never where anything sits.
	it("keeps every card in place when a selection narrows the messages", async () => {
		setPage([
			row(),
			row({ toTaskId: "task-c", toSeq: 33, toTitle: "Other worker" }),
		]);
		renderLog();
		await messageRows(2);
		const before = nodeCards().map((node) => (node as HTMLElement).style.left);
		const card = nodeCards().find((node) => node.textContent?.includes("#22"));
		await userEvent.click(card as HTMLElement);
		await messageRows(1);
		expect(nodeCards().map((node) => (node as HTMLElement).style.left)).toEqual(
			before,
		);
	});

	// The user's own board is mostly parked and mostly finished; both states have to
	// read off the card without opening anything.
	it("greys hibernated cards, puts them last, and marks finished ones", async () => {
		taskExtras.value = {
			"task-b": { status: "completed" },
			"task-c": { hibernated: true },
		};
		setPage([
			row(),
			row({ toTaskId: "task-c", toSeq: 33, toTitle: "Other worker" }),
		]);
		renderLog();
		await messageRows(2);
		await userEvent.click(screen.getByTestId("traffic-nodes-parked-toggle"));
		const cards = nodeCards() as HTMLElement[];
		const asleep = cards.find((card) =>
			card.textContent?.includes("#33"),
		) as HTMLElement;
		const done = cards.find((card) =>
			card.textContent?.includes("#22"),
		) as HTMLElement;
		expect(asleep.className).toContain("is-parked");
		expect(done.className).toContain("is-completed");
		expect(done.textContent).toContain("Completed");
		// Last band: nothing sits below a hibernated card.
		for (const other of cards.filter((card) => card !== asleep)) {
			expect(parseFloat(asleep.style.top)).toBeGreaterThan(
				parseFloat(other.style.top),
			);
		}
	});

	// The board census was the complaint: 43 cards, four wires. What is left out is
	// named on a chip and one click brings it back.
	it("leaves silent and hibernated tasks off the stage until asked", async () => {
		taskExtras.value = { "task-c": { hibernated: true } };
		setPage([row()]);
		renderLog();
		await messageRows(1);
		expect(nodeCards()).toHaveLength(2);
		const parkedToggle = screen.getByTestId("traffic-nodes-parked-toggle");
		expect(parkedToggle).toHaveAttribute("aria-pressed", "false");
		expect(parkedToggle.textContent).toContain("1");
		await userEvent.click(parkedToggle);
		expect(nodeCards()).toHaveLength(3);
		await userEvent.click(parkedToggle);
		expect(nodeCards()).toHaveLength(2);
	});

	it("selecting a card in Experiment 2 drives the shared inspector", async () => {
		setPage([row()]);
		renderLog();
		await messageRows(1);
		const card = nodeCards().find((node) => node.textContent?.includes("#22"));
		await userEvent.click(card as HTMLElement);
		const inspector = within(screen.getByRole("complementary"));
		expect(inspector.getByText("Current task overview")).toBeTruthy();
	});
});

describe("Coordination replay controls", () => {
	it("opens on the whole stage and reveals Focus when inspecting a task", async () => {
		setPage([row()]);
		renderLog();
		await waitFor(() =>
			expect(screen.getAllByTestId("traffic-node-card").length).toBeGreaterThan(
				0,
			),
		);
		expect(screen.queryByRole("complementary")).toBeNull();
		expect(
			screen
				.getByRole("button", { name: "Follow" })
				.getAttribute("aria-pressed"),
		).toBe("true");
		await userEvent.click(screen.getAllByTestId("traffic-node-card")[0]);
		expect(screen.getByRole("complementary")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Focus" }));
		expect(
			screen
				.getByRole("button", { name: "Follow" })
				.getAttribute("aria-pressed"),
		).toBe("false");
	});
	it("plays and steps actual messages, returns Live, and removes transport in Experiment 1", async () => {
		setPage([
			row({ subject: "Second exchange" }),
			row({
				at: new Date(Date.now() - 60000).toISOString(),
				subject: "First exchange",
			}),
		]);
		renderLog();
		const play = await screen.findByRole("button", { name: "Play replay" });
		await waitFor(() => expect(play.hasAttribute("disabled")).toBe(false));
		await userEvent.click(play);
		expect(screen.getByRole("button", { name: "Pause replay" })).toBeTruthy();
		expect(
			document.querySelector(".traffic-event-readout")?.textContent,
		).toContain("First exchange");
		await userEvent.click(screen.getByRole("button", { name: "Next message" }));
		expect(
			document.querySelector(".traffic-event-readout")?.textContent,
		).toContain("Second exchange");
		expect(screen.getByRole("button", { name: "Play replay" })).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Live" }));
		expect(document.querySelector(".traffic-edge-subject")).toBeNull();
		await userEvent.click(screen.getByTestId("traffic-experiment-1"));
		expect(screen.queryByRole("button", { name: "Play replay" })).toBeNull();
	});
});

describe("Space toggles the replay", () => {
	/** Two messages so the transport has something to play through. */
	function seedTwo() {
		setPage([
			row({ subject: "Second exchange" }),
			row({
				at: new Date(Date.now() - 60000).toISOString(),
				subject: "First exchange",
			}),
		]);
	}

	/** A raw keydown on the window — what a Space press from the stage looks like. */
	function pressSpace(over: Partial<KeyboardEventInit> = {}) {
		const event = new KeyboardEvent("keydown", {
			code: "Space",
			key: " ",
			bubbles: true,
			cancelable: true,
			...over,
		});
		act(() => {
			window.dispatchEvent(event);
		});
		return event;
	}

	it("plays from the start, pauses, and stops the page from scrolling", async () => {
		seedTwo();
		renderLog();
		const play = await screen.findByRole("button", { name: "Play replay" });
		await waitFor(() => expect(play.hasAttribute("disabled")).toBe(false));

		const started = pressSpace();
		expect(started.defaultPrevented).toBe(true);
		expect(screen.getByRole("button", { name: "Pause replay" })).toBeTruthy();
		expect(
			document.querySelector(".traffic-event-readout")?.textContent,
		).toContain("First exchange");

		pressSpace();
		expect(screen.getByRole("button", { name: "Play replay" })).toBeTruthy();
	});

	it("ignores a held key, a modifier and a composing IME", async () => {
		seedTwo();
		renderLog();
		const play = await screen.findByRole("button", { name: "Play replay" });
		await waitFor(() => expect(play.hasAttribute("disabled")).toBe(false));

		for (const over of [{ repeat: true }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }]) {
			expect(pressSpace(over).defaultPrevented).toBe(false);
		}
		expect(screen.getByRole("button", { name: "Play replay" })).toBeTruthy();
	});

	it("leaves the key to a search field and to the focused control", async () => {
		seedTwo();
		renderLog();
		const play = await screen.findByRole("button", { name: "Play replay" });
		await waitFor(() => expect(play.hasAttribute("disabled")).toBe(false));

		screen.getByRole("searchbox", { name: "Search tasks and messages" }).focus();
		expect(pressSpace().defaultPrevented).toBe(false);
		expect(screen.getByRole("button", { name: "Play replay" })).toBeTruthy();

		// A focused button activates on Space by itself; claiming the key here
		// would fire two different actions from one press.
		screen.getByRole("button", { name: "Messages" }).focus();
		expect(pressSpace().defaultPrevented).toBe(false);
		expect(screen.getByRole("button", { name: "Play replay" })).toBeTruthy();
	});

	it("stays out of the orbit, which has no replay to toggle", async () => {
		seedTwo();
		renderLog();
		await screen.findByRole("button", { name: "Play replay" });
		await userEvent.click(screen.getByTestId("traffic-experiment-1"));
		expect(pressSpace().defaultPrevented).toBe(false);
	});
});

it("Follow reveals its hibernated endpoint and replay never uses a future delivery verdict", async () => {
	taskExtras.value = { "task-b": { hibernated: true } };
	setPage([
		row({ subject: "Later failure", status: "not-delivered" }),
		row({
			at: new Date(Date.now() - 60000).toISOString(),
			subject: "Earlier delivery",
			status: "delivered",
		}),
	]);
	renderLog();
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: /^Replay$/ }).hasAttribute("disabled"),
		).toBe(false),
	);
	expect(
		screen
			.queryAllByTestId("traffic-node-card")
			.some((card) => card.textContent?.includes("#22")),
	).toBe(true);
	await userEvent.click(screen.getByRole("button", { name: /^Replay$/ }));
	expect(
		screen
			.getAllByTestId("traffic-node-card")
			.some((card) => card.classList.contains("is-parked")),
	).toBe(true);
	expect(
		document
			.querySelector(".traffic-wire.is-active")
			?.classList.contains("verdict-delivered"),
	).toBe(true);
	fireEvent.change(screen.getByRole("slider", { name: "Message timeline" }), {
		target: { value: "1" },
	});
	expect(
		document
			.querySelector(".traffic-wire.is-active")
			?.classList.contains("verdict-not-delivered"),
	).toBe(true);
});

it("Focus reveals a hibernated task selected from the task list without waking it", async () => {
	taskExtras.value = { "task-c": { hibernated: true } };
	setPage([row()]);
	renderLog();
	await messageRows(1);
	expect(screen.getAllByTestId("traffic-node-card")).toHaveLength(2);
	await userEvent.click(
		within(screen.getByRole("complementary")).getByRole("button", {
			name: "Tasks",
		}),
	);
	const task = Array.from(document.querySelectorAll(".traffic-task-row")).find(
		(el) => el.textContent?.includes("#33"),
	);
	await userEvent.click(task as HTMLElement);
	await userEvent.click(screen.getByRole("button", { name: "Focus" }));
	expect(screen.getAllByTestId("traffic-node-card")).toHaveLength(3);
	expect(
		screen
			.getAllByTestId("traffic-node-card")
			.find((el) => el.classList.contains("is-parked")),
	).toBeTruthy();
	expect(
		screen.getByRole("button", { name: "Follow" }).getAttribute("aria-pressed"),
	).toBe("false");
});

it("selects a full local calendar day, then Live restores 24h and Follow", async () => {
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);
	const earlier = new Date(yesterday);
	earlier.setMilliseconds(-1);
	setPage([
		row({ at: new Date().toISOString(), subject: "Current exchange" }),
		row({ at: yesterday.toISOString(), subject: "Midnight yesterday" }),
		row({
			at: new Date(today.getTime() - 1).toISOString(),
			subject: "End of yesterday",
		}),
		row({ at: earlier.toISOString(), subject: "Outside selected day" }),
	]);
	renderLog();
	await waitFor(() =>
		expect(screen.getByRole("button", { name: /^Replay$/ })).not.toBeDisabled(),
	);
	await userEvent.click(screen.getByRole("button", { name: "Follow" }));
	await userEvent.click(
		screen.getByRole("button", { name: "Time window: Last hour" }),
	);
	await userEvent.click(screen.getByRole("button", { name: "Yesterday" }));
	expect(
		(await messageRows(2)).map((el) => el.textContent).join(" "),
	).toContain("Midnight yesterday");
	expect(
		(await messageRows(2)).map((el) => el.textContent).join(" "),
	).not.toContain("Current exchange");
	expect(screen.getByRole("button", { name: "Follow" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	// Live is not part of the entry rule — it still returns to its own 24 hours.
	await userEvent.click(screen.getByRole("button", { name: "Live" }));
	expect(
		screen.getByRole("button", { name: "Time window: Last 24 hours" }),
	).toBeTruthy();
	expect(screen.getByRole("button", { name: "Follow" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
});

it("Follow settles once on the pair and holds the same framing for its reply", async () => {
	const media = vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
		matches: false,
		media: query,
		onchange: null,
		addEventListener: () => {},
		removeEventListener: () => {},
		addListener: () => {},
		removeListener: () => {},
		dispatchEvent: () => false,
	}));
	const size = { width: 1400, height: 640 };
	const clientWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => size.width);
	const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => size.height);
	let resize: ResizeObserverCallback | undefined;
	vi.stubGlobal("ResizeObserver", class {
		constructor(private callback: ResizeObserverCallback) {}
		observe(target: Element) { if (target.classList.contains("traffic-nodes")) resize = this.callback; }
		unobserve() {}
		disconnect() {}
	});

	let clock = 0,
		sequence = 0;
	const frames = new Map<number, FrameRequestCallback>();
	const time = vi.spyOn(performance, "now").mockImplementation(() => clock);
	const rect = vi
		.spyOn(HTMLElement.prototype, "getBoundingClientRect")
		.mockReturnValue({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: 1400,
			bottom: 640,
			width: 1400,
			height: 640,
			toJSON: () => ({}),
		});
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++sequence, callback);
		return sequence;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	const advance = (ms: number) => {
		clock += ms;
		act(() => {
			const pending = [...frames.values()];
			frames.clear();
			pending.forEach((callback) => callback(clock));
		});
	};
	setPage([
		row({
			fromTaskId: "task-b",
			toTaskId: "task-a",
			fromSeq: 22,
			toSeq: 11,
			subject: "Reply",
		}),
		row({ at: new Date(Date.now() - 60000).toISOString(), subject: "Request" }),
	]);
	const rendered = renderLog();
	try {
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: /^Replay$/ }),
			).not.toBeDisabled(),
		);
		advance(600);
		fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
		advance(600);
		fireEvent.click(screen.getByRole("button", { name: /^Replay$/ }));
		advance(250);
		const stage = screen.getByTestId("traffic-node-scene");
		const moving = stage.style.transform;
		advance(300);
		const settled = stage.style.transform;
		expect(settled).not.toBe(moving);
		advance(1000);
		expect(stage.style.transform).toBe(settled);
		fireEvent.click(screen.getByRole("button", { name: "Next message" }));
		advance(1600);
		expect(stage.style.transform).toBe(settled);
		size.width = 900;
		size.height = 360;
		act(() => resize?.([], {} as ResizeObserver));
		advance(600);
		expect(stage.style.transform).not.toBe(settled);
		const resized = stage.style.transform;
		fireEvent.click(screen.getByRole("button", { name: "Fit everything on screen" }));
		advance(600);
		expect(stage.style.transform).not.toBe(resized);
		expect(screen.getByRole("button", { name: "Follow" })).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(screen.getByRole("button", { name: "Follow" }));
		advance(600);
		fireEvent.click(screen.getByRole("button", { name: "Follow" }));
		const manual = stage.style.transform;
		size.width = 800;
		act(() => resize?.([], {} as ResizeObserver));
		advance(2000);
		expect(stage.style.transform).toBe(manual);
	} finally {
		rendered.unmount();
		clientWidth.mockRestore();
		clientHeight.mockRestore();
		media.mockRestore();
		time.mockRestore();
		rect.mockRestore();
		vi.unstubAllGlobals();
	}
});


it("All Projects replays a senderless message in another project and reveals its recipient", async () => {
	projectFixtures.value.push({ id: "proj-2", name: "Project Two" });
	additionalTasks.value = [{ id: "task-b", projectId: "proj-2", seq: 3, title: "Other project receiver", status: "in-progress" }];
	setPage([row({ at: new Date(Date.now() - 60000).toISOString(), subject: "First project message" })]);
	projectPages.value["proj-2"] = {
		...page.value,
		rows: [row({ fromTaskId: null, fromSeq: null, toTaskId: "task-b", toSeq: 3,
			toProjectId: "proj-2", subject: "Senderless second project message" })],
	};
	renderLog(vi.fn(), null);
	await waitFor(() => expect(screen.getByRole("button", { name: /^Replay$/ })).not.toBeDisabled());
	await waitFor(() => expect(screen.getAllByTestId("traffic-node-card").some(card => card.textContent?.includes("#3"))).toBe(true));
	expect(screen.getAllByTestId("traffic-node-card").some(card => card.textContent?.includes("#22"))).toBe(true);
	expect([...document.querySelectorAll(".traffic-project-heading")].map(el => el.textContent)).toEqual(["Project One", "Project Two"]);
	await userEvent.click(screen.getByRole("button", { name: /^Replay$/ }));
	await userEvent.click(screen.getByRole("button", { name: "Next message" }));
	const active = document.querySelectorAll(".traffic-node-card.is-lit");
	expect(active).toHaveLength(1);
	expect(active[0].textContent).toContain("Other project receiver");
	expect(document.querySelector(".traffic-edge-subject")?.textContent).toContain("Senderless second project message");
	expect(document.querySelector(".traffic-wire.is-active")).toBeNull();
});

it("Follow returns to overview after live inactivity and replay completion but keeps a manual pause", async () => {
	vi.useFakeTimers();
	const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1400);
	const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(640);
	const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1400, 640));
	setPage([row({ subject: "Current pair" }), row({ toTaskId: "task-c", toSeq: 33, at: new Date(Date.now() - 60000).toISOString() })]);
	const rendered = renderLog();
	try {
		await act(async () => { await vi.advanceTimersByTimeAsync(1); });
		// Live is where "inactivity returns to overview" applies; entry parks the
		// cursor at the start of the hour instead.
		fireEvent.click(screen.getByRole("button", { name: "Live" }));
		const stage = screen.getByTestId("traffic-node-scene");
		const pair = stage.style.transform;
		act(() => vi.advanceTimersByTime(3600));
		const overview = stage.style.transform;
		expect(overview).not.toBe(pair);
		fireEvent.click(screen.getByRole("button", { name: /^Replay$/ }));
		fireEvent.click(screen.getByRole("button", { name: "Next message" }));
		const paused = stage.style.transform;
		act(() => vi.advanceTimersByTime(10000));
		expect(stage.style.transform).toBe(paused);
		fireEvent.click(screen.getByRole("button", { name: /^Replay$/ }));
		act(() => vi.advanceTimersByTime(2200));
		act(() => vi.advanceTimersByTime(2200));
		act(() => vi.advanceTimersByTime(1));
		expect(stage.style.transform).toBe(overview);
		expect(document.querySelector(".traffic-edge-subject")).toBeNull();
	} finally {
		rendered.unmount();
		width.mockRestore(); height.mockRestore(); rect.mockRestore();
		vi.useRealTimers();
	}
});


it.each(["held", "delivered", "unconfirmed", "not-delivered"] as const)("%s message bubbles contain only the message and a tail", async (status) => {
	const subject = "Work finished with a question";
	setPage([row({ fromTaskId: null, fromSeq: null, status, subject })]);
	renderLog();
	await waitFor(() => expect(screen.getByRole("button", { name: /^Replay$/ })).not.toBeDisabled());
	await userEvent.click(screen.getByRole("button", { name: /^Replay$/ }));
	const bubble = document.querySelector(".traffic-edge-subject");
	expect(bubble?.textContent).toBe(subject);
	expect(bubble?.querySelector(".traffic-message-tail")).not.toBeNull();
	expect(bubble?.classList.contains("is-failed")).toBe(status === "not-delivered");
	expect(document.querySelector(".traffic-wire.is-active")).toBeNull();
});

it("minimap navigation hands camera control away from Follow", async () => {
	const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1400);
	const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(640);
	setPage([row()]);
	const rendered = renderLog();
	try {
		const map = await screen.findByRole("button", { name: "Canvas minimap" });
		const stage = screen.getByTestId("traffic-node-scene");
		const before = stage.style.transform;
		expect(document.querySelector(".traffic-nodes")).toHaveAttribute("data-follow", "true");
		map.focus();
		await userEvent.keyboard("{ArrowRight}");
		expect(stage.style.transform).not.toBe(before);
		expect(document.querySelector(".traffic-nodes")).toHaveAttribute("data-follow", "false");
	} finally {
		rendered.unmount(); width.mockRestore(); height.mockRestore();
	}
});

it.each(["held", "delivered", "unconfirmed", "not-delivered"] as const)("%s sends three round drops in order and keeps only failures short of the destination", async (status) => {
	vi.useFakeTimers();
	const media = vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
		matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {},
		addListener() {}, removeListener() {}, dispatchEvent: () => false,
	}));
	const frames = new Map<number, FrameRequestCallback>();
	let frameId = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	const advance = (ms: number) => act(() => {
		vi.advanceTimersByTime(ms);
		const pending = [...frames.values()]; frames.clear();
		pending.forEach(callback => callback(performance.now()));
	});
	setPage([row({ status })]);
	const rendered = renderLog();
	try {
		await act(async () => { await vi.advanceTimersByTimeAsync(1); });
		// Entry autoplays the trailing hour; this test is about the live flights, so
		// hand the cursor back to Live before stepping.
		fireEvent.click(screen.getByRole("button", { name: "Live" }));
		fireEvent.click(screen.getByRole("button", { name: "Next message" }));
		advance(0);
		expect(document.querySelectorAll("circle.traffic-flight")).toHaveLength(1);
		advance(500);
		expect(document.querySelectorAll("circle.traffic-flight")).toHaveLength(2);
		advance(500);
		expect(document.querySelectorAll("circle.traffic-flight")).toHaveLength(3);
		const positions = [...document.querySelectorAll("circle.traffic-flight")].map(el => el.getAttribute("transform"));
		expect(new Set(positions).size).toBe(3);
		advance(200);
		const destination = document.querySelector(".traffic-wire.is-active")!.getAttribute("d")!.match(/-?\d+(?:\.\d+)?/g)!.slice(-2).map(Number);
		const arrived = document.querySelector("circle.traffic-flight")!.getAttribute("transform")!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
		if (status === "not-delivered") expect(arrived).not.toEqual(destination);
		else expect(arrived).toEqual(destination);
		advance(1300);
		expect(document.querySelectorAll(".traffic-flight")).toHaveLength(0);
	} finally {
		rendered.unmount(); media.mockRestore(); vi.unstubAllGlobals(); vi.useRealTimers();
	}
});
