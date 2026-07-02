import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductivityStatEvent } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import ProductivityStatsView from "../ProductivityStatsView";

vi.mock("../../rpc", () => ({
	api: { request: { getProductivityStats: vi.fn(), getAgentUsage: vi.fn() } },
}));

import { api } from "../../rpc";
const mockGet = api.request.getProductivityStats as unknown as ReturnType<typeof vi.fn>;
const mockUsage = api.request.getAgentUsage as unknown as ReturnType<typeof vi.fn>;

const DAY = 86_400_000;

function ev(over: Partial<ProductivityStatEvent> = {}): ProductivityStatEvent {
	return {
		taskId: "t" + Math.round(Math.random() * 1e9),
		projectId: "p1",
		projectName: "Proj A",
		projectKind: "git",
		title: "task",
		status: "completed",
		createdAt: new Date(Date.now() - 3 * DAY).toISOString(),
		movedAt: new Date(Date.now() - 1 * DAY).toISOString(),
		insertions: 10,
		deletions: 2,
		files: 1,
		liveStats: false,
		agentId: "claude",
		groupId: null,
		variantIndex: null,
		...over,
	};
}

function renderView() {
	return render(
		<I18nProvider>
			<ProductivityStatsView navigate={vi.fn()} goBack={vi.fn()} canGoBack={false} />
		</I18nProvider>,
	);
}

describe("ProductivityStatsView", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		// Default: no agent usage on disk (the two usage counters stay hidden).
		mockUsage.mockResolvedValue({ days: [], generatedAt: new Date().toISOString(), hasUnpricedModels: false });
	});

	it("shows the empty state when there are no events", async () => {
		mockGet.mockResolvedValue({ events: [], generatedAt: new Date().toISOString() });
		renderView();
		expect(await screen.findByText("Ship your first task to light up the cockpit")).toBeInTheDocument();
	});

	it("renders the cockpit with hero captions and the time-range switch when data exists", async () => {
		mockGet.mockResolvedValue({
			events: [ev(), ev({ projectId: "p2", projectName: "Proj B" })],
			generatedAt: new Date().toISOString(),
		});
		renderView();

		// Title + a hero caption appear once data resolves.
		expect(await screen.findByText("Productivity")).toBeInTheDocument();
		expect(await screen.findByText("Tasks shipped")).toBeInTheDocument();
		// Time range switch options.
		expect(screen.getByRole("tab", { name: "Week" })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "All" })).toBeInTheDocument();
		// Per-project section heading.
		expect(screen.getByText("By project")).toBeInTheDocument();
	});

	it("shows an error state with a retry when the RPC fails", async () => {
		mockGet.mockRejectedValue(new Error("boom"));
		renderView();
		expect(await screen.findByText("Couldn't load stats")).toBeInTheDocument();
	});

	it("navigates to a past period via the ‹ arrow", async () => {
		// One recent + one shipped 10 days ago, so there is older data to step into.
		mockGet.mockResolvedValue({
			events: [
				ev(),
				ev({
					movedAt: new Date(Date.now() - 10 * DAY).toISOString(),
					createdAt: new Date(Date.now() - 20 * DAY).toISOString(),
				}),
			],
			generatedAt: new Date().toISOString(),
		});
		renderView();
		// Default range is "week" → navigator shows "This week".
		expect(await screen.findByText("This week")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Previous period" }));
		expect(await screen.findByText("Last week")).toBeInTheDocument();
	});

	it("hides the period navigator for the All range", async () => {
		mockGet.mockResolvedValue({ events: [ev()], generatedAt: new Date().toISOString() });
		renderView();
		expect(await screen.findByRole("group", { name: "Time period" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("tab", { name: "All" }));
		expect(screen.queryByRole("group", { name: "Time period" })).not.toBeInTheDocument();
	});

	it("renders the speedometer cockpit (not the compact grid) on wide viewports", async () => {
		mockGet.mockResolvedValue({ events: [ev()], generatedAt: new Date().toISOString() });
		renderView();
		// Wait for data, then confirm the desktop gauge branch is used.
		expect(await screen.findByText("Tasks shipped")).toBeInTheDocument();
		expect(screen.queryByTestId("hero-stats-compact")).not.toBeInTheDocument();
	});

	it("shows token + API-cost counters when agent usage exists in the period", async () => {
		mockGet.mockResolvedValue({ events: [ev()], generatedAt: new Date().toISOString() });
		const now = new Date();
		const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		mockUsage.mockResolvedValue({
			days: [
				{
					date: `${now.getFullYear()}-01-01`,
					startMs: midnight,
					source: "claude",
					inputTokens: 1_000_000,
					outputTokens: 500_000,
					cacheCreationInputTokens: 0,
					cacheReadInputTokens: 0,
					costUsd: 17.5,
					fullyPriced: true,
				},
			],
			generatedAt: new Date().toISOString(),
			hasUnpricedModels: false,
		});
		renderView();
		expect(await screen.findByText("Tokens used")).toBeInTheDocument();
		expect(screen.getByText("~API cost")).toBeInTheDocument();
		expect(screen.getByText("$17.50")).toBeInTheDocument();
	});

	it("hides the usage counters when no agent usage is on disk", async () => {
		mockGet.mockResolvedValue({ events: [ev()], generatedAt: new Date().toISOString() });
		renderView();
		expect(await screen.findByText("Productivity")).toBeInTheDocument();
		expect(screen.queryByText("~API cost")).not.toBeInTheDocument();
	});
});

describe("ProductivityStatsView narrow viewport", () => {
	const originalInnerWidth = window.innerWidth;
	const originalMatchMedia = window.matchMedia;

	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		mockUsage.mockResolvedValue({ days: [], generatedAt: new Date().toISOString(), hasUnpricedModels: false });
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			value: (query: string) => ({
				matches: true,
				media: query,
				onchange: null,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
				dispatchEvent: vi.fn(),
			}),
		});
	});

	afterEach(() => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
		Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
	});

	it("swaps the speedometer cockpit for the compact hero grid on phones", async () => {
		mockGet.mockResolvedValue({ events: [ev()], generatedAt: new Date().toISOString() });
		renderView();
		// The compact grid appears, still carrying the same hero metric caption.
		const grid = await screen.findByTestId("hero-stats-compact");
		expect(grid).toBeInTheDocument();
		expect(within(grid).getByText("Tasks shipped")).toBeInTheDocument();
		expect(within(grid).getByText("Completion rate")).toBeInTheDocument();
	});
});
