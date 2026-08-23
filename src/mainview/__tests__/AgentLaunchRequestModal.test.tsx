import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import type { AgentLaunchRequest, CodingAgent, GlobalSettings } from "../../shared/types";
import { I18nProvider } from "../i18n";

// Only the fields the modal's default-resolution reads; the picker is stubbed.
const AGENTS = [
	{
		id: "builtin-claude",
		name: "Claude",
		command: "claude",
		defaultConfigId: "claude-auto",
		configurations: [
			{ id: "claude-auto", name: "Opus · auto", model: "claude-opus-4-8", permissionMode: "auto" },
			{ id: "claude-plan", name: "Opus · plan", model: "claude-opus-4-8", permissionMode: "plan" },
		],
	},
] as unknown as CodingAgent[];

const SETTINGS = { defaultAgentId: "builtin-claude", defaultConfigId: "claude-auto", favorites: [] } as unknown as GlobalSettings;

vi.mock("../rpc", () => ({
	api: {
		request: {
			getAgents: vi.fn(() => Promise.resolve(AGENTS)),
			getGlobalSettings: vi.fn(() => Promise.resolve(SETTINGS)),
			checkAgentAvailability: vi.fn(() => Promise.resolve([
				{ agentId: "builtin-claude", installed: true },
			])),
			updateGlobalSettings: vi.fn(() => Promise.resolve(SETTINGS)),
			// Reached by the picker's account pill; a missing method throws
			// synchronously inside its effect and tears the whole tree down.
			listAgentAccounts: vi.fn(() => Promise.resolve({ agents: [] })),
			getAgentRateLimits: vi.fn(() => Promise.resolve(null)),
			updateAgentLaunchChoice: vi.fn(() => Promise.resolve(undefined)),
		},
	},
}));

// The Provider→Model→Mode cascade is a shared launch-surface component with its
// own coverage; stub it so these tests assert the dialog's contract (who asked,
// which task, what the answer carries) instead of re-testing the picker.
vi.mock("../components/AgentConfigPicker", () => ({
	default: () => <div data-testid="agent-config-picker" />,
}));

import AgentLaunchRequestModal from "../components/AgentLaunchRequestModal";
import { api } from "../rpc";

function makeRequest(overrides?: Partial<AgentLaunchRequest>): AgentLaunchRequest {
	return {
		requestId: "req-1",
		taskId: "task-1",
		projectId: "proj-1",
		taskTitle: "Fix the parser",
		targetStatus: "in-progress",
		scratch: false,
		requesterSeq: 3,
		requesterTitle: "Asking task",
		defaultPriority: "P2",
		autoApproveAt: null,
		subject: {
			seqLabel: "7",
			projectName: "dev-3.0",
			priority: "P2",
			labels: [],
			overview: "Parser drops trailing commas",
		},
		...overrides,
	};
}

function renderModal(request = makeRequest()) {
	const onRespond = vi.fn();
	render(
		<I18nProvider>
			<AgentLaunchRequestModal request={request} onRespond={onRespond} />
		</I18nProvider>,
	);
	return { onRespond };
}

