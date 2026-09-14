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
		lastActivityAt: null,
		bytes: 1024,
		origin: "live" as const,
		...overrides,
	};
}

function panel(taskId: string | null) {
	return (
		<I18nProvider>
			<TrafficConversation projectId="p1" taskId={taskId} format={(iso) => iso} />
		</I18nProvider>
	);
}

function show() {
	render(panel("t1"));
}

function oneTurn(text: string): TaskConversationView {
	return {
		sessions: [session()],
		sessionKey: "claude:s1",
		totalTurns: 1,
		firstIndex: 0,
		turns: [{ index: 0, startedAt: null, userText: text, clippedChars: 0, actions: 0, tools: [] }],
	};
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
				{ index: 0, startedAt: null, userText: "fix the parser", assistantText: "fixed", clippedChars: 0, actions: 3, tools: ["Bash", "Edit"] },
			],
		};
		show();
		expect(await screen.findByText("fix the parser")).toBeInTheDocument();
		expect(screen.getByText("fixed")).toBeInTheDocument();
		expect(screen.getByText(/3 tool calls · Bash, Edit/)).toBeInTheDocument();
	});

	it("folds a long message and opens it in place", async () => {
		const long = `${"paragraph text ".repeat(150)}\n\nTAIL PARAGRAPH`;
		view.value = {
			sessions: [session()],
			sessionKey: "claude:s1",
			totalTurns: 1,
			firstIndex: 0,
			turns: [{ index: 0, startedAt: null, userText: long, clippedChars: 0, actions: 0, tools: [] }],
		};
		show();
		const more = await screen.findByRole("button", { name: "Show more" });
		expect(screen.queryByText(/TAIL PARAGRAPH/)).not.toBeInTheDocument();

		await userEvent.click(more);
		expect(screen.getByText(/TAIL PARAGRAPH/)).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Show less" }));
		expect(screen.queryByText(/TAIL PARAGRAPH/)).not.toBeInTheDocument();
	});

	it("renders the message as Markdown, not as raw syntax", async () => {
		const body = [
			"**bold claim** and `inline code`",
			"",
			"- first item",
			"- second item",
			"",
			"```ts",
			"const x = 1;",
			"```",
			"",
			"[the docs](https://example.com/docs)",
		].join("\n");
		view.value = {
			sessions: [session()],
			sessionKey: "claude:s1",
			totalTurns: 1,
			firstIndex: 0,
			turns: [{ index: 0, startedAt: null, assistantText: body, clippedChars: 0, actions: 0, tools: [] }],
		};
		show();
		const bold = await screen.findByText("bold claim");
		expect(bold.tagName).toBe("STRONG");
		expect(screen.getByText("inline code").tagName).toBe("CODE");
		expect(screen.getAllByRole("listitem")).toHaveLength(2);
		expect(screen.getByRole("link", { name: "the docs" })).toHaveAttribute(
			"href",
			"https://example.com/docs",
		);
		// The fenced block keeps its own element rather than becoming prose.
		expect(document.querySelector(".traffic-turn-body pre")).not.toBeNull();
		// Raw markdown must not survive as text anywhere in the message.
		expect(screen.queryByText(/\*\*bold claim\*\*/)).not.toBeInTheDocument();
	});

	it("leaves a short message alone", async () => {
		view.value = {
			sessions: [session()],
			sessionKey: "claude:s1",
			totalTurns: 1,
			firstIndex: 0,
			turns: [{ index: 0, startedAt: null, userText: "short one", clippedChars: 0, actions: 0, tools: [] }],
		};
		show();
		expect(await screen.findByText("short one")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
	});

	it("says what the panel refused to carry at all, and promises nothing about where it is", async () => {
		view.value = {
			sessions: [session()],
			sessionKey: "claude:s1",
			totalTurns: 1,
			firstIndex: 0,
			turns: [{ index: 0, startedAt: null, userText: "huge…", clippedChars: 9784, actions: 0, tools: [] }],
		};
		show();
		expect(await screen.findByText(/Too long for this panel: 9784 more characters/)).toBeInTheDocument();
		expect(screen.queryByText(/open the task/i)).not.toBeInTheDocument();
	});

	it("labels an archived copy and does not call it live", async () => {
		view.value = {
			sessions: [session({ origin: "archived" })],
			sessionKey: "claude:s1",
			totalTurns: 1,
			firstIndex: 0,
			turns: [{ index: 0, startedAt: null, assistantText: "done", clippedChars: 0, actions: 0, tools: [] }],
		};
		show();
		expect(await screen.findByText("Archived")).toBeInTheDocument();
		expect(screen.queryByText("Live")).not.toBeInTheDocument();
	});

	it("offers earlier turns only when earlier turns exist, and keeps what is on screen", async () => {
		view.value = {
			sessions: [session()],
			sessionKey: "claude:s1",
			totalTurns: 40,
			firstIndex: 20,
			turns: [{ index: 20, startedAt: null, userText: "later", clippedChars: 0, actions: 0, tools: [] }],
		};
		show();
		const earlier = await screen.findByRole("button", { name: "Load earlier turns" });
		expect(screen.getByText("1 of 40 turns")).toBeInTheDocument();

		view.value = {
			sessions: [session()],
			sessionKey: "claude:s1",
			totalTurns: 40,
			firstIndex: 0,
			turns: [{ index: 0, startedAt: null, userText: "earliest", clippedChars: 0, actions: 0, tools: [] }],
		};
		await userEvent.click(earlier);

		await waitFor(() => expect(screen.getByText("earliest")).toBeInTheDocument());
		expect(screen.getByText("later")).toBeInTheDocument();
		expect(readTaskConversation).toHaveBeenLastCalledWith(
			expect.objectContaining({ before: 20, sessionKey: "claude:s1" }),
		);
	});

	it("fires one request when the user arrows through several nodes", async () => {
		const { rerender } = render(panel("t1"));
		rerender(panel("t2"));
		// Longer than a keypress, shorter than the debounce: a window that only
		// stays quiet because the request is actually delayed, not merely cancelled.
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(readTaskConversation).not.toHaveBeenCalled();
		rerender(panel("t3"));

		await waitFor(() => expect(readTaskConversation).toHaveBeenCalledTimes(1));
		expect(readTaskConversation).toHaveBeenCalledWith(expect.objectContaining({ taskId: "t3" }));
	});

	it("drops a late page of earlier turns when the user has moved to another task", async () => {
		view.value = {
			sessions: [session()],
			sessionKey: "claude:s1",
			totalTurns: 40,
			firstIndex: 20,
			turns: [{ index: 20, startedAt: null, userText: "page of t1", clippedChars: 0, actions: 0, tools: [] }],
		};
		const { rerender } = render(panel("t1"));
		const earlier = await screen.findByRole("button", { name: "Load earlier turns" });

		let land: (view: TaskConversationView) => void = () => {};
		readTaskConversation.mockImplementationOnce(
			() => new Promise<TaskConversationView>((resolve) => { land = resolve; }),
		);
		await userEvent.click(earlier);

		view.value = oneTurn("task two");
		rerender(panel("t2"));
		// The new task's own answer lands FIRST, so the late one has something to
		// corrupt: without the guard it merges into the task now on screen.
		await waitFor(() => expect(screen.getByText("task two")).toBeInTheDocument());
		land(oneTurn("earlier turns of t1"));

		await waitFor(() => expect(screen.getByText("task two")).toBeInTheDocument());
		expect(screen.queryByText("earlier turns of t1")).not.toBeInTheDocument();
	});

	it("drops a response for a task the user has already left", async () => {
		let land: (view: TaskConversationView) => void = () => {};
		readTaskConversation.mockImplementationOnce(
			() => new Promise<TaskConversationView>((resolve) => { land = resolve; }),
		);

		const { rerender } = render(panel("t1"));
		await waitFor(() => expect(readTaskConversation).toHaveBeenCalledTimes(1));

		view.value = oneTurn("second task");
		rerender(panel("t2"));
		await waitFor(() => expect(screen.getByText("second task")).toBeInTheDocument());
		land(oneTurn("first task"));

		await waitFor(() => expect(screen.getByText("second task")).toBeInTheDocument());
		expect(screen.queryByText("first task")).not.toBeInTheDocument();
	});
});
