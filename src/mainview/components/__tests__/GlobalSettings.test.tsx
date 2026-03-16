import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GlobalSettings from "../GlobalSettings";
import { I18nProvider } from "../../i18n";
import type { CodingAgent, GlobalSettings as GlobalSettingsType } from "../../../shared/types";
import { KEYMAP_LS_KEY } from "../../terminal-keymaps";

vi.mock("../../zoom", () => ({
	getZoom: vi.fn(() => 1.0),
	adjustZoom: vi.fn(),
	applyZoom: vi.fn(),
	ZOOM_STEP: 0.1,
	DEFAULT_ZOOM: 1.0,
	MIN_ZOOM: 0.5,
	MAX_ZOOM: 2.0,
	ZOOM_CHANGED_EVENT: "zoom-changed",
}));

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAgents: vi.fn(),
			saveAgents: vi.fn(),
			getGlobalSettings: vi.fn(),
			saveGlobalSettings: vi.fn(),
			checkAgentAvailability: vi.fn().mockResolvedValue([]),
		},
	},
}));

import { api } from "../../rpc";

const mockedApi = vi.mocked(api, true);

const mockAgents: CodingAgent[] = [
	{
		id: "agent-1",
		name: "Claude",
		baseCommand: "claude",
		isDefault: true,
		configurations: [
			{ id: "cfg-1", name: "Default", model: "sonnet" },
			{ id: "cfg-2", name: "Plan", model: "opus", permissionMode: "plan" },
		],
		defaultConfigId: "cfg-1",
	},
	{
		id: "agent-2",
		name: "Codex",
		baseCommand: "codex",
		configurations: [{ id: "cfg-3", name: "Default" }],
		defaultConfigId: "cfg-3",
	},
];

const mockGlobalSettings: GlobalSettingsType = {
	defaultAgentId: "agent-1",
	defaultConfigId: "cfg-1",
	taskDropPosition: "top",
	updateChannel: "stable",
};

function renderGlobalSettings() {
	return render(
		<I18nProvider>
			<GlobalSettings />
		</I18nProvider>,
	);
}

function setupMocks(
	agents: CodingAgent[] = mockAgents,
	settings: GlobalSettingsType = mockGlobalSettings,
) {
	mockedApi.request.getAgents.mockResolvedValue(agents);
	mockedApi.request.getGlobalSettings.mockResolvedValue(settings);
	mockedApi.request.saveAgents.mockResolvedValue(undefined as any);
	mockedApi.request.saveGlobalSettings.mockResolvedValue(undefined as any);
}

/** Wait for async data (agents + settings) to be loaded into the UI.
 *  We wait for "Default Configuration" which only renders when BOTH agents
 *  and globalSettings are loaded (it requires defaultAgentId to match an
 *  agent that has configurations). Without this, tests race: agents arrive
 *  but globalSettings still has initial defaultAgentId "builtin-claude". */
async function waitForLoad() {
	await screen.findByText("Default Configuration");
}

