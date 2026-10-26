import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n";
import { AutoAccountExclusions } from "../AutoAccountExclusions";
import type { AgentAccountIdentity, AgentAccountsState } from "../../../../shared/agent-accounts";
import type { Project } from "../../../../shared/types";

vi.mock("../../../rpc", () => ({
	api: { request: { listAgentAccounts: vi.fn() } },
}));

import { api } from "../../../rpc";

const listAgentAccounts = api.request.listAgentAccounts as ReturnType<typeof vi.fn>;

const dana: AgentAccountIdentity = { email: "dana@example.test", organization: null, plan: "team", planLabel: "Team", accountId: "ws-1", userId: "user-dana" };

function codexState(managed: AgentAccountIdentity[], current: AgentAccountIdentity | null): AgentAccountsState {
	return {
		claude: { accounts: [], activeId: null, systemConfigDir: "/home/me/.claude", systemIdentity: null },
		codex: {
			accounts: managed.map((identity, i) => ({ id: `cx-${i}`, kind: "codex", label: `Managed ${i}`, identity, auth: "oauth", api: null, createdAt: i })),
			activeId: "cx-0",
			currentIdentity: current,
		},
		omp: { accounts: [], activeId: null },
		pi: { accounts: [], activeId: null },
	};
}

async function renderExclusions(state: AgentAccountsState) {
	listAgentAccounts.mockResolvedValue(state);
	const view = render(
		<I18nProvider>
			<AutoAccountExclusions project={{ id: "p", autoAccountExclusions: [] } as unknown as Project} onSave={() => {}} />
		</I18nProvider>,
	);
	await waitFor(() => expect(listAgentAccounts).toHaveBeenCalled());
	return view;
}

describe("AutoAccountExclusions — the Codex default login (#1964)", () => {
	it("gives ~/.codex no switch when it is a managed account's own identity", async () => {
		const { container } = await renderExclusions(codexState([dana, { ...dana, accountId: "ws-2" }], dana));
		await waitFor(() => expect(screen.getAllByRole("switch")).toHaveLength(2));
		expect(screen.queryByRole("switch", { name: "Unmanaged login" })).toBeNull();
		expect(container.textContent).not.toContain("Unmanaged login");
	});

	it("hides the section when the twin is the only other login", async () => {
		const { container } = await renderExclusions(codexState([dana], dana));
		await new Promise((r) => setTimeout(r, 0));
		expect(container.querySelector('[data-testid="auto-account-exclusions"]')).toBeNull();
	});

	it("keeps a switch for another seat of the same workspace", async () => {
		await renderExclusions(codexState([dana], { ...dana, email: "lee@example.test", userId: "user-lee" }));
		expect(await screen.findByRole("switch", { name: "Unmanaged login" })).toBeTruthy();
	});

	it("keeps a switch for a default login whose person is unknown", async () => {
		await renderExclusions(codexState([dana], { ...dana, email: null, userId: undefined }));
		expect(await screen.findByRole("switch", { name: "Unmanaged login" })).toBeTruthy();
	});
});
