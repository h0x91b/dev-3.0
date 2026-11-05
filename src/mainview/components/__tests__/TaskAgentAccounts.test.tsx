import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { TaskAgentAccountsList } from "../TaskAgentAccounts";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import type { CodingAgent, Task } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getProjectClaudeLogin: vi.fn().mockResolvedValue({ configDir: null, identity: null }),
			getNativeTaskAgents: vi.fn(),
			listAgentAccounts: vi.fn().mockResolvedValue({
				claude: {
					accounts: [
						{ id: "a1", kind: "claude", label: "Work", identity: null, auth: "oauth", api: null, createdAt: 0 },
						{ id: "a2", kind: "claude", label: "Side", identity: null, auth: "oauth", api: null, createdAt: 0 },
					],
					activeId: null,
					systemConfigDir: "/home/me/.claude",
					systemIdentity: null,
				},
				codex: { accounts: [], activeId: null, currentIdentity: null },
				omp: { accounts: [], activeId: null },
				pi: { accounts: [], activeId: null },
			}),
		},
	},
}));

const agents = [{ id: "builtin-claude", name: "Claude Code", baseCommand: "claude", configurations: [] }] as CodingAgent[];

function renderList(task: Partial<Task>) {
	const full = { id: "t1", seq: 1, projectId: "p1", title: "T", description: "", createdAt: "2025-01-01T00:00:00Z", agentId: "builtin-claude", accountId: "a1", ...task } as Task;
	return render(<I18nProvider><TaskAgentAccountsList task={full} agents={agents} /></I18nProvider>);
}

describe("TaskAgentAccountsList — native extra agents", () => {
	beforeEach(() => {
		vi.mocked(api.request.getNativeTaskAgents).mockReset().mockResolvedValue([
			{ paneId: "p2", agentCmd: "claude", agentId: "builtin-claude", configId: null, accountId: "a2" },
		]);
	});

	it("shows the extra agent's account on a native task", async () => {
		renderList({ terminalBackend: "native" });
		expect(await screen.findByText("Side")).toBeTruthy();
		expect(screen.getByText("Work")).toBeTruthy();
		expect(api.request.getNativeTaskAgents).toHaveBeenCalledWith({ projectId: "p1", taskId: "t1" });
	});

	it("does not ask for native agents on a tmux task", async () => {
		renderList({});
		expect(await screen.findByText("Work")).toBeTruthy();
		expect(api.request.getNativeTaskAgents).not.toHaveBeenCalled();
	});
});
