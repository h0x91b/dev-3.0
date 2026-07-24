import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AgentSettingsSection from "../AgentSettingsSection";
import { I18nProvider } from "../../../i18n";
import { DEFAULT_AGENTS, type CodingAgent, type GlobalSettings } from "../../../../shared/types";

// The section renders AgentConfigPicker → AgentAccountIndicator, which lists
// managed agent accounts. Empty registries keep the indicator hidden here.
vi.mock("../../../rpc", () => ({
	api: {
		request: {
			checkAgentAvailability: vi.fn(() => Promise.resolve([])),
			setAgentBinaryPath: vi.fn(() => Promise.resolve()),
			listAgentAccounts: vi.fn(() =>
				Promise.resolve({
					claude: { accounts: [], activeId: null, systemIdentity: null },
					codex: { accounts: [], activeId: null, currentIdentity: null },
				}),
			),
			setActiveAgentAccount: vi.fn(),
		},
	},
}));

const baseSettings: GlobalSettings = {
	defaultAgentId: "builtin-claude",
	defaultConfigId: "claude-auto-opus48",
	taskDropPosition: "top",
	updateChannel: "stable",
};

/** Apply a partial patch to the Claude agent in DEFAULT_AGENTS for a test render. */
function agentsWithClaude(patch: Partial<CodingAgent>): CodingAgent[] {
	return DEFAULT_AGENTS.map((a) =>
		a.baseCommand === "claude" ? { ...a, ...patch } : a,
	);
}

function renderSection(claudePatch: Partial<CodingAgent> = {}, onAgentsChange = vi.fn()) {
	render(
		<I18nProvider>
			<AgentSettingsSection
				t={((k: string) => k) as never}
				agents={agentsWithClaude(claudePatch)}
				globalSettings={baseSettings}
				onAgentsChange={onAgentsChange}
				onDefaultAgentChange={vi.fn()}
				onDefaultConfigChange={vi.fn()}
			/>
		</I18nProvider>,
	);
	return onAgentsChange;
}

/** Expand an agent's row by clicking its header (so its provider section renders). */
async function expandAgent(user: ReturnType<typeof userEvent.setup>, name: string) {
	// The agent header is a role=button containing the agent name.
	const header = screen.getAllByRole("button", { name: new RegExp(name) })[0];
	await user.click(header);
}

/** Pull the patched Claude agent out of the last onAgentsChange call. */
function lastClaude(onAgentsChange: ReturnType<typeof vi.fn>): CodingAgent {
	const calls = onAgentsChange.mock.calls;
	const updated = calls[calls.length - 1][0] as CodingAgent[];
	return updated.find((a) => a.baseCommand === "claude")!;
}

