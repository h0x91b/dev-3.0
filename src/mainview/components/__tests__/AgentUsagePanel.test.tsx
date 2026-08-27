import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import AgentUsagePanel from "../AgentUsagePanel";
import { AGENT_ACCOUNTS_CHANGED_EVENT } from "../AgentAccountIndicator";
import type { AgentAccountsState } from "../../../shared/agent-accounts";
import type { AgentRateLimitsReport } from "../../../shared/rate-limits";

vi.mock("../../rpc", () => ({
	api: { request: { setActiveAgentAccount: vi.fn() } },
}));

import { api } from "../../rpc";

const setActive = api.request.setActiveAgentAccount as ReturnType<typeof vi.fn>;

function accounts(): AgentAccountsState {
	return {
		claude: {
			accounts: [
				{ id: "work", kind: "claude", label: "Work Claude", identity: null, auth: "oauth", api: null, createdAt: 0 },
				{ id: "home", kind: "claude", label: "Home Claude", identity: null, auth: "oauth", api: null, createdAt: 0 },
			],
			activeId: "work",
			systemIdentity: null,
		},
		codex: { accounts: [], activeId: null, currentIdentity: null },
	};
}

function report(): AgentRateLimitsReport {
	const now = Date.now();
	return {
		generatedAt: now,
		snapshots: [
			{
				source: "claude",
				accountId: "work",
				capturedAt: now,
				windows: [{ id: "five_hour", usedPercent: 42, resetsAt: now + 3_600_000, windowMinutes: 300 }],
				creditsBalance: null,
				monthlyCredits: null,
				planType: null,
			},
		],
	};
}

function renderPanel(state: AgentAccountsState | null = accounts()) {
	return render(
		<I18nProvider>
			<AgentUsagePanel report={report()} accounts={state} onOpenSettings={() => {}} />
		</I18nProvider>,
	);
}

beforeEach(() => {
	setActive.mockReset();
	setActive.mockResolvedValue(undefined);
});

describe("AgentUsagePanel", () => {
	it("lists every account, with usage on the one that has a reading", async () => {
		renderPanel();
		expect(screen.getByText("Work Claude")).toBeTruthy();
		expect(screen.getByText("Home Claude")).toBeTruthy();
		expect(screen.getByText("42% used")).toBeTruthy();
		expect(screen.getAllByText("no recent usage data").length).toBeGreaterThan(0);
	});

	it("marks the current default and leaves it inert", async () => {
		renderPanel();
		const radios = screen.getAllByRole("radio");
		const current = radios.find((r) => r.getAttribute("aria-checked") === "true");
		expect(current?.textContent).toContain("Work Claude");
		await userEvent.click(current as HTMLElement);
		expect(setActive).not.toHaveBeenCalled();
	});

	it("switches the default account and announces the change", async () => {
		const onChanged = vi.fn();
		window.addEventListener(AGENT_ACCOUNTS_CHANGED_EVENT, onChanged);
		try {
			renderPanel();
			await userEvent.click(screen.getByRole("radio", { name: "Make Home Claude the default account" }));
			expect(setActive).toHaveBeenCalledWith({ kind: "claude", accountId: "home" });
			expect(onChanged).toHaveBeenCalledTimes(1);
		} finally {
			window.removeEventListener(AGENT_ACCOUNTS_CHANGED_EVENT, onChanged);
		}
	});

	it("switches back to the Claude system login", async () => {
		renderPanel();
		await userEvent.click(
			screen.getByRole("radio", { name: "Make System login (~/.claude) the default account" }),
		);
		expect(setActive).toHaveBeenCalledWith({ kind: "claude", accountId: null });
	});

	it("keeps the Codex unmanaged login informational — it cannot become a default", async () => {
		const state = accounts();
		state.codex.currentIdentity = {
			email: "dev@corp.com",
			organization: null,
			plan: "enterprise",
			planLabel: "Enterprise",
			accountId: "cdx",
		};
		renderPanel(state);
		const unmanaged = screen.getAllByRole("radio").find((r) => r.textContent?.includes("Unmanaged login"));
		expect(unmanaged).toBeTruthy();
		await userEvent.click(unmanaged as HTMLElement);
		expect(setActive).not.toHaveBeenCalled();
	});
});
