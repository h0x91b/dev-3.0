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
			getGlobalSettings: vi.fn().mockResolvedValue({
				defaultAgentId: "builtin-claude",
				defaultConfigId: "claude-default",
				taskDropPosition: "top",
			}),
		},
	},
}));

import { api } from "../../rpc";
const mockedApi = vi.mocked(api);

// ---- Fixtures ----

const claudeAgent: CodingAgent = {
	id: "builtin-claude",
	name: "Claude",
	baseCommand: "claude",
	isDefault: true,
	configurations: [
		{ id: "claude-default", name: "Default", model: "sonnet" },
		{ id: "claude-plan", name: "Plan (Opus)", model: "opus" },
		{ id: "claude-bypass", name: "Bypass (Opus)", model: "opus" },
	],
	defaultConfigId: "claude-default",
};

const codexAgent: CodingAgent = {
	id: "builtin-codex",
	name: "Codex",
	baseCommand: "codex",
	isDefault: true,
	configurations: [{ id: "codex-default", name: "Default" }],
	defaultConfigId: "codex-default",
};

const geminiAgent: CodingAgent = {
	id: "builtin-gemini",
	name: "Gemini",
	baseCommand: "gemini",
	isDefault: true,
	configurations: [{ id: "gemini-default", name: "Default" }],
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
	},
) {
	return render(
		<I18nProvider>
			<LaunchVariantsModal
				task={baseTask}
				project={project}
				targetStatus={opts?.targetStatus ?? "in-progress"}
				agents={agents}
				globalSettings={opts?.globalSettings ?? makeGlobalSettings()}
				dispatch={opts?.dispatch ?? vi.fn()}
				onClose={opts?.onClose ?? vi.fn()}
			/>
		</I18nProvider>,
	);
}

/**
 * Custom Select helpers.
 * The Select component renders a <button> with id="variant-agent-N" / "variant-config-N".
 * The button text is the selected option's label.
 */
function getAgentButtons(): HTMLButtonElement[] {
	const buttons: HTMLButtonElement[] = [];
	for (let i = 0; ; i++) {
		const el = document.getElementById(`variant-agent-${i}`);
		if (!el) break;
		buttons.push(el as HTMLButtonElement);
	}
	return buttons;
}

function getConfigButtons(): HTMLButtonElement[] {
	const buttons: HTMLButtonElement[] = [];
	for (let i = 0; ; i++) {
		const el = document.getElementById(`variant-config-${i}`);
		if (!el) break;
		buttons.push(el as HTMLButtonElement);
	}
	return buttons;
}

function getSelectedText(button: HTMLButtonElement): string {
	return button.textContent?.trim() ?? "";
}

/** Click a custom Select trigger to open it, then click the option with the given label */
async function selectOption(user: ReturnType<typeof userEvent.setup>, button: HTMLButtonElement, optionLabel: string) {
	await user.click(button);
	// The dropdown is rendered via portal — find the option button by text
	const option = screen.getByText(optionLabel, { selector: "button" });
	await user.click(option);
}

/** Open a custom Select and return all option labels */
async function getDropdownOptions(user: ReturnType<typeof userEvent.setup>, button: HTMLButtonElement): Promise<string[]> {
	await user.click(button);
	// Dropdown is a portal with buttons as options
	// Find the dropdown container — it's the last .bg-overlay in the DOM (portaled)
	const overlays = document.querySelectorAll(".bg-overlay.border");
	const dropdown = overlays[overlays.length - 1];
	const optionButtons = dropdown?.querySelectorAll("button") ?? [];
	const labels = Array.from(optionButtons).map((b) => b.textContent?.trim() ?? "");
	// Close by clicking outside
	await user.click(button);
	return labels;
}

// ---- Tests ----

