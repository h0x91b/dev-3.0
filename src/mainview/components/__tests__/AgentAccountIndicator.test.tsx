import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentAccountsState } from "../../../shared/agent-accounts";
import type { CodingAgent } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			listAgentAccounts: vi.fn(),
			setActiveAgentAccount: vi.fn(),
		},
	},
}));

vi.mock("../../confirm", () => ({
	confirm: vi.fn().mockResolvedValue(true),
}));

import { api } from "../../rpc";
import { confirm } from "../../confirm";
import { I18nProvider } from "../../i18n";
import AgentAccountIndicator, { agentAccountKindForCommand } from "../AgentAccountIndicator";

const mockedApi = vi.mocked(api, true);
const mockedConfirm = vi.mocked(confirm);

const claudeAgent: CodingAgent = {
	id: "builtin-claude",
	name: "Claude",
	baseCommand: "claude",
	configurations: [],
};

const codexAgent: CodingAgent = {
	id: "builtin-codex",
	name: "Codex",
	baseCommand: "codex",
	configurations: [],
};

function makeState(overrides?: Partial<AgentAccountsState>): AgentAccountsState {
	return {
		claude: {
			accounts: [
				{
					id: "cl-1",
					kind: "claude",
					label: "work@example.com",
					identity: {
						email: "work@example.com",
						organization: null,
						plan: "default_claude_max_5x",
						planLabel: "Max 5x",
						accountId: "uuid-1",
					},
					auth: "oauth" as const,
					api: null,
					createdAt: 1,
				},
			],
			activeId: "cl-1",
			systemIdentity: {
				email: "main@example.com",
				organization: null,
				plan: null,
				planLabel: null,
				accountId: "uuid-0",
			},
		},
		codex: { accounts: [], activeId: null, currentIdentity: null },
		...overrides,
	};
}

function renderIndicator(
	agent: CodingAgent | null = claudeAgent,
	opts?: { value?: string | null; onSelect?: (accountId: string | null) => void },
) {
	return render(
		<I18nProvider>
			<AgentAccountIndicator agent={agent} value={opts?.value} onSelect={opts?.onSelect} />
		</I18nProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockedApi.request.listAgentAccounts.mockResolvedValue(makeState());
	mockedApi.request.setActiveAgentAccount.mockResolvedValue(undefined as any);
	mockedConfirm.mockResolvedValue(true);
});

describe("agentAccountKindForCommand", () => {
	it("maps claude/codex commands (with paths and args) to their kind", () => {
		expect(agentAccountKindForCommand("claude")).toBe("claude");
		expect(agentAccountKindForCommand("/opt/homebrew/bin/claude --continue")).toBe("claude");
		expect(agentAccountKindForCommand("codex")).toBe("codex");
		expect(agentAccountKindForCommand("gemini")).toBeNull();
		expect(agentAccountKindForCommand("")).toBeNull();
	});
});