describe("AgentSettingsSection — per-agent provider selector", () => {
	// The stub `t` returns the key verbatim, so provider buttons are labeled by key.
	it("shows the provider toggle inside the expanded Claude agent", async () => {
		const user = userEvent.setup();
		renderSection();
		await expandAgent(user, "Claude");
		expect(screen.getByRole("button", { name: "settings.providerAnthropic" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "settings.providerBedrock" })).toBeTruthy();
	});

	it("shows the OpenAI/Bedrock toggle inside the expanded Codex agent (no geo selector)", async () => {
		const user = userEvent.setup();
		renderSection();
		await expandAgent(user, "Codex");
		expect(screen.getByRole("button", { name: "settings.providerOpenAI" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "settings.providerBedrock" })).toBeTruthy();
	});

	it("does NOT show a provider toggle for an agent with no registered backend (Gemini)", async () => {
		const user = userEvent.setup();
		renderSection();
		await expandAgent(user, "Gemini");
		// Gemini has no backend in the registry → no provider toggle.
		expect(screen.queryByRole("button", { name: "settings.providerBedrock" })).toBeNull();
	});

	it("Codex on Bedrock: model table derives flat openai.<family> ids and hides the geo toggle", async () => {
		const user = userEvent.setup();
		render(
			<I18nProvider>
				<AgentSettingsSection
					t={((k: string) => k) as never}
					agents={DEFAULT_AGENTS.map((a) =>
						a.baseCommand === "codex" ? { ...a, llmProvider: "bedrock-codex" as const } : a,
					)}
					globalSettings={baseSettings}
					onAgentsChange={vi.fn()}
					onDefaultAgentChange={vi.fn()}
					onDefaultConfigChange={vi.fn()}
				/>
			</I18nProvider>,
		);
		await expandAgent(user, "Codex");
		expect(screen.getByPlaceholderText("openai.gpt-5.6-sol")).toBeTruthy();
		// Bedrock's OpenAI ids carry no geo prefix → no inference-profile selector.
		expect(screen.queryByRole("button", { name: "global" })).toBeNull();
	});

	it("selecting Bedrock persists llmProvider on the Claude agent", async () => {
		const user = userEvent.setup();
		const onAgentsChange = renderSection();
		await expandAgent(user, "Claude");
		await user.click(screen.getByRole("button", { name: "settings.providerBedrock" }));
		expect(lastClaude(onAgentsChange).llmProvider).toBe("bedrock");
	});

	it("shows the geo toggle + pre-populated model table when Bedrock is selected", async () => {
		const user = userEvent.setup();
		renderSection({ llmProvider: "bedrock" });
		await expandAgent(user, "Claude");
		expect(screen.getByRole("button", { name: "global" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "eu" })).toBeTruthy();
		expect(
			screen.getByPlaceholderText("global.anthropic.claude-opus-4-8[1m]"),
		).toBeTruthy();
	});

	it("changing the geo persists it on the agent's providerConfig", async () => {
		const user = userEvent.setup();
		const onAgentsChange = renderSection({ llmProvider: "bedrock" });
		await expandAgent(user, "Claude");
		await user.click(screen.getByRole("button", { name: "eu" }));
		expect(lastClaude(onAgentsChange).providerConfig).toEqual({ bedrock: { geo: "eu" } });
	});

	it("hides provider fields on the native (Anthropic) provider", async () => {
		const user = userEvent.setup();
		renderSection({ llmProvider: "anthropic" });
		await expandAgent(user, "Claude");
		expect(screen.queryByRole("button", { name: "global" })).toBeNull();
		expect(screen.queryByText("settings.providerModelTable")).toBeNull();
	});

	it("editing a model-table row writes a per-model override keyed by alias", async () => {
		const user = userEvent.setup();
		const onAgentsChange = renderSection({ llmProvider: "bedrock" });
		await expandAgent(user, "Claude");
		const input = screen.getByPlaceholderText("global.anthropic.claude-opus-4-8[1m]");
		await user.type(input, "z");
		const override = lastClaude(onAgentsChange).providerConfig?.bedrock?.modelOverrides?.[
			"claude-opus-4-8[1m]"
		];
		expect(override).toContain("z");
	});

	it("an overridden row shows the Manual badge and a Revert control", async () => {
		const user = userEvent.setup();
		renderSection({
			llmProvider: "bedrock",
			providerConfig: {
				bedrock: { modelOverrides: { "claude-opus-4-8[1m]": "us.anthropic.claude-opus-4-8" } },
			},
		});
		await expandAgent(user, "Claude");
		expect(screen.getByDisplayValue("us.anthropic.claude-opus-4-8")).toBeTruthy();
		expect(screen.getAllByText("settings.providerModelManual").length).toBeGreaterThan(0);
		expect(screen.getAllByText("settings.providerModelRevert").length).toBeGreaterThan(0);
	});

	it("clicking Revert clears that model's override", async () => {
		const user = userEvent.setup();
		const onAgentsChange = renderSection({
			llmProvider: "bedrock",
			providerConfig: {
				bedrock: { modelOverrides: { "claude-opus-4-8[1m]": "us.anthropic.claude-opus-4-8" } },
			},
		});
		await expandAgent(user, "Claude");
		await user.click(screen.getAllByText("settings.providerModelRevert")[0]);
		// Sole override removed → modelOverrides becomes undefined.
		expect(lastClaude(onAgentsChange).providerConfig?.bedrock?.modelOverrides).toBeUndefined();
	});
});