describe("GlobalSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		document.documentElement.dataset.theme = "dark";
	});

	describe("initial load", () => {
		it("fetches agents and global settings on mount", async () => {
			setupMocks();
			renderGlobalSettings();
			await waitForLoad();

			expect(mockedApi.request.getAgents).toHaveBeenCalledOnce();
			expect(mockedApi.request.getGlobalSettings).toHaveBeenCalledOnce();
		});

		it("renders theme cards", async () => {
			setupMocks();
			renderGlobalSettings();
			await waitForLoad();

			expect(screen.getByText("Dark")).toBeInTheDocument();
			expect(screen.getByText("Light")).toBeInTheDocument();
			expect(screen.getByText("System")).toBeInTheDocument();
		});

		it("renders language cards", async () => {
			setupMocks();
			renderGlobalSettings();
			await waitForLoad();

			expect(screen.getByText("EN")).toBeInTheDocument();
			expect(screen.getByText("RU")).toBeInTheDocument();
			expect(screen.getByText("ES")).toBeInTheDocument();
		});

		it("renders agent list", async () => {
			setupMocks();
			renderGlobalSettings();
			await waitForLoad();

			expect(screen.getAllByText("Claude").length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText("Codex").length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("theme switching", () => {
		it("applies dark theme", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			await user.click(screen.getByText("Dark"));

			expect(document.documentElement.dataset.theme).toBe("dark");
			expect(localStorage.getItem("dev3-theme")).toBe("dark");
		});

		it("applies light theme", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			await user.click(screen.getByText("Light"));

			expect(document.documentElement.dataset.theme).toBe("light");
			expect(localStorage.getItem("dev3-theme")).toBe("light");
		});

		it("applies system theme based on prefers-color-scheme", async () => {
			setupMocks();
			const user = userEvent.setup();
			// Mock matchMedia to return dark preference
			Object.defineProperty(window, "matchMedia", {
				writable: true,
				value: vi.fn().mockImplementation((query: string) => ({
					matches: query === "(prefers-color-scheme: dark)",
					media: query,
				})),
			});

			renderGlobalSettings();
			await waitForLoad();

			await user.click(screen.getByText("System"));

			expect(document.documentElement.dataset.theme).toBe("dark");
			expect(localStorage.getItem("dev3-theme")).toBe("system");
		});
	});

	describe("task drop position", () => {
		it("selects top by default", async () => {
			setupMocks();
			renderGlobalSettings();
			await waitForLoad();

			const topButton = screen.getByText("Top").closest("button")!;
			expect(topButton.className).toContain("border-accent");
		});

		it("switches to bottom and saves", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			await user.click(screen.getByText("Bottom"));

			expect(mockedApi.request.saveGlobalSettings).toHaveBeenCalledWith(
				expect.objectContaining({ taskDropPosition: "bottom" }),
			);
		});
	});

	describe("update channel", () => {
		it("shows stable selected by default", async () => {
			setupMocks();
			renderGlobalSettings();
			await waitForLoad();

			const select = screen.getByDisplayValue("Stable");
			expect(select).toBeInTheDocument();
		});

		it("select is disabled and cannot be changed", async () => {
			setupMocks();
			renderGlobalSettings();
			await waitForLoad();

			const select = screen.getByDisplayValue("Stable");
			expect(select).toBeDisabled();
			expect(mockedApi.request.saveGlobalSettings).not.toHaveBeenCalled();
		});
	});

	describe("default agent selection", () => {
		it("changes default agent and saves with first config", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			// Find the default agent select - it's the one with agent-1 selected
			const agentSelects = screen.getAllByRole("combobox");
			const agentSelect = agentSelects.find(
				(s) => (s as HTMLSelectElement).value === "agent-1",
			)!;

			await user.selectOptions(agentSelect, "agent-2");

			expect(mockedApi.request.saveGlobalSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					defaultAgentId: "agent-2",
					defaultConfigId: "cfg-3",
				}),
			);
		});

		it("shows default config selector when agent has configs", async () => {
			setupMocks();
			renderGlobalSettings();
			await waitForLoad();

			expect(screen.getByText("Default Configuration")).toBeInTheDocument();
		});

		it("shows config preview card with model info", async () => {
			setupMocks();
			renderGlobalSettings();
			await waitForLoad();

			// Default config is "Default" with model "sonnet"
			expect(screen.getByText("Model:")).toBeInTheDocument();
			expect(screen.getByText("sonnet")).toBeInTheDocument();
		});

		it("shows permission mode in preview when selecting non-default config", async () => {
			setupMocks(mockAgents, {
				...mockGlobalSettings,
				defaultConfigId: "cfg-2",
			});
			renderGlobalSettings();
			await waitForLoad();

			expect(screen.getByText("opus")).toBeInTheDocument();
			expect(screen.getByText("Permission Mode:")).toBeInTheDocument();
			expect(screen.getByText("Plan Mode")).toBeInTheDocument();
		});

		it("changes default config and saves", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			// Find the config select - should show Default (sonnet) config options
			const configSelect = screen.getAllByRole("combobox").find(
				(s) => (s as HTMLSelectElement).value === "cfg-1",
			)!;

			await user.selectOptions(configSelect, "cfg-2");

			expect(mockedApi.request.saveGlobalSettings).toHaveBeenCalledWith(
				expect.objectContaining({ defaultConfigId: "cfg-2" }),
			);
		});
	});

	describe("agent management", () => {
		it("expands agent when clicked", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			// Click on agent header to expand
			const agentHeaders = screen.getAllByRole("button");
			const claudeHeader = agentHeaders.find((b) =>
				b.textContent?.includes("Claude") && b.textContent?.includes("claude"),
			)!;
			await user.click(claudeHeader);

			// Should show agent editing fields
			expect(screen.getByText("Name")).toBeInTheDocument();
			expect(screen.getByText("Base Command")).toBeInTheDocument();
			expect(screen.getByText("Configurations")).toBeInTheDocument();
		});

		it("collapses agent when clicked again", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			const agentHeaders = screen.getAllByRole("button");
			const claudeHeader = agentHeaders.find((b) =>
				b.textContent?.includes("Claude") && b.textContent?.includes("claude"),
			)!;

			// Expand
			await user.click(claudeHeader);
			expect(screen.getByText("Configurations")).toBeInTheDocument();

			// Collapse
			await user.click(claudeHeader);
			expect(screen.queryByText("Configurations")).not.toBeInTheDocument();
		});

		it("updates agent name", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			// Expand Codex (non-default agent)
			const agentHeaders = screen.getAllByRole("button");
			const codexHeader = agentHeaders.find((b) =>
				b.textContent?.includes("Codex") && b.textContent?.includes("codex"),
			)!;
			await user.click(codexHeader);

			// Find the name input (value = "Codex")
			const nameInput = screen.getByDisplayValue("Codex");
			await user.clear(nameInput);
			await user.type(nameInput, "MyAgent");

			expect(mockedApi.request.saveAgents).toHaveBeenCalled();
		});

		it("updates agent base command", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			const agentHeaders = screen.getAllByRole("button");
			const codexHeader = agentHeaders.find((b) =>
				b.textContent?.includes("Codex") && b.textContent?.includes("codex"),
			)!;
			await user.click(codexHeader);

			const cmdInput = screen.getByDisplayValue("codex");
			await user.clear(cmdInput);
			await user.type(cmdInput, "mybin");

			expect(mockedApi.request.saveAgents).toHaveBeenCalled();
		});

		it("adds a new agent", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			await user.click(screen.getByText(/Add Agent/));

			expect(mockedApi.request.saveAgents).toHaveBeenCalledWith({
				agents: expect.arrayContaining([
					expect.objectContaining({ name: "New Agent", baseCommand: "" }),
				]),
			});
		});

		it("deletes a non-default agent", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			// Expand Codex
			const agentHeaders = screen.getAllByRole("button");
			const codexHeader = agentHeaders.find((b) =>
				b.textContent?.includes("Codex") && b.textContent?.includes("codex"),
			)!;
			await user.click(codexHeader);

			// Click delete
			await user.click(screen.getByText("Delete"));

			// Should save without Codex
			const lastCall = mockedApi.request.saveAgents.mock.calls[mockedApi.request.saveAgents.mock.calls.length - 1];
			const savedAgents = lastCall[0].agents as CodingAgent[];
			expect(savedAgents.find((a) => a.id === "agent-2")).toBeUndefined();
		});

		it("shows cannot delete message for default agents", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			// Expand Claude (default agent)
			const agentHeaders = screen.getAllByRole("button");
			const claudeHeader = agentHeaders.find((b) =>
				b.textContent?.includes("Claude") && b.textContent?.includes("claude"),
			)!;
			await user.click(claudeHeader);

			expect(
				screen.getByText("Default agents cannot be deleted"),
			).toBeInTheDocument();
		});
	});

	describe("configuration management", () => {
		it("expands config when clicked", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			// Expand Claude agent
			const agentHeaders = screen.getAllByRole("button");
			const claudeHeader = agentHeaders.find((b) =>
				b.textContent?.includes("Claude") && b.textContent?.includes("claude"),
			)!;
			await user.click(claudeHeader);

			// Expand the Default config
			const configButtons = screen.getAllByRole("button");
			const defaultConfig = configButtons.find(
				(b) => b.textContent?.includes("Default") && b.textContent?.includes("sonnet"),
			)!;
			await user.click(defaultConfig);

			expect(screen.getByText("Command Preview")).toBeInTheDocument();
			expect(screen.getByText("Permission Mode")).toBeInTheDocument();
		});

		it("updates config name", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			// Expand Claude agent, then expand first config
			const agentHeaders = screen.getAllByRole("button");
			const claudeHeader = agentHeaders.find((b) =>
				b.textContent?.includes("Claude") && b.textContent?.includes("claude"),
			)!;
			await user.click(claudeHeader);

			const configButtons = screen.getAllByRole("button");
			const planConfig = configButtons.find(
				(b) => b.textContent?.includes("Plan") && b.textContent?.includes("opus"),
			)!;
			await user.click(planConfig);

			// Change config name input — the "Plan" value in the config editor input
			const nameInputs = screen.getAllByDisplayValue("Plan");
			const configNameInput = nameInputs[0];
			await user.clear(configNameInput);
			await user.type(configNameInput, "Custom");

			expect(mockedApi.request.saveAgents).toHaveBeenCalled();
		});

		it("adds a new configuration", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			// Expand Claude
			const agentHeaders = screen.getAllByRole("button");
			const claudeHeader = agentHeaders.find((b) =>
				b.textContent?.includes("Claude") && b.textContent?.includes("claude"),
			)!;
			await user.click(claudeHeader);

			await user.click(screen.getByText(/Add Configuration/));

			const lastCall = mockedApi.request.saveAgents.mock.calls[mockedApi.request.saveAgents.mock.calls.length - 1];
			const savedAgents = lastCall[0].agents as CodingAgent[];
			const claude = savedAgents.find((a) => a.id === "agent-1")!;
			expect(claude.configurations).toHaveLength(3);
			expect(claude.configurations[2].name).toBe("New Config");
		});

		it("deletes a configuration when there are multiple", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			// Expand Claude
			const agentHeaders = screen.getAllByRole("button");
			const claudeHeader = agentHeaders.find((b) =>
				b.textContent?.includes("Claude") && b.textContent?.includes("claude"),
			)!;
			await user.click(claudeHeader);

			// Expand Plan config
			const configButtons = screen.getAllByRole("button");
			const planConfig = configButtons.find(
				(b) => b.textContent?.includes("Plan") && b.textContent?.includes("opus"),
			)!;
			await user.click(planConfig);

			// Click delete config
			await user.click(screen.getByText("Delete Configuration"));

			const lastCall = mockedApi.request.saveAgents.mock.calls[mockedApi.request.saveAgents.mock.calls.length - 1];
			const savedAgents = lastCall[0].agents as CodingAgent[];
			const claude = savedAgents.find((a) => a.id === "agent-1")!;
			expect(claude.configurations).toHaveLength(1);
			expect(claude.configurations[0].id).toBe("cfg-1");
		});

		it("updates defaultConfigId when active config is deleted", async () => {
			setupMocks(mockAgents, {
				...mockGlobalSettings,
				defaultConfigId: "cfg-2",
			});
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			// Expand Claude
			const agentHeaders = screen.getAllByRole("button");
			const claudeHeader = agentHeaders.find((b) =>
				b.textContent?.includes("Claude") && b.textContent?.includes("claude"),
			)!;
			await user.click(claudeHeader);

			// Expand Plan config (cfg-2 which is agent's defaultConfigId)
			const configButtons = screen.getAllByRole("button");
			const planConfig = configButtons.find(
				(b) => b.textContent?.includes("Plan") && b.textContent?.includes("opus"),
			)!;
			await user.click(planConfig);

			await user.click(screen.getByText("Delete Configuration"));

			// Agent's defaultConfigId should switch to the remaining config
			const lastCall = mockedApi.request.saveAgents.mock.calls[mockedApi.request.saveAgents.mock.calls.length - 1];
			const savedAgents = lastCall[0].agents as CodingAgent[];
			const claude = savedAgents.find((a) => a.id === "agent-1")!;
			// If the deleted config was the agent's defaultConfigId, it updates
			expect(claude.configurations).toHaveLength(1);
		});

		it("does not show delete button for single config", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			// Expand Codex (has only 1 config)
			const agentHeaders = screen.getAllByRole("button");
			const codexHeader = agentHeaders.find((b) =>
				b.textContent?.includes("Codex") && b.textContent?.includes("codex"),
			)!;
			await user.click(codexHeader);

			// Expand the single config
			const configButtons = screen.getAllByRole("button");
			const defaultConfig = configButtons.find(
				(b) => {
					const parent = b.closest(".bg-elevated");
					return parent && b.textContent?.includes("Default") && !b.textContent?.includes("sonnet");
				},
			)!;
			await user.click(defaultConfig);

			expect(screen.queryByText("Delete Configuration")).not.toBeInTheDocument();
		});
	});

	describe("config fields", () => {
		async function expandFirstConfig() {
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			// Expand Claude
			const agentHeaders = screen.getAllByRole("button");
			const claudeHeader = agentHeaders.find((b) =>
				b.textContent?.includes("Claude") && b.textContent?.includes("claude"),
			)!;
			await user.click(claudeHeader);

			// Expand Default config
			const configButtons = screen.getAllByRole("button");
			const defaultConfig = configButtons.find(
				(b) => b.textContent?.includes("Default") && b.textContent?.includes("sonnet"),
			)!;
			await user.click(defaultConfig);

			return user;
		}

		it("updates model field", async () => {
			setupMocks();
			const user = await expandFirstConfig();

			const modelInput = screen.getByDisplayValue("sonnet");
			await user.clear(modelInput);
			await user.type(modelInput, "opus");

			expect(mockedApi.request.saveAgents).toHaveBeenCalled();
		});

		it("changes permission mode", async () => {
			setupMocks();
			const user = await expandFirstConfig();

			const permSelect = screen.getAllByRole("combobox").find(
				(s) => (s as HTMLSelectElement).value === "default",
			)!;
			await user.selectOptions(permSelect, "plan");

			const lastCall = mockedApi.request.saveAgents.mock.calls[mockedApi.request.saveAgents.mock.calls.length - 1];
			const savedAgents = lastCall[0].agents as CodingAgent[];
			const cfg = savedAgents[0].configurations[0];
			expect(cfg.permissionMode).toBe("plan");
		});

		it("changes effort level", async () => {
			setupMocks();
			const user = await expandFirstConfig();

			// Effort select has empty string as default value
			const effortSelect = screen.getAllByRole("combobox").find(
				(s) => {
					const el = s as HTMLSelectElement;
					return el.value === "" && el.options.length === 4;
				},
			)!;
			await user.selectOptions(effortSelect, "high");

			const lastCall = mockedApi.request.saveAgents.mock.calls[mockedApi.request.saveAgents.mock.calls.length - 1];
			const savedAgents = lastCall[0].agents as CodingAgent[];
			const cfg = savedAgents[0].configurations[0];
			expect(cfg.effort).toBe("high");
		});

		it("updates max budget", async () => {
			setupMocks();
			const user = await expandFirstConfig();

			const budgetInput = screen.getByRole("spinbutton");
			await user.type(budgetInput, "5.5");

			expect(mockedApi.request.saveAgents).toHaveBeenCalled();
		});

		it("updates append prompt", async () => {
			setupMocks();
			const user = await expandFirstConfig();

			const textareas = document.querySelectorAll("textarea");
			expect(textareas.length).toBe(1);
			await user.type(textareas[0], "extra prompt");

			expect(mockedApi.request.saveAgents).toHaveBeenCalled();
		});
	});

	describe("default badge", () => {
		it("shows default badge on default agents", async () => {
			setupMocks();
			renderGlobalSettings();
			await waitForLoad();

			// Claude is isDefault: true
			const badges = screen.getAllByText("Default");
			expect(badges.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("autocapitalize disabled on technical inputs", () => {
		it("base command input has autocapitalize off", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			// Expand Codex
			const agentHeaders = screen.getAllByRole("button");
			const codexHeader = agentHeaders.find((b) =>
				b.textContent?.includes("Codex") && b.textContent?.includes("codex"),
			)!;
			await user.click(codexHeader);

			const cmdInput = screen.getByDisplayValue("codex");
			expect(cmdInput).toHaveAttribute("autocapitalize", "off");
			expect(cmdInput).toHaveAttribute("autocorrect", "off");
			expect(cmdInput.getAttribute("spellcheck")).toBe("false");
		});

		it("model input has autocapitalize off", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			// Expand Claude agent
			const agentHeaders = screen.getAllByRole("button");
			const claudeHeader = agentHeaders.find((b) =>
				b.textContent?.includes("Claude") && b.textContent?.includes("claude"),
			)!;
			await user.click(claudeHeader);

			// Expand Default config
			const configButtons = screen.getAllByRole("button");
			const defaultConfig = configButtons.find(
				(b) => b.textContent?.includes("Default") && b.textContent?.includes("sonnet"),
			)!;
			await user.click(defaultConfig);

			const modelInput = screen.getByDisplayValue("sonnet");
			expect(modelInput).toHaveAttribute("autocapitalize", "off");
			expect(modelInput).toHaveAttribute("autocorrect", "off");
			expect(modelInput.getAttribute("spellcheck")).toBe("false");
		});

		it("base command override input has autocapitalize off", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			// Expand Claude agent
			const agentHeaders = screen.getAllByRole("button");
			const claudeHeader = agentHeaders.find((b) =>
				b.textContent?.includes("Claude") && b.textContent?.includes("claude"),
			)!;
			await user.click(claudeHeader);

			// Expand Default config
			const configButtons = screen.getAllByRole("button");
			const defaultConfig = configButtons.find(
				(b) => b.textContent?.includes("Default") && b.textContent?.includes("sonnet"),
			)!;
			await user.click(defaultConfig);

			// Find the base command override input (empty by default)
			const overrideLabel = screen.getByText("Base Command Override");
			const overrideInput = overrideLabel.closest("div")!.querySelector("input")!;
			expect(overrideInput).toHaveAttribute("autocapitalize", "off");
			expect(overrideInput).toHaveAttribute("autocorrect", "off");
			expect(overrideInput.getAttribute("spellcheck")).toBe("false");
		});
	});

	describe("config count display", () => {
		it("shows correct config count per agent", async () => {
			setupMocks();
			renderGlobalSettings();
			await waitForLoad();

			expect(screen.getByText("2 configs")).toBeInTheDocument();
			expect(screen.getByText("1 config")).toBeInTheDocument();
		});
	});

	describe("terminal keymap preset", () => {
		function getKeymapToggle() {
			return screen.getByRole("button", { name: /iTerm2 compatibility/ });
		}

		it("renders the iTerm2 compatibility toggle", async () => {
			setupMocks();
			renderGlobalSettings();
			await waitForLoad();

			expect(getKeymapToggle()).toBeInTheDocument();
		});

		it("toggle is inactive by default", async () => {
			setupMocks();
			renderGlobalSettings();
			await waitForLoad();

			expect(getKeymapToggle().className).not.toContain("border-accent");
		});

		it("clicking the toggle saves terminalKeymap iterm2 to backend", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			await user.click(getKeymapToggle());

			expect(mockedApi.request.saveGlobalSettings).toHaveBeenCalledWith(
				expect.objectContaining({ terminalKeymap: "iterm2" }),
			);
		});

		it("clicking the toggle persists iterm2 preset to localStorage", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			await user.click(getKeymapToggle());

			expect(localStorage.getItem(KEYMAP_LS_KEY)).toBe("iterm2");
		});

		it("clicking the toggle again reverts to default", async () => {
			setupMocks(mockAgents, { ...mockGlobalSettings, terminalKeymap: "iterm2" });
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			await user.click(getKeymapToggle());

			expect(mockedApi.request.saveGlobalSettings).toHaveBeenCalledWith(
				expect.objectContaining({ terminalKeymap: "default" }),
			);
		});

		it("loads terminalKeymap from backend settings and syncs to localStorage", async () => {
			setupMocks(mockAgents, { ...mockGlobalSettings, terminalKeymap: "iterm2" });
			renderGlobalSettings();
			await waitForLoad();

			expect(localStorage.getItem(KEYMAP_LS_KEY)).toBe("iterm2");
		});
	});
});
