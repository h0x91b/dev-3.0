import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import type { AccountLoginState, AgentAccountsState } from "../../../../shared/agent-accounts";
import { I18nProvider, useT } from "../../../i18n";
import AgentAccountsSection from "../AgentAccountsSection";

vi.mock("../../../rpc", () => ({
	isElectrobun: false,
	api: {
		request: {
			listAgentAccounts: vi.fn(),
			importAgentAccount: vi.fn(),
			addAgentApiProfile: vi.fn(),
			getAgentApiProfileDraft: vi.fn(),
			updateAgentApiProfile: vi.fn(),
			startAccountLogin: vi.fn(),
			getAccountLogin: vi.fn().mockResolvedValue(null),
			restartAccountLogin: vi.fn(),
			closeAccountLogin: vi.fn().mockResolvedValue(undefined),
			getAccountLoginPtyUrl: vi.fn().mockResolvedValue("ws://localhost:1/?session=account-login-l1"),
			setActiveAgentAccount: vi.fn(),
			removeAgentAccount: vi.fn(),
			renameAgentAccount: vi.fn(),
			listPinnedClaudeLogins: vi.fn().mockResolvedValue([]),
		},
	},
}));

vi.mock("../../../TerminalView", () => ({
	default: ({ ptyUrl }: { ptyUrl: string }) => <div data-testid="terminal-view">{ptyUrl}</div>,
}));

vi.mock("../../../confirm", () => ({
	confirm: vi.fn().mockResolvedValue(true),
}));

import { api } from "../../../rpc";
import { confirm } from "../../../confirm";

const mockedApi = vi.mocked(api, true);
const mockedConfirm = vi.mocked(confirm);

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
			activeId: null,
			systemConfigDir: "/home/me/.claude", systemIdentity: {
				email: "main@example.com",
				organization: null,
				plan: null,
				planLabel: null,
				accountId: "uuid-0",
			},
		},
		codex: { accounts: [], activeId: null, currentIdentity: null },
		omp: { accounts: [], activeId: null },
		...overrides,
	};
}

function Harness() {
	const t = useT();
	return <AgentAccountsSection t={t} />;
}

function renderSection() {
	return render(
		<I18nProvider>
			<Harness />
		</I18nProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockedApi.request.listAgentAccounts.mockResolvedValue(makeState());
	mockedApi.request.setActiveAgentAccount.mockResolvedValue(undefined as any);
	mockedApi.request.removeAgentAccount.mockResolvedValue(undefined as any);
	mockedApi.request.renameAgentAccount.mockResolvedValue(undefined as any);
	mockedApi.request.getAccountLogin.mockResolvedValue(null);
	mockedApi.request.closeAccountLogin.mockResolvedValue(undefined);
	mockedApi.request.getAccountLoginPtyUrl.mockResolvedValue("ws://localhost:1/?session=account-login-l1");
	mockedConfirm.mockResolvedValue(true);
});

