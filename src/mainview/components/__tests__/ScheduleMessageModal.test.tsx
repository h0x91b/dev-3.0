import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ScheduleMessageModal from "../ScheduleMessageModal";
import { I18nProvider } from "../../i18n";
import type { Project, Task } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			scheduleMessage: vi.fn().mockResolvedValue({ id: "t1", scheduledMessages: [] }),
			saveMessageDraft: vi.fn().mockResolvedValue({ id: "t1" }),
			sendMessageDraft: vi.fn().mockResolvedValue({ id: "t1" }),
			tmuxLayout: vi.fn().mockResolvedValue({ sessionName: "dev3-t1", exists: true, windows: [], panes: [] }),
			uploadFileBase64: vi.fn(),
			readImageBase64: vi.fn().mockResolvedValue(null),
		},
	},
}));

import { api } from "../../rpc";
const mockedApi = vi.mocked(api, true);

const task = {
	id: "task-abcdef12",
	projectId: "proj-1",
	seq: 7,
	title: "Do the thing",
	status: "in-progress",
	worktreePath: "/tmp/wt",
} as unknown as Task;

const project = { id: "proj-1", name: "Proj" } as unknown as Project;

function renderModal(initialText?: string, taskOverride: Partial<Task> = {}) {
	const dispatch = vi.fn();
	const onClose = vi.fn();
	const view = render(
		<I18nProvider>
			<ScheduleMessageModal task={{ ...task, ...taskOverride }} project={project} dispatch={dispatch} onClose={onClose} initialText={initialText} />
		</I18nProvider>,
	);
	return { dispatch, onClose, unmount: view.unmount };
}

/** The timed "Send later" path sits behind the In… mode now. */
async function pickLater() {
	await userEvent.click(screen.getByRole("button", { name: "In…" }));
}

function makeFileList(files: File[]): FileList {
	return {
		length: files.length,
		item: (index: number) => files[index] ?? null,
		...Object.fromEntries(files.map((file, index) => [index, file])),
	} as unknown as FileList;
}

function dispatchDrop(target: Element, files: File[]) {
	const event = new MouseEvent("drop", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "dataTransfer", {
		value: { files: makeFileList(files), dropEffect: "copy" as const },
	});
	act(() => target.dispatchEvent(event));
}

afterEach(() => {
	cleanup();
	vi.mocked(api.request.tmuxLayout).mockResolvedValue({ sessionName: "dev3-t1", exists: true, windows: [], panes: [] } as never);
	vi.clearAllMocks();
});

