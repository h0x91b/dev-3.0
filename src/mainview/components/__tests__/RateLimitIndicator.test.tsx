import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import RateLimitIndicator from "../RateLimitIndicator";
import type { AgentRateLimitsReport } from "../../../shared/rate-limits";
import type { AgentAccountsState } from "../../../shared/agent-accounts";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAgentRateLimits: vi.fn(),
			listAgentAccounts: vi.fn(),
		},
	},
}));

import { api } from "../../rpc";

const mockedGet = api.request.getAgentRateLimits as ReturnType<typeof vi.fn>;
const mockedAccounts = api.request.listAgentAccounts as ReturnType<typeof vi.fn>;

function emptyAccounts(): AgentAccountsState {
	return {
		claude: { accounts: [], activeId: null, systemIdentity: null },
		codex: { accounts: [], activeId: null, currentIdentity: null },
	};
}

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
	mockedAccounts.mockReset();
	mockedAccounts.mockResolvedValue(emptyAccounts());
});

describe("RateLimitIndicator", () => {
	it("renders nothing while no rate-limit data exists", async () => {
		mockedGet.mockResolvedValue({ generatedAt: Date.now(), snapshots: [] });
		const { container } = renderIndicator();
		await act(async () => {});
		expect(container.querySelector("[role='status']")).toBeNull();
	});

	it("shows the worst window percentage from the latest active account", async () => {
		mockedGet.mockResolvedValue(report(42));
		renderIndicator();
		await act(async () => {});
		expect(screen.getByText("42%")).toBeTruthy();
		expect(screen.getByRole("status").className).toContain("text-fg-3");
	});

	it("compact mode keeps the mini bars but drops the percent text", async () => {
		mockedGet.mockResolvedValue(report(42));
		render(
			<I18nProvider>
				<RateLimitIndicator compact />
			</I18nProvider>,
		);
		await act(async () => {});
		const pill = screen.getByRole("status");
		expect(pill.querySelector("[aria-hidden='true']")).toBeTruthy();
		expect(screen.queryByText("42%")).toBeNull();
	});

	it("ignores a more-used window from an older account", async () => {
		const now = Date.now();
		mockedGet.mockResolvedValue({
			generatedAt: now,
			snapshots: [
				{
					source: "codex",
					accountId: "exhausted",
					capturedAt: now - 1_000,
					activeAt: now - 1_000,
					windows: [{ id: "primary", usedPercent: 100, resetsAt: now + 3_600_000, windowMinutes: 300 }],
					creditsBalance: null,
					monthlyCredits: null,
					planType: null,
				},
				{
					source: "claude",
					accountId: "latest",
					capturedAt: now,
					activeAt: now,
					windows: [{ id: "five_hour", usedPercent: 29, resetsAt: now + 3_600_000, windowMinutes: 300 }],
					creditsBalance: null,
					monthlyCredits: null,
					planType: null,
				},
			],
		});
		renderIndicator();
		await act(async () => {});

		expect(screen.getByText("29%")).toBeTruthy();
		expect(screen.queryByText("100%")).toBeNull();
		expect(screen.getByRole("status").className).toContain("text-fg-3");
	});

	it("shows unlimited latest accounts as 0% used", async () => {
		const now = Date.now();
		mockedGet.mockResolvedValue({
			generatedAt: now,
			snapshots: [
				{
					source: "claude",
					capturedAt: now - 1_000,
					activeAt: now - 1_000,
					windows: [{ id: "five_hour", usedPercent: 100, resetsAt: now + 3_600_000, windowMinutes: 300 }],
					creditsBalance: null,
					monthlyCredits: null,
					planType: null,
				},
				{
					source: "codex",
					capturedAt: now,
					activeAt: now,
					windows: [],
					creditsBalance: "unlimited",
					monthlyCredits: null,
					planType: "enterprise",
				},
			],
		});
		renderIndicator();
		await act(async () => {});

		expect(screen.getByText("∞ unlimited")).toBeTruthy();
		expect(screen.queryByText("0%")).toBeNull();
		expect(screen.getByRole("status").getAttribute("aria-label")).toContain("Codex ∞ unlimited");
		expect(screen.getByRole("status").className).toContain("text-fg-3");
	});

	it("labels the header percentage as used so it is not ambiguous", async () => {
		mockedGet.mockResolvedValue(report(42));
		renderIndicator();
		await act(async () => {});
		// The number and the "used" qualifier sit in the same badge.
		expect(screen.getByText("42%")).toBeTruthy();
		expect(screen.getByText("used")).toBeTruthy();
		expect(screen.getByRole("status").getAttribute("aria-label")).toContain("42% used");
	});

	it("spells out '<n>% used' on each Claude window row in the tooltip", async () => {
		mockedGet.mockResolvedValue(report(42));
		renderIndicator();
		await act(async () => {});
		await userEvent.tab();
		expect(await screen.findByText("5h")).toBeTruthy();
		expect(screen.getByText("5% used")).toBeTruthy();
		expect(screen.getByText("7d")).toBeTruthy();
		expect(screen.getByText("42% used")).toBeTruthy();
	});

	it("renders a usage bar per window with severity-colored fill and clamped width", async () => {
		mockedGet.mockResolvedValue(report(97));
		renderIndicator();
		await act(async () => {});
		await userEvent.tab();
		await screen.findByText("5h");
		const tooltip = screen.getByRole("tooltip");
		const fills = tooltip.querySelectorAll("[class*='rounded-full'] > span");
		expect(fills.length).toBe(2);
		expect((fills[0] as HTMLElement).className).toContain("bg-accent");
		expect((fills[0] as HTMLElement).style.width).toBe("5%");
		expect((fills[1] as HTMLElement).className).toContain("bg-danger");
		expect((fills[1] as HTMLElement).style.width).toBe("97%");
	});

	it("shows an unlimited-credits chip instead of usage bars for unlimited accounts", async () => {
		mockedGet.mockResolvedValue({
			generatedAt: Date.now(),
			snapshots: [
				{
					source: "codex",
					capturedAt: Date.now(),
					windows: [],
					creditsBalance: "unlimited",
					monthlyCredits: null,
					planType: "enterprise",
				},
			],
		});
		renderIndicator();
		await act(async () => {});
		await userEvent.tab();
		// One match in the pill label, one as the tooltip card chip.
		expect((await screen.findAllByText("∞ unlimited")).length).toBe(2);
		expect(screen.queryByText(/credits: unlimited/)).toBeNull();
	});

	it("renders a mini usage bar inside the header pill", async () => {
		mockedGet.mockResolvedValue(report(42));
		renderIndicator();
		await act(async () => {});
		const pill = screen.getByRole("status");
		const fill = pill.querySelector('span[aria-hidden="true"] > span > span');
		expect(fill).toBeTruthy();
		expect((fill as HTMLElement).style.width).toBe("42%");
		expect((fill as HTMLElement).className).toContain("bg-accent");
	});

	it("shows a per-account 'captured just now' note for a fresh reading", async () => {
		mockedGet.mockResolvedValue(report(42));
		renderIndicator();
		await act(async () => {});
		await userEvent.tab();
		expect(await screen.findByText("captured just now")).toBeTruthy();
	});

	it("flags a stale reading with its age and the warning tint", async () => {
		const now = Date.now();
		mockedGet.mockResolvedValue({
			generatedAt: now,
			snapshots: [
				{
					source: "claude",
					accountId: "old",
					capturedAt: now - 20 * 60_000,
					activeAt: now - 20 * 60_000,
					windows: [{ id: "seven_day", usedPercent: 30, resetsAt: now + 86_400_000, windowMinutes: 10080 }],
					creditsBalance: null,
					monthlyCredits: null,
					planType: null,
				},
			],
		});
		renderIndicator();
		await act(async () => {});
		await userEvent.tab();
		const note = await screen.findByText("captured 20m ago");
		expect(note.className).toContain("text-warning");
	});

	it("stacks one pill bar per account with its own severity color", async () => {
		const now = Date.now();
		const snapshot = (source: "claude" | "codex", accountId: string, percent: number, activeAt: number) => ({
			source,
			accountId,
			capturedAt: activeAt,
			activeAt,
			windows: [{ id: source === "claude" ? "five_hour" : "primary", usedPercent: percent, resetsAt: now + 3_600_000, windowMinutes: 300 }],
			creditsBalance: null,
			monthlyCredits: null,
			planType: null,
		});
		mockedGet.mockResolvedValue({
			generatedAt: now,
			snapshots: [snapshot("claude", "a", 42, now), snapshot("codex", "b", 85, now - 1_000), snapshot("codex", "c", 97, now - 2_000)],
		});
		renderIndicator();
		await act(async () => {});
		const pill = screen.getByRole("status");
		const fills = pill.querySelectorAll('span[aria-hidden="true"] > span > span');
		expect(fills.length).toBe(3);
		expect((fills[0] as HTMLElement).style.width).toBe("42%");
		expect((fills[0] as HTMLElement).className).toContain("bg-accent");
		expect((fills[1] as HTMLElement).style.width).toBe("85%");
		expect((fills[1] as HTMLElement).className).toContain("bg-warning");
		expect((fills[2] as HTMLElement).style.width).toBe("97%");
		expect((fills[2] as HTMLElement).className).toContain("bg-danger");
		// The headline number still tracks the most recently active account.
		expect(screen.getByText("42%")).toBeTruthy();
	});

	it("renders an unlimited account's pill bar as a full success line and caps bars at four", async () => {
		const now = Date.now();
		const snapshot = (accountId: string, percent: number) => ({
			source: "codex" as const,
			accountId,
			capturedAt: now,
			activeAt: now,
			windows: [{ id: "primary", usedPercent: percent, resetsAt: now + 3_600_000, windowMinutes: 300 }],
			creditsBalance: null,
			monthlyCredits: null,
			planType: null,
		});
		mockedGet.mockResolvedValue({
			generatedAt: now,
			snapshots: [
				{
					source: "codex",
					accountId: "unl",
					capturedAt: now,
					activeAt: now,
					windows: [],
					creditsBalance: "unlimited",
					monthlyCredits: null,
					planType: "enterprise",
				},
				snapshot("a", 10),
				snapshot("b", 20),
				snapshot("c", 30),
				snapshot("d", 40),
			],
		});
		renderIndicator();
		await act(async () => {});
		const pill = screen.getByRole("status");
		const fills = pill.querySelectorAll('span[aria-hidden="true"] > span > span');
		expect(fills.length).toBe(4);
		expect((fills[0] as HTMLElement).style.width).toBe("100%");
		expect((fills[0] as HTMLElement).className).toContain("bg-success");
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

	it("shows the system-login account identity and plan in the tooltip", async () => {
		mockedGet.mockResolvedValue(report(42));
		mockedAccounts.mockResolvedValue({
			claude: {
				accounts: [],
				activeId: null,
				systemIdentity: {
					email: "alice@example.com",
					organization: null,
					plan: "default_claude_max_5x",
					planLabel: "Max 5x",
					accountId: "uuid-1",
				},
			},
			codex: { accounts: [], activeId: null, currentIdentity: null },
		});
		renderIndicator();
		await act(async () => {});
		await userEvent.tab();
		expect(await screen.findByText("alice@example.com")).toBeTruthy();
		expect(screen.getByText("Max 5x")).toBeTruthy();
	});

	it("shows the active managed account label for its source", async () => {
		mockedGet.mockResolvedValue(report(42));
		mockedAccounts.mockResolvedValue({
			claude: {
				accounts: [
					{
						id: "acc-1",
						kind: "claude",
						label: "Work account",
						identity: {
							email: "work@corp.com",
							organization: "Corp",
							plan: "default_claude_pro",
							planLabel: "Pro",
							accountId: "uuid-2",
						},
						auth: "oauth",
						api: null,
						createdAt: 0,
					},
				],
				activeId: "acc-1",
				systemIdentity: null,
			},
			codex: { accounts: [], activeId: null, currentIdentity: null },
		});
		renderIndicator();
		await act(async () => {});
		await userEvent.tab();
		expect(await screen.findByText("Work account")).toBeTruthy();
		expect(screen.getByText("Pro")).toBeTruthy();
	});

	it("shows each recently attributed account instead of collapsing to the default", async () => {
		const capturedAt = Date.now();
		const snapshot = (source: "claude" | "codex", accountId: string, percent: number) => ({
			source,
			accountId,
			capturedAt,
			activeAt: capturedAt,
			windows: [{ id: source === "claude" ? "five_hour" : "primary", usedPercent: percent, resetsAt: capturedAt + 3_600_000, windowMinutes: 300 }],
			creditsBalance: null,
			monthlyCredits: null,
			planType: null,
		});
		mockedGet.mockResolvedValue({
			generatedAt: capturedAt,
			snapshots: [snapshot("claude", "claude-1", 42), snapshot("claude", "claude-2", 17), snapshot("codex", "codex-1", 28)],
		});
		mockedAccounts.mockResolvedValue({
			claude: {
				accounts: [
					{ id: "claude-1", kind: "claude", label: "Work Claude", identity: null, auth: "oauth", api: null, createdAt: 0 },
					{ id: "claude-2", kind: "claude", label: "Personal Claude", identity: null, auth: "oauth", api: null, createdAt: 0 },
				],
				activeId: "claude-1",
				systemIdentity: null,
			},
			codex: {
				accounts: [{ id: "codex-1", kind: "codex", label: "Enterprise Codex", identity: null, auth: "oauth", api: null, createdAt: 0 }],
				activeId: "codex-1",
				currentIdentity: null,
			},
		});

		renderIndicator();
		await act(async () => {});
		await userEvent.tab();
		expect(await screen.findByText("Work Claude")).toBeTruthy();
		expect(screen.getByText("Personal Claude")).toBeTruthy();
		expect(screen.getByText("Enterprise Codex")).toBeTruthy();
	});

	it("shows the workspace/organization name so same-email accounts are distinguishable", async () => {
		mockedGet.mockResolvedValue(report(42));
		mockedAccounts.mockResolvedValue({
			claude: {
				accounts: [],
				activeId: null,
				systemIdentity: {
					email: "arseny@wix.com",
					organization: "Acme Workspace",
					plan: "default_claude_max_5x",
					planLabel: "Max 5x",
					accountId: "uuid-1",
				},
			},
			codex: { accounts: [], activeId: null, currentIdentity: null },
		});
		renderIndicator();
		await act(async () => {});
		await userEvent.tab();
		expect(await screen.findByText("arseny@wix.com")).toBeTruthy();
		expect(screen.getByText("· Acme Workspace")).toBeTruthy();
	});

	it("collapses an 'email (workspace)' auto-label into a single 'email · workspace' row", async () => {
		mockedGet.mockResolvedValue({
			generatedAt: Date.now(),
			snapshots: [
				{
					source: "codex",
					capturedAt: Date.now(),
					windows: [{ id: "monthly_credits", usedPercent: 10, resetsAt: Date.now() + 86_400_000, windowMinutes: null }],
					creditsBalance: null,
					monthlyCredits: { limit: 8824, used: 100, remainingPercent: 98, resetsAt: Date.now() + 86_400_000 },
					planType: "enterprise_cbp_usage_based",
				},
			],
		});
		mockedAccounts.mockResolvedValue({
			claude: { accounts: [], activeId: null, systemIdentity: null },
			codex: {
				accounts: [
					{
						id: "acc-cdx",
						kind: "codex",
						label: "arsenyp@wix.com (Wix)",
						identity: { email: "arsenyp@wix.com", organization: "Wix", plan: "enterprise", planLabel: "Enterprise", accountId: "acc-cdx" },
						auth: "oauth",
						api: null,
						createdAt: 0,
					},
				],
				activeId: "acc-cdx",
				currentIdentity: null,
			},
		});
		renderIndicator();
		await act(async () => {});
		await userEvent.tab();
		// The verbose "email (workspace)" parenthetical is collapsed to email …
		expect(await screen.findByText("arsenyp@wix.com")).toBeTruthy();
		expect(screen.queryByText("arsenyp@wix.com (Wix)")).toBeNull();
		// … and the workspace shows exactly once as the chip.
		expect(screen.getAllByText("· Wix")).toHaveLength(1);
	});
});
