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

function renderModal(initialText?: string) {
	const dispatch = vi.fn();
	const onClose = vi.fn();
	render(
		<I18nProvider>
			<ScheduleMessageModal task={task} project={project} dispatch={dispatch} onClose={onClose} initialText={initialText} />
		</I18nProvider>,
	);
	return { dispatch, onClose };
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
		const submit = screen.getByRole("button", { name: /schedule/i });
		expect(submit).toBeDisabled();
		await userEvent.type(screen.getByTestId("schedule-message-input"), "check CI");
		expect(submit).not.toBeDisabled();
	});

	it("schedules with the resolved ISO time and the agent target by default", async () => {
		mockedApi.request.scheduleMessage.mockResolvedValue({ id: task.id, scheduledMessages: [] } as never);
		renderModal();
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
		await userEvent.type(screen.getByTestId("schedule-message-input"), "poke the shell");
		const select = await screen.findByRole("combobox");
		await userEvent.selectOptions(select, "%4");
		await userEvent.click(screen.getByRole("button", { name: /schedule/i }));
		await waitFor(() => expect(mockedApi.request.scheduleMessage).toHaveBeenCalled());
		const call = mockedApi.request.scheduleMessage.mock.calls[0]![0];
		expect(call.target).toEqual({ kind: "pane", paneId: "%4" });
	});

	describe("draft protection (BUG-14)", () => {
		function backdrop() {
			return screen.getByRole("dialog").parentElement!;
		}

		it("closes at once on Escape when nothing was typed", async () => {
			const { onClose } = renderModal();
			await userEvent.keyboard("{Escape}");
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it("asks before discarding a typed message on Escape, and a second Escape keeps editing", async () => {
			const { onClose } = renderModal();
			const input = screen.getByTestId("schedule-message-input") as HTMLTextAreaElement;
			await userEvent.type(input, "important prompt");
			await userEvent.keyboard("{Escape}");
			expect(onClose).not.toHaveBeenCalled();
			expect(screen.getByTestId("schedule-discard-confirm")).toBeInTheDocument();
			await userEvent.keyboard("{Escape}");
			expect(onClose).not.toHaveBeenCalled();
			expect(screen.queryByTestId("schedule-discard-confirm")).toBeNull();
			expect(input.value).toBe("important prompt");
		});

		it("asks before discarding on a backdrop click, and Discard closes deliberately", async () => {
			const { onClose } = renderModal();
			await userEvent.type(screen.getByTestId("schedule-message-input"), "important prompt");
			const notPrevented = fireEvent.mouseDown(backdrop());
			fireEvent.click(backdrop());
			expect(onClose).not.toHaveBeenCalled();
			expect(notPrevented).toBe(false);
			expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus();
			await userEvent.click(screen.getByRole("button", { name: "Discard message" }));
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it("Keep editing returns focus to the message with the text intact", async () => {
			const { onClose } = renderModal();
			const input = screen.getByTestId("schedule-message-input") as HTMLTextAreaElement;
			await userEvent.type(input, "important prompt");
			await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
			await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
			expect(onClose).not.toHaveBeenCalled();
			expect(input.value).toBe("important prompt");
			expect(input).toHaveFocus();
		});

		it("ignores a selection drag that starts in the textarea and is released on the backdrop", async () => {
			const { onClose } = renderModal();
			const input = screen.getByTestId("schedule-message-input");
			fireEvent.mouseDown(input);
			fireEvent.mouseUp(backdrop());
			fireEvent.click(backdrop());
			expect(onClose).not.toHaveBeenCalled();
			expect(screen.queryByTestId("schedule-discard-confirm")).toBeNull();
		});

		it("does not treat an untouched composer seed as a draft to protect", async () => {
			const { onClose } = renderModal("draft from composer");
			await userEvent.keyboard("{Escape}");
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it("cannot be dismissed while scheduling is in flight, and schedules exactly once", async () => {
			let resolve!: (v: unknown) => void;
			mockedApi.request.scheduleMessage.mockImplementation(() => new Promise((r) => { resolve = r; }) as never);
			const { onClose, dispatch } = renderModal();
			await userEvent.type(screen.getByTestId("schedule-message-input"), "go");
			const submit = screen.getByRole("button", { name: /schedule/i });
			fireEvent.click(submit);
			fireEvent.click(submit);
			await userEvent.keyboard("{Escape}");
			fireEvent.mouseDown(backdrop());
			fireEvent.click(backdrop());
			expect(onClose).not.toHaveBeenCalled();
			expect(screen.queryByTestId("schedule-discard-confirm")).toBeNull();
			expect(mockedApi.request.scheduleMessage).toHaveBeenCalledTimes(1);
			await act(async () => resolve({ id: task.id, scheduledMessages: [] }));
			expect(dispatch).toHaveBeenCalledTimes(1);
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it("keeps the message and shows the error when scheduling fails", async () => {
			mockedApi.request.scheduleMessage.mockRejectedValue(new Error("socket gone"));
			const { onClose, dispatch } = renderModal();
			const input = screen.getByTestId("schedule-message-input") as HTMLTextAreaElement;
			await userEvent.type(input, "retry me");
			await userEvent.click(screen.getByRole("button", { name: /schedule/i }));
			expect(await screen.findByText(/socket gone/)).toBeInTheDocument();
			expect(onClose).not.toHaveBeenCalled();
			expect(dispatch).not.toHaveBeenCalled();
			expect(input.value).toBe("retry me");
		});
	});
});
