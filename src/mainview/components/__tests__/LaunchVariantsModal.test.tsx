import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LaunchVariantsModal from "../LaunchVariantsModal";
import { I18nProvider } from "../../i18n";
import type { CodingAgent, GlobalSettings, Project, Task, TaskStatus } from "../../../shared/types";
import type { AppAction } from "../../state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			spawnVariants: vi.fn(),
			addAttempts: vi.fn(),
			toggleTaskWatch: vi.fn(),
			listAgentAccounts: vi.fn().mockResolvedValue({
				claude: { accounts: [], activeId: null, systemIdentity: null },
				codex: { accounts: [], activeId: null, currentIdentity: null },
			}),
			saveGlobalSettings: vi.fn().mockResolvedValue(undefined),
			checkAgentAvailability: vi.fn().mockResolvedValue([]),
			getGlobalSettings: vi.fn().mockResolvedValue({
				defaultAgentId: "builtin-claude",
				defaultConfigId: "claude-default",
				taskDropPosition: "top",
			}),
		},
	},
}));

import { api } from "../../rpc";
const mockedApi = vi.mocked(api, true);

// ---- Fixtures ----
//
// Realistic shape for the Provider → Model → Mode cascade: presets carry a
// `model` (so they group) and structured `permissionMode`/`effort` where the
// agent uses them. Claude spans 3 model groups; Codex spans 2.

const claudeAgent: CodingAgent = {
	id: "builtin-claude",
	name: "Claude",
	baseCommand: "claude",
	isDefault: true,
	configurations: [
		{ id: "claude-default", name: "Default (Sonnet 5)", model: "claude-sonnet-5" },
		{ id: "claude-auto-opus", name: "Auto (Opus 4.8, X-High)", model: "claude-opus-4-8[1m]", permissionMode: "auto", effort: "xhigh" },
		{ id: "claude-bypass-opus", name: "Bypass (Opus 4.8, X-High)", model: "claude-opus-4-8[1m]", permissionMode: "bypassPermissions", effort: "xhigh" },
		{ id: "claude-bypass-fable", name: "Bypass (Fable 5)", model: "claude-fable-5", permissionMode: "bypassPermissions" },
	],
	defaultConfigId: "claude-default",
};

const codexAgent: CodingAgent = {
	id: "builtin-codex",
	name: "Codex",
	baseCommand: "codex",
	isDefault: true,
	configurations: [
		{ id: "codex-default", name: "Default (GPT-5.5 Heavy Bypass)", model: "gpt-5.5", additionalArgs: ["--sandbox", "danger-full-access"] },
		{ id: "codex-plan", name: "Plan (GPT-5.5)", model: "gpt-5.5", appendPrompt: "Plan first." },
		{ id: "codex-heavy", name: "Heavy (GPT-5.5 High)", model: "gpt-5.5" },
		{ id: "codex-codex-medium", name: "GPT-5.3 Codex Medium", model: "gpt-5.3-codex" },
		{ id: "codex-codex-high", name: "GPT-5.3 Codex High", model: "gpt-5.3-codex" },
	],
	defaultConfigId: "codex-default",
};

const geminiAgent: CodingAgent = {
	id: "builtin-gemini",
	name: "Gemini",
	baseCommand: "gemini",
	isDefault: true,
	configurations: [{ id: "gemini-default", name: "Default (3.1 Pro)", model: "gemini-3.1-pro-preview" }],
	defaultConfigId: "gemini-default",
};

const agents = [claudeAgent, codexAgent, geminiAgent];

const baseTask: Task = {
	id: "t1",
	seq: 1,
	projectId: "p1",
	title: "Test task title",
	description: "Test task description",
	status: "todo",
	baseBranch: "main",
	worktreePath: null,
	branchName: null,
	groupId: null,
	variantIndex: null,
	agentId: null,
	configId: null,
	createdAt: "2025-01-01T00:00:00Z",
	updatedAt: "2025-01-01T00:00:00Z",
};

function makeProject(overrides?: Partial<Project>): Project {
	return {
		id: "p1",
		name: "Test Project",
		path: "/tmp/test",
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2025-01-01T00:00:00Z",
		...overrides,
	};
}

function makeGlobalSettings(overrides?: Partial<GlobalSettings>): GlobalSettings {
	return {
		defaultAgentId: "builtin-claude",
		defaultConfigId: "claude-default",
		taskDropPosition: "top",
		updateChannel: "stable",
		...overrides,
	};
}

