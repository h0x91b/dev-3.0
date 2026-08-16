import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

// The picker renders AgentAccountIndicator, which pulls in rpc.ts (Electrobun).
// Empty account registries keep the indicator hidden in these layout tests.
vi.mock("../../rpc", () => ({
	api: {
		request: {
			listAgentAccounts: vi.fn().mockResolvedValue({
				claude: { accounts: [], activeId: null, systemIdentity: null },
				codex: { accounts: [], activeId: null, currentIdentity: null },
			}),
			setActiveAgentAccount: vi.fn(),
			modelCatalogGet: vi.fn().mockResolvedValue({
				providers: [{ id: "p-or", kind: "openrouter", label: "OpenRouter", hasKey: true }],
				models: [{ id: "m-flash", providerId: "p-or", name: "ds-flash", modelId: "deepseek/flash" }],
			}),
		},
	},
}));

import AgentConfigPicker, { type AgentConfigSelection } from "../AgentConfigPicker";
import { I18nProvider } from "../../i18n";
import type { CodingAgent } from "../../../shared/types";

// Two model groups per agent so the Model field actually has choices, plus
// structured permissionMode/effort so the Mode leaf labels are derived.
const claudeAgent: CodingAgent = {
	id: "builtin-claude",
	name: "Claude",
	baseCommand: "claude",
	isDefault: true,
	configurations: [
		{ id: "fable-auto-medium", name: "Auto (Fable 5, Medium)", model: "claude-fable-5", permissionMode: "auto", effort: "medium" },
		{ id: "fable-bypass-xhigh", name: "Bypass (Fable 5, X-High)", model: "claude-fable-5", permissionMode: "bypassPermissions", effort: "xhigh" },
		{ id: "opus-auto-medium", name: "Auto (Opus 4.8, Medium)", model: "claude-opus-4-8[1m]", permissionMode: "auto", effort: "medium" },
		{ id: "opus-bypass-xhigh", name: "Bypass (Opus 4.8, X-High)", model: "claude-opus-4-8[1m]", permissionMode: "bypassPermissions", effort: "xhigh" },
	],
	defaultConfigId: "fable-auto-medium",
};

const codexAgent: CodingAgent = {
	id: "builtin-codex",
	name: "Codex",
	baseCommand: "codex",
	isDefault: true,
	configurations: [
		{ id: "codex-default", name: "Default (GPT-5.5)", model: "gpt-5.5" },
	],
	defaultConfigId: "codex-default",
};

const agents = [claudeAgent, codexAgent];

/** Controlled harness mirroring how real parents wire the picker. */
function Harness({ initial, onChange, showLabels }: { initial: AgentConfigSelection; onChange?: (n: AgentConfigSelection) => void; showLabels?: boolean }) {
	const [sel, setSel] = useState(initial);
	return (
		<I18nProvider>
			<AgentConfigPicker
				idPrefix="test"
				agents={agents}
				showLabels={showLabels}
				agentId={sel.agentId}
				configId={sel.configId}
				onChange={(next) => {
					setSel(next);
					onChange?.(next);
				}}
			/>
		</I18nProvider>
	);
}

const harnessBtn = () => document.getElementById("test-harness") as HTMLButtonElement;
const model = () => document.getElementById("test-model") as HTMLButtonElement;
const mode = () => document.getElementById("test-mode") as HTMLButtonElement;
const text = (b: HTMLButtonElement) => b?.textContent?.trim() ?? "";

async function pick(user: ReturnType<typeof userEvent.setup>, button: HTMLButtonElement, label: string) {
	await user.click(button);
	const overlays = document.querySelectorAll(".bg-overlay.border");
	const dropdown = overlays[overlays.length - 1];
	const option = Array.from(dropdown?.querySelectorAll("button") ?? []).find((b) => b.textContent?.trim() === label);
	if (!option) throw new Error(`option "${label}" not found`);
	await user.click(option);
}

