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
			toggleFavoriteAgent: vi.fn(() => Promise.resolve({})),
			checkCodexBedrockConfig: vi.fn(() => Promise.resolve({ configured: true })),
		},
	},
}));

vi.mock("../../../confirm", () => ({ confirm: vi.fn(() => Promise.resolve(true)) }));
vi.mock("../../../toast", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { api } from "../../../rpc";
import { confirm } from "../../../confirm";

/** Identity translator: keys render verbatim, and `t.plural` answers with the
 *  suffixed key so a plural call is as assertable as a plain one. */
const identityT = Object.assign((key: string) => key, {
	plural: (key: string, count: number) => key + (count === 1 ? "_one" : "_other"),
});

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
				t={identityT as never}
				agents={agentsWithClaude(claudePatch)}
				globalSettings={baseSettings}
				onAgentsChange={onAgentsChange}
				onDefaultAgentChange={vi.fn()}
				onDefaultConfigChange={vi.fn()}
				onGlobalSettingsChange={vi.fn()}
			/>
		</I18nProvider>,
	);
	return onAgentsChange;
}

/** Point the library's one detail pane at an agent (its own settings, not a preset),
 *  which is what renders the provider section. */
async function expandAgent(user: ReturnType<typeof userEvent.setup>, name: string) {
	const trigger = document.getElementById("agent-library-agent");
	if (!trigger) throw new Error("agent library select is missing");
	await user.click(trigger);
	await user.click(screen.getByRole("option", { name: new RegExp(name) }));
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
					t={identityT as never}
					agents={DEFAULT_AGENTS.map((a) =>
						a.baseCommand === "codex" ? { ...a, llmProvider: "bedrock-codex" as const } : a,
					)}
					globalSettings={baseSettings}
					onAgentsChange={vi.fn()}
					onDefaultAgentChange={vi.fn()}
					onDefaultConfigChange={vi.fn()}
					onGlobalSettingsChange={vi.fn()}
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

	it("Codex on Bedrock: warns when ~/.codex/config.toml lacks the provider section", async () => {
		vi.mocked(api.request.checkCodexBedrockConfig).mockResolvedValueOnce({ configured: false });
		const user = userEvent.setup();
		render(
			<I18nProvider>
				<AgentSettingsSection
					t={identityT as never}
					agents={DEFAULT_AGENTS.map((a) =>
						a.baseCommand === "codex" ? { ...a, llmProvider: "bedrock-codex" as const } : a,
					)}
					globalSettings={baseSettings}
					onAgentsChange={vi.fn()}
					onDefaultAgentChange={vi.fn()}
					onDefaultConfigChange={vi.fn()}
					onGlobalSettingsChange={vi.fn()}
				/>
			</I18nProvider>,
		);
		await expandAgent(user, "Codex");
		expect(await screen.findByText("settings.providerBedrockCodexConfigMissing")).toBeTruthy();
	});

	it("Codex on Bedrock: no warning when the provider section exists (default mock)", async () => {
		const user = userEvent.setup();
		render(
			<I18nProvider>
				<AgentSettingsSection
					t={identityT as never}
					agents={DEFAULT_AGENTS.map((a) =>
						a.baseCommand === "codex" ? { ...a, llmProvider: "bedrock-codex" as const } : a,
					)}
					globalSettings={baseSettings}
					onAgentsChange={vi.fn()}
					onDefaultAgentChange={vi.fn()}
					onDefaultConfigChange={vi.fn()}
					onGlobalSettingsChange={vi.fn()}
				/>
			</I18nProvider>,
		);
		await expandAgent(user, "Codex");
		// Let the preflight promise resolve before asserting the negative.
		expect(screen.getByPlaceholderText("openai.gpt-5.6-sol")).toBeTruthy();
		expect(screen.queryByText("settings.providerBedrockCodexConfigMissing")).toBeNull();
	});

	it("a stale provider id (base command changed to codex) renders no provider fields", async () => {
		const user = userEvent.setup();
		// Claude was on Bedrock, then its base command was edited to `codex`:
		// `"bedrock"` belongs to the claude backend, so nothing should render for it.
		renderSection({ llmProvider: "bedrock", baseCommand: "codex" });
		await expandAgent(user, "Claude");
		expect(screen.queryByText("settings.providerBedrockHint")).toBeNull();
		expect(screen.queryByRole("button", { name: "global" })).toBeNull();
		expect(screen.queryByText("settings.providerModelTable")).toBeNull();
	});

	it("a stale provider id highlights the native option (matches launcher fallback)", async () => {
		const user = userEvent.setup();
		renderSection({ llmProvider: "bedrock", baseCommand: "codex" });
		await expandAgent(user, "Claude");
		// The launcher rejects the mismatched id and launches native — the toggle
		// must show the same reality, not render with no active option.
		const native = screen.getAllByRole("button", { name: "settings.providerOpenAI" })[0];
		expect(native.className).toContain("bg-accent");
	});

	it("selecting a preset row swaps the detail pane to that preset's editor", async () => {
		const user = userEvent.setup();
		renderSection();
		// Claude's presets are grouped by model, labelled by the launch picker's mode leaf.
		await user.click(screen.getAllByRole("option", { name: /Auto · Medium/ })[0]);
		expect(screen.getByDisplayValue("Auto (Fable 5, Medium)")).toBeTruthy();
		expect(screen.getByText("settings.commandPreview")).toBeTruthy();
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

/** Select the Nth preset row for the active agent (rows carry the mode leaf label). */
async function openPreset(user: ReturnType<typeof userEvent.setup>, label: RegExp) {
	await user.click(screen.getAllByRole("option", { name: label })[0]);
}

describe("AgentSettingsSection — preset library", () => {
	it("filters the list loosely, so “xhigh” finds “X-High” rows", async () => {
		const user = userEvent.setup();
		renderSection();
		const search = screen.getByLabelText("settings.presetSearchLabel");
		expect(screen.getAllByRole("option", { name: /Auto · Medium/ }).length).toBeGreaterThan(0);

		await user.type(search, "xhigh");
		expect(screen.queryByRole("option", { name: /Auto · Medium/ })).toBeNull();
		expect(screen.getAllByRole("option", { name: /X-High/ }).length).toBeGreaterThan(0);
	});

	it("says so when the filter matches no preset", async () => {
		const user = userEvent.setup();
		renderSection();
		await user.type(screen.getByLabelText("settings.presetSearchLabel"), "definitelynothing");
		expect(screen.getAllByText("settings.presetSearchEmpty").length).toBeGreaterThan(0);
	});

	it("duplicating a preset inserts a copy right after it and selects it", async () => {
		const user = userEvent.setup();
		const onAgentsChange = renderSection();
		await openPreset(user, /Auto · Medium/);
		await user.click(screen.getByRole("button", { name: "settings.duplicatePreset" }));

		const configs = lastClaude(onAgentsChange).configurations;
		const sourceIndex = configs.findIndex((c) => c.id === "claude-auto-fable5-medium");
		expect(configs[sourceIndex + 1].name).toBe("settings.presetCopyName");
		expect(configs[sourceIndex + 1].model).toBe("claude-fable-5");
	});

	it("Make default writes defaultConfigId for the selected preset", async () => {
		const user = userEvent.setup();
		const onAgentsChange = renderSection();
		await openPreset(user, /Auto · High/);
		await user.click(screen.getByRole("button", { name: "settings.setDefaultConfig" }));
		expect(lastClaude(onAgentsChange).defaultConfigId).toBe("claude-auto-fable5-high");
	});

	it("deleting a preset asks first and only then removes it", async () => {
		const user = userEvent.setup();
		const onAgentsChange = renderSection();
		await openPreset(user, /Auto · Medium/);
		await user.click(screen.getByRole("button", { name: "settings.deleteConfig" }));

		expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
		expect(
			lastClaude(onAgentsChange).configurations.some((c) => c.id === "claude-auto-fable5-medium"),
		).toBe(false);
	});

	it("keeps a preset when the confirmation is declined", async () => {
		vi.mocked(confirm).mockResolvedValueOnce(false);
		const user = userEvent.setup();
		const onAgentsChange = renderSection();
		await openPreset(user, /Auto · Medium/);
		await user.click(screen.getByRole("button", { name: "settings.deleteConfig" }));
		expect(onAgentsChange).not.toHaveBeenCalled();
	});

	it("stars the selected preset and offers to unstar it once it is a favorite", async () => {
		const user = userEvent.setup();
		render(
			<I18nProvider>
				<AgentSettingsSection
					t={identityT as never}
					agents={DEFAULT_AGENTS}
					globalSettings={baseSettings}
					onAgentsChange={vi.fn()}
					onDefaultAgentChange={vi.fn()}
					onDefaultConfigChange={vi.fn()}
					onGlobalSettingsChange={vi.fn()}
				/>
			</I18nProvider>,
		);
		await openPreset(user, /Auto · Medium/);
		await user.click(screen.getByRole("button", { name: "settings.favoriteAdd" }));
		expect(api.request.toggleFavoriteAgent).toHaveBeenCalledWith({
			agentId: "builtin-claude",
			configId: "claude-auto-fable5-medium",
		});
	});

	it("an already-favorite preset shows the unstar action instead", async () => {
		const user = userEvent.setup();
		render(
			<I18nProvider>
				<AgentSettingsSection
					t={identityT as never}
					agents={DEFAULT_AGENTS}
					globalSettings={{
						...baseSettings,
						favorites: [
							{ agentId: "builtin-claude", configId: "claude-auto-fable5-medium", uses: 3, lastUsedAt: 1 },
						],
					}}
					onAgentsChange={vi.fn()}
					onDefaultAgentChange={vi.fn()}
					onDefaultConfigChange={vi.fn()}
					onGlobalSettingsChange={vi.fn()}
				/>
			</I18nProvider>,
		);
		await openPreset(user, /Auto · Medium/);
		const toggle = screen.getByRole("button", { name: "settings.favoriteRemove" });
		expect(toggle).toHaveAttribute("aria-pressed", "true");
		expect(screen.queryByRole("button", { name: "settings.favoriteAdd" })).toBeNull();
	});

	it("an enum field takes a value the app never shipped", async () => {
		const user = userEvent.setup();
		const onAgentsChange = renderSection();
		await openPreset(user, /Auto · Medium/);

		// The reasoning-effort combobox: type a level dev3 has no option for.
		await user.click(screen.getByLabelText("settings.configEffort"));
		const field = screen.getByRole("combobox", { name: "settings.selectFilterHint" });
		await user.type(field, "ultra{Enter}");

		const config = lastClaude(onAgentsChange).configurations.find(
			(c) => c.id === "claude-auto-fable5-medium",
		);
		expect(config?.effort).toBe("ultra");
	});
});

// The reported bug: dev3 recognizes only the five literal CLI names, so an agent
// pointed at a wrapper script or a shell alias got no lifecycle hooks and its
// task never moved between columns — with nothing on screen saying so.
describe("AgentSettingsSection — lifecycle hooks", () => {
	/** The wrapper tests rename baseCommand, so find the agent by its id. */
	function patchedAgent(onAgentsChange: ReturnType<typeof vi.fn>): CodingAgent {
		const calls = onAgentsChange.mock.calls;
		const updated = calls[calls.length - 1][0] as CodingAgent[];
		return updated.find((a) => a.id === "builtin-claude")!;
	}

	async function openHooksSelect(user: ReturnType<typeof userEvent.setup>) {
		await expandAgent(user, "Claude");
		const trigger = document.getElementById("agent-hooks-builtin-claude");
		if (!trigger) throw new Error("hooks select is missing");
		await user.click(trigger);
	}

	it("says nothing for a command it recognizes", async () => {
		const user = userEvent.setup();
		renderSection();
		await expandAgent(user, "Claude");
		expect(screen.queryByText("settings.hooksMissingTitle")).toBeNull();
	});

	it("warns that an unrecognized command gets no hooks", async () => {
		const user = userEvent.setup();
		renderSection({ baseCommand: "my-claude" });
		await expandAgent(user, "Claude");
		expect(screen.getByText("settings.hooksMissingTitle")).toBeInTheDocument();
	});

	it("stops warning once the agent declares a hook family", async () => {
		const user = userEvent.setup();
		renderSection({ baseCommand: "my-claude", hooksIntegration: "claude" });
		await expandAgent(user, "Claude");
		expect(screen.queryByText("settings.hooksMissingTitle")).toBeNull();
	});

	it("persists the declared family", async () => {
		const user = userEvent.setup();
		const onAgentsChange = renderSection({ baseCommand: "my-claude" });
		await openHooksSelect(user);
		await user.click(screen.getByRole("option", { name: "settings.hooksClaude" }));
		expect(patchedAgent(onAgentsChange).hooksIntegration).toBe("claude");
	});

	it("clears the field back to auto-detection", async () => {
		const user = userEvent.setup();
		const onAgentsChange = renderSection({ baseCommand: "my-claude", hooksIntegration: "codex" });
		await openHooksSelect(user);
		await user.click(screen.getByRole("option", { name: "settings.hooksAuto" }));
		expect(patchedAgent(onAgentsChange).hooksIntegration).toBeUndefined();
	});
});

// Field-level editing moved here when Settings → Agents stopped being accordions;
// GlobalSettings.test.tsx keeps only the screen-level agent CRUD.
describe("AgentSettingsSection — preset fields", () => {
	const PRESET_ID = "claude-auto-fable5-medium";

	function editedPreset(onAgentsChange: ReturnType<typeof vi.fn>) {
		return lastClaude(onAgentsChange).configurations.find((c) => c.id === PRESET_ID);
	}

	it("writes the permission mode picked from the list", async () => {
		const user = userEvent.setup();
		const onAgentsChange = renderSection();
		await openPreset(user, /Auto · Medium/);

		await user.click(screen.getByLabelText("settings.configPermissionMode"));
		await user.click(screen.getByRole("option", { name: "settings.permPlan" }));

		expect(editedPreset(onAgentsChange)?.permissionMode).toBe("plan");
	});

	it("takes a typed budget and stores it as a number", async () => {
		const user = userEvent.setup();
		const onAgentsChange = renderSection();
		await openPreset(user, /Auto · Medium/);

		await user.click(screen.getByLabelText("settings.configMaxBudget"));
		await user.type(screen.getByRole("combobox", { name: "settings.budgetFilterHint" }), "5.5{Enter}");

		expect(editedPreset(onAgentsChange)?.maxBudgetUsd).toBe(5.5);
	});

	it("keeps prompt, args and env vars collapsed under Advanced", async () => {
		const user = userEvent.setup();
		const onAgentsChange = renderSection();
		await openPreset(user, /Auto · Medium/);

		// <details> keeps its children in the DOM, so "collapsed" is the open flag.
		const advanced = screen.getByText("settings.presetAdvanced").closest("details")!;
		expect(advanced.open).toBe(false);

		await user.click(screen.getByText("settings.presetAdvanced"));
		expect(advanced.open).toBe(true);

		// One character: the parent never feeds edited agents back in this harness,
		// so a controlled input resets between keystrokes.
		await user.type(advanced.querySelector("textarea")!, "x");
		expect(editedPreset(onAgentsChange)?.appendPrompt).toBe("x");
	});

	it("does not autocapitalize the base command override", async () => {
		const user = userEvent.setup();
		renderSection();
		await openPreset(user, /Auto · Medium/);
		await user.click(screen.getByText("settings.presetAdvanced"));

		const override = screen
			.getByText("settings.configBaseCommandOverride")
			.closest("div")!
			.querySelector("input")!;
		expect(override).toHaveAttribute("autocapitalize", "off");
		expect(override).toHaveAttribute("autocorrect", "off");
		expect(override.getAttribute("spellcheck")).toBe("false");
	});
});
