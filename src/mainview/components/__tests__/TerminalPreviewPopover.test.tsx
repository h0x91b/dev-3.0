import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import TerminalPreviewPopover from "../TerminalPreviewPopover";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getNativeTaskAgents: vi.fn().mockResolvedValue([]),
			listAgentAccounts: vi.fn().mockResolvedValue({
				claude: {
					accounts: [{ id: "a1", kind: "claude", label: "Work", identity: { email: "work@example.com" }, auth: "oauth", api: null, createdAt: 0 }],
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

const baseState = {
	open: true,
	html: null,
	loading: false,
	pos: { top: 0, left: 0 },
	activeTaskId: "t1",
	cancelClose: vi.fn(),
	scheduleClose: vi.fn(),
};

function renderPopover(props: Record<string, unknown>) {
	return render(
		<I18nProvider>
			<TerminalPreviewPopover {...baseState} {...props} />
		</I18nProvider>,
	);
}

describe("TerminalPreviewPopover — attention banner", () => {
	it("renders the attention reason banner when a reason is set", () => {
		renderPopover({ taskId: "t1", projectId: "p1", attentionReasons: ["PR is ready for review"] });
		expect(screen.getByText("PR is ready for review")).toBeTruthy();
	});

	it("renders all accumulated reasons", () => {
		renderPopover({ taskId: "t1", projectId: "p1", attentionReasons: ["one", "two", "three"] });
		expect(screen.getByText("one")).toBeTruthy();
		expect(screen.getByText("two")).toBeTruthy();
		expect(screen.getByText("three")).toBeTruthy();
	});

	it("does not render the banner when there are no reasons", () => {
		renderPopover({ taskId: "t1", projectId: "p1", overview: "some overview" });
		expect(screen.queryByText("PR is ready for review")).toBeNull();
	});

	it("ignores empty/whitespace-only reasons", () => {
		renderPopover({ taskId: "t1", projectId: "p1", attentionReasons: ["   ", ""] });
		// Banner suppressed → the overview-empty fallback isn't shown as a reason.
		expect(screen.queryByText("Attention")).toBeNull();
	});

	it("shows the banner even when there is no overview to display", () => {
		renderPopover({ taskId: "t1", projectId: "p1", attentionReasons: ["needs your input"] });
		expect(screen.getByText("needs your input")).toBeTruthy();
	});
});

describe("TerminalPreviewPopover — agent accounts", () => {
	const claudeAgent = { id: "builtin-claude", name: "Claude Code", baseCommand: "claude", configurations: [] };
	const taskWith = (accountId: string | null, extra: Record<string, unknown> = {}) => ({
		id: "t1",
		agentId: "builtin-claude",
		accountId,
		sessionState: { panes: [{ agentCmd: "claude", agentId: "builtin-claude", configId: null, sessionId: null }] },
		...extra,
	});

	it("lists the account of each agent, with label and email marked private", async () => {
		renderPopover({ taskId: "t1", projectId: "p1", task: taskWith("a1"), agents: [claudeAgent] });
		const label = await screen.findByText("Work");
		const email = screen.getByText("work@example.com");
		expect(label.className).toContain("streamer-private");
		expect(email.className).toContain("streamer-private");
		expect(screen.getByText("Agents")).toBeTruthy();
		expect(screen.getAllByTestId("task-agent-account-row")).toHaveLength(1);
	});

	it("shows a deleted account without crashing", async () => {
		renderPopover({ taskId: "t1", projectId: "p1", task: taskWith("gone"), agents: [claudeAgent] });
		await waitFor(() => expect(screen.getByText("Deleted account")).toBeTruthy());
	});

	it("is visible with only the agents block", async () => {
		renderPopover({ taskId: "t1", projectId: "p1", task: taskWith("a1"), agents: [claudeAgent] });
		const block = (await screen.findByTestId("task-agent-accounts")).parentElement!;
		expect((block.parentElement as HTMLElement).style.opacity).toBe("1");
	});

	it("draws the agents block border only when terminal content follows", async () => {
		const first = renderPopover({ taskId: "t1", projectId: "p1", task: taskWith("a1"), agents: [claudeAgent] });
		const bare = (await screen.findByTestId("task-agent-accounts")).parentElement!;
		expect(bare.className).not.toContain("border-b");
		first.unmount();
		renderPopover({ taskId: "t1", projectId: "p1", html: "<pre>out</pre>", task: taskWith("a1"), agents: [claudeAgent] });
		const withPreview = (await screen.findByTestId("task-agent-accounts")).parentElement!;
		expect(withPreview.className).toContain("border-b");
	});

	it("renders the Auto tag when the router picked the account", async () => {
		const pick = { reason: { code: "only", short: null }, at: "x" };
		renderPopover({ taskId: "t1", projectId: "p1", task: taskWith("a1", { accountPick: pick }), agents: [claudeAgent] });
		expect(await screen.findByText("Auto")).toBeTruthy();
	});

	it("renders no agents block when the task has no agent", () => {
		renderPopover({ taskId: "t1", projectId: "p1", task: { id: "t1", agentId: null }, agents: [claudeAgent] });
		expect(screen.queryByTestId("task-agent-accounts")).toBeNull();
		expect(screen.queryByText("Agents")).toBeNull();
	});

	describe("native task whose saved panes are all parked", () => {
		const parkedNative = (extra: Record<string, unknown> = {}) => taskWith("a1", {
			terminalBackend: "native",
			sessionState: { panes: [{ agentCmd: "claude", agentId: "builtin-claude", configId: null, sessionId: null, parked: true }] },
			...extra,
		});

		it("shows the section with the running extra agent", async () => {
			vi.mocked(api.request.getNativeTaskAgents).mockResolvedValueOnce([
				{ paneId: "p2", agentCmd: "claude", agentId: "builtin-claude", configId: null, accountId: "a1" },
			]);
			renderPopover({ taskId: "t1", projectId: "p1", task: parkedNative(), agents: [claudeAgent] });
			expect(await screen.findByText("Work")).toBeTruthy();
			expect(screen.getByText("Agents")).toBeTruthy();
			expect(screen.getAllByTestId("task-agent-account-row")).toHaveLength(1);
		});

		it("shows no section when there is no extra agent", async () => {
			renderPopover({ taskId: "t1", projectId: "p1", task: parkedNative(), agents: [claudeAgent] });
			await waitFor(() => expect(api.request.getNativeTaskAgents).toHaveBeenCalled());
			expect(screen.queryByText("Agents")).toBeNull();
		});
	});

	it("neither mounts the list nor asks for native agents on a tmux task without agents", () => {
		vi.mocked(api.request.getNativeTaskAgents).mockClear();
		renderPopover({ taskId: "t1", projectId: "p1", task: { id: "t1", agentId: null }, agents: [claudeAgent] });
		expect(api.request.getNativeTaskAgents).not.toHaveBeenCalled();
	});
});
