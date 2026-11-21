import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HeldMessagesChip from "../HeldMessagesChip";
import { I18nProvider } from "../../i18n";
import { _resetHeldAgentMessageCounts } from "../../held-agent-messages";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getHeldAgentMessageCounts: vi.fn().mockResolvedValue({ t1: 2 }),
			sendHeldAgentMessagesNow: vi.fn().mockResolvedValue({ released: 2 }),
		},
	},
}));

import { api } from "../../rpc";

const mockedApi = api as unknown as {
	request: { getHeldAgentMessageCounts: ReturnType<typeof vi.fn>; sendHeldAgentMessagesNow: ReturnType<typeof vi.fn> };
};

function push(taskId: string, count: number) {
	act(() => {
		window.dispatchEvent(new CustomEvent("rpc:heldAgentMessages", { detail: { taskId, count } }));
	});
}

function renderChip(taskId = "t1") {
	return render(
		<I18nProvider>
			<HeldMessagesChip taskId={taskId} />
		</I18nProvider>,
	);
}

describe("HeldMessagesChip", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_resetHeldAgentMessageCounts();
	});

	it("shows the count a view that just opened reads from the app", async () => {
		renderChip();
		expect(await screen.findByTestId("task-held-messages-chip")).toHaveTextContent("2 waiting");
	});

	it("follows the push, and disappears once the messages are delivered", async () => {
		mockedApi.request.getHeldAgentMessageCounts.mockResolvedValueOnce({});
		renderChip();
		await act(async () => {});
		expect(screen.queryByTestId("task-held-messages-chip")).toBeNull();
		push("t1", 1);
		expect(screen.getByTestId("task-held-messages-chip")).toHaveTextContent("1 waiting");
		push("other", 5);
		expect(screen.getByTestId("task-held-messages-chip")).toHaveTextContent("1 waiting");
		push("t1", 0);
		expect(screen.queryByTestId("task-held-messages-chip")).toBeNull();
	});

	it("sends the task's waiting messages from its popover", async () => {
		renderChip();
		await userEvent.click(await screen.findByTestId("task-held-messages-chip"));
		await userEvent.click(screen.getByTestId("task-held-messages-send-now"));
		expect(mockedApi.request.sendHeldAgentMessagesNow).toHaveBeenCalledWith({ taskId: "t1" });
		expect(screen.queryByTestId("task-held-messages-send-now")).toBeNull();
	});

	it("closes its popover on Escape without the app's Escape shortcut also navigating", async () => {
		const appShortcut = vi.fn();
		window.addEventListener("keydown", appShortcut);
		try {
			renderChip();
			await userEvent.click(await screen.findByTestId("task-held-messages-chip"));
			await userEvent.keyboard("{Escape}");
			expect(screen.queryByTestId("task-held-messages-send-now")).toBeNull();
			expect(appShortcut).not.toHaveBeenCalled();
		} finally {
			window.removeEventListener("keydown", appShortcut);
		}
	});

	it("drops a count the app no longer holds when Send now releases nothing", async () => {
		mockedApi.request.sendHeldAgentMessagesNow.mockResolvedValueOnce({ released: 0 });
		renderChip();
		await userEvent.click(await screen.findByTestId("task-held-messages-chip"));
		await userEvent.click(screen.getByTestId("task-held-messages-send-now"));
		expect(screen.queryByTestId("task-held-messages-chip")).toBeNull();
	});
});
