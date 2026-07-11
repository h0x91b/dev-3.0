import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentAccountsState } from "../../../../shared/agent-accounts";
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
			prepareAgentAccountLogin: vi.fn(),
			completeAgentAccountLogin: vi.fn(),
			setActiveAgentAccount: vi.fn(),
			removeAgentAccount: vi.fn(),
			renameAgentAccount: vi.fn(),
		},
	},
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
	mockedConfirm.mockResolvedValue(true);
});

describe("AgentAccountsSection", () => {
	it("renders the system login row, accounts, and plan badges", async () => {
		renderSection();
		expect(await screen.findByText("System login (~/.claude)")).toBeTruthy();
		expect(screen.getByText("work@example.com")).toBeTruthy();
		expect(screen.getByText("main@example.com")).toBeTruthy();
		expect(screen.getByText("Max 5x")).toBeTruthy();
		// System login is active by default (activeId=null).
		expect(screen.getByText("Active")).toBeTruthy();
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

	it("imports the current login", async () => {
		mockedApi.request.importAgentAccount.mockResolvedValue({} as any);
		const user = userEvent.setup();
		renderSection();
		await screen.findByText("System login (~/.claude)");
		const importButtons = screen.getAllByText("Import current login");
		await user.click(importButtons[0]);
		await waitFor(() => {
			expect(mockedApi.request.importAgentAccount).toHaveBeenCalledWith({ kind: "claude" });
		});
	});

	it("runs the add-account flow: shows the login command and verifies", async () => {
		mockedApi.request.prepareAgentAccountLogin.mockResolvedValue({
			accountId: "pending-1",
			loginCommand: "CLAUDE_CONFIG_DIR='/x' claude /login",
		});
		mockedApi.request.completeAgentAccountLogin.mockResolvedValue({} as any);
		const user = userEvent.setup();
		renderSection();
		await screen.findByText("System login (~/.claude)");

		const addButtons = screen.getAllByText("+ Add account");
		await user.click(addButtons[0]);

		expect(await screen.findByText("CLAUDE_CONFIG_DIR='/x' claude /login")).toBeTruthy();
		await user.click(screen.getByText("I’ve logged in — verify"));
		await waitFor(() => {
			expect(mockedApi.request.completeAgentAccountLogin).toHaveBeenCalledWith({
				kind: "claude",
				accountId: "pending-1",
			});
		});
	});

	it("cancelling a claude add-flow cleans up the pending dir", async () => {
		mockedApi.request.prepareAgentAccountLogin.mockResolvedValue({
			accountId: "pending-1",
			loginCommand: "CLAUDE_CONFIG_DIR='/x' claude /login",
		});
		const user = userEvent.setup();
		renderSection();
		await screen.findByText("System login (~/.claude)");
		await user.click(screen.getAllByText("+ Add account")[0]);
		await screen.findByText("CLAUDE_CONFIG_DIR='/x' claude /login");

		await user.click(screen.getByText("Cancel"));
		await waitFor(() => {
			expect(mockedApi.request.removeAgentAccount).toHaveBeenCalledWith({
				kind: "claude",
				accountId: "pending-1",
			});
		});
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
		await screen.findByText("System login (~/.claude)");

		await user.click(screen.getByText("+ API profile"));
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
		await screen.findByText("System login (~/.claude)");

		await user.click(screen.getByText("+ API profile"));
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
					systemIdentity: null,
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
					systemIdentity: null,
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
		await user.click(screen.getByLabelText("Edit API profile"));

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
		await screen.findByText("System login (~/.claude)");

		await user.click(screen.getByText("+ API profile"));
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
					systemIdentity: null,
				},
			}),
		);
		const user = userEvent.setup();
		renderSection();
		await screen.findByText("OpenRouter");
		await user.click(screen.getByLabelText("Edit API profile"));

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
	});
});
