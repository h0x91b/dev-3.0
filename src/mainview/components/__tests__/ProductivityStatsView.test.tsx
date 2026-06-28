import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductivityStatEvent } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import ProductivityStatsView from "../ProductivityStatsView";

vi.mock("../../rpc", () => ({
	api: { request: { getProductivityStats: vi.fn() } },
}));

import { api } from "../../rpc";
const mockGet = api.request.getProductivityStats as unknown as ReturnType<typeof vi.fn>;

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
});
