import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

const remembered = vi.hoisted(() => ({ value: null as { profile: string | null } | null }));

vi.mock("../../rpc", () => ({
	api: {
		request: {
			listAgentAccounts: vi.fn().mockResolvedValue({
				claude: { accounts: [], activeId: null, systemConfigDir: "/home/me/.claude", systemIdentity: null },
				codex: { accounts: [], activeId: null, currentIdentity: null },
			}),
			setActiveAgentAccount: vi.fn(),
			modelCatalogGet: vi.fn().mockResolvedValue({ providers: [], models: [] }),
			getRememberedBedrockProfile: vi.fn(async () => remembered.value),
			getProjectClaudeLogin: vi.fn().mockResolvedValue({ configDir: null }),
		},
	},
}));

import AgentConfigPicker from "../AgentConfigPicker";
import { I18nProvider } from "../../i18n";
import type { CodingAgent } from "../../../shared/types";

const configurations = [{ id: "auto", name: "Auto (Opus 5)", model: "claude-opus-5", permissionMode: "auto" as const }];
const bedrockAgent: CodingAgent = {
	id: "claude-bedrock",
	name: "Claude · Bedrock",
	baseCommand: "claude",
	configurations,
	defaultConfigId: "auto",
	llmProvider: "bedrock",
	providerConfig: {
		bedrock: {
			profiles: [
				{ name: "og", awsProfile: "og-aws-claude-code", region: "us-west-2" },
				{ name: "sandbox", awsProfile: "sandbox-aws-claude-code" },
			],
			defaultProfile: "sandbox",
		},
	},
};
const nativeAgent: CodingAgent = { id: "builtin-claude", name: "Claude", baseCommand: "claude", configurations, defaultConfigId: "auto" };

function Harness({ agentId, initial, onPick, inherit }: { agentId: string; initial?: string | null; onPick: (p: string | null | undefined) => void; inherit?: boolean }) {
	const [profile, setProfile] = useState<string | null | undefined>(initial);
	const [agent, setAgent] = useState(agentId);
	return (
		<I18nProvider>
			<AgentConfigPicker
				idPrefix="t"
				projectId="p1"
				agents={[bedrockAgent, nativeAgent]}
				agentId={agent}
				configId="auto"
				onChange={(next) => setAgent(next.agentId ?? agent)}
				bedrockProfile={profile}
				onBedrockProfileChange={(next) => {
					setProfile(next);
					onPick(next);
				}}
				bedrockProfileInheritLabel={inherit ? "Same as the task" : undefined}
			/>
		</I18nProvider>
	);
}

const awsSelect = () => document.getElementById("t-aws-profile") as HTMLButtonElement | null;

beforeEach(() => {
	remembered.value = null;
});

describe("AgentConfigPicker — AWS profile", () => {
	it("is absent for an agent on the native backend", async () => {
		const onPick = vi.fn();
		render(<Harness agentId="builtin-claude" onPick={onPick} />);
		await screen.findByText("Claude");
		expect(awsSelect()).toBeNull();
		expect(onPick).not.toHaveBeenCalled();
	});

	it("seeds the project's remembered pick", async () => {
		remembered.value = { profile: "og" };
		const onPick = vi.fn();
		render(<Harness agentId="claude-bedrock" onPick={onPick} />);
		await waitFor(() => expect(onPick).toHaveBeenLastCalledWith("og"));
		expect(awsSelect()?.textContent).toContain("og-aws-claude-code");
	});

	it("seeds a remembered None as None, not the default", async () => {
		remembered.value = { profile: null };
		const onPick = vi.fn();
		render(<Harness agentId="claude-bedrock" onPick={onPick} />);
		await waitFor(() => expect(onPick).toHaveBeenLastCalledWith(null));
	});

	it("falls back to the agent default when the remembered profile was removed", async () => {
		remembered.value = { profile: "gone" };
		const onPick = vi.fn();
		render(<Harness agentId="claude-bedrock" onPick={onPick} />);
		await waitFor(() => expect(onPick).toHaveBeenLastCalledWith("sandbox"));
	});

	it("keeps a valid pick the parent seeded (retry re-runs on the same account)", async () => {
		remembered.value = { profile: "sandbox" };
		const onPick = vi.fn();
		render(<Harness agentId="claude-bedrock" initial="og" onPick={onPick} />);
		await screen.findByText(/og-aws-claude-code/);
		expect(onPick).not.toHaveBeenCalled();
	});

	it("lets the user pick None", async () => {
		const onPick = vi.fn();
		render(<Harness agentId="claude-bedrock" initial="og" onPick={onPick} />);
		await userEvent.click(awsSelect()!);
		await userEvent.click(await screen.findByText("None (project env)"));
		expect(onPick).toHaveBeenLastCalledWith(null);
	});

	it("with an inherit row, an unset pick stays unset", async () => {
		remembered.value = { profile: "og" };
		const onPick = vi.fn();
		render(<Harness agentId="claude-bedrock" onPick={onPick} inherit />);
		await screen.findByText("Same as the task");
		expect(onPick).not.toHaveBeenCalled();
	});
});