describe("AgentAccountIndicator", () => {
	it("shows the active managed account label on the trigger", async () => {
		renderIndicator();
		const trigger = await screen.findByTestId("agent-account-trigger");
		expect(trigger.textContent).toContain("work@example.com");
	});

	it("renders nothing when the provider has no managed accounts", async () => {
		mockedApi.request.listAgentAccounts.mockResolvedValue(
			makeState({ claude: { accounts: [], activeId: null, systemIdentity: null } }),
		);
		const { container } = renderIndicator();
		await waitFor(() => expect(mockedApi.request.listAgentAccounts).toHaveBeenCalled());
		expect(container.textContent).toBe("");
	});

	it("renders nothing for a provider without an account registry", () => {
		const { container } = renderIndicator({ ...claudeAgent, baseCommand: "gemini" });
		expect(mockedApi.request.listAgentAccounts).not.toHaveBeenCalled();
		expect(container.textContent).toBe("");
	});

	it("falls back to the system login email when no managed account is active", async () => {
		const base = makeState();
		mockedApi.request.listAgentAccounts.mockResolvedValue(
			makeState({ claude: { ...base.claude, activeId: null } }),
		);
		renderIndicator();
		const trigger = await screen.findByTestId("agent-account-trigger");
		expect(trigger.textContent).toContain("main@example.com");
	});

	it("opens the popover and switches the active account", async () => {
		const base = makeState();
		mockedApi.request.listAgentAccounts.mockResolvedValue(
			makeState({ claude: { ...base.claude, activeId: null } }),
		);
		const user = userEvent.setup();
		renderIndicator();

		await user.click(await screen.findByTestId("agent-account-trigger"));
		await user.click(screen.getByText("work@example.com"));

		await waitFor(() => {
			expect(mockedApi.request.setActiveAgentAccount).toHaveBeenCalledWith({
				kind: "claude",
				accountId: "cl-1",
			});
		});
		// The switch re-lists accounts (via the window event) to refresh the label.
		expect(mockedApi.request.listAgentAccounts.mock.calls.length).toBeGreaterThan(1);
	});

	it("switches the default without a confirmation dialog (global mode)", async () => {
		const base = makeState();
		mockedApi.request.listAgentAccounts.mockResolvedValue(
			makeState({ claude: { ...base.claude, activeId: null } }),
		);
		const user = userEvent.setup();
		renderIndicator();

		await user.click(await screen.findByTestId("agent-account-trigger"));
		await user.click(screen.getByText("work@example.com"));

		await waitFor(() => expect(mockedApi.request.setActiveAgentAccount).toHaveBeenCalled());
		// Setting a default is no longer billing-destructive → no confirm.
		expect(mockedConfirm).not.toHaveBeenCalled();
	});

	it("local per-launch mode: picks via onSelect without mutating the global default", async () => {
		const onSelect = vi.fn();
		const user = userEvent.setup();
		// value=null → system login selected, so the managed account row is clickable.
		renderIndicator(claudeAgent, { value: null, onSelect });

		await user.click(await screen.findByTestId("agent-account-trigger"));
		await user.click(screen.getByText("work@example.com"));

		expect(onSelect).toHaveBeenCalledWith("cl-1");
		expect(mockedApi.request.setActiveAgentAccount).not.toHaveBeenCalled();
		expect(mockedConfirm).not.toHaveBeenCalled();
	});

	it("local per-launch mode: the system login row is selectable and yields null", async () => {
		const onSelect = vi.fn();
		const user = userEvent.setup();
		renderIndicator(claudeAgent, { value: "cl-1", onSelect });

		await user.click(await screen.findByTestId("agent-account-trigger"));
		await user.click(screen.getByText("System login (~/.claude)"));

		expect(onSelect).toHaveBeenCalledWith(null);
		expect(mockedApi.request.setActiveAgentAccount).not.toHaveBeenCalled();
	});

	it("lets the popover switch back to the system login", async () => {
		const user = userEvent.setup();
		renderIndicator();

		await user.click(await screen.findByTestId("agent-account-trigger"));
		await user.click(screen.getByText("System login (~/.claude)"));

		await waitFor(() => {
			expect(mockedApi.request.setActiveAgentAccount).toHaveBeenCalledWith({
				kind: "claude",
				accountId: null,
			});
		});
	});

	it("marks API profiles with an API chip and host in the popover", async () => {
		const base = makeState();
		mockedApi.request.listAgentAccounts.mockResolvedValue(
			makeState({
				claude: {
					...base.claude,
					accounts: [
						{
							id: "api-1",
							kind: "claude",
							label: "OpenRouter",
							identity: null,
							auth: "api",
							api: { baseUrl: "https://openrouter.ai/api", model: null, slotModels: {}, hasApiKey: true, envKeys: [] },
							createdAt: 1,
						},
					],
					activeId: "api-1",
				},
			}),
		);
		const user = userEvent.setup();
		renderIndicator();

		const trigger = await screen.findByTestId("agent-account-trigger");
		expect(trigger.textContent).toContain("OpenRouter");
		await user.click(trigger);
		expect(screen.getByText("openrouter.ai")).toBeTruthy();
		expect(screen.getAllByText("API").length).toBeGreaterThan(0);
	});

	it("shows the Codex workspace id in the account popover", async () => {
		mockedApi.request.listAgentAccounts.mockResolvedValue(
			makeState({
				codex: {
					accounts: [
						{
							id: "codex-1",
							kind: "codex",
							label: "shared@example.com",
							identity: {
								email: "shared@example.com",
								organization: "Wix",
								plan: "enterprise_cbp_usage_based",
								planLabel: "Enterprise",
								accountId: "81b5a3a4-9199-40e2-bcde-a6d3ebc9d654",
							},
							auth: "oauth",
							api: null,
							createdAt: 1,
						},
					],
					activeId: "codex-1",
					currentIdentity: null,
				},
			}),
		);
		const user = userEvent.setup();
		renderIndicator(codexAgent);

		await user.click(await screen.findByTestId("agent-account-trigger"));
		expect(screen.getByText("Workspace 81b5a3a4")).toBeTruthy();
	});
});