function renderModal(
	project: Project,
	opts?: {
		dispatch?: React.Dispatch<AppAction>;
		onClose?: () => void;
		targetStatus?: TaskStatus;
		globalSettings?: GlobalSettings;
		task?: Task;
		onGlobalSettingsChange?: (settings: GlobalSettings) => void;
	},
) {
	return render(
		<I18nProvider>
			<LaunchVariantsModal
				task={opts?.task ?? baseTask}
				project={project}
				targetStatus={opts?.targetStatus ?? "in-progress"}
				agents={agents}
				globalSettings={opts?.globalSettings ?? makeGlobalSettings()}
				dispatch={opts?.dispatch ?? vi.fn()}
				onClose={opts?.onClose ?? vi.fn()}
				onGlobalSettingsChange={opts?.onGlobalSettingsChange}
			/>
		</I18nProvider>,
	);
}

/**
 * Custom Select helpers. Each cascade field renders a <button> with id
 * "variant-N-provider" / "variant-N-model" / "variant-N-mode" (the shared
 * AgentConfigPicker uses `${idPrefix}-<field>`); its text is the selected
 * option's label.
 */
function getButtonsById(prefix: string): HTMLButtonElement[] {
	const buttons: HTMLButtonElement[] = [];
	for (let i = 0; ; i++) {
		const el = document.getElementById(`variant-${i}-${prefix}`);
		if (!el) break;
		buttons.push(el as HTMLButtonElement);
	}
	return buttons;
}
const getProviderButtons = () => getButtonsById("provider");
const getModelButtons = () => getButtonsById("model");
const getModeButtons = () => getButtonsById("mode");

function getSelectedText(button: HTMLButtonElement): string {
	return button.textContent?.trim() ?? "";
}

/** Click a custom Select trigger to open it, then click the option with the given label */
async function selectOption(user: ReturnType<typeof userEvent.setup>, button: HTMLButtonElement, optionLabel: string) {
	await user.click(button);
	const overlays = document.querySelectorAll(".bg-overlay.border");
	const dropdown = overlays[overlays.length - 1];
	const option = Array.from(dropdown?.querySelectorAll("button") ?? []).find((b) => b.textContent?.trim() === optionLabel);
	if (!option) throw new Error(`Option "${optionLabel}" not found in dropdown`);
	await user.click(option);
}

/** Open a custom Select and return all option labels */
async function getDropdownOptions(user: ReturnType<typeof userEvent.setup>, button: HTMLButtonElement): Promise<string[]> {
	await user.click(button);
	const overlays = document.querySelectorAll(".bg-overlay.border");
	const dropdown = overlays[overlays.length - 1];
	const optionButtons = dropdown?.querySelectorAll("button") ?? [];
	const labels = Array.from(optionButtons).map((b) => b.textContent?.trim() ?? "");
	await user.click(button);
	return labels;
}

// ---- Tests ----