describe("ScheduleMessageModal", () => {
	it("disables submit until there is text", async () => {
		renderModal();
		await pickLater();
		const submit = screen.getByRole("button", { name: /schedule/i });
		expect(submit).toBeDisabled();
		await userEvent.type(screen.getByTestId("schedule-message-input"), "check CI");
		expect(submit).not.toBeDisabled();
	});

	it("schedules with the resolved ISO time and the agent target by default", async () => {
		mockedApi.request.scheduleMessage.mockResolvedValue({ id: task.id, scheduledMessages: [] } as never);
		renderModal();
		await pickLater();
		await userEvent.type(screen.getByTestId("schedule-message-input"), "continue when green");
		await userEvent.click(screen.getByRole("button", { name: /schedule/i }));
		await waitFor(() => expect(mockedApi.request.scheduleMessage).toHaveBeenCalled());
		const call = mockedApi.request.scheduleMessage.mock.calls[0]![0];
		expect(call.taskId).toBe(task.id);
		expect(call.projectId).toBe(project.id);
		expect(call.text).toBe("continue when green");
		expect(call.target).toEqual({ kind: "agent" });
		expect(new Date(call.at).getTime()).toBeGreaterThan(Date.now());
	});

	it("seeds the textarea from initialText (composer draft)", () => {
		renderModal("draft from composer");
		expect((screen.getByTestId("schedule-message-input") as HTMLTextAreaElement).value).toBe("draft from composer");
	});

	it("keeps the message field focused while a dropped image uploads", async () => {
		let resolveUpload!: (result: { path: string }) => void;
		mockedApi.request.uploadFileBase64.mockImplementation(() => new Promise((resolve) => {
			resolveUpload = resolve;
		}) as never);
		renderModal();
		const textarea = screen.getByTestId("schedule-message-input") as HTMLTextAreaElement;
		textarea.focus();
		textarea.blur();

		dispatchDrop(textarea.parentElement!, [new File(["image"], "photo.png", { type: "image/png" })]);

		await waitFor(() => expect(mockedApi.request.uploadFileBase64).toHaveBeenCalled());
		expect(textarea).toHaveFocus();
		await act(async () => resolveUpload({ path: "/tmp/photo.png" }));
		await waitFor(() => expect(textarea.value).toBe("/tmp/photo.png\n"));
		expect(textarea).toHaveFocus();
	});

	it("offers a concrete pane target when live panes exist", async () => {
		vi.mocked(api.request.tmuxLayout).mockResolvedValue({
			sessionName: "dev3-t1",
			exists: true,
			windows: [],
			panes: [{ windowIndex: 0, paneId: "%4", active: true, left: 0, top: 0, width: 80, height: 24, command: "zsh", title: "" }],
		} as never);
		renderModal();
		await pickLater();
		await userEvent.type(screen.getByTestId("schedule-message-input"), "poke the shell");
		const select = await screen.findByRole("combobox");
		await userEvent.selectOptions(select, "%4");
		await userEvent.click(screen.getByRole("button", { name: /schedule/i }));
		await waitFor(() => expect(mockedApi.request.scheduleMessage).toHaveBeenCalled());
		const call = mockedApi.request.scheduleMessage.mock.calls[0]![0];
		expect(call.target).toEqual({ kind: "pane", paneId: "%4" });
	});

	describe("message draft (#2281)", () => {
		function backdrop() {
			return screen.getByRole("dialog").parentElement!;
		}

		it("defaults to When agent stops while the agent works, and arms the draft", async () => {
			const { onClose } = renderModal();
			expect(screen.getByRole("button", { name: "When agent stops" })).toHaveAttribute("aria-pressed", "true");
			await userEvent.type(screen.getByTestId("schedule-message-input"), "then rebase");
			await userEvent.click(screen.getByRole("button", { name: "Send on stop" }));
			await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
			expect(mockedApi.request.saveMessageDraft).toHaveBeenLastCalledWith({ taskId: task.id, projectId: project.id, text: "then rebase", sendOnStop: true });
			expect(mockedApi.request.sendMessageDraft).not.toHaveBeenCalled();
		});

		it("offers only Now when the agent is not working", () => {
			renderModal(undefined, { status: "review-by-user" });
			expect(screen.queryByRole("button", { name: "When agent stops" })).toBeNull();
			expect(screen.getByRole("button", { name: "Now" })).toHaveAttribute("aria-pressed", "true");
		});

		it("Now saves the text and sends the draft", async () => {
			const { onClose } = renderModal(undefined, { status: "review-by-user" });
			await userEvent.type(screen.getByTestId("schedule-message-input"), "go on");
			await userEvent.click(screen.getByRole("button", { name: "Send now" }));
			await waitFor(() => expect(mockedApi.request.sendMessageDraft).toHaveBeenCalledWith({ taskId: task.id, projectId: project.id }));
			expect(mockedApi.request.saveMessageDraft).toHaveBeenCalledWith(expect.objectContaining({ text: "go on", sendOnStop: false }));
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it("Keep as draft parks the text unarmed, without sending", async () => {
			const { onClose } = renderModal(undefined, { messageDraft: { text: "later", sendOnStop: true, updatedAt: "t0" } });
			await userEvent.click(screen.getByRole("button", { name: "Keep as draft" }));
			await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
			expect(mockedApi.request.saveMessageDraft).toHaveBeenLastCalledWith({ taskId: task.id, projectId: project.id, text: "later", sendOnStop: false });
			expect(mockedApi.request.sendMessageDraft).not.toHaveBeenCalled();
		});

		it("shows Close instead while there is nothing to keep", () => {
			renderModal();
			expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
		});

		it("autosaves the text as the task's draft after a typing pause", async () => {
			renderModal();
			await userEvent.type(screen.getByTestId("schedule-message-input"), "half a thought");
			await waitFor(() => expect(mockedApi.request.saveMessageDraft).toHaveBeenCalledWith(expect.objectContaining({ text: "half a thought" })));
		});

		it("closes at once on Escape and flushes the last keystrokes", async () => {
			const { onClose, unmount } = renderModal();
			await userEvent.type(screen.getByTestId("schedule-message-input"), "important prompt");
			await userEvent.keyboard("{Escape}");
			expect(onClose).toHaveBeenCalledTimes(1);
			unmount();
			expect(mockedApi.request.saveMessageDraft).toHaveBeenCalledWith(expect.objectContaining({ text: "important prompt" }));
		});

		it("opens on the saved draft, and Discard clears it", async () => {
			const { onClose } = renderModal(undefined, { messageDraft: { text: "saved words", updatedAt: "2026-11-11T00:00:00Z" } });
			expect((screen.getByTestId("schedule-message-input") as HTMLTextAreaElement).value).toBe("saved words");
			await userEvent.click(screen.getByTestId("message-draft-discard"));
			await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
			expect(mockedApi.request.saveMessageDraft).toHaveBeenCalledWith(expect.objectContaining({ text: "" }));
		});

		it("appends a composer seed to an existing draft", () => {
			renderModal("from composer", { messageDraft: { text: "saved words", updatedAt: "2026-11-11T00:00:00Z" } });
			expect((screen.getByTestId("schedule-message-input") as HTMLTextAreaElement).value).toBe("saved words\n\nfrom composer");
		});

		it("scheduling for later clears the draft so the text is not sent twice", async () => {
			const { onClose } = renderModal(undefined, { messageDraft: { text: "saved words", updatedAt: "2026-11-11T00:00:00Z" } });
			await pickLater();
			await userEvent.click(screen.getByRole("button", { name: /schedule/i }));
			await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
			expect(mockedApi.request.scheduleMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "saved words" }));
			expect(mockedApi.request.saveMessageDraft).toHaveBeenLastCalledWith(expect.objectContaining({ text: "" }));
		});

		it("ignores a selection drag that starts in the textarea and is released on the backdrop", async () => {
			const { onClose } = renderModal();
			const input = screen.getByTestId("schedule-message-input");
			fireEvent.mouseDown(input);
			fireEvent.mouseUp(backdrop());
			fireEvent.click(backdrop());
			expect(onClose).not.toHaveBeenCalled();
		});

		it("cannot be dismissed while scheduling is in flight, and schedules exactly once", async () => {
			let resolve!: (v: unknown) => void;
			mockedApi.request.scheduleMessage.mockImplementation(() => new Promise((r) => { resolve = r; }) as never);
			const { onClose } = renderModal();
			await pickLater();
			await userEvent.type(screen.getByTestId("schedule-message-input"), "go");
			const submit = screen.getByRole("button", { name: /schedule/i });
			fireEvent.click(submit);
			fireEvent.click(submit);
			await userEvent.keyboard("{Escape}");
			fireEvent.mouseDown(backdrop());
			fireEvent.click(backdrop());
			expect(onClose).not.toHaveBeenCalled();
			expect(mockedApi.request.scheduleMessage).toHaveBeenCalledTimes(1);
			await act(async () => resolve({ id: task.id, scheduledMessages: [] }));
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it("keeps the message and shows the error when scheduling fails", async () => {
			mockedApi.request.scheduleMessage.mockRejectedValue(new Error("socket gone"));
			const { onClose } = renderModal();
			await pickLater();
			const input = screen.getByTestId("schedule-message-input") as HTMLTextAreaElement;
			await userEvent.type(input, "retry me");
			await userEvent.click(screen.getByRole("button", { name: /schedule/i }));
			expect(await screen.findByText(/socket gone/)).toBeInTheDocument();
			expect(onClose).not.toHaveBeenCalled();
			expect(input.value).toBe("retry me");
		});
	});
});