describe("AgentAccountsSection", () => {
	it("renders the system login row, accounts, and plan badges", async () => {
		renderSection();
		expect(await screen.findByText("Default login (/home/me/.claude)")).toBeTruthy();
		expect(screen.getByText("work@example.com")).toBeTruthy();
		expect(screen.getByText("main@example.com")).toBeTruthy();
		expect(screen.getByText("Max 5x")).toBeTruthy();
		// Claude's and omp's system logins are each their block's default (activeId=null).
		expect(screen.getAllByText("Default")).toHaveLength(2);
	});

	it("activates an account on row click", async () => {
		const user = userEvent.setup();
		renderSection();
		const row = await screen.findByText("work@example.com");
		await user.click(row);
		await waitFor(() => {
			expect(mockedApi.request.setActiveAgentAccount).toHaveBeenCalledWith({
				kind: "claude",
				accountId: "cl-1",
			});
		});
	});

	it("sets the default account without a confirmation dialog", async () => {
		const user = userEvent.setup();
		renderSection();
		const row = await screen.findByText("work@example.com");
		await user.click(row);
		await waitFor(() => expect(mockedApi.request.setActiveAgentAccount).toHaveBeenCalled());
		// Setting the default is no longer billing-destructive (per-launch is the guard).
		expect(mockedConfirm).not.toHaveBeenCalled();
	});

	it("dispatches the accounts-changed window event after a mutation", async () => {
		const listener = vi.fn();
		window.addEventListener("dev3:agentAccountsChanged", listener);
		try {
			const user = userEvent.setup();
			renderSection();
			const row = await screen.findByText("work@example.com");
			await user.click(row);
			await waitFor(() => expect(listener).toHaveBeenCalled());
		} finally {
			window.removeEventListener("dev3:agentAccountsChanged", listener);
		}
	});

	it("omp: no import, and Add account runs omp login in the embedded terminal", async () => {
		mockedApi.request.startAccountLogin.mockResolvedValue({
			loginId: "o1",
			kind: "omp",
			phase: "running",
			sessionKey: "account-login-o1",
			deviceAuth: false,
			manualCommand: "PI_CODING_AGENT_DIR='/x' omp login",
			executable: "omp",
			installUrl: null,
			exitCode: null,
			error: null,
			pending: null,
			account: null,
			startedAt: 0,
			expiresAt: 1,
		});
		const user = userEvent.setup();
		renderSection();
		await screen.findByText("omp default (~/.omp/agent)");
		// Claude and Codex import; omp has nothing to import.
		expect(screen.getAllByText("Import current login")).toHaveLength(2);

		const addButtons = screen.getAllByText("Add account");
		await user.click(addButtons[addButtons.length - 1]);
		expect(mockedApi.request.startAccountLogin).toHaveBeenCalledWith({ kind: "omp", remoteViewer: true });
		expect(await screen.findByText("Sign in to Oh My Pi")).toBeTruthy();
		expect(await screen.findByTestId("terminal-view")).toBeTruthy();
		expect(mockedApi.request.getAccountLoginPtyUrl).toHaveBeenCalledWith({ sessionKey: "account-login-o1" });
		// The provider list is explained in remote mode too, next to the host-browser note.
		expect(screen.getByText(/type a provider’s number.*appears on the host, not here/)).toBeTruthy();
	});

	it("imports the current login", async () => {
		mockedApi.request.importAgentAccount.mockResolvedValue({} as any);
		const user = userEvent.setup();
		renderSection();
		await screen.findByText("Default login (/home/me/.claude)");
		const importButtons = screen.getAllByText("Import current login");
		await user.click(importButtons[0]);
		await waitFor(() => {
			expect(mockedApi.request.importAgentAccount).toHaveBeenCalledWith({ kind: "claude" });
		});
	});

	function login(overrides?: Partial<AccountLoginState>): AccountLoginState {
		return {
			loginId: "l1",
			kind: "claude",
			phase: "running",
			sessionKey: "account-login-l1",
			deviceAuth: false,
			manualCommand: "CLAUDE_CONFIG_DIR='/x' claude /login",
			executable: "claude",
			installUrl: "https://example.com/install",
			exitCode: null,
			error: null,
			pending: null,
			account: null,
			startedAt: 0,
			expiresAt: 1,
			...overrides,
		};
	}

	function pushLogin(state: AccountLoginState | null, kind: "claude" | "codex" = "claude") {
		act(() => {
			window.dispatchEvent(new CustomEvent("rpc:accountLoginChanged", { detail: { kind, state } }));
		});
	}

	it("Add account opens the embedded sign-in terminal on the host, not a command to copy", async () => {
		mockedApi.request.startAccountLogin.mockResolvedValue(login());
		const user = userEvent.setup();
		renderSection();
		await screen.findByText("Default login (/home/me/.claude)");

		await user.click(screen.getAllByText("Add account")[0]);

		expect(mockedApi.request.startAccountLogin).toHaveBeenCalledWith({ kind: "claude", remoteViewer: true });
		expect(await screen.findByText("Sign in to Claude Code")).toBeTruthy();
		expect(await screen.findByTestId("terminal-view")).toBeTruthy();
		expect(mockedApi.request.getAccountLoginPtyUrl).toHaveBeenCalledWith({ sessionKey: "account-login-l1" });
		// A remote viewer is told the CLI's browser tab opens on the host.
		expect(screen.getByText(/appears on the host, not here/)).toBeTruthy();
		expect(screen.queryByTestId("account-login-manual")).toBeNull();
	});

	it("shows success from the host's verification and Done releases the login", async () => {
		mockedApi.request.startAccountLogin.mockResolvedValue(login());
		const user = userEvent.setup();
		renderSection();
		await screen.findByText("Default login (/home/me/.claude)");
		await user.click(screen.getAllByText("Add account")[0]);
		await screen.findByText("Sign in to Claude Code");
		mockedApi.request.listAgentAccounts.mockClear();

		pushLogin(login({ phase: "succeeded", account: { label: "new@example.com" } as any }));

		expect(await screen.findByText("Signed in as new@example.com")).toBeTruthy();
		expect(mockedApi.request.listAgentAccounts).toHaveBeenCalled();
		await user.click(screen.getByTestId("account-login-done"));
		await waitFor(() => expect(mockedApi.request.closeAccountLogin).toHaveBeenCalledWith({ loginId: "l1" }));
		await waitFor(() => expect(screen.queryByTestId("account-login-modal")).toBeNull());
	});

	it("Tab never traps the keyboard inside the sign-in terminal", async () => {
		mockedApi.request.startAccountLogin.mockResolvedValue(login());
		const user = userEvent.setup();
		renderSection();
		await screen.findByText("Default login (/home/me/.claude)");
		await user.click(screen.getAllByText("Add account")[0]);
		const terminal = await screen.findByTestId("terminal-view");
		// Like ghostty's input: it swallows Tab as a keystroke for the PTY.
		const inner = document.createElement("textarea");
		inner.addEventListener("keydown", (e) => {
			if (e.key === "Tab") {
				e.preventDefault();
				e.stopPropagation();
			}
		});
		terminal.appendChild(inner);
		inner.focus();

		await user.keyboard("{Tab}");
		expect(document.activeElement).toBe(screen.getByTestId("account-login-cancel"));
		inner.focus();
		await user.keyboard("{Shift>}{Tab}{/Shift}");
		expect(document.activeElement).toBe(screen.getByTestId("account-login-hide"));
	});

	it("an identity the provider has not confirmed is shown as pending, never as success", async () => {
		mockedApi.request.startAccountLogin.mockResolvedValue(login());
		const user = userEvent.setup();
		renderSection();
		await screen.findByText("Default login (/home/me/.claude)");
		await user.click(screen.getAllByText("Add account")[0]);
		await screen.findByText("Sign in to Claude Code");

		pushLogin(login({ pending: "status-unavailable" }));
		expect((await screen.findByTestId("account-login-pending")).textContent).toContain("claude auth status");
		expect(screen.queryByTestId("account-login-done")).toBeNull();
	});

	it("hiding keeps the sign-in running and offers Open / Cancel in the list", async () => {
		mockedApi.request.startAccountLogin.mockResolvedValue(login());
		const user = userEvent.setup();
		renderSection();
		await screen.findByText("Default login (/home/me/.claude)");
		await user.click(screen.getAllByText("Add account")[0]);
		await screen.findByText("Sign in to Claude Code");

		await user.click(screen.getByTestId("account-login-hide"));
		expect(screen.queryByTestId("account-login-modal")).toBeNull();
		expect(mockedApi.request.closeAccountLogin).not.toHaveBeenCalled();
		const row = screen.getByTestId("account-login-row-claude");
		expect(row.textContent).toContain("Sign-in in progress");

		await user.click(screen.getByText("Open"));
		expect(await screen.findByTestId("account-login-modal")).toBeTruthy();
		await user.click(screen.getByTestId("account-login-cancel"));
		await waitFor(() => expect(mockedApi.request.closeAccountLogin).toHaveBeenCalledWith({ loginId: "l1" }));
	});

	it("a missing CLI shows the manual fallback and retries through the host", async () => {
		mockedApi.request.startAccountLogin.mockResolvedValue(login({ phase: "missing-executable", sessionKey: null }));
		mockedApi.request.restartAccountLogin.mockResolvedValue(login({ loginId: "l2" }));
		const user = userEvent.setup();
		renderSection();
		await screen.findByText("Default login (/home/me/.claude)");
		await user.click(screen.getAllByText("Add account")[0]);

		expect(await screen.findByText("claude isn’t installed on the dev3 host")).toBeTruthy();
		expect(screen.queryByTestId("account-login-terminal")).toBeNull();
		expect(screen.getByTestId("account-login-manual").textContent).toContain("CLAUDE_CONFIG_DIR='/x' claude /login");

		await user.click(screen.getByTestId("account-login-retry"));
		await waitFor(() => expect(mockedApi.request.restartAccountLogin).toHaveBeenCalledWith({ loginId: "l1", remoteViewer: true }));
	});

	it("picks up a sign-in already running on the host when the screen opens", async () => {
		mockedApi.request.getAccountLogin.mockImplementation(async ({ kind }) => (kind === "codex" ? login({ kind: "codex", phase: "exited" }) : null));
		renderSection();
		const row = await screen.findByTestId("account-login-row-codex");
		expect(row.textContent).toContain("The sign-in command ended before a login was saved");
		expect(mockedApi.request.startAccountLogin).not.toHaveBeenCalled();
	});

	it("removes an account after confirmation", async () => {
		const user = userEvent.setup();
		renderSection();
		await screen.findByText("work@example.com");
		await user.click(screen.getByText("Remove"));
		await waitFor(() => {
			expect(mockedConfirm).toHaveBeenCalled();
			expect(mockedApi.request.removeAgentAccount).toHaveBeenCalledWith({
				kind: "claude",
				accountId: "cl-1",
			});
		});
	});

	it("does not remove when confirmation is declined", async () => {
		mockedConfirm.mockResolvedValue(false);
		const user = userEvent.setup();
		renderSection();
		await screen.findByText("work@example.com");
		await user.click(screen.getByText("Remove"));
		await waitFor(() => expect(mockedConfirm).toHaveBeenCalled());
		expect(mockedApi.request.removeAgentAccount).not.toHaveBeenCalled();
	});

	it("adds an API profile through the inline form", async () => {
		mockedApi.request.addAgentApiProfile.mockResolvedValue({} as any);
		const user = userEvent.setup();
		renderSection();
		await screen.findByText("Default login (/home/me/.claude)");

		await user.click(screen.getByText("Add API profile"));
		await user.type(screen.getByPlaceholderText("https://openrouter.ai/api"), "https://openrouter.ai/api");
		await user.type(screen.getByPlaceholderText("sk-ant-…"), "sk-or-123");
		await user.type(screen.getByPlaceholderText(/CLAUDE_CODE_USE_BEDROCK/), "AWS_REGION=us-east-1");
		await user.click(screen.getByText("Add profile"));

		await waitFor(() => {
			expect(mockedApi.request.addAgentApiProfile).toHaveBeenCalledWith({
				kind: "claude",
				label: undefined,
				baseUrl: "https://openrouter.ai/api",
				apiKey: "sk-or-123",
				model: undefined,
				slotModels: {},
				envText: "AWS_REGION=us-east-1",
			});
		});
	});

	it("keeps the Add profile button disabled while the form is empty", async () => {
		const user = userEvent.setup();
		renderSection();
		await screen.findByText("Default login (/home/me/.claude)");

		await user.click(screen.getByText("Add API profile"));
		expect((screen.getByText("Add profile") as HTMLButtonElement).disabled).toBe(true);
		expect(mockedApi.request.addAgentApiProfile).not.toHaveBeenCalled();
	});

	it("renders API profile rows with API badge and host (no model list)", async () => {
		mockedApi.request.listAgentAccounts.mockResolvedValue(
			makeState({
				claude: {
					accounts: [
						{
							id: "api-1",
							kind: "claude",
							label: "OpenRouter",
							identity: null,
							auth: "api",
							api: {
								baseUrl: "https://openrouter.ai/api",
								model: "claude-sonnet-4-6",
								slotModels: {},
								hasApiKey: true,
								envKeys: [],
							},
							createdAt: 1,
						},
					],
					activeId: "api-1",
					systemConfigDir: "/home/me/.claude", systemIdentity: null,
				},
			}),
		);
		renderSection();
		expect(await screen.findByText("OpenRouter")).toBeTruthy();
		expect(screen.getByText("API")).toBeTruthy();
		expect(screen.getByText("openrouter.ai")).toBeTruthy();
		// The per-slot / master model is intentionally not shown in the compact row.
		expect(screen.queryByText("claude-sonnet-4-6")).toBeNull();
	});

	it("edits an API profile: prefills the form (incl. the key) and updates the master model", async () => {
		mockedApi.request.listAgentAccounts.mockResolvedValue(
			makeState({
				claude: {
					accounts: [
						{
							id: "api-1",
							kind: "claude",
							label: "OpenRouter",
							identity: null,
							auth: "api",
							api: { baseUrl: "https://openrouter.ai/api", model: "old-model", slotModels: {}, hasApiKey: true, envKeys: ["AWS_REGION"] },
							createdAt: 1,
						},
					],
					activeId: "api-1",
					systemConfigDir: "/home/me/.claude", systemIdentity: null,
				},
			}),
		);
		mockedApi.request.getAgentApiProfileDraft.mockResolvedValue({
			label: "OpenRouter",
			baseUrl: "https://openrouter.ai/api",
			apiKey: "sk-live-key",
			model: "old-model",
			slotModels: {},
			envText: "AWS_REGION=us-east-1",
			hasApiKey: true,
		});
		mockedApi.request.updateAgentApiProfile.mockResolvedValue({} as any);
		const user = userEvent.setup();
		renderSection();

		await screen.findByText("OpenRouter");
		await user.click(screen.getByLabelText("Edit API profile — OpenRouter"));

		// Form is prefilled from the draft, including the (masked) key value.
		// Master field is the one carrying the current model value (its placeholder
		// intentionally matches the Opus/Fable slot examples).
		const modelInput = (await screen.findByDisplayValue("old-model")) as HTMLInputElement;
		expect(modelInput.value).toBe("old-model");
		expect((screen.getByPlaceholderText("https://openrouter.ai/api") as HTMLInputElement).value).toBe(
			"https://openrouter.ai/api",
		);
		expect((screen.getByPlaceholderText("sk-ant-…") as HTMLInputElement).value).toBe("sk-live-key");

		await user.clear(modelInput);
		await user.type(modelInput, "new-model");
		await user.click(screen.getByText("Save changes"));

		await waitFor(() => {
			expect(mockedApi.request.updateAgentApiProfile).toHaveBeenCalledWith({
				kind: "claude",
				accountId: "api-1",
				label: "OpenRouter",
				baseUrl: "https://openrouter.ai/api",
				apiKey: "sk-live-key",
				model: "new-model",
				slotModels: {},
				envText: "AWS_REGION=us-east-1",
			});
		});
	});

	it("auto-fills a slot's Name from the Model ID's last path segment", async () => {
		mockedApi.request.addAgentApiProfile.mockResolvedValue({} as any);
		const user = userEvent.setup();
		renderSection();
		await screen.findByText("Default login (/home/me/.claude)");

		await user.click(screen.getByText("Add API profile"));
		// The Haiku slot's Model ID placeholder is a deepseek example.
		const haikuId = screen.getByPlaceholderText("deepseek/deepseek-v4-flash");
		await user.type(haikuId, "provider/my-fast-model");

		// The adjacent Name field (placeholder = derived example) auto-fills.
		const nameInputs = screen.getAllByPlaceholderText("deepseek-v4-flash");
		expect((nameInputs[0] as HTMLInputElement).value).toBe("my-fast-model");
	});

	it("reveals the API key when the eye toggle is clicked", async () => {
		mockedApi.request.getAgentApiProfileDraft.mockResolvedValue({
			label: "OpenRouter",
			baseUrl: "https://openrouter.ai/api",
			apiKey: "sk-live-key",
			model: "",
			slotModels: {},
			envText: "",
			hasApiKey: true,
		});
		mockedApi.request.listAgentAccounts.mockResolvedValue(
			makeState({
				claude: {
					accounts: [
						{
							id: "api-1",
							kind: "claude",
							label: "OpenRouter",
							identity: null,
							auth: "api",
							api: { baseUrl: "https://openrouter.ai/api", model: "", slotModels: {}, hasApiKey: true, envKeys: [] },
							createdAt: 1,
						},
					],
					activeId: "api-1",
					systemConfigDir: "/home/me/.claude", systemIdentity: null,
				},
			}),
		);
		const user = userEvent.setup();
		renderSection();
		await screen.findByText("OpenRouter");
		await user.click(screen.getByLabelText("Edit API profile — OpenRouter"));

		const keyInput = (await screen.findByPlaceholderText("sk-ant-…")) as HTMLInputElement;
		expect(keyInput.type).toBe("password");
		await user.click(screen.getByLabelText("Show key"));
		expect(keyInput.type).toBe("text");
	});

	it("shows the unmanaged codex login row", async () => {
		mockedApi.request.listAgentAccounts.mockResolvedValue(
			makeState({
				codex: {
					accounts: [],
					activeId: null,
					currentIdentity: {
						email: "codex@example.com",
						organization: null,
						plan: "plus",
						planLabel: "Plus",
						accountId: "acc-1",
					},
				},
			}),
		);
		renderSection();
		expect(await screen.findByText("Unmanaged login")).toBeTruthy();
		expect(screen.getByText("codex@example.com")).toBeTruthy();
		expect(screen.getByText("Workspace acc-1")).toBeTruthy();
	});

	it("shows a readable name for a resolved Codex workspace", async () => {
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
								organization: "Globex ChatGPT Enterprise",
								plan: "enterprise_cbp_usage_based",
								planLabel: "Enterprise",
								accountId: "b8e0e9ae-workspace",
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

		renderSection();
		expect(await screen.findByText("Workspace Globex ChatGPT Enterprise")).toBeTruthy();
		expect(screen.queryByText("Workspace b8e0e9ae")).toBeNull();
	});

	it("lists each project-pinned Claude login beside ~/.claude, with the projects that pin it", async () => {
		mockedApi.request.listAgentAccounts.mockResolvedValue(
			makeState({
				claude: { ...makeState().claude, accounts: [] },
			}),
		);
		mockedApi.request.listPinnedClaudeLogins.mockResolvedValueOnce([
			{
				configDir: "/mnt/e/Projects/app/.claude",
				identity: { email: "pin@example.com", organization: null, plan: null, planLabel: null, accountId: null },
				projectNames: ["app", "app-docs"],
			},
		]);
		renderSection();
		expect(await screen.findByText("Project login (…/app/.claude)")).toBeTruthy();
		expect(screen.getByText("pin@example.com")).toBeTruthy();
		expect(screen.getByText("Pinned by app, app-docs")).toBeTruthy();
		expect(screen.getByText("Default login (/home/me/.claude)")).toBeTruthy();
		expect(screen.queryByText(/override these pins/)).toBeNull();
		expect(screen.getByText(/the default login only applies to projects without one/)).toBeTruthy();
		// Informational rows carry no radio circle that would read as "not selected".
		expect(screen.getByTestId("pinned-claude-logins").querySelector(".rounded-full")).toBeNull();
	});

	it("says when nobody is signed into the default login", async () => {
		mockedApi.request.listAgentAccounts.mockResolvedValue(
			makeState({ claude: { ...makeState().claude, accounts: [], systemIdentity: null } }),
		);
		renderSection();
		expect(await screen.findByText("Not signed in")).toBeTruthy();
	});

	it("warns that managed accounts override the pins", async () => {
		mockedApi.request.listAgentAccounts.mockResolvedValue(makeState());
		mockedApi.request.listPinnedClaudeLogins.mockResolvedValueOnce([
			{ configDir: "/p/app/.claude", identity: null, projectNames: ["app"] },
		]);
		renderSection();
		expect(await screen.findByText(/override these pins/)).toBeTruthy();
	});
});