describe("LaunchVariantsModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("initial cascade resolution", () => {
		it("decomposes the default config into Provider/Model/Mode", () => {
			const gs = makeGlobalSettings({ defaultAgentId: "builtin-claude", defaultConfigId: "claude-default" });
			renderModal(makeProject(), { globalSettings: gs });

			expect(getSelectedText(getProviderButtons()[0])).toBe("Claude");
			expect(getSelectedText(getModelButtons()[0])).toBe("Sonnet 5");
			expect(getSelectedText(getModeButtons()[0])).toBe("Default");
		});

		it("decomposes a globalSettings.defaultConfigId with effort into model + mode", () => {
			const gs = makeGlobalSettings({ defaultAgentId: "builtin-claude", defaultConfigId: "claude-bypass-opus" });
			renderModal(makeProject(), { globalSettings: gs });

			expect(getSelectedText(getModelButtons()[0])).toBe("Opus 4.8");
			expect(getSelectedText(getModeButtons()[0])).toBe("Bypass · X-High");
		});

		it("falls back to first config for a custom agent with no defaultConfigId", () => {
			const customAgent: CodingAgent = {
				id: "custom",
				name: "Custom",
				baseCommand: "bash",
				configurations: [
					{ id: "cfg-a", name: "Alpha" },
					{ id: "cfg-b", name: "Beta" },
				],
			};
			const gs = { defaultAgentId: "custom", taskDropPosition: "top" as const } as GlobalSettings;

			render(
				<I18nProvider>
					<LaunchVariantsModal
						task={baseTask}
						project={makeProject()}
						targetStatus="in-progress"
						agents={[...agents, customAgent]}
						globalSettings={gs}
						dispatch={vi.fn()}
						onClose={vi.fn()}
					/>
				</I18nProvider>,
			);

			// Model-less custom configs collapse to one "Default" group; mode = first.
			expect(getSelectedText(getModelButtons()[0])).toBe("Default");
			expect(getSelectedText(getModeButtons()[0])).toBe("Alpha");
		});
	});

	describe("cascade dropdown population", () => {
		it("provider dropdown lists all agents", async () => {
			const user = userEvent.setup();
			renderModal(makeProject());
			const options = await getDropdownOptions(user, getProviderButtons()[0]);
			expect(options).toEqual(["Claude", "Codex", "Gemini"]);
		});

		it("model dropdown lists Claude's model groups (first-seen order)", async () => {
			const user = userEvent.setup();
			renderModal(makeProject(), { globalSettings: makeGlobalSettings() });
			const options = await getDropdownOptions(user, getModelButtons()[0]);
			expect(options).toEqual(["Sonnet 5", "Opus 4.8", "Fable 5"]);
		});

		it("mode dropdown shows a single-preset group (Sonnet 5)", async () => {
			const user = userEvent.setup();
			renderModal(makeProject(), { globalSettings: makeGlobalSettings({ defaultConfigId: "claude-default" }) });
			expect(await getDropdownOptions(user, getModeButtons()[0])).toEqual(["Default"]);
		});

		it("mode dropdown lists only the presets in the current model group (Opus 4.8)", async () => {
			const user = userEvent.setup();
			renderModal(makeProject(), { globalSettings: makeGlobalSettings({ defaultConfigId: "claude-bypass-opus" }) });
			expect(await getDropdownOptions(user, getModeButtons()[0])).toEqual(["Auto · X-High", "Bypass · X-High"]);
		});

		it("derives readable mode leaves for arg-encoded Codex presets", async () => {
			const user = userEvent.setup();
			renderModal(makeProject(), { globalSettings: makeGlobalSettings({ defaultAgentId: "builtin-codex", defaultConfigId: "codex-default" }) });
			expect(getSelectedText(getModelButtons()[0])).toBe("GPT-5.5");
			const modes = await getDropdownOptions(user, getModeButtons()[0]);
			expect(modes).toEqual(["Default (Heavy Bypass)", "Plan", "Heavy (High)"]);
		});
	});

	describe("provider switching", () => {
		it("resets model + mode to the new provider's default", async () => {
			const user = userEvent.setup();
			renderModal(makeProject(), { globalSettings: makeGlobalSettings() });

			expect(getSelectedText(getProviderButtons()[0])).toBe("Claude");

			await selectOption(user, getProviderButtons()[0], "Codex");

			expect(getSelectedText(getProviderButtons()[0])).toBe("Codex");
			expect(getSelectedText(getModelButtons()[0])).toBe("GPT-5.5");
			expect(getSelectedText(getModeButtons()[0])).toBe("Default (Heavy Bypass)");
		});

		it("switching back to Claude restores its default cascade", async () => {
			const user = userEvent.setup();
			renderModal(makeProject(), { globalSettings: makeGlobalSettings() });

			await selectOption(user, getProviderButtons()[0], "Codex");
			await selectOption(user, getProviderButtons()[0], "Claude");

			expect(getSelectedText(getModelButtons()[0])).toBe("Sonnet 5");
			expect(getSelectedText(getModeButtons()[0])).toBe("Default");
		});
	});

	describe("model switching", () => {
		it("preserves the current mode kind across a model change when it exists", async () => {
			const user = userEvent.setup();
			// Start on Bypass · X-High (Opus 4.8); switch to Fable 5, which has a
			// Bypass preset (no effort tier) → mode stays Bypass.
			renderModal(makeProject(), { globalSettings: makeGlobalSettings({ defaultConfigId: "claude-bypass-opus" }) });

			expect(getSelectedText(getModeButtons()[0])).toBe("Bypass · X-High");

			await selectOption(user, getModelButtons()[0], "Fable 5");

			expect(getSelectedText(getModelButtons()[0])).toBe("Fable 5");
			expect(getSelectedText(getModeButtons()[0])).toBe("Bypass");
		});

		it("falls back to the group's first mode when the kind does not exist", async () => {
			const user = userEvent.setup();
			// Start on Sonnet 5 / Default; switch to Opus 4.8 (no plain Default) →
			// first mode of that group.
			renderModal(makeProject(), { globalSettings: makeGlobalSettings({ defaultConfigId: "claude-default" }) });

			await selectOption(user, getModelButtons()[0], "Opus 4.8");

			expect(getSelectedText(getModeButtons()[0])).toBe("Auto · X-High");
		});
	});

	describe("add/remove variants", () => {
		it("adds a variant row with defaults", async () => {
			const user = userEvent.setup();
			renderModal(makeProject());

			expect(getProviderButtons()).toHaveLength(1);

			await user.click(screen.getByText("+ Add Variant"));

			expect(getProviderButtons()).toHaveLength(2);
			expect(getSelectedText(getProviderButtons()[1])).toBe("Claude");
			expect(getSelectedText(getModelButtons()[1])).toBe("Sonnet 5");
			expect(getSelectedText(getModeButtons()[1])).toBe("Default");
		});

		it("remove button appears only when multiple variants exist", async () => {
			const user = userEvent.setup();
			renderModal(makeProject());

			expect(screen.queryByTitle("Remove")).not.toBeInTheDocument();

			await user.click(screen.getByText("+ Add Variant"));

			expect(screen.getAllByTitle("Remove")).toHaveLength(2);
		});

		it("removing a variant updates the list", async () => {
			const user = userEvent.setup();
			renderModal(makeProject());

			await user.click(screen.getByText("+ Add Variant"));
			expect(getProviderButtons()).toHaveLength(2);

			await user.click(screen.getAllByTitle("Remove")[0]);

			expect(getProviderButtons()).toHaveLength(1);
		});

		it("hides the Add Variant button for virtual (Operations) boards", () => {
			const project = makeProject({ kind: "virtual" });
			renderModal(project);

			expect(screen.queryByText("+ Add Variant")).not.toBeInTheDocument();
			expect(getProviderButtons()).toHaveLength(1);
		});
	});

	describe("launch action", () => {
		it("calls spawnVariants with the flat configId (storage unchanged) and dispatches", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();
			const onClose = vi.fn();

			const resultTasks: Task[] = [
				{ ...baseTask, id: "v1", status: "in-progress", groupId: "g1", variantIndex: 1, agentId: "builtin-claude", configId: "claude-default" },
			];
			mockedApi.request.spawnVariants.mockResolvedValue(resultTasks);

			renderModal(makeProject(), { dispatch, onClose });

			await user.click(screen.getByText("Launch"));

			expect(mockedApi.request.spawnVariants).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				targetStatus: "in-progress",
				variants: [{ agentId: "builtin-claude", configId: "claude-default" }],
			});

			await vi.waitFor(() => {
				expect(dispatch).toHaveBeenCalledWith({
					type: "spawnVariants",
					sourceTaskId: "t1",
					variants: resultTasks,
				});
			});

			expect(onClose).toHaveBeenCalled();
		});

		it("launches the leaf configId chosen through the cascade", async () => {
			const user = userEvent.setup();
			mockedApi.request.spawnVariants.mockResolvedValue([]);
			renderModal(makeProject(), { globalSettings: makeGlobalSettings({ defaultConfigId: "claude-default" }) });

			await selectOption(user, getModelButtons()[0], "Opus 4.8");
			await selectOption(user, getModeButtons()[0], "Bypass · X-High");

			await user.click(screen.getByText("Launch"));

			expect(mockedApi.request.spawnVariants).toHaveBeenCalledWith(
				expect.objectContaining({
					variants: [{ agentId: "builtin-claude", configId: "claude-bypass-opus" }],
				}),
			);
		});

		it("shows error when spawnVariants fails", async () => {
			const user = userEvent.setup();
			mockedApi.request.spawnVariants.mockRejectedValue(new Error("boom"));
			renderModal(makeProject());

			await user.click(screen.getByText("Launch"));

			await vi.waitFor(() => {
				expect(screen.getByText(/Failed to launch.*boom/)).toBeInTheDocument();
			});
		});
	});

	describe("fallback when globalSettings agent is missing", () => {
		it("selects the global default provider", () => {
			renderModal(makeProject());
			expect(getSelectedText(getProviderButtons()[0])).toBe("Claude");
		});

		it("falls back to the first agent when globalSettings agent is nonexistent", async () => {
			const user = userEvent.setup();
			const gs = makeGlobalSettings({ defaultAgentId: "deleted-agent" });
			renderModal(makeProject(), { globalSettings: gs });

			const options = await getDropdownOptions(user, getModeButtons()[0]);
			expect(options.length).toBeGreaterThan(0);
		});

		it("sends the global-default configId in spawnVariants", async () => {
			const user = userEvent.setup();
			mockedApi.request.spawnVariants.mockResolvedValue([]);
			renderModal(makeProject());

			await user.click(screen.getByText("Launch"));

			expect(mockedApi.request.spawnVariants).toHaveBeenCalledWith(
				expect.objectContaining({
					variants: [{ agentId: "builtin-claude", configId: "claude-default" }],
				}),
			);
		});
	});

	describe("modal UI", () => {
		it("shows task title in header", () => {
			renderModal(makeProject());
			expect(screen.getByText("Test task title")).toBeInTheDocument();
		});

		it("closes on backdrop click", async () => {
			const user = userEvent.setup();
			const onClose = vi.fn();
			renderModal(makeProject(), { onClose });

			const backdrop = screen.getByText("Launch Task").closest(".fixed");
			if (backdrop) await user.click(backdrop);

			expect(onClose).toHaveBeenCalled();
		});
	});

	describe("watch default preference", () => {
		it("initializes the Watch toggle from globalSettings.watchByDefault for a new task", () => {
			const gs = makeGlobalSettings({ watchByDefault: true });
			renderModal(makeProject(), { globalSettings: gs });
			expect(screen.getByText("Watching")).toBeInTheDocument();
		});

		it("defaults to unwatched when no preference is stored", () => {
			renderModal(makeProject(), { globalSettings: makeGlobalSettings() });
			expect(screen.getByText("Watch")).toBeInTheDocument();
		});

		it("respects an existing task's explicit watched flag over the default", () => {
			const gs = makeGlobalSettings({ watchByDefault: false });
			renderModal(makeProject(), { globalSettings: gs, task: { ...baseTask, watched: true } });
			expect(screen.getByText("Watching")).toBeInTheDocument();
		});

		it("persists the choice as the new default when the toggle is clicked", async () => {
			const user = userEvent.setup();
			const onGlobalSettingsChange = vi.fn();
			renderModal(makeProject(), { globalSettings: makeGlobalSettings(), onGlobalSettingsChange });

			await user.click(screen.getByText("Watch"));

			expect(onGlobalSettingsChange).toHaveBeenCalledWith(
				expect.objectContaining({ watchByDefault: true }),
			);
			expect(mockedApi.request.saveGlobalSettings).toHaveBeenCalledWith(
				expect.objectContaining({ watchByDefault: true }),
			);
			expect(screen.getByText("Watching")).toBeInTheDocument();
		});

		it("applies the remembered Watch default to the task on launch", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();
			mockedApi.request.spawnVariants.mockResolvedValue([]);
			mockedApi.request.toggleTaskWatch.mockResolvedValue({ ...baseTask, watched: true });

			renderModal(makeProject(), { dispatch, globalSettings: makeGlobalSettings({ watchByDefault: true }) });

			await user.click(screen.getByText("Launch"));

			await vi.waitFor(() => {
				expect(mockedApi.request.toggleTaskWatch).toHaveBeenCalledWith({
					taskId: "t1",
					projectId: "p1",
					watched: true,
				});
			});
		});

		it("does not touch watch on launch when the toggle matches the task state", async () => {
			const user = userEvent.setup();
			mockedApi.request.spawnVariants.mockResolvedValue([]);

			renderModal(makeProject(), { globalSettings: makeGlobalSettings() });

			await user.click(screen.getByText("Launch"));

			await vi.waitFor(() => {
				expect(mockedApi.request.spawnVariants).toHaveBeenCalled();
			});
			expect(mockedApi.request.toggleTaskWatch).not.toHaveBeenCalled();
		});
	});

	describe("keyboard shortcuts", () => {
		it("Escape closes the modal", async () => {
			const onClose = vi.fn();
			renderModal(makeProject(), { onClose });
			await userEvent.keyboard("{Escape}");
			expect(onClose).toHaveBeenCalled();
		});

		it("Enter triggers launch", async () => {
			const onClose = vi.fn();
			const dispatch = vi.fn();
			mockedApi.request.spawnVariants.mockResolvedValue([]);
			renderModal(makeProject(), { onClose, dispatch });
			await userEvent.keyboard("{Enter}");
			await vi.waitFor(() => {
				expect(mockedApi.request.spawnVariants).toHaveBeenCalled();
			});
		});

		it("Enter does not trigger launch when an input is focused", async () => {
			const onClose = vi.fn();
			mockedApi.request.spawnVariants.mockResolvedValue([]);
			renderModal(makeProject(), { onClose });

			const input = document.createElement("input");
			document.body.appendChild(input);
			input.focus();

			await userEvent.keyboard("{Enter}");
			expect(mockedApi.request.spawnVariants).not.toHaveBeenCalled();
			document.body.removeChild(input);
		});

		// Regression: a keyboard user who tab-focuses any cascade Select and
		// presses Enter to open it must NOT spawn agents (accidental, costly launch).
		it.each([
			["provider", () => getProviderButtons()[0]],
			["model", () => getModelButtons()[0]],
			["mode", () => getModeButtons()[0]],
		])("Enter does not trigger launch when the %s Select button is focused", async (_name, getBtn) => {
			mockedApi.request.spawnVariants.mockResolvedValue([]);
			renderModal(makeProject());

			getBtn().focus();
			expect(document.activeElement?.tagName).toBe("BUTTON");

			await userEvent.keyboard("{Enter}");
			expect(mockedApi.request.spawnVariants).not.toHaveBeenCalled();
		});

		it("Enter does not trigger launch when the Cancel button is focused", async () => {
			mockedApi.request.spawnVariants.mockResolvedValue([]);
			renderModal(makeProject());

			(screen.getByText("Cancel") as HTMLButtonElement).focus();

			await userEvent.keyboard("{Enter}");
			expect(mockedApi.request.spawnVariants).not.toHaveBeenCalled();
		});

		it("Enter does not trigger launch when the Watch button is focused", async () => {
			mockedApi.request.spawnVariants.mockResolvedValue([]);
			renderModal(makeProject());

			(screen.getByText("Watch").closest("button") as HTMLButtonElement).focus();

			await userEvent.keyboard("{Enter}");
			expect(mockedApi.request.spawnVariants).not.toHaveBeenCalled();
		});

		it("Cmd/Ctrl/Shift+Enter do not trigger launch", async () => {
			mockedApi.request.spawnVariants.mockResolvedValue([]);
			renderModal(makeProject());

			await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
			await userEvent.keyboard("{Control>}{Enter}{/Control}");
			await userEvent.keyboard("{Shift>}{Enter}{/Shift}");

			expect(mockedApi.request.spawnVariants).not.toHaveBeenCalled();
		});
	});

	describe("single open dropdown", () => {
		it("closes an open Select dropdown when focus moves to another control", async () => {
			const user = userEvent.setup();
			renderModal(makeProject());

			const providerBtn = getProviderButtons()[0];
			providerBtn.focus();
			await user.keyboard("{Enter}");

			// Provider dropdown is open — "Codex" only appears as a provider option.
			expect(screen.getByText("Codex")).toBeInTheDocument();

			await user.tab();

			expect(screen.queryByText("Codex")).not.toBeInTheDocument();
		});
	});

	describe("focus trap", () => {
		it("moves focus into the dialog on open", () => {
			renderModal(makeProject());
			const dialog = screen.getByRole("dialog");
			expect(dialog.contains(document.activeElement)).toBe(true);
			expect(document.activeElement).not.toBe(document.body);
		});

		it("Tab from the last control cycles back into the dialog (does not escape)", async () => {
			const user = userEvent.setup();
			renderModal(makeProject());
			const dialog = screen.getByRole("dialog");

			(screen.getByText("Launch") as HTMLButtonElement).focus();
			await user.tab();

			expect(dialog.contains(document.activeElement)).toBe(true);
			expect(document.activeElement).not.toBe(document.body);
		});

		it("Shift+Tab from the first control cycles to the last (stays in dialog)", async () => {
			const user = userEvent.setup();
			renderModal(makeProject());
			const dialog = screen.getByRole("dialog");

			(screen.getByText("Watch").closest("button") as HTMLButtonElement).focus();
			await user.tab({ shift: true });

			expect(dialog.contains(document.activeElement)).toBe(true);
		});

		it("Tab never lands on an element outside the dialog", async () => {
			const user = userEvent.setup();
			renderModal(makeProject());
			const dialog = screen.getByRole("dialog");

			const outside = document.createElement("button");
			outside.textContent = "behind";
			document.body.appendChild(outside);

			for (let i = 0; i < 12; i++) {
				await user.tab();
				expect(dialog.contains(document.activeElement)).toBe(true);
				expect(document.activeElement).not.toBe(outside);
			}

			document.body.removeChild(outside);
		});
	});
});
