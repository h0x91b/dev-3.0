import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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
function Harness({ initial, onChange }: { initial: AgentConfigSelection; onChange?: (n: AgentConfigSelection) => void }) {
	const [sel, setSel] = useState(initial);
	return (
		<I18nProvider>
			<AgentConfigPicker
				idPrefix="test"
				agents={agents}
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

const provider = () => document.getElementById("test-provider") as HTMLButtonElement;
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
	it("decomposes the current config into Provider/Model/Mode", () => {
		render(<Harness initial={{ agentId: "builtin-claude", configId: "opus-bypass-xhigh" }} />);
		expect(text(provider())).toBe("Claude");
		expect(text(model())).toBe("Opus 4.8");
		expect(text(mode())).toBe("Bypass · X-High");
	});

	it("changing Provider resets to the new agent's default config", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<Harness initial={{ agentId: "builtin-claude", configId: "opus-bypass-xhigh" }} onChange={onChange} />);

		await pick(user, provider(), "Codex");

		expect(onChange).toHaveBeenLastCalledWith({ agentId: "builtin-codex", configId: "codex-default" });
		expect(text(provider())).toBe("Codex");
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

	it("changing Mode updates only the config id", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<Harness initial={{ agentId: "builtin-claude", configId: "fable-auto-medium" }} onChange={onChange} />);

		await pick(user, mode(), "Bypass · X-High");

		expect(onChange).toHaveBeenLastCalledWith({ agentId: "builtin-claude", configId: "fable-bypass-xhigh" });
	});
});