describe("AgentConfigPicker", () => {
	it("decomposes the current config into Harness/Model/Mode", () => {
		render(<Harness initial={{ agentId: "builtin-claude", configId: "opus-bypass-xhigh" }} />);
		expect(text(harnessBtn())).toBe("Claude");
		expect(text(model())).toBe("Opus 4.8");
		expect(text(mode())).toBe("Bypass · X-High");
	});

	it("changing Harness resets to the new agent's default config", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<Harness initial={{ agentId: "builtin-claude", configId: "opus-bypass-xhigh" }} onChange={onChange} />);

		await pick(user, harnessBtn(), "Codex");

		expect(onChange).toHaveBeenLastCalledWith({ agentId: "builtin-codex", configId: "codex-default" });
		expect(text(harnessBtn())).toBe("Codex");
		expect(text(model())).toBe("GPT-5.5");
		expect(text(mode())).toBe("Default");
	});

	it("changing Model preserves the Mode kind (permissionMode + effort) across the group switch", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		// Start on Fable Bypass X-High; switching model to Opus 4.8 keeps Bypass X-High.
		render(<Harness initial={{ agentId: "builtin-claude", configId: "fable-bypass-xhigh" }} onChange={onChange} />);

		await pick(user, model(), "Opus 4.8");

		expect(onChange).toHaveBeenLastCalledWith({ agentId: "builtin-claude", configId: "opus-bypass-xhigh" });
		expect(text(mode())).toBe("Bypass · X-High");
	});

	it("shows the field labels by default (Settings and single-picker dialogs)", () => {
		render(<Harness initial={{ agentId: "builtin-claude", configId: "fable-auto-medium" }} />);
		const label = document.querySelector('label[for="test-harness"]');
		expect(label?.textContent).toBe("Harness");
		expect(label?.className).not.toContain("sr-only");
	});

	it("with showLabels off keeps each label as the control's accessible name", () => {
		render(<Harness showLabels={false} initial={{ agentId: "builtin-claude", configId: "fable-auto-medium" }} />);
		// Hidden only where the fields sit in a row — the parent's header takes over
		// there; stacked, these labels are the only ones on screen.
		expect(document.querySelector('label[for="test-model"]')?.className).toContain(
			"[@container_(min-width:34rem)]:sr-only",
		);
		expect(screen.getByRole("combobox", { name: "Model" })).toBe(model());
	});

	it("changing Mode updates only the config id", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<Harness initial={{ agentId: "builtin-claude", configId: "fable-auto-medium" }} onChange={onChange} />);

		await pick(user, mode(), "Bypass · X-High");

		expect(onChange).toHaveBeenLastCalledWith({ agentId: "builtin-claude", configId: "fable-bypass-xhigh" });
	});

	// Provider is a property of the model, so it is a caption on the Model field —
	// never a fourth thing to pick (AGENTS.md § Model routing glossary).
	describe("the provider caption", () => {
		const routedAgent: CodingAgent = {
			id: "builtin-codex",
			name: "Codex",
			baseCommand: "codex",
			configurations: [
				{ id: "codex-default", name: "Default (GPT-5.5)", model: "gpt-5.5" },
				{ id: "ds-flash", name: "DS-Flash", modelRoles: { main: "m-flash" } },
			],
			defaultConfigId: "ds-flash",
		};

		function RoutedHarness() {
			const [sel, setSel] = useState<AgentConfigSelection>({ agentId: "builtin-codex", configId: "ds-flash" });
			return (
				<I18nProvider>
					<AgentConfigPicker idPrefix="test" agents={[routedAgent]} agentId={sel.agentId} configId={sel.configId} onChange={setSel} />
				</I18nProvider>
			);
		}

		it("names who serves a catalog-bound preset, on the closed field", async () => {
			render(<RoutedHarness />);
			await waitFor(() => expect(text(model())).toContain("OpenRouter"));
			expect(text(model())).toContain("DS-Flash");
		});

		it("leaves a built-in preset uncaptioned rather than guessing a vendor", async () => {
			const user = userEvent.setup();
			render(<RoutedHarness />);
			await waitFor(() => expect(text(model())).toContain("OpenRouter"));

			await user.click(model());
			const overlays = document.querySelectorAll(".bg-overlay.border");
			const rows = Array.from(overlays[overlays.length - 1]?.querySelectorAll("button") ?? []);
			const builtin = rows.find((b) => b.textContent?.includes("GPT-5.5"));
			expect(builtin?.textContent).not.toContain("OpenRouter");
		});
	});
});
