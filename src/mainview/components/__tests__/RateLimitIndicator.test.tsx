import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import RateLimitIndicator from "../RateLimitIndicator";
import type { AgentRateLimitsReport } from "../../../shared/rate-limits";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAgentRateLimits: vi.fn(),
		},
	},
}));

import { api } from "../../rpc";

const mockedGet = api.request.getAgentRateLimits as ReturnType<typeof vi.fn>;

function report(percent: number): AgentRateLimitsReport {
	return {
		generatedAt: Date.now(),
		snapshots: [
			{
				source: "claude",
				capturedAt: Date.now(),
				windows: [
					{ id: "five_hour", usedPercent: 5, resetsAt: Date.now() + 3_600_000, windowMinutes: 300 },
					{ id: "seven_day", usedPercent: percent, resetsAt: Date.now() + 86_400_000, windowMinutes: 10080 },
				],
				creditsBalance: null,
				monthlyCredits: null,
				planType: null,
			},
		],
	};
}

function renderIndicator() {
	return render(
		<I18nProvider>
			<RateLimitIndicator />
		</I18nProvider>,
	);
}

beforeEach(() => {
	mockedGet.mockReset();
});

describe("RateLimitIndicator", () => {
	it("renders nothing while no rate-limit data exists", async () => {
		mockedGet.mockResolvedValue({ generatedAt: Date.now(), snapshots: [] });
		const { container } = renderIndicator();
		await act(async () => {});
		expect(container.querySelector("[role='status']")).toBeNull();
	});

	it("shows the worst window percentage once data arrives", async () => {
		mockedGet.mockResolvedValue(report(42));
		renderIndicator();
		await act(async () => {});
		expect(screen.getByText("42%")).toBeTruthy();
		expect(screen.getByRole("status").className).toContain("text-fg-3");
	});

	it("escalates to the warning token at ≥80%", async () => {
		mockedGet.mockResolvedValue(report(83));
		renderIndicator();
		await act(async () => {});
		expect(screen.getByRole("status").className).toContain("text-warning");
	});

	it("escalates to the danger token at ≥95%", async () => {
		mockedGet.mockResolvedValue(report(97));
		renderIndicator();
		await act(async () => {});
		expect(screen.getByRole("status").className).toContain("text-danger");
	});

	it("updates from an agentRateLimitsUpdated push event", async () => {
		mockedGet.mockResolvedValue({ generatedAt: Date.now(), snapshots: [] });
		renderIndicator();
		await act(async () => {});
		act(() => {
			window.dispatchEvent(new CustomEvent("rpc:agentRateLimitsUpdated", { detail: report(66) }));
		});
		expect(screen.getByText("66%")).toBeTruthy();
	});

	it("stays hidden when the backend request fails", async () => {
		mockedGet.mockRejectedValue(new Error("no backend"));
		const { container } = renderIndicator();
		await act(async () => {});
		expect(container.querySelector("[role='status']")).toBeNull();
	});

	it("shows a monthly-only Codex limit and its detailed credit usage", async () => {
		mockedGet.mockResolvedValue({
			generatedAt: Date.now(),
			snapshots: [
				{
					source: "codex",
					capturedAt: Date.now(),
					windows: [{ id: "monthly_credits", usedPercent: 97, resetsAt: Date.now() + 86_400_000, windowMinutes: null }],
					creditsBalance: null,
					monthlyCredits: { limit: 8824, used: 329.532, remainingPercent: 3, resetsAt: Date.now() + 86_400_000 },
					planType: "enterprise_cbp_usage_based",
				},
			],
		});
		renderIndicator();
		await act(async () => {});

		expect(screen.getByText("97%")).toBeTruthy();
		expect(screen.getByRole("status").getAttribute("aria-label")).toContain("monthly credits");
		await userEvent.tab();
		expect(await screen.findByText(/329.53 \/ 8,824/)).toBeTruthy();
	});
});