describe("LaunchVariantsModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("initial config resolution", () => {
		it("uses agent.defaultConfigId when globalSettings.defaultConfigId is not matching", () => {
			const project = makeProject();
			const gs = makeGlobalSettings({ defaultAgentId: "builtin-claude", defaultConfigId: "claude-default" });
			renderModal(project, { globalSettings: gs });

			const configBtn = getConfigButtons()[0];
			expect(getSelectedText(configBtn)).toBe("Default");
		});

		it("uses globalSettings.defaultConfigId when set", () => {
			const project = makeProject();
			const gs = makeGlobalSettings({ defaultAgentId: "builtin-claude", defaultConfigId: "claude-plan" });
			renderModal(project, { globalSettings: gs });

			const configBtn = getConfigButtons()[0];
			expect(getSelectedText(configBtn)).toBe("Plan (Opus)");
		});

		it("falls back to first config when agent has no defaultConfigId and global config is null", () => {
			const customAgent: CodingAgent = {
				id: "custom",
				name: "Custom",
				baseCommand: "bash",
				configurations: [
					{ id: "cfg-a", name: "Alpha" },
					{ id: "cfg-b", name: "Beta" },
				],
				// No defaultConfigId
			};
			const project = makeProject();
			// globalSettings.defaultConfigId must be null/undefined to trigger fallback
			const gs = { defaultAgentId: "custom", taskDropPosition: "top" as const } as GlobalSettings;

			render(
				<I18nProvider>
					<LaunchVariantsModal
						task={baseTask}
						project={project}
						targetStatus="in-progress"
						agents={[...agents, customAgent]}
						globalSettings={gs}
						dispatch={vi.fn()}
						onClose={vi.fn()}
					/>
				</I18nProvider>,
			);

			const configBtn = getConfigButtons()[0];
			expect(getSelectedText(configBtn)).toBe("Alpha");
		});
	});

	describe("config dropdown population", () => {
		it("shows all configurations for Claude (multi-config agent)", async () => {
			const user = userEvent.setup();
			const project = makeProject();
			const gs = makeGlobalSettings({ defaultAgentId: "builtin-claude" });
			renderModal(project, { globalSettings: gs });

			const options = await getDropdownOptions(user, getConfigButtons()[0]);
			expect(options).toHaveLength(3);
			expect(options[0]).toBe("Default");
			expect(options[1]).toBe("Plan (Opus)");
			expect(options[2]).toBe("Bypass (Opus)");
		});

		it("shows single configuration for Codex", async () => {
			const user = userEvent.setup();
			const project = makeProject();
			const gs = makeGlobalSettings({ defaultAgentId: "builtin-codex", defaultConfigId: "codex-default" });
			renderModal(project, { globalSettings: gs });

			const options = await getDropdownOptions(user, getConfigButtons()[0]);
			expect(options).toHaveLength(1);
			expect(options[0]).toBe("Default");
		});

		it("agent dropdown shows all agents", async () => {
			const user = userEvent.setup();
			const project = makeProject();
			renderModal(project);

			const options = await getDropdownOptions(user, getAgentButtons()[0]);
			expect(options).toHaveLength(3);
			expect(options[0]).toBe("Claude");
			expect(options[1]).toBe("Codex");
			expect(options[2]).toBe("Gemini");
		});
	});

	describe("agent switching", () => {
		it("resets config to agent default when switching agents", async () => {
			const user = userEvent.setup();
			const project = makeProject();
			const gs = makeGlobalSettings({ defaultAgentId: "builtin-claude" });
			renderModal(project, { globalSettings: gs });

			const agentBtn = getAgentButtons()[0];
			const configBtn = getConfigButtons()[0];

			// Initially Claude with Default
			expect(getSelectedText(agentBtn)).toBe("Claude");
			expect(getSelectedText(configBtn)).toBe("Default");

			// Switch to Codex
			await selectOption(user, agentBtn, "Codex");

			const configBtnAfter = getConfigButtons()[0];
			expect(getSelectedText(configBtnAfter)).toBe("Default");

			// Config dropdown should show Codex configs (only 1)
			const options = await getDropdownOptions(user, configBtnAfter);
			expect(options).toHaveLength(1);
			expect(options[0]).toBe("Default");
		});

		it("switching back to Claude restores all Claude configs", async () => {
			const user = userEvent.setup();
			const project = makeProject();
			const gs = makeGlobalSettings({ defaultAgentId: "builtin-claude" });
			renderModal(project, { globalSettings: gs });

			const agentBtn = getAgentButtons()[0];

			// Switch to Codex, then back to Claude
			await selectOption(user, agentBtn, "Codex");
			await selectOption(user, agentBtn, "Claude");

			const configBtn = getConfigButtons()[0];
			expect(getSelectedText(configBtn)).toBe("Default");

			const options = await getDropdownOptions(user, configBtn);
			expect(options).toHaveLength(3);
		});
	});

	describe("add/remove variants", () => {
		it("adds a variant row with defaults", async () => {
			const user = userEvent.setup();
			const project = makeProject();
			renderModal(project);

			// Initially 1 variant row
			expect(getAgentButtons()).toHaveLength(1);

			// Click "+ Add Variant"
			await user.click(screen.getByText("+ Add Variant"));

			// Now 2 variant rows
			expect(getAgentButtons()).toHaveLength(2);

			// Second row should also have Claude + Default
			const agentBtns = getAgentButtons();
			const configBtns = getConfigButtons();
			expect(getSelectedText(agentBtns[1])).toBe("Claude");
			expect(getSelectedText(configBtns[1])).toBe("Default");
		});

		it("remove button appears only when multiple variants exist", async () => {
			const user = userEvent.setup();
			const project = makeProject();
			renderModal(project);

			// With 1 variant, no remove button
			expect(screen.queryByTitle("Remove")).not.toBeInTheDocument();

			// Add variant
			await user.click(screen.getByText("+ Add Variant"));

			// Now remove buttons appear
			const removeButtons = screen.getAllByTitle("Remove");
			expect(removeButtons).toHaveLength(2);
		});

		it("removing a variant updates the list", async () => {
			const user = userEvent.setup();
			const project = makeProject();
			renderModal(project);

			await user.click(screen.getByText("+ Add Variant"));
			expect(getAgentButtons()).toHaveLength(2);

			// Remove first variant
			const removeButtons = screen.getAllByTitle("Remove");
			await user.click(removeButtons[0]);

			expect(getAgentButtons()).toHaveLength(1);
		});
	});

	describe("launch action", () => {
		it("calls spawnVariants with correct params and dispatches", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();
			const onClose = vi.fn();
			const project = makeProject();

			const resultTasks: Task[] = [
				{ ...baseTask, id: "v1", status: "in-progress", groupId: "g1", variantIndex: 1, agentId: "builtin-claude", configId: "claude-default" },
			];
			mockedApi.request.spawnVariants.mockResolvedValue(resultTasks);

			renderModal(project, { dispatch, onClose });

			await user.click(screen.getByText("Launch"));

			expect(mockedApi.request.spawnVariants).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				targetStatus: "in-progress",
				variants: [{ agentId: "builtin-claude", configId: "claude-default" }],
			});

			// Wait for async
			await vi.waitFor(() => {
				expect(dispatch).toHaveBeenCalledWith({
					type: "spawnVariants",
					sourceTaskId: "t1",
					variants: resultTasks,
				});
			});

			expect(onClose).toHaveBeenCalled();
		});

		it("shows error when spawnVariants fails", async () => {
			const user = userEvent.setup();
			const project = makeProject();

			mockedApi.request.spawnVariants.mockRejectedValue(new Error("boom"));

			renderModal(project);

			await user.click(screen.getByText("Launch"));

			await vi.waitFor(() => {
				expect(screen.getByText(/Failed to launch.*boom/)).toBeInTheDocument();
			});
		});
	});

	describe("fallback when globalSettings agent is missing", () => {
		it("populates config dropdown when globalSettings agent is valid", async () => {
			const user = userEvent.setup();
			const project = makeProject();
			renderModal(project);

			const options = await getDropdownOptions(user, getConfigButtons()[0]);
			expect(options.length).toBeGreaterThan(0);
		});

		it("selects global default agent", () => {
			const project = makeProject();
			renderModal(project);

			const agentBtn = getAgentButtons()[0];
			expect(getSelectedText(agentBtn)).toBe("Claude");
		});

		it("falls back to first agent when globalSettings agent is nonexistent", async () => {
			const user = userEvent.setup();
			const project = makeProject();
			const gs = makeGlobalSettings({ defaultAgentId: "deleted-agent" });
			renderModal(project, { globalSettings: gs });

			const options = await getDropdownOptions(user, getConfigButtons()[0]);
			expect(options.length).toBeGreaterThan(0);
		});

		it("sends correct agentId in spawnVariants using global default", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();
			const onClose = vi.fn();
			const project = makeProject();

			mockedApi.request.spawnVariants.mockResolvedValue([]);
			renderModal(project, { dispatch, onClose });

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

			// Click backdrop (the outer fixed div)
			const backdrop = screen.getByText("Launch Task").closest(".fixed");
			if (backdrop) await user.click(backdrop);

			expect(onClose).toHaveBeenCalled();
		});
	});
});
