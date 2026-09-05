import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentMessageLogPage, AgentMessageLogRow } from "../../shared/agent-message-log";
import { I18nProvider } from "../i18n";
import { noteTrafficArrival, resetTrafficSeen, resetTrafficStore } from "../agent-traffic";
import { setAgentTrafficEnabledForTests } from "../agent-traffic-flag";
import AgentTrafficIndicator from "../components/agent-traffic/AgentTrafficIndicator";
import AgentTrafficLog from "../components/agent-traffic/AgentTrafficLog";
import { api } from "../rpc";

vi.mock("../components/agent-traffic/TrafficOrbit", () => ({ default: () => <div aria-label="Project traffic map" /> }));

const page: { value: AgentMessageLogPage } = {
	value: { rows: [], oldestDay: null, retentionDays: 30, hasMore: false },
};

const knownTaskIds: { value: string[] } = { value: ["task-a", "task-b", "task-c"] };

vi.mock("../rpc", () => ({
	api: {
		request: {
			readAgentMessageLog: vi.fn(() => Promise.resolve(page.value)),
			getProjects: vi.fn(() => Promise.resolve([{ id: "proj-1", name: "Project One" }])),
			getTasks: vi.fn(() => Promise.resolve(knownTaskIds.value.map((id, index) => ({
				id, projectId: "proj-1", seq: (index + 1) * 11, title: id === "task-a" ? "Coordinator" : id === "task-b" ? "Worker" : "Other worker",
				status: "in-progress", taskType: id === "task-a" ? "coordinator" : null, overview: "Current task overview",
			})))),
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

function setPage(rows: AgentMessageLogRow[], over: Partial<AgentMessageLogPage> = {}) {
	page.value = { rows, oldestDay: rows.length ? "2026-08-01" : null, retentionDays: 30, hasMore: false, ...over };
}

beforeEach(() => {
	vi.clearAllMocks();
	resetTrafficStore();
	resetTrafficSeen();
	setPage([]);
	knownTaskIds.value = ["task-a", "task-b", "task-c"];
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
	localStorage.setItem("dev3-agent-traffic-seen", String(Date.now() - 60 * 60 * 1000));
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
		render(<I18nProvider><AgentTrafficIndicator projectId="proj-1" onOpenLog={onOpenLog} /></I18nProvider>);
		const pill = await screen.findByTestId("agent-traffic-indicator");
		expect(pill.textContent).toContain("1");
		await userEvent.click(pill);
		expect(onOpenLog).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId("agent-traffic-popover")).toBeNull();
		expect(screen.getByTestId("agent-traffic-indicator").textContent).not.toContain("1");
		expect(pill.getAttribute("aria-haspopup")).toBe("dialog");
		expect(pill.getAttribute("title")).toBe("Open agent traffic");
	});
});

describe("AgentTrafficIndicator (kebab row)", () => {
	function renderRow(variant: "menu" | "sheet" = "menu") {
		return render(
			<I18nProvider>
				<AgentTrafficIndicator projectId="proj-1" onOpenLog={vi.fn()} variant={variant} />
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
		expect((await screen.findByTestId("agent-traffic-menu-badge")).textContent).toBe("2");
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
		expect((await screen.findByTestId("agent-traffic-menu-badge")).textContent).toBe("9+");
	});
});

function renderLog(onOpenTask = vi.fn()) {
	return render(
		<I18nProvider>
			<AgentTrafficLog projectId="proj-1" onClose={vi.fn()} onOpenTask={onOpenTask} />
		</I18nProvider>,
	);
}

async function choose(label: string, option: string) {
	await userEvent.click(screen.getByRole("combobox", { name: label }));
	await userEvent.click(await screen.findByRole("option", { name: option }));
}

async function messageRows(count: number) {
	await waitFor(() => expect(screen.getAllByTestId("traffic-message-row")).toHaveLength(count));
	return screen.getAllByTestId("traffic-message-row");
}

describe("AgentTrafficLog live orbit", () => {
	it("shows persisted traffic from the last 24 hours immediately, with older history available", async () => {
		setPage([
			row({ at: new Date(Date.now() - 5 * 86400000).toISOString(), subject: "Five days ago" }),
			row({ at: new Date(Date.now() - 20 * 3600000).toISOString(), subject: "Earlier today" }),
		]);
		renderLog();
		expect((await messageRows(1))[0].textContent).toContain("Earlier today");
		expect(screen.getByRole("combobox", { name: "Time window" }).textContent).toContain("Last 24 hours");
		await choose("Time window", "Loaded history");
		expect((await messageRows(2)).some(element => element.textContent?.includes("Five days ago"))).toBe(true);
	});

	it.each([
		["delivered", "Delivered"], ["held", "Held"], ["unconfirmed", "Unconfirmed"], ["not-delivered", "Not delivered"],
	] as const)("retains and filters the %s delivery verdict", async (status, label) => {
		setPage(["delivered", "held", "unconfirmed", "not-delivered"].map((value) => row({ status: value as AgentMessageLogRow["status"], subject: `${value} attempt` })));
		renderLog();
		await messageRows(4);
		await choose("Delivery status", label);
		const [message] = await messageRows(1);
		expect(message.textContent).toContain(`${status} attempt`);
		await userEvent.click(message);
		const inspector = screen.getByRole("complementary", { name: "Task and message details" });
		expect(within(inspector).getByText(label)).toBeTruthy();
		if (status === "delivered") expect(inspector.textContent).toContain("not a read receipt");
		if (status === "held") expect(inspector.textContent).toContain("does not show whether it is still queued");
	});

	it("selects one pair from message details and clears the filter", async () => {
		setPage([row({ subject: "First pair" }), row({ toTaskId: "task-c", toSeq: 33, subject: "Other pair" })]);
		renderLog();
		await userEvent.click((await messageRows(2))[0]);
		await userEvent.click(screen.getByRole("button", { name: "Show this pair" }));
		expect(await messageRows(1)).toHaveLength(1);
		await userEvent.click(screen.getByRole("button", { name: "Clear selection" }));
		await messageRows(2);
	});

	it("states retention and the oldest stored day, including partial-page evidence", async () => {
		setPage([row()], { hasMore: true });
		renderLog();
		expect(await screen.findByText(/2026-08-01/)).toBeTruthy();
		expect(screen.getByText(/30 days/)).toBeTruthy();
		expect(screen.getByText(/Older rows remain to be loaded/)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Load older messages" }));
		await waitFor(() => expect(api.request.readAgentMessageLog).toHaveBeenCalledWith({ projectId: "proj-1", limit: 1000 }));
	});

	it("leads with the full subject and reveals the full stored body on selection", async () => {
		const subject = "A complete subject that must remain readable without an ellipsis";
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
		expect((await messageRows(1))[0].textContent).toContain("Legacy message body");
	});

	it("exposes spilled body evidence in message details", async () => {
		setPage([row({ subject: "Large report", bodyKind: "spill-pointer", body: "Read the report file", spillPath: "/tmp/spill.txt" })]);
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
		expect(document.querySelector("pre")?.textContent).toBe("rebase before you push");
		expect(onOpenTask).not.toHaveBeenCalled();
	});

	it("opens the receiver only from its explicit action, not message selection", async () => {
		setPage([row()]);
		const onOpenTask = vi.fn();
		renderLog(onOpenTask);
		await userEvent.click((await messageRows(1))[0]);
		expect(onOpenTask).not.toHaveBeenCalled();
		await userEvent.click(await screen.findByRole("button", { name: "Open task" }));
		expect(onOpenTask).toHaveBeenCalledWith("task-b", "proj-1");
	});

	it("offers task inspection and navigation without WebGL", async () => {
		setPage([row()]);
		const onOpenTask = vi.fn();
		renderLog(onOpenTask);
		await messageRows(1);
		await userEvent.click(screen.getByRole("button", { name: "Tasks" }));
		await userEvent.click(await screen.findByRole("button", { name: /#22 Worker/ }));
		expect(screen.getByText("Current task overview")).toBeTruthy();
		expect(onOpenTask).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Open task" }));
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
		expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("Report");
	});

	it("shows a load error and recovers on retry", async () => {
		vi.mocked(api.request.getProjects).mockRejectedValueOnce(new Error("offline"));
		setPage([row({ subject: "Recovered report" })]);
		renderLog();
		expect(await screen.findByRole("alert")).toHaveTextContent("Some traffic data could not be loaded");
		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect((await messageRows(1))[0].textContent).toContain("Recovered report");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("removes navigation when a task is deleted while its details stay open", async () => {
		setPage([row()]);
		renderLog();
		await userEvent.click((await messageRows(1))[0]);
		expect(await screen.findByRole("button", { name: "Open task" })).toBeTruthy();
		act(() => window.dispatchEvent(new CustomEvent("rpc:taskRemoved", { detail: { projectId: "proj-1", taskId: "task-b" } })));
		expect(screen.queryByRole("button", { name: "Open task" })).toBeNull();
		expect(screen.getByText(/This task no longer exists/)).toBeTruthy();
	});
});
