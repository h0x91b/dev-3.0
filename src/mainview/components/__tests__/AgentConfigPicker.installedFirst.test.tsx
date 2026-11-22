import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			listAgentAccounts: vi.fn().mockResolvedValue({
				claude: { accounts: [], activeId: null, systemConfigDir: "/home/me/.claude", systemIdentity: null },
				codex: { accounts: [], activeId: null, currentIdentity: null },
			}),
			setActiveAgentAccount: vi.fn(),
			modelCatalogGet: vi.fn().mockResolvedValue({ providers: [], models: [] }),
		},
	},
}));

import AgentConfigPicker from "../AgentConfigPicker";
import { I18nProvider } from "../../i18n";
import type { CodingAgent } from "../../../shared/types";

const agent = (id: string, name: string): CodingAgent => ({
	id,
	name,
	baseCommand: id,
	isDefault: true,
	configurations: [{ id: `${id}-c`, name: "Default", model: "m" }],
	defaultConfigId: `${id}-c`,
});

const agents = [agent("a-claude", "Claude"), agent("a-codex", "Codex"), agent("a-agy", "Antigravity"), agent("a-pi", "Pi")];
const availability = [
	{ agentId: "a-claude", installed: true },
	{ agentId: "a-codex", installed: false },
	{ agentId: "a-agy", installed: true },
	{ agentId: "a-pi", installed: false },
] as never;

async function providerOrder(installedFirst: boolean): Promise<string[]> {
	const user = userEvent.setup();
	render(
		<I18nProvider>
			<AgentConfigPicker
				idPrefix="t"
				agents={agents}
				agentId="a-claude"
				configId="a-claude-c"
				onChange={() => {}}
				agentAvailability={availability}
				installedFirst={installedFirst}
			/>
		</I18nProvider>,
	);
	await user.click(document.getElementById("t-harness") as HTMLButtonElement);
	const overlays = document.querySelectorAll(".bg-overlay.border");
	const dropdown = overlays[overlays.length - 1]!;
	return Array.from(dropdown.querySelectorAll("button")).map((b) => (b.textContent ?? "").replace(/Not installed.*/i, "").trim());
}

describe("AgentConfigPicker provider order", () => {
	it("lists installed agents above the missing ones, each group in its own order, on a launch surface", async () => {
		expect(await providerOrder(true)).toEqual(["Claude", "Antigravity", "Codex", "Pi"]);
	});

	it("keeps the configured order when it is not a launch surface", async () => {
		expect(await providerOrder(false)).toEqual(["Claude", "Codex", "Antigravity", "Pi"]);
	});
});
