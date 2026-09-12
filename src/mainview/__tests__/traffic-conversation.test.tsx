import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TaskConversationView } from "../../shared/task-conversation-model";
import { I18nProvider } from "../i18n";
import TrafficConversation from "../components/agent-traffic/TrafficConversation";

/**
 * The Conversation tab of the traffic inspector. The three things it must never
 * get wrong: an unreadable task says so instead of looking silent, an archived
 * copy is labelled as one, and a long history never claims to be the whole thing.
 */

const view: { value: TaskConversationView } = {
	value: { sessions: [], sessionKey: null, turns: [], totalTurns: 0, firstIndex: 0 },
};
const readTaskConversation = vi.fn(() => Promise.resolve(view.value));

vi.mock("../rpc", () => ({
	api: { request: { readTaskConversation: (...args: unknown[]) => readTaskConversation(...(args as [])) } },
}));

function session(overrides: Partial<TaskConversationView["sessions"][number]> = {}) {
	return {
		key: "claude:s1",
		source: "claude" as const,
		sessionId: "s1",
		model: null,
		startedAt: null,
		endedAt: null,
		turns: 2,
		origin: "live" as const,
		fidelity: "full" as const,
		...overrides,
	};
}

function show() {
	render(
		<I18nProvider>
			<TrafficConversation projectId="p1" taskId="t1" format={(iso) => iso} />
		</I18nProvider>,
	);
}

beforeEach(() => {
	readTaskConversation.mockClear();
	view.value = { sessions: [], sessionKey: null, turns: [], totalTurns: 0, firstIndex: 0 };
});

describe("TrafficConversation", () => {
	it("asks for a task before it asks the backend for anything", () => {
		render(
			<I18nProvider>
				<TrafficConversation projectId="p1" taskId={null} format={(iso) => iso} />
			</I18nProvider>,
		);
		expect(screen.getByText(/Pick a task/)).toBeInTheDocument();
		expect(readTaskConversation).not.toHaveBeenCalled();
	});

	it("says nothing is readable instead of showing an empty conversation", async () => {
		show();
		expect(await screen.findByText(/No readable conversation/)).toBeInTheDocument();
	});

	it("renders both speakers and the tool calls between them", async () => {
		view.value = {
			sessions: [session()],
			sessionKey: "claude:s1",
			totalTurns: 2,
			firstIndex: 0,
			turns: [
				{ index: 0, startedAt: null, userText: "fix the parser", assistantText: "fixed", clamped: false, actions: 3, tools: ["Bash", "Edit"] },
			],
		};
		show();
		expect(await screen.findByText("fix the parser")).toBeInTheDocument();
		expect(screen.getByText("fixed")).toBeInTheDocument();
		expect(screen.getByText(/3 tool calls · Bash, Edit/)).toBeInTheDocument();
	});

	it("labels an archived copy and does not call it live", async () => {
		view.value = {
			sessions: [session({ origin: "archived" })],
			sessionKey: "claude:s1",
			totalTurns: 1,
			firstIndex: 0,
			turns: [{ index: 0, startedAt: null, assistantText: "done", clamped: false, actions: 0, tools: [] }],
		};
		show();
		expect(await screen.findByText("Archived")).toBeInTheDocument();
		expect(screen.queryByText("Live")).not.toBeInTheDocument();
	});

	it("offers earlier turns only when earlier turns exist, and keeps what is on screen", async () => {
		view.value = {
			sessions: [session({ turns: 40 })],
			sessionKey: "claude:s1",
			totalTurns: 40,
			firstIndex: 20,
			turns: [{ index: 20, startedAt: null, userText: "later", clamped: false, actions: 0, tools: [] }],
		};
		show();
		const earlier = await screen.findByRole("button", { name: "Load earlier turns" });
		expect(screen.getByText("1 of 40 turns")).toBeInTheDocument();

		view.value = {
			sessions: [session({ turns: 40 })],
			sessionKey: "claude:s1",
			totalTurns: 40,
			firstIndex: 0,
			turns: [{ index: 0, startedAt: null, userText: "earliest", clamped: false, actions: 0, tools: [] }],
		};
		await userEvent.click(earlier);

		await waitFor(() => expect(screen.getByText("earliest")).toBeInTheDocument());
		expect(screen.getByText("later")).toBeInTheDocument();
		expect(readTaskConversation).toHaveBeenLastCalledWith(
			expect.objectContaining({ before: 20, sessionKey: "claude:s1" }),
		);
	});
});
