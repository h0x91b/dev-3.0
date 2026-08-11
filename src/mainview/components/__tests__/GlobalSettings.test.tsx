import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GlobalSettings from "../GlobalSettings";
import { I18nProvider } from "../../i18n";
import type { CodingAgent, GlobalSettings as GlobalSettingsType } from "../../../shared/types";
import type { SettingsSectionId } from "../../state";

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

vi.mock("../../confirm", () => ({ confirm: vi.fn(() => Promise.resolve(true)) }));

vi.mock("../../rpc", () => ({
	isElectrobun: false,
	api: {
		request: {
			getAgents: vi.fn(),
			saveAgents: vi.fn(),
			getGlobalSettings: vi.fn(),
			saveGlobalSettings: vi.fn(),
			checkAgentAvailability: vi.fn().mockResolvedValue([]),
			setTmuxTheme: vi.fn().mockResolvedValue(undefined),
			checkCaffeinateAvailable: vi.fn().mockResolvedValue({ available: true }),
			checkCanaryChannelAvailable: vi.fn().mockResolvedValue({ available: true }),
			getNativeTerminalAvailability: vi
				.fn()
				.mockResolvedValue({ available: true, tmuxSupported: true, diagnostics: [] }),
			getNewTaskTerminalBackend: vi.fn().mockResolvedValue({ backend: null }),
			setNewTaskTerminalBackend: vi.fn().mockResolvedValue({ backend: "native" }),
			listAgentAccounts: vi.fn().mockResolvedValue({
				claude: { accounts: [], activeId: null, systemIdentity: null },
				codex: { accounts: [], activeId: null, currentIdentity: null },
			}),
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
	taskSortOrder: "oldest-first",
	updateChannel: "stable",
};

function renderGlobalSettings(section?: SettingsSectionId) {
	return render(
		<I18nProvider>
			<GlobalSettings section={section} />
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

function setViewport(width: number) {
	Object.defineProperty(window, "innerWidth", {
		configurable: true,
		value: width,
	});
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		writable: true,
		value: vi.fn((query: string) => {
			const maxWidth = query.match(/max-width:\s*(\d+)px/)?.[1];
			return {
				matches: maxWidth ? width <= Number(maxWidth) : false,
				media: query,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			};
		}),
	});
}

async function waitForLoad() {
	await waitFor(() => {
		expect(mockedApi.request.getGlobalSettings).toHaveBeenCalled();
	});
}

/** Wait for the agents category to finish rendering its library. */
async function waitForAgentLibrary() {
	await screen.findByText("Model:");
	await waitFor(() => {
		expect(document.getElementById("agent-library-agent")).not.toBeNull();
	});
}

/** Point the library's one detail pane at `name`'s own agent settings. */
async function openAgent(user: ReturnType<typeof userEvent.setup>, name: string) {
	await user.click(document.getElementById("agent-library-agent")!);
	await user.click(screen.getByRole("option", { name: new RegExp(`^${name}`) }));
}

/** Open a preset row in the library's editor (the agent must already be active). */
async function openPreset(user: ReturnType<typeof userEvent.setup>, label: RegExp) {
	await user.click(screen.getAllByRole("option", { name: label })[0]);
}

/** Open a custom Select trigger (by element id) and click the option labeled `label`. */
async function pickFromSelect(user: ReturnType<typeof userEvent.setup>, triggerId: string, label: string) {
	const trigger = document.getElementById(triggerId) as HTMLButtonElement;
	await user.click(trigger);
	const overlays = document.querySelectorAll(".bg-overlay.border");
	const dropdown = overlays[overlays.length - 1];
	const option = Array.from(dropdown?.querySelectorAll("button") ?? []).find((b) => b.textContent?.trim() === label);
	if (!option) throw new Error(`Option "${label}" not found in dropdown`);
	await user.click(option);
}

describe("GlobalSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		setViewport(1024);
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

		it("renders the category navigation and theme cards", async () => {
			setupMocks();
			renderGlobalSettings();
			await waitForLoad();

			expect(screen.getByRole("button", { name: "Appearance" })).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Tasks & Board" })).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "System" })).toBeInTheDocument();
		expect(document.getElementById("settings-category-title")!).toHaveTextContent("Appearance");
			expect(screen.getByText("Dark")).toBeInTheDocument();
			expect(screen.getByText("Light")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^System$/ })).toBeInTheDocument();
		});

		it("renders language cards", async () => {
			setupMocks();
			renderGlobalSettings();
			await waitForLoad();

			expect(screen.getByText("EN")).toBeInTheDocument();
			expect(screen.getByText("RU")).toBeInTheDocument();
			expect(screen.getByText("ES")).toBeInTheDocument();
		});

		it("keeps incomplete external app rows visible while saving valid rows only", async () => {
			const user = userEvent.setup();
			setupMocks();

			renderGlobalSettings("workspace");
			await waitForLoad();

			await user.click(screen.getByRole("button", { name: /Add App/ }));
			const displayNameInput = screen.getByPlaceholderText("Display name");
			await user.type(displayNameInput, "PyCharm");

			expect(displayNameInput).toHaveValue("PyCharm");

			await waitFor(() => {
				expect(mockedApi.request.saveGlobalSettings).toHaveBeenCalled();
			});
			expect(screen.getByDisplayValue("PyCharm")).toBeInTheDocument();

			const saveCalls = mockedApi.request.saveGlobalSettings.mock.calls;
			const savedSettings = saveCalls[saveCalls.length - 1]?.[0];
			expect(savedSettings?.externalApps).toBeUndefined();
		});

		// The library shows one agent at a time: its picker plus that agent's presets.
		it("renders the agent library for the first agent", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("agents");
			await waitForLoad();
			await waitForAgentLibrary();

			expect(document.getElementById("agent-library-agent")).toHaveTextContent("Claude");
			expect(screen.getAllByRole("option", { name: /Plan/ }).length).toBeGreaterThanOrEqual(1);

			await openAgent(user, "Codex");
			expect(document.getElementById("agent-library-agent")).toHaveTextContent("Codex");
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
			expect(mockedApi.request.setTmuxTheme).toHaveBeenCalledWith({ theme: "dark", preference: "dark" });
		});

		it("applies light theme", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			await user.click(screen.getByText("Light"));

			expect(document.documentElement.dataset.theme).toBe("light");
			expect(localStorage.getItem("dev3-theme")).toBe("light");
			expect(mockedApi.request.setTmuxTheme).toHaveBeenCalledWith({ theme: "light", preference: "light" });
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

			const systemTheme = screen
				.getAllByText("System")
				.find((element) => element.closest("button")?.className.includes("p-4"));
			await user.click(systemTheme!);

			expect(document.documentElement.dataset.theme).toBe("dark");
			expect(localStorage.getItem("dev3-theme")).toBe("system");
			expect(mockedApi.request.setTmuxTheme).toHaveBeenCalledWith({ theme: "dark", preference: "system" });
		});
	});

	describe("task sort order", () => {
		it("selects oldest-first by default", async () => {
			setupMocks();
			renderGlobalSettings("tasks");
			await waitForLoad();

			const oldestButton = screen.getByText("Oldest first").closest("button")!;
			expect(oldestButton.className).toContain("border-accent");
		});

		it("switches to newest-first and saves", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("tasks");
			await waitForLoad();

			await user.click(screen.getByText("Newest first"));

			expect(mockedApi.request.saveGlobalSettings).toHaveBeenCalledWith(
				expect.objectContaining({ taskSortOrder: "newest-first" }),
			);
		});
	});

	describe("new-task terminal backend", () => {
		const nativeCard = () => screen.getByRole("radio", { name: /^Native terminal \(experimental\)/ });

		it("shows tmux selected and saves an explicit native opt-in", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("terminal");
			await waitForLoad();

			expect(screen.getByRole("radio", { name: /^tmux \(current default\)/ })).toHaveAttribute(
				"aria-checked",
				"true",
			);
			await waitFor(() => expect(nativeCard()).toBeEnabled());
			await user.click(nativeCard());

			// The preference lives in its own sidecar file, never in settings.json.
			expect(mockedApi.request.setNewTaskTerminalBackend).toHaveBeenCalledWith({ backend: "native" });
			expect(mockedApi.request.saveGlobalSettings).not.toHaveBeenCalled();
		});

		it("keeps native disabled and unsaved when this build has no native host", async () => {
			setupMocks();
			mockedApi.request.getNativeTerminalAvailability.mockResolvedValue({
				available: false,
				tmuxSupported: true,
				diagnostics: ["Packaged host image unusable: no manifest"],
			});
			const user = userEvent.setup();
			renderGlobalSettings("terminal");
			await waitForLoad();

			await waitFor(() => expect(nativeCard()).toBeDisabled());
			await user.click(nativeCard());
			expect(mockedApi.request.setNewTaskTerminalBackend).not.toHaveBeenCalled();
		});
	});

		describe("watch default", () => {
		function getWatchDefaultSwitch() {
			return screen.getByRole("switch", { name: "Watch tasks by default" });
		}

		it("is off when no preference is stored", async () => {
			setupMocks();
			renderGlobalSettings("tasks");
			await waitForLoad();

			expect(getWatchDefaultSwitch()).toHaveAttribute("aria-checked", "false");
		});

		it("saves the global preference without changing a task", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("tasks");
			await waitForLoad();

			await user.click(getWatchDefaultSwitch());

			expect(mockedApi.request.saveGlobalSettings).toHaveBeenCalledWith(
				expect.objectContaining({ watchByDefault: true }),
			);
			expect(getWatchDefaultSwitch()).toHaveAttribute("aria-checked", "true");
		});
	});

	describe("merge completion suggestions", () => {
		function getMergeSuggestionSwitch() {
			return screen.getByRole("switch", { name: "Suggest completing tasks after merge" });
		}

		it("is on by default", async () => {
			setupMocks();
			renderGlobalSettings("tasks");
			await waitForLoad();

			expect(getMergeSuggestionSwitch()).toHaveAttribute("aria-checked", "true");
		});

		it("saves the global opt-out", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("tasks");
			await waitForLoad();

			await user.click(getMergeSuggestionSwitch());

			expect(mockedApi.request.saveGlobalSettings).toHaveBeenCalledWith(
				expect.objectContaining({ suggestCompletingTasksAfterMerge: false }),
			);
			expect(getMergeSuggestionSwitch()).toHaveAttribute("aria-checked", "false");
		});
	});

	describe("default diff view mode", () => {
		it("selects auto by default", async () => {
			setupMocks();
			renderGlobalSettings("tasks");
			await waitForLoad();

			const autoButton = screen.getByText("Auto").closest("button")!;
			expect(autoButton.className).toContain("border-accent");
		});

		it("switches to unified and saves", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("tasks");
			await waitForLoad();

			await user.click(screen.getByText("Unified"));

			expect(mockedApi.request.saveGlobalSettings).toHaveBeenCalledWith(
				expect.objectContaining({ defaultDiffViewMode: "unified" }),
			);
		});

		it("switches to side by side and saves", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("tasks");
			await waitForLoad();

			await user.click(screen.getByText("Side by side"));

			expect(mockedApi.request.saveGlobalSettings).toHaveBeenCalledWith(
				expect.objectContaining({ defaultDiffViewMode: "split" }),
			);
		});
	});

	describe("update channel", () => {
		it("shows stable selected by default", async () => {
			setupMocks();
			renderGlobalSettings("system");
			await waitForLoad();

			const select = screen.getByDisplayValue("Stable");
			expect(select).toBeInTheDocument();
		});

		// The control is ENABLED again: run 31257371545 published canary-macos-arm64,
		// canary-macos-x64, canary-linux-x64 and canary-linux-arm64 (all HTTP 200, buildOrder
		// 1618, sha 7a9d230fb). It shipped `disabled` while that was not true, because a
		// channel with no manifest answers 403 and reads to the user as a bare error.
		it("is enabled where the canary feed publishes a build", async () => {
			setupMocks();
			renderGlobalSettings("system");
			await waitForLoad();

			expect(
				screen.getByDisplayValue("Stable"),
				"the update-channel select must be enabled when the host answers that canary publishes for it. It was disabled while nothing was published; re-disabling it globally would silently remove the feature on every platform to protect one.",
			).not.toBeDisabled();
		});

		// The per-platform half. Windows has no canary build leg, so `canary-win-x64` answers
		// 403 — enabling the control there would hand a Windows user the exact bare
		// `HTTP 403 fetching update.json` that v1.42.1 shipped.
		it("is disabled, with a reason, where the channel publishes nothing", async () => {
			setupMocks();
			mockedApi.request.checkCanaryChannelAvailable.mockResolvedValue({ available: false });
			renderGlobalSettings("system");
			await waitForLoad();

			expect(
				await screen.findByText(/not published for this platform yet/i),
				"a disabled channel picker must SAY why. A dimmed control with no explanation reads as broken rather than as 'not yet published here'.",
			).toBeInTheDocument();
			expect(screen.getByDisplayValue("Stable")).toBeDisabled();
		});

	});

	describe("default agent selection", () => {
		it("changes default agent and saves with first config", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("agents");
			await waitForLoad();
			await screen.findByText("Model:");

			// Provider picker starts on Claude (agent-1); switch to Codex (agent-2).
			await pickFromSelect(user, "default-agent-provider", "Codex");

			expect(mockedApi.request.saveGlobalSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					defaultAgentId: "agent-2",
					defaultConfigId: "cfg-3",
				}),
			);
		});

		it("shows the Provider/Model/Mode default picker when agent has configs", async () => {
			setupMocks();
			renderGlobalSettings("agents");
			await waitForLoad();
			await screen.findByText("Model:");

			expect(document.getElementById("default-agent-provider")).toBeInTheDocument();
			expect(document.getElementById("default-agent-model")).toBeInTheDocument();
			expect(document.getElementById("default-agent-mode")).toBeInTheDocument();
		});

		it("shows config preview card with model info", async () => {
			setupMocks();
			renderGlobalSettings("agents");
			await waitForLoad();
			await screen.findByText("Model:");

			// Default config is "Default" with model "sonnet"
			expect(screen.getByText("Model:")).toBeInTheDocument();
			expect(screen.getByText("sonnet")).toBeInTheDocument();
		});

		it("shows permission mode in preview when selecting non-default config", async () => {
			setupMocks(mockAgents, {
				...mockGlobalSettings,
				defaultConfigId: "cfg-2",
			});
			renderGlobalSettings("agents");
			await waitForLoad();
			await screen.findByText("Model:");

			expect(screen.getByText("opus")).toBeInTheDocument();
			expect(screen.getByText("Permission Mode:")).toBeInTheDocument();
			expect(screen.getByText("Plan Mode")).toBeInTheDocument();
		});

		it("changes default config and saves", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("agents");
			await waitForLoad();
			await screen.findByText("Model:");

			// cfg-1 (model "sonnet") and cfg-2 (model "opus") are in different Model
			// groups; switching Model from Sonnet → Opus selects cfg-2 (the only
			// preset in the Opus group).
			await pickFromSelect(user, "default-agent-model", "Opus");

			expect(mockedApi.request.saveGlobalSettings).toHaveBeenCalledWith(
				expect.objectContaining({ defaultConfigId: "cfg-2" }),
			);
		});
	});

	// Settings → Agents is a library: one agent picker, a filterable preset list,
	// and exactly one detail pane. These drive it at screen level (agent CRUD and
	// save serialization); per-field editing lives in AgentSettingsSection.test.tsx.
	describe("agent management", () => {
		it("opens an agent's own settings from the library picker", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("agents");
			await waitForLoad();
			await waitForAgentLibrary();

			await openAgent(user, "Codex");

			expect(screen.getByDisplayValue("Codex")).toBeInTheDocument();
			expect(screen.getByDisplayValue("codex")).toBeInTheDocument();
			expect(screen.getByText("Lifecycle Hooks")).toBeInTheDocument();
		});

		it("updates agent name", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("agents");
			await waitForLoad();
			await waitForAgentLibrary();
			await openAgent(user, "Codex");

			const nameInput = screen.getByDisplayValue("Codex");
			await user.clear(nameInput);
			await user.type(nameInput, "MyAgent");

			expect(mockedApi.request.saveAgents).toHaveBeenCalled();
		});

		it("updates agent base command", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("agents");
			await waitForLoad();
			await waitForAgentLibrary();
			await openAgent(user, "Codex");

			const cmdInput = screen.getByDisplayValue("codex");
			await user.clear(cmdInput);
			await user.type(cmdInput, "mybin");

			expect(mockedApi.request.saveAgents).toHaveBeenCalled();
		});

		it("adds a new agent", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("agents");
			await waitForLoad();
			await waitForAgentLibrary();

			await user.click(screen.getByText(/Add Agent/));

			expect(mockedApi.request.saveAgents).toHaveBeenCalledWith({
				agents: expect.arrayContaining([
					expect.objectContaining({ name: "New Agent", baseCommand: "" }),
				]),
			});
		});

		it("deletes a non-default agent once the deletion is confirmed", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("agents");
			await waitForLoad();
			await waitForAgentLibrary();
			await openAgent(user, "Codex");

			await user.click(screen.getByText("Delete"));

			await waitFor(() => {
				const calls = mockedApi.request.saveAgents.mock.calls;
				const savedAgents = calls[calls.length - 1][0].agents as CodingAgent[];
				expect(savedAgents.find((a) => a.id === "agent-2")).toBeUndefined();
			});
		});

		it("shows cannot delete message for default agents", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("agents");
			await waitForLoad();
			await waitForAgentLibrary();
			await openAgent(user, "Claude");

			expect(screen.getByText("Default agents cannot be deleted")).toBeInTheDocument();
		});
	});

	describe("preset management", () => {
		it("opens a preset in the editor", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("agents");
			await waitForLoad();
			await waitForAgentLibrary();

			await openPreset(user, /Plan/);

			expect(screen.getByText("Command Preview")).toBeInTheDocument();
			expect(screen.getByText("Permission Mode")).toBeInTheDocument();
		});

		it("updates preset name", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("agents");
			await waitForLoad();
			await waitForAgentLibrary();
			await openPreset(user, /Plan/);

			const nameInput = screen.getAllByDisplayValue("Plan")[0];
			await user.clear(nameInput);
			await user.type(nameInput, "Custom");

			expect(mockedApi.request.saveAgents).toHaveBeenCalled();
		});

		it("adds a new preset", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("agents");
			await waitForLoad();
			await waitForAgentLibrary();

			await user.click(screen.getByRole("button", { name: /New preset/ }));

			const calls = mockedApi.request.saveAgents.mock.calls;
			const savedAgents = calls[calls.length - 1][0].agents as CodingAgent[];
			const claude = savedAgents.find((a) => a.id === "agent-1")!;
			expect(claude.configurations).toHaveLength(3);
			expect(claude.configurations[2].name).toBe("New preset");
		});

		it("deletes a preset when there are multiple", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("agents");
			await waitForLoad();
			await waitForAgentLibrary();
			await openPreset(user, /Plan/);

			await user.click(screen.getByText("Delete Configuration"));

			await waitFor(() => {
				const calls = mockedApi.request.saveAgents.mock.calls;
				const savedAgents = calls[calls.length - 1][0].agents as CodingAgent[];
				const claude = savedAgents.find((a) => a.id === "agent-1")!;
				expect(claude.configurations).toHaveLength(1);
				expect(claude.configurations[0].id).toBe("cfg-1");
			});
		});

		it("updates defaultConfigId when active config is deleted", async () => {
			setupMocks(mockAgents, { ...mockGlobalSettings, defaultConfigId: "cfg-2" });
			const user = userEvent.setup();
			renderGlobalSettings("agents");
			await waitForLoad();
			await waitForAgentLibrary();
			await openPreset(user, /Plan/);

			await user.click(screen.getByText("Delete Configuration"));

			await waitFor(() => {
				const calls = mockedApi.request.saveAgents.mock.calls;
				const savedAgents = calls[calls.length - 1][0].agents as CodingAgent[];
				const claude = savedAgents.find((a) => a.id === "agent-1")!;
				expect(claude.configurations).toHaveLength(1);
			});
		});

		it("does not offer to delete an agent's only preset", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("agents");
			await waitForLoad();
			await waitForAgentLibrary();
			await openAgent(user, "Codex");
			await openPreset(user, /Default/);

			expect(screen.queryByText("Delete Configuration")).not.toBeInTheDocument();
		});
	});

	describe("config fields", () => {
		it("serializes config saves so the latest base command override wins", async () => {
			setupMocks();
			const pending: Array<{
				resolve: () => void;
				payload: { agents: CodingAgent[] };
			}> = [];
			let persistedAgents: CodingAgent[] | null = null;

			mockedApi.request.saveAgents.mockImplementation(
				(payload: { agents: CodingAgent[] }) =>
					new Promise<void>((resolve) => {
						pending.push({
							payload,
							resolve: () => {
								persistedAgents = payload.agents;
								resolve();
							},
						});
					}) as any,
			);

			const user = userEvent.setup();
			renderGlobalSettings("agents");
			await waitForLoad();
			await waitForAgentLibrary();
			await openPreset(user, /Plan/);
			await user.click(screen.getByText(/^Advanced/));

			const overrideLabel = screen.getByText("Base Command Override");
			const overrideInput = overrideLabel.closest("div")!.querySelector("input")!;

			await user.type(overrideInput, "xy");

			expect(mockedApi.request.saveAgents).toHaveBeenCalledTimes(1);
			expect(pending).toHaveLength(1);

			pending[0].resolve();

			await waitFor(() => {
				expect(mockedApi.request.saveAgents).toHaveBeenCalledTimes(2);
			});
			expect(pending).toHaveLength(2);

			pending[1].resolve();

			await waitFor(() => {
				const claude = persistedAgents?.find((agent) => agent.id === "agent-1");
				expect(claude?.configurations[1]?.baseCommandOverride).toBe("xy");
			});
		});
	});

	describe("default badge", () => {
		it("shows default badge on default agents", async () => {
			setupMocks();
			renderGlobalSettings("agents");
			await waitForLoad();
			await waitForAgentLibrary();

			const badges = screen.getAllByText("Default");
			expect(badges.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("autocapitalize disabled on technical inputs", () => {
		it("base command input has autocapitalize off", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("agents");
			await waitForLoad();
			await waitForAgentLibrary();
			await openAgent(user, "Codex");

			const cmdInput = screen.getByDisplayValue("codex");
			expect(cmdInput).toHaveAttribute("autocapitalize", "off");
			expect(cmdInput).toHaveAttribute("autocorrect", "off");
			expect(cmdInput.getAttribute("spellcheck")).toBe("false");
		});
	});

	describe("preset count display", () => {
		it("shows the preset count for the active agent", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings("agents");
			await waitForLoad();
			await waitForAgentLibrary();

			expect(screen.getByText("2 presets")).toBeInTheDocument();

			await openAgent(user, "Codex");
			expect(screen.getByText("1 preset")).toBeInTheDocument();
		});
	});

	describe("category navigation and search", () => {
		it("shows one category page at a time", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			await user.click(screen.getByRole("button", { name: "Tasks & Board" }));

			expect(document.getElementById("settings-category-title")!).toHaveTextContent("Tasks & Board");
			expect(screen.getByText("Task sort order")).toBeInTheDocument();
			expect(screen.queryByText("Choose the color theme for dev-3.0.")).not.toBeInTheDocument();
		});

		it("filters localized titles and descriptions across categories and opens the entry", async () => {
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			const search = screen.getByRole("searchbox", { name: "Search settings" });
			await user.type(search, "scroll speed");

			expect(screen.getByText("Search results")).toBeInTheDocument();
			expect(screen.getByText("Category: Terminal")).toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: /Terminal scroll speed/ }));

			expect(document.getElementById("settings-category-title")).toHaveTextContent("Terminal");
			expect(screen.getByRole("slider", { name: "Terminal scroll speed" })).toHaveValue("2");
		});

		it("matches Russian setting copy", async () => {
			localStorage.setItem("dev3-locale", "ru");
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			await user.type(screen.getByRole("searchbox", { name: "Поиск настроек" }), "скорость");

			expect(screen.getByText("Скорость прокрутки терминала")).toBeInTheDocument();
			expect(screen.getByText("Категория: Терминал")).toBeInTheDocument();
		});

		it("maps legacy proxy deep-links to System", async () => {
			setupMocks();
			renderGlobalSettings("proxy");
			await waitForLoad();

			expect(document.getElementById("settings-category-title")).toHaveTextContent("System");
			expect(screen.getByText("Token-saving proxy (experimental)")).toBeInTheDocument();
		});
	});

	describe("system settings", () => {
		it("round-trips the confirm-before-quit toggle through skipQuitDialog", async () => {
			setupMocks(mockAgents, { ...mockGlobalSettings, skipQuitDialog: true });
			const user = userEvent.setup();
			renderGlobalSettings("system");
			await waitForLoad();

			const toggle = await screen.findByRole("switch", {
				name: "Confirm before quitting",
			});
			expect(toggle).toHaveAttribute("aria-checked", "false");

			await user.click(toggle);
			expect(mockedApi.request.saveGlobalSettings).toHaveBeenLastCalledWith(
				expect.objectContaining({ skipQuitDialog: undefined }),
			);
			expect(toggle).toHaveAttribute("aria-checked", "true");

			await user.click(toggle);
			expect(mockedApi.request.saveGlobalSettings).toHaveBeenLastCalledWith(
				expect.objectContaining({ skipQuitDialog: true }),
			);
		});
	});

	describe("narrow viewport", () => {
		it("uses list-to-detail drill-down with a back affordance", async () => {
			setViewport(390);
			setupMocks();
			const user = userEvent.setup();
			renderGlobalSettings();
			await waitForLoad();

			expect(screen.queryByRole("button", { name: "Back to categories" })).not.toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: "Appearance" }));

			expect(await screen.findByRole("button", { name: "Back to categories" })).toBeInTheDocument();
			expect(screen.getByText("Theme")).toBeInTheDocument();

			await user.click(screen.getByRole("button", { name: "Back to categories" }));
			expect(screen.getByRole("searchbox", { name: "Search settings" })).toBeInTheDocument();
		});
	});

});