describe("AgentLaunchRequestModal", () => {
	it("names the asking task and the task to be launched", async () => {
		renderModal();

		expect(await screen.findByText(/Asked by task #3/)).toBeInTheDocument();
		expect(screen.getByText("Fix the parser")).toBeInTheDocument();
		expect(screen.getByText("Parser drops trailing commas")).toBeInTheDocument();
		// Identity row: which board this task lives on.
		expect(screen.getByText("#7")).toBeInTheDocument();
		expect(screen.getByText("dev-3.0")).toBeInTheDocument();
	});

	it("marks the dialog as an AI-agent request", async () => {
		renderModal();
		expect(await screen.findByText(/AI agent request/i)).toBeInTheDocument();
	});

	it("autofocuses Decline so muscle memory cannot rubber-stamp the launch", async () => {
		renderModal();
		await waitFor(() => expect(screen.getByRole("button", { name: "Decline" })).toHaveFocus());
	});

	it("answers with the picked agent and config on Launch", async () => {
		const user = userEvent.setup();
		const { onRespond } = renderModal();

		const launch = await screen.findByTestId("agent-launch-accept");
		await waitFor(() => expect(launch).toBeEnabled());
		await user.click(launch);

		expect(onRespond).toHaveBeenCalledWith(true, {
			agentId: "builtin-claude",
			configId: "claude-auto",
			accountId: undefined,
			priority: "P2",
		});
	});

	it("answers with a refusal on Decline, carrying no launch choice", async () => {
		const user = userEvent.setup();
		const { onRespond } = renderModal();

		await user.click(await screen.findByRole("button", { name: "Decline" }));

		expect(onRespond).toHaveBeenCalledWith(false);
	});

	it("seeds the priority picker with the priority the launch would use", async () => {
		// The requester's band when the target never had one of its own (#1496).
		renderModal(makeRequest({ defaultPriority: "P0", subject: { ...makeRequest().subject, priority: "P3" } }));

		expect(await screen.findByRole("button", { name: /^Priority P0/ })).toBeInTheDocument();
	});

	it("launches with the priority the user picked instead of the default", async () => {
		const user = userEvent.setup();
		const { onRespond } = renderModal(makeRequest({ defaultPriority: "P3" }));

		await user.click(await screen.findByRole("button", { name: /^Priority P3/ }));
		await user.click(await screen.findByRole("menuitemradio", { name: /P1/ }));

		expect(api.request.updateAgentLaunchChoice).not.toHaveBeenCalled(); // no auto-approve deadline

		const launch = await screen.findByTestId("agent-launch-accept");
		await waitFor(() => expect(launch).toBeEnabled());
		await user.click(launch);

		expect(onRespond).toHaveBeenCalledWith(true, expect.objectContaining({ priority: "P1" }));
	});

	it("mirrors a priority change to the pending request so an auto-approval uses it", async () => {
		const user = userEvent.setup();
		renderModal(makeRequest({ defaultPriority: "P3", autoApproveAt: Date.now() + 5 * 60_000 }));

		await user.click(await screen.findByRole("button", { name: /^Priority P3/ }));
		await user.click(await screen.findByRole("menuitemradio", { name: /P0/ }));

		expect(api.request.updateAgentLaunchChoice).toHaveBeenCalledWith({
			requestId: "req-1",
			launch: expect.objectContaining({ priority: "P0" }),
		});
	});

	it("closes the priority picker on Escape without declining the launch", async () => {
		// The dialog's own Esc handler mounts first; only the overlay-layer stack
		// keeps it from throwing away the whole request (utils/overlay-layers.ts).
		const user = userEvent.setup();
		const { onRespond } = renderModal();

		await user.click(await screen.findByRole("button", { name: /^Priority P2/ }));
		await screen.findByRole("menu");
		await user.keyboard("{Escape}");

		expect(screen.queryByRole("menu")).toBeNull();
		expect(onRespond).not.toHaveBeenCalled();
	});

	it("says a scratch task starts with no prompt", async () => {
		renderModal(makeRequest({ scratch: true, taskTitle: "Scratch — 14:32" }));

		expect(await screen.findByText(/Agent wants a scratch task/)).toBeInTheDocument();
		expect(screen.getByText(/Starts with no prompt/)).toBeInTheDocument();
	});
});

describe("AgentLaunchRequestModal — auto-approve countdown", () => {
	it("says when the launch will happen on its own", async () => {
		renderModal(makeRequest({ autoApproveAt: Date.now() + 5 * 60_000 }));

		const countdown = await screen.findByTestId("agent-launch-countdown");
		// Rendered from the deadline, so a backgrounded window cannot drift.
		expect(countdown).toHaveTextContent(/Starts on its own in 5:00|Starts on its own in 4:59/);
	});

	it("shows nothing when auto-approval is off", async () => {
		renderModal(makeRequest({ autoApproveAt: null }));

		await screen.findByText(/Asked by task #3/);
		expect(screen.queryByTestId("agent-launch-countdown")).toBeNull();
	});
});
