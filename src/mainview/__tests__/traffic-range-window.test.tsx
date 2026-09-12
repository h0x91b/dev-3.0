/**
 * Dragging the ruler is the same window the presets write, not a second one.
 *
 * The screen is rendered whole here rather than the ruler alone: the thing worth
 * proving is that a dragged interval reaches the message list, the period
 * trigger and the live/history readout, and that picking a preset afterwards
 * simply overwrites it.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
	AgentMessageLogPage,
	AgentMessageLogRow,
} from "../../shared/agent-message-log";
import { I18nProvider } from "../i18n";
import { resetTrafficStore } from "../agent-traffic";
import { setAgentTrafficEnabledForTests } from "../agent-traffic-flag";
import AgentTrafficScreen from "../components/agent-traffic/AgentTrafficScreen";

vi.mock("../components/agent-traffic/TrafficOrbit", () => ({
	default: () => <div aria-label="Project traffic map" />,
}));
vi.mock("../components/agent-traffic/TrafficNodes", () => ({
	default: () => <div data-testid="traffic-nodes" />,
}));

const page: { value: AgentMessageLogPage } = {
	value: { rows: [], oldestDay: null, retentionDays: 30, hasMore: false },
};

vi.mock("../rpc", () => ({
	api: {
		request: {
			readAgentMessageLog: vi.fn(() => Promise.resolve(page.value)),
			getGlobalSettings: vi.fn(() => Promise.resolve({})),
			saveGlobalSettings: vi.fn(() => Promise.resolve()),
			getProjects: vi.fn(() =>
				Promise.resolve([{ id: "proj-1", name: "Project One" }]),
			),
			getTasks: vi.fn(() =>
				Promise.resolve([
					{
						id: "task-a",
						projectId: "proj-1",
						seq: 11,
						title: "Coordinator",
						status: "in-progress",
						taskType: "coordinator",
					},
					{
						id: "task-b",
						projectId: "proj-1",
						seq: 22,
						title: "Worker",
						status: "in-progress",
					},
				]),
			),
		},
	},
}));

const MINUTE = 60000;
const WIDTH = 600;
const NOW = Date.now();

function row(minutesAgo: number, subject: string): AgentMessageLogRow {
	return {
		v: 1,
		at: new Date(NOW - minutesAgo * MINUTE).toISOString(),
		fromTaskId: "task-a",
		fromSeq: 11,
		fromTitle: "Coordinator",
		toTaskId: "task-b",
		toSeq: 22,
		toTitle: "Worker",
		toProjectId: "proj-1",
		kind: "immediate",
		subject,
		body: subject,
		bodyKind: "text",
		status: "delivered",
	};
}

let restoreRect: () => void;

beforeEach(() => {
	vi.clearAllMocks();
	resetTrafficStore();
	setAgentTrafficEnabledForTests(true);
	page.value = {
		// Newest first, the order the log itself returns.
		rows: [
			row(10, "ten minutes ago"),
			row(30, "half an hour ago"),
			row(50, "fifty minutes ago"),
			row(120, "two hours ago"),
			row(300, "five hours ago"),
		],
		oldestDay: "2026-08-01",
		retentionDays: 30,
		hasMore: false,
	};
	const original = Element.prototype.getBoundingClientRect;
	Element.prototype.getBoundingClientRect = function () {
		return this.classList?.contains("traffic-range-track")
			? ({
					left: 0,
					top: 0,
					width: WIDTH,
					height: 18,
					right: WIDTH,
					bottom: 18,
					x: 0,
					y: 0,
					toJSON: () => ({}),
				} as DOMRect)
			: original.call(this);
	};
	restoreRect = () => {
		Element.prototype.getBoundingClientRect = original;
	};
});

afterEach(() => {
	restoreRect();
	setAgentTrafficEnabledForTests(false);
});

function renderScreen() {
	return render(
		<I18nProvider>
			<AgentTrafficScreen projectId="proj-1" onOpenTask={vi.fn()} />
		</I18nProvider>,
	);
}

async function messageRows(count: number) {
	if (document.querySelector(".traffic-inspector")?.hasAttribute("hidden"))
		await userEvent.click(screen.getByRole("button", { name: "Messages" }));
	await waitFor(() =>
		expect(screen.getAllByTestId("traffic-message-row")).toHaveLength(count),
	);
}

/** Drag the named end of the band to a pixel position on the stubbed track. */
function dragHandle(testId: string, from: number, to: number) {
	fireEvent.pointerDown(screen.getByTestId(testId), {
		clientX: from,
		button: 0,
	});
	fireEvent.pointerMove(window, { clientX: to });
	fireEvent.pointerUp(window, { clientX: to });
}

describe("dragging the traffic time range", () => {
	it("opens on the trailing hour with the ruler drawn around it", async () => {
		renderScreen();
		await screen.findByTestId("traffic-range");
		await messageRows(3);
		expect(screen.getByRole("button", { name: /Last hour/ })).toBeTruthy();
	});

	it("widens the window when the start handle is dragged back", async () => {
		renderScreen();
		await screen.findByTestId("traffic-range");
		await messageRows(3);
		dragHandle("traffic-range-start", WIDTH * 0.667, 0);
		// The two-hour-old message is inside the widened window; the five-hour-old
		// one is still outside the ruler's own span, so it stays out.
		await messageRows(4);
		expect(screen.queryByRole("button", { name: /Last hour/ })).toBeNull();
	});

	it("stops calling itself live once the window is a fixed interval", async () => {
		renderScreen();
		await screen.findByTestId("traffic-range");
		await messageRows(3);
		expect(document.querySelector(".traffic-live")?.textContent).toBe("Live");
		dragHandle("traffic-range-end", WIDTH, WIDTH * 0.9);
		await waitFor(() =>
			expect(document.querySelector(".traffic-live")?.textContent).toBe(
				"History",
			),
		);
	});

	it("lets a preset overwrite a dragged range — one window, not two", async () => {
		renderScreen();
		await screen.findByTestId("traffic-range");
		await messageRows(3);
		dragHandle("traffic-range-start", WIDTH * 0.667, 0);
		await messageRows(4);
		await userEvent.click(
			screen.getByRole("button", { name: /Time window/ }),
		);
		await userEvent.click(
			await screen.findByRole("button", { name: "Last hour" }),
		);
		await messageRows(3);
		expect(screen.getByRole("button", { name: /Last hour/ })).toBeTruthy();
	});

	it("adjusts the window from the keyboard as well as the pointer", async () => {
		renderScreen();
		await screen.findByTestId("traffic-range");
		await messageRows(3);
		const start = screen.getByTestId("traffic-range-start");
		const before = Number(start.getAttribute("aria-valuenow"));
		fireEvent.keyDown(start, { key: "Home" });
		await waitFor(() =>
			expect(
				Number(screen.getByTestId("traffic-range-start").getAttribute("aria-valuenow")),
			).toBeLessThan(before),
		);
		await messageRows(4);
	});
});
