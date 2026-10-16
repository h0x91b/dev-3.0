import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

const getAgentLiveModels = vi.fn();
vi.mock("../../rpc", () => ({
	api: {
		request: {
			listAgentAccounts: vi.fn().mockResolvedValue({
				claude: { accounts: [], activeId: null, systemConfigDir: "/home/me/.claude", systemIdentity: null },
				codex: { accounts: [], activeId: null, currentIdentity: null },
				omp: { accounts: [], activeId: null },
			}),
			setActiveAgentAccount: vi.fn(),
			modelCatalogGet: vi.fn().mockResolvedValue({ providers: [], models: [] }),
			getAgentLiveModels: (...args: unknown[]) => getAgentLiveModels(...args),
		},
	},
}));

import AgentConfigPicker, { type AgentConfigSelection } from "../AgentConfigPicker";
import { I18nProvider } from "../../i18n";
import type { CodingAgent } from "../../../shared/types";

const ompAgent: CodingAgent = {
	id: "builtin-omp",
	name: "Oh My Pi",
	baseCommand: "omp",
	isDefault: true,
	configurations: [
		{ id: "omp-yolo", name: "Bypass", permissionMode: "bypassPermissions" },
		{ id: "omp-default", name: "Default" },
		{ id: "omp-yolo-high", name: "Bypass (High)", modeLabel: "Bypass · High", permissionMode: "bypassPermissions" },
	],
	defaultConfigId: "omp-default",
};

const liveModels = [
	{ selector: "openai-codex/gpt-6.1-sol", provider: "openai-codex", id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
	{ selector: "openai-codex/gpt-5.6-luna", provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
];

function Harness({ initial, onChange, settingsSurface }: { initial: AgentConfigSelection; onChange?: (n: AgentConfigSelection) => void; settingsSurface?: boolean }) {
	const [sel, setSel] = useState(initial);
	return (
		<I18nProvider>
			<AgentConfigPicker
				idPrefix="test"
				agents={[ompAgent]}
				agentId={sel.agentId}
				configId={sel.configId}
				accountId="acct-1"
				onAccountChange={settingsSurface ? undefined : () => {}}
				onChange={(next) => {
					setSel(next);
					onChange?.(next);
				}}
			/>
		</I18nProvider>
	);
}

const model = () => document.getElementById("test-model") as HTMLButtonElement;
const mode = () => document.getElementById("test-mode") as HTMLButtonElement;
const text = (b: HTMLButtonElement) => b?.textContent?.trim() ?? "";

async function openOptions(user: ReturnType<typeof userEvent.setup>, button: HTMLButtonElement): Promise<HTMLButtonElement[]> {
	await user.click(button);
	const overlays = document.querySelectorAll(".bg-overlay.border");
	return Array.from(overlays[overlays.length - 1]?.querySelectorAll("button") ?? []);
}

beforeEach(() => getAgentLiveModels.mockReset());

describe("AgentConfigPicker — live models", () => {
	it("lists the account's models newest first, above the agent's own default", async () => {
		getAgentLiveModels.mockResolvedValue({ status: "resolved", models: liveModels });
		const user = userEvent.setup();
		render(<Harness initial={{ agentId: "builtin-omp", configId: "omp-default" }} />);
		await waitFor(() => expect(getAgentLiveModels).toHaveBeenCalledWith({ agentId: "builtin-omp", accountId: "acct-1" }));

		const labels = (await waitFor(async () => {
			const options = await openOptions(user, model());
			const found = options.map((b) => b.textContent?.trim() ?? "");
			expect(found).toContain("GPT-6.1 Sol");
			return found;
		})).filter((label) => label !== "");
		expect(labels.indexOf("GPT-6.1 Sol")).toBeLessThan(labels.indexOf("GPT-5.6 Luna"));
		expect(labels.indexOf("GPT-5.6 Luna")).toBeLessThan(labels.findIndex((label) => !label.startsWith("GPT")));
	});

	it("a pick keeps the current mode and stores the model in the configId", async () => {
		getAgentLiveModels.mockResolvedValue({ status: "resolved", models: liveModels });
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<Harness initial={{ agentId: "builtin-omp", configId: "omp-yolo-high" }} onChange={onChange} />);

		await waitFor(async () => {
			const option = (await openOptions(user, model())).find((b) => b.textContent?.trim() === "GPT-6.1 Sol");
			expect(option).toBeTruthy();
			await user.click(option as HTMLButtonElement);
		});
		expect(onChange).toHaveBeenLastCalledWith({ agentId: "builtin-omp", configId: "omp-yolo-high|model=openai-codex/gpt-6.1-sol" });
		expect(text(model())).toBe("GPT-6.1 Sol");
		expect(text(mode())).toBe("Bypass · High");
	});

	it("shows a stored live pick even when the account's list is unknown", () => {
		getAgentLiveModels.mockResolvedValue({ status: "unknown" });
		render(<Harness initial={{ agentId: "builtin-omp", configId: "omp-default|model=openai-codex/gpt-6-luna" }} />);
		expect(text(model())).toBe("gpt-6-luna");
		expect(text(mode())).toBe("Default");
	});

	it("drops back to the mode alone when the account does not serve the picked model", async () => {
		getAgentLiveModels.mockResolvedValue({ status: "resolved", models: [] });
		const onChange = vi.fn();
		render(<Harness initial={{ agentId: "builtin-omp", configId: "omp-yolo-high|model=openai-codex/gpt-6-luna" }} onChange={onChange} />);
		await waitFor(() => expect(onChange).toHaveBeenCalledWith({ agentId: "builtin-omp", configId: "omp-yolo-high" }));
		expect(text(mode())).toBe("Bypass · High");
	});

	it("starts a launch on the account's newest model, keeping the mode", async () => {
		getAgentLiveModels.mockResolvedValue({ status: "resolved", models: liveModels });
		const onChange = vi.fn();
		render(<Harness initial={{ agentId: "builtin-omp", configId: "omp-yolo" }} onChange={onChange} />);
		await waitFor(() => expect(onChange).toHaveBeenCalledWith({ agentId: "builtin-omp", configId: "omp-yolo|model=openai-codex/gpt-6.1-sol" }));
		expect(text(mode())).toBe("Bypass");
	});

	it("leaves a hand-picked agent default alone", async () => {
		getAgentLiveModels.mockResolvedValue({ status: "resolved", models: liveModels });
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<Harness initial={{ agentId: "builtin-omp", configId: "omp-yolo" }} onChange={onChange} />);
		await waitFor(() => expect(text(model())).toBe("GPT-6.1 Sol"));
		const own = (await openOptions(user, model())).find((b) => !(b.textContent ?? "").startsWith("GPT") && (b.textContent ?? "").trim() !== "" && !(b.textContent ?? "").includes("Connect"));
		await user.click(own as HTMLButtonElement);
		expect(onChange).toHaveBeenLastCalledWith({ agentId: "builtin-omp", configId: "omp-yolo" });
		await new Promise((r) => setTimeout(r, 50));
		expect(onChange).toHaveBeenLastCalledWith({ agentId: "builtin-omp", configId: "omp-yolo" });
	});

	it("never rewrites a preset on a Settings surface", async () => {
		getAgentLiveModels.mockResolvedValue({ status: "resolved", models: liveModels });
		const onChange = vi.fn();
		render(<Harness initial={{ agentId: "builtin-omp", configId: "omp-yolo" }} onChange={onChange} settingsSurface />);
		await waitFor(() => expect(getAgentLiveModels).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 50));
		expect(onChange).not.toHaveBeenCalled();
	});
});
