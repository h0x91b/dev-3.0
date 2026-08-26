import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentMessageLogPage, AgentMessageLogRow } from "../../shared/agent-message-log";
import { I18nProvider } from "../i18n";
import { resetTrafficSeen, resetTrafficStore } from "../agent-traffic";
import { setAgentTrafficEnabledForTests } from "../agent-traffic-flag";
import AgentTrafficIndicator from "../components/agent-traffic/AgentTrafficIndicator";
import AgentTrafficLog from "../components/agent-traffic/AgentTrafficLog";

const page: { value: AgentMessageLogPage } = {
	value: { rows: [], oldestDay: null, retentionDays: 30, hasMore: false },
};

const knownTaskIds: { value: string[] } = { value: ["task-a", "task-b", "task-c"] };

vi.mock("../rpc", () => ({
	api: {
		request: {
			readAgentMessageLog: vi.fn(() => Promise.resolve(page.value)),
			// The log resolves which receivers still exist before promising navigation.
			getTasks: vi.fn(() => Promise.resolve(knownTaskIds.value.map((id) => ({ id })))),
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
			<AgentTrafficIndicator projectId="proj-1" navigate={vi.fn()} onOpenLog={vi.fn()} />
		</I18nProvider>,
	);
}

describe("AgentTrafficIndicator (bar)", () => {
	// The bar slot is earned per occasion. Nothing new means no pill: the kebab row
	// is the control's home, and a permanent number nobody acts on is the header
	// button creep the manifest names as this app's top anti-pattern.
	it("renders nothing while there is nothing new", async () => {
		setPage([row()]);
		renderIndicator();
		await waitFor(() => expect(page.value.rows).toHaveLength(1));
		expect(screen.queryByTestId("agent-traffic-indicator")).toBeNull();
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

	// Looking is reading, so opening the panel retires the badge — but the pill has
	// to outlive it: clearing mid-click used to take the panel down with it.
	it("survives its own badge while the panel is open, then goes", async () => {
		withUnread();
		setPage([row()]);
		renderIndicator();
		await userEvent.click(await screen.findByTestId("agent-traffic-indicator"));
		expect(await screen.findByTestId("agent-traffic-popover")).toBeTruthy();
		// Still on the bar because its panel is, but carrying no number: a "0" badge
		// reads as a counter that broke.
		expect(screen.getByTestId("agent-traffic-indicator").textContent).not.toContain("0");

		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByTestId("agent-traffic-indicator")).toBeNull());
	});

	it("opens a panel listing each pair, and offers the log", async () => {
		withUnread();
		setPage([row()]);
		const onOpenLog = vi.fn();
		render(
			<I18nProvider>
				<AgentTrafficIndicator projectId="proj-1" navigate={vi.fn()} onOpenLog={onOpenLog} />
			</I18nProvider>,
		);
		await userEvent.click(await screen.findByTestId("agent-traffic-indicator"));
		expect(await screen.findByTestId("agent-traffic-popover")).toBeTruthy();
		expect(screen.getAllByTestId("traffic-pair-row")).toHaveLength(1);

		await userEvent.click(screen.getByTestId("traffic-open-log"));
		expect(onOpenLog).toHaveBeenCalled();
	});

	// ⇧⌘M / the View menu / the palette open the log without going through the
	// panel, and the panel is portaled above the dialog — it used to hang over the
	// log it had just handed off to.
	it("closes its panel when the log is opened from anywhere else", async () => {
		withUnread();
		setPage([row()]);
		renderIndicator();
		await userEvent.click(await screen.findByTestId("agent-traffic-indicator"));
		expect(await screen.findByTestId("agent-traffic-popover")).toBeTruthy();
		window.dispatchEvent(new CustomEvent("open-agent-traffic-log"));
		await waitFor(() => expect(screen.queryByTestId("agent-traffic-popover")).toBeNull());
	});

	// The click goes where the answer is owed — the receiver's task, whose pane holds
	// the text — not to the sender that is already done talking.
	it("navigates to the task that owes the answer", async () => {
		withUnread();
		setPage([row()]);
		const navigate = vi.fn();
		render(
			<I18nProvider>
				<AgentTrafficIndicator projectId="proj-1" navigate={navigate} onOpenLog={vi.fn()} />
			</I18nProvider>,
		);
		await userEvent.click(await screen.findByTestId("agent-traffic-indicator"));
		await userEvent.click(screen.getByTestId("traffic-pair-row"));
		expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "proj-1", activeTaskId: "task-b" });
	});
});

describe("AgentTrafficIndicator (kebab row)", () => {
	function renderRow(variant: "menu" | "sheet" = "menu") {
		return render(
			<I18nProvider>
				<AgentTrafficIndicator projectId="proj-1" navigate={vi.fn()} onOpenLog={vi.fn()} variant={variant} />
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

describe("AgentTrafficLog", () => {
	it("lists every message, not just the live ones", async () => {
		setPage([
			row({ at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), body: "last week" }),
			row({ body: "just now" }),
		]);
		renderLog();
		await waitFor(() => expect(screen.getAllByTestId("traffic-ledger-row")).toHaveLength(2));
	});

	// The one honest filter: the delivery verdict is recorded per row. There is
	// deliberately no importance filter, because no sender can set importance.
	it("filters down to messages dev3 could not prove landed", async () => {
		setPage([row({ status: "delivered" }), row({ status: "unconfirmed", body: "maybe lost" })]);
		renderLog();
		await waitFor(() => expect(screen.getAllByTestId("traffic-ledger-row")).toHaveLength(2));
		await userEvent.click(screen.getByText("Unproven only"));
		const rows = screen.getAllByTestId("traffic-ledger-row");
		expect(rows).toHaveLength(1);
		expect(rows[0].textContent).toContain("maybe lost");
	});

	it("narrows the ledger to one pair, and back again", async () => {
		setPage([row(), row({ toTaskId: "task-c", toSeq: 33, body: "other pair" })]);
		renderLog();
		await waitFor(() => expect(screen.getAllByTestId("traffic-pair-row")).toHaveLength(2));
		await userEvent.click(screen.getAllByTestId("traffic-pair-row")[0]);
		expect(screen.getAllByTestId("traffic-ledger-row")).toHaveLength(1);
		await userEvent.click(screen.getAllByTestId("traffic-pair-row")[0]);
		expect(screen.getAllByTestId("traffic-ledger-row")).toHaveLength(2);
	});

	// Trimmed history has to read as trimmed. Without this line a 30-day window
	// looks like "the agents never spoke before that day".
	it("states the retention window and the oldest day still on disk", async () => {
		setPage([row()]);
		renderLog();
		expect(await screen.findByText(/2026-08-01/)).toBeTruthy();
	});

	// A body too large to type never had text to show; the row must say that rather
	// than render an empty message.
	it("names a spilled body instead of showing nothing", async () => {
		setPage([row({ bodyKind: "spill-pointer", body: "", spillPath: "/tmp/spill.txt" })]);
		renderLog();
		expect(await screen.findByText(/written to a file/i)).toBeTruthy();
	});

	// A 30-day log outlives tasks. A row that closes the log and changes nothing
	// reads as a broken app, so the row keeps its text and drops its click.
	it("does not promise navigation to a task that no longer exists", async () => {
		knownTaskIds.value = ["task-a"];
		setPage([row()]);
		const onOpenTask = vi.fn();
		renderLog(onOpenTask);
		const ledger = await screen.findByTestId("traffic-ledger-row");
		await waitFor(() => expect(ledger.getAttribute("data-gone")).toBe("true"));
		expect(ledger.textContent).toContain("rebase before you push");
		await userEvent.click(ledger);
		expect(onOpenTask).not.toHaveBeenCalled();
	});

	it("opens the receiving task from a ledger row", async () => {
		setPage([row()]);
		const onOpenTask = vi.fn();
		renderLog(onOpenTask);
		await waitFor(() => expect(screen.getAllByTestId("traffic-ledger-row")).toHaveLength(1));
		await userEvent.click(screen.getAllByTestId("traffic-ledger-row")[0]);
		expect(onOpenTask).toHaveBeenCalledWith("task-b", "proj-1");
	});
});
