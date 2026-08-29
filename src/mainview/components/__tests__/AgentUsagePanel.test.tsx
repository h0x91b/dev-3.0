import { render, screen, waitFor } from "@testing-library/react";
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

vi.mock("../../toast", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import { api } from "../../rpc";
import { toast } from "../../toast";

const setActive = api.request.setActiveAgentAccount as ReturnType<typeof vi.fn>;
const toastSuccess = toast.success as ReturnType<typeof vi.fn>;
const toastError = toast.error as ReturnType<typeof vi.fn>;

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

/** Two accounts on one email, told apart only by their workspace — the shape
 *  that made three rows announce the same name. */
function sameEmailAccounts(): AgentAccountsState {
	const identity = (organization: string) => ({
		email: "dev@corp.com",
		organization,
		plan: "max",
		planLabel: "Max 5x",
		accountId: null,
	});
	return {
		claude: {
			accounts: [
				{ id: "a", kind: "claude", label: "dev@corp.com", identity: identity("Alpha"), auth: "oauth", api: null, createdAt: 0 },
				{ id: "b", kind: "claude", label: "dev@corp.com", identity: identity("Beta"), auth: "oauth", api: null, createdAt: 0 },
			],
			activeId: null,
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

function renderPanel(state: AgentAccountsState | null = accounts(), interactive = true) {
	return render(
		<I18nProvider>
			<AgentUsagePanel report={report()} accounts={state} interactive={interactive} onOpenSettings={() => {}} />
		</I18nProvider>,
	);
}

/** The panel's own scroll body — the element the dwell timer hangs off. */
function panelBody(): HTMLElement {
	return screen.getByText("Pick the default for new launches.").parentElement?.parentElement as HTMLElement;
}

beforeEach(() => {
	setActive.mockReset();
	setActive.mockResolvedValue(undefined);
	toastSuccess.mockReset();
	toastError.mockReset();
});

describe("AgentUsagePanel", () => {
	it("lists every account, with usage on the one that has a reading", async () => {
		renderPanel();
		expect(screen.getByText("Work Claude")).toBeTruthy();
		expect(screen.getByText("Home Claude")).toBeTruthy();
		expect(screen.getByText("42% used")).toBeTruthy();
		expect(screen.getAllByText("no recent data").length).toBeGreaterThan(0);
	});

	it("marks the current default and leaves it inert", async () => {
		renderPanel();
		const radios = screen.getAllByRole("radio");
		const current = radios.find((r) => r.getAttribute("aria-checked") === "true");
		expect(current?.textContent).toContain("Work Claude");
		await userEvent.click(current as HTMLElement);
		expect(setActive).not.toHaveBeenCalled();
	});

	it("switches the default account, announces it, and leaves a receipt", async () => {
		const onChanged = vi.fn();
		window.addEventListener(AGENT_ACCOUNTS_CHANGED_EVENT, onChanged);
		try {
			renderPanel();
			await userEvent.click(screen.getByRole("radio", { name: "Make Home Claude the default account" }));
			expect(setActive).toHaveBeenCalledWith({ kind: "claude", accountId: "home" });
			expect(onChanged).toHaveBeenCalledTimes(1);
			// The panel can be gone a frame later, so the toast is the only proof
			// the user gets that a durable setting moved.
			expect(toastSuccess).toHaveBeenCalledWith("Home Claude is now the default for new launches", {
				source: "settings",
			});
		} finally {
			window.removeEventListener(AGENT_ACCOUNTS_CHANGED_EVENT, onChanged);
		}
	});

	it("stays read-only for a pointer that has not settled in the panel", async () => {
		renderPanel(accounts(), false);
		// The row a hovering pointer would land on: live in a pinned panel, inert
		// here, because nothing has dwelled inside this one yet.
		const home = screen.getAllByRole("radio").find((r) => r.textContent?.includes("Home Claude"));
		expect(home?.getAttribute("aria-disabled")).toBe("true");
		await userEvent.click(home as HTMLElement);
		expect(setActive).not.toHaveBeenCalled();
	});

	it("arms its rows once the pointer has rested in the panel", async () => {
		renderPanel(accounts(), false);
		const home = () => screen.getAllByRole("radio").find((r) => r.textContent?.includes("Home Claude"));
		// Still inert while the pointer could just be passing through.
		expect(home()?.getAttribute("aria-disabled")).toBe("true");
		await userEvent.hover(panelBody());
		await waitFor(() => expect(home()?.getAttribute("aria-disabled")).toBeNull());
		await userEvent.click(home() as HTMLElement);
		expect(setActive).toHaveBeenCalledWith({ kind: "claude", accountId: "home" });
	});

	it("disarms again when the pointer leaves", async () => {
		renderPanel(accounts(), false);
		const home = () => screen.getAllByRole("radio").find((r) => r.textContent?.includes("Home Claude"));
		await userEvent.hover(panelBody());
		await waitFor(() => expect(home()?.getAttribute("aria-disabled")).toBeNull());
		await userEvent.unhover(panelBody());
		expect(home()?.getAttribute("aria-disabled")).toBe("true");
		await userEvent.click(home() as HTMLElement);
		expect(setActive).not.toHaveBeenCalled();
	});

	it("reports a failed switch instead of pretending it worked", async () => {
		setActive.mockRejectedValue(new Error("account file is locked"));
		renderPanel();
		await userEvent.click(screen.getByRole("radio", { name: "Make Home Claude the default account" }));
		expect(toastError).toHaveBeenCalledWith("account file is locked", { source: "settings" });
		expect(toastSuccess).not.toHaveBeenCalled();
	});

	it("names each row by more than the email two accounts share", async () => {
		renderPanel(sameEmailAccounts());
		const names = screen
			.getAllByRole("radio")
			.map((r) => r.getAttribute("aria-label"))
			.filter((name): name is string => !!name);
		expect(names).toContain("Make dev@corp.com · Alpha · Max 5x the default account");
		expect(names).toContain("Make dev@corp.com · Beta · Max 5x the default account");
		expect(new Set(names).size).toBe(names.length);
	});

	it("moves focus with the arrow keys without switching anything", async () => {
		renderPanel();
		const radios = screen.getAllByRole("radio");
		// One tab stop per group — the rest are reachable by arrow, not by Tab.
		expect(radios.filter((r) => r.getAttribute("tabindex") === "0").length).toBe(1);
		radios[0]?.focus();
		await userEvent.keyboard("{ArrowDown}");
		expect(document.activeElement).toBe(radios[1]);
		expect(setActive).not.toHaveBeenCalled();
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
