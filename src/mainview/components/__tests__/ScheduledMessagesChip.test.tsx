import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ScheduledMessagesChip from "../ScheduledMessagesChip";
import { I18nProvider } from "../../i18n";
import type { Project, Task } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			cancelScheduledMessage: vi.fn().mockResolvedValue({ id: "t1", scheduledMessages: [] }),
			sendScheduledMessageNow: vi.fn().mockResolvedValue({ id: "t1", scheduledMessages: [] }),
		},
	},
}));

import { api } from "../../rpc";

const mockedApi = api as unknown as {
	request: {
		cancelScheduledMessage: ReturnType<typeof vi.fn>;
		sendScheduledMessageNow: ReturnType<typeof vi.fn>;
	};
};

const project = { id: "p1" } as unknown as Project;

function makeTask(scheduledMessages: Task["scheduledMessages"]): Task {
	return { id: "t1", scheduledMessages } as unknown as Task;
}

function renderChip(task: Task, dispatch = vi.fn()) {
	return render(
		<I18nProvider>
			<ScheduledMessagesChip task={task} project={project} dispatch={dispatch} />
		</I18nProvider>,
	);
}

describe("ScheduledMessagesChip", () => {
	beforeEach(() => vi.clearAllMocks());

	it("renders nothing when the queue is empty", () => {
		const { container } = renderChip(makeTask([]));
		expect(container.firstChild).toBeNull();
	});

	it("renders nothing when scheduledMessages is undefined", () => {
		const { container } = renderChip(makeTask(undefined));
		expect(container.firstChild).toBeNull();
	});

	it("shows a per-message count badge when more than one is queued", () => {
		renderChip(makeTask([
			{ id: "m1", text: "first", at: new Date(Date.now() + 600_000).toISOString(), target: { kind: "agent" } },
			{ id: "m2", text: "second", at: new Date(Date.now() + 1_200_000).toISOString(), target: { kind: "agent" } },
		]));
		expect(screen.getByText("·2")).toBeTruthy();
	});

	it("opens the popover and cancels the soonest message", async () => {
		const dispatch = vi.fn();
		renderChip(makeTask([
			{ id: "m1", text: "continue", at: new Date(Date.now() + 600_000).toISOString(), target: { kind: "agent" } },
		]), dispatch);
		await userEvent.click(screen.getByTestId("task-card-scheduled-message-badge"));
		await userEvent.click(screen.getByText("Cancel"));
		expect(mockedApi.request.cancelScheduledMessage).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1", messageId: "m1" });
	});

	it("leads with the subject and keeps the body on hover", async () => {
		renderChip(makeTask([
			{
				id: "m1",
				text: "a very long agent body nobody reads in a popover",
				subject: "PR 1577 merged, main green",
				at: new Date(Date.now() + 600_000).toISOString(),
				target: { kind: "agent" },
			},
		]));
		await userEvent.click(screen.getByTestId("task-card-scheduled-message-badge"));
		const line = screen.getByText("PR 1577 merged, main green");
		expect(line.getAttribute("title")).toBe("a very long agent body nobody reads in a popover");
		expect(screen.queryByText("a very long agent body nobody reads in a popover")).toBeNull();
	});

	it("falls back to the body when nothing carried a subject", async () => {
		renderChip(makeTask([
			{ id: "m1", text: "continue", at: new Date(Date.now() + 600_000).toISOString(), target: { kind: "agent" } },
		]));
		await userEvent.click(screen.getByTestId("task-card-scheduled-message-badge"));
		expect(screen.getByText("continue")).toBeTruthy();
	});

	it("sends the soonest message immediately from the popover", async () => {
		renderChip(makeTask([
			{ id: "m1", text: "continue", at: new Date(Date.now() + 600_000).toISOString(), target: { kind: "agent" } },
		]));
		await userEvent.click(screen.getByTestId("task-card-scheduled-message-badge"));
		await userEvent.click(screen.getByText("Send now"));
		expect(mockedApi.request.sendScheduledMessageNow).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1", messageId: "m1" });
	});
});
