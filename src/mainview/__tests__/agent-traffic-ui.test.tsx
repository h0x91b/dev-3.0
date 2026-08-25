import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentMessageLogPage, AgentMessageLogRow } from "../../shared/agent-message-log";
import { I18nProvider } from "../i18n";
import { resetTrafficStore } from "../agent-traffic";
import AgentTrafficIndicator from "../components/agent-traffic/AgentTrafficIndicator";
import AgentTrafficLog from "../components/agent-traffic/AgentTrafficLog";

const page: { value: AgentMessageLogPage } = {
	value: { rows: [], oldestDay: null, retentionDays: 30, hasMore: false },
};

vi.mock("../rpc", () => ({
	api: {
		request: {
			readAgentMessageLog: vi.fn(() => Promise.resolve(page.value)),
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
	setPage([]);
});

function renderIndicator() {
	return render(
		<I18nProvider>
			<AgentTrafficIndicator projectId="proj-1" navigate={vi.fn()} onOpenLog={vi.fn()} />
		</I18nProvider>,
	);
}

describe("AgentTrafficIndicator", () => {
	// The header's permanent ambient slot belongs to memory headroom. Silence is the
	// normal state here, so a board with no traffic must carry no glyph at all —
	// otherwise this is one more dead control in a header the manifest already
	// warns is crowded.
	it("renders nothing while no agent is talking", async () => {
		renderIndicator();
		await waitFor(() => expect(page.value.rows).toHaveLength(0));
		expect(screen.queryByTestId("agent-traffic-indicator")).toBeNull();
	});

	it("appears with the live pair count once agents talk", async () => {
		setPage([row(), row({ toTaskId: "task-c", toSeq: 33 })]);
		renderIndicator();
		const pill = await screen.findByTestId("agent-traffic-indicator");
		expect(pill.textContent).toContain("2");
		// Never colour-and-number only: the count needs a name a screen reader reads.
		expect(pill.getAttribute("aria-label")).toBeTruthy();
	});

	// A pair that went quiet long ago is history, and history lives in the log.
	it("forgets a pair that stopped talking before the live window", async () => {
		setPage([row({ at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() })]);
		renderIndicator();
		await waitFor(() => expect(page.value.rows).toHaveLength(1));
		expect(screen.queryByTestId("agent-traffic-indicator")).toBeNull();
	});

	it("opens a panel listing each pair, and offers the log", async () => {
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

	// The click goes where the answer is owed — the receiver's task, whose pane holds
	// the text — not to the sender that is already done talking.
	it("navigates to the task that owes the answer", async () => {
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

	it("opens the receiving task from a ledger row", async () => {
		setPage([row()]);
		const onOpenTask = vi.fn();
		renderLog(onOpenTask);
		await waitFor(() => expect(screen.getAllByTestId("traffic-ledger-row")).toHaveLength(1));
		await userEvent.click(screen.getAllByTestId("traffic-ledger-row")[0]);
		expect(onOpenTask).toHaveBeenCalledWith("task-b", "proj-1");
	});
});
