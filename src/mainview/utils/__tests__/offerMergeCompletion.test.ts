import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task, TaskDialogSubject } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			prepareMergeCompletionPrompt: vi.fn(),
			dismissMergeCompletionPrompt: vi.fn(),
			setTaskManualCompletion: vi.fn(),
		},
	},
}));
vi.mock("../../confirm", () => ({
	confirm: vi.fn(),
}));
vi.mock("../../toast", () => ({
	toast: { info: vi.fn(), error: vi.fn() },
}));

import { offerMergeCompletion } from "../offerMergeCompletion";
import { _resetMergeCompletionPromptInFlightForTests } from "../mergeCompletionPrompt";
import { api } from "../../rpc";
import { confirm } from "../../confirm";
import { toast } from "../../toast";
import type { TFunction } from "../../i18n";

const mockedPrepare = vi.mocked(api.request.prepareMergeCompletionPrompt);
const mockedDismiss = vi.mocked(api.request.dismissMergeCompletionPrompt);
const mockedManual = vi.mocked(api.request.setTaskManualCompletion);
const mockedConfirm = vi.mocked(confirm);

// Echoes interpolation params so tests can assert the branch/task flow into copy.
const t = ((key: string, params?: Record<string, string>) =>
	params ? `${key}|${params.taskTitle ?? ""}|${params.branchName ?? ""}` : key) as unknown as TFunction;

const project = { id: "p1", name: "Alpha", path: "/a", labels: [] } as unknown as Project;
const task = {
	id: "t1",
	projectId: "p1",
	title: "Auto title",
	customTitle: "My Task",
	branchName: "feat/x",
	status: "review-by-user",
	seq: 42,
} as unknown as Task;

const wireContext = {
	taskId: "t1",
	projectId: "p1",
	taskTitle: "Wire Task",
	branchName: "feat/wire",
};

describe("offerMergeCompletion", () => {
	beforeEach(() => {
		_resetMergeCompletionPromptInFlightForTests();
		mockedPrepare.mockResolvedValue({ shouldPrompt: true, fingerprint: "fp-server" });
		mockedDismiss.mockResolvedValue({} as never);
		mockedManual.mockResolvedValue({} as never);
	});
	afterEach(() => vi.clearAllMocks());

	it("prompts with the outcome-card dialog and runs onComplete on accept (wire path)", async () => {
		mockedConfirm.mockResolvedValue(true);
		const onComplete = vi.fn();

		const outcome = await offerMergeCompletion({
			context: { ...wireContext, subject: undefined },
			t,
			fingerprint: "fp-1",
			onComplete,
		});

		expect(outcome).toBe("completed");
		expect(onComplete).toHaveBeenCalledTimes(1);
		// App poller path never re-reserves (the poller reserved server-side).
		expect(mockedPrepare).not.toHaveBeenCalled();
		expect(mockedDismiss).not.toHaveBeenCalled();
		// The dialog options come from buildMergeCompletionDialogOptions unchanged.
		expect(mockedConfirm).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "app.branchMergedTitle",
				alternativeAction: { label: "app.branchMergedManualCompletion", value: "manual" },
				outcomeCards: expect.objectContaining({ statusValue: "feat/wire" }),
				dismissOnBackdrop: false,
			}),
		);
	});

	it("dismisses with the wire fingerprint on Not now and does not complete", async () => {
		mockedConfirm.mockResolvedValue(false);
		const onComplete = vi.fn();

		const outcome = await offerMergeCompletion({
			context: wireContext,
			t,
			fingerprint: "fp-1",
			onComplete,
		});

		expect(outcome).toBe("dismissed");
		expect(onComplete).not.toHaveBeenCalled();
		expect(mockedDismiss).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1", fingerprint: "fp-1" });
	});

	it("persists manual completion and neither completes nor dismisses", async () => {
		mockedConfirm.mockResolvedValue("manual" as never);
		const onComplete = vi.fn();

		const outcome = await offerMergeCompletion({
			context: wireContext,
			t,
			fingerprint: "fp-1",
			onComplete,
		});

		expect(outcome).toBe("manual");
		expect(mockedManual).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1", manualCompletion: true });
		expect(onComplete).not.toHaveBeenCalled();
		expect(mockedDismiss).not.toHaveBeenCalled();
	});

	it("toasts on a manual-completion RPC failure but still returns manual", async () => {
		mockedConfirm.mockResolvedValue("manual" as never);
		mockedManual.mockRejectedValue(new Error("boom"));

		const outcome = await offerMergeCompletion({
			context: wireContext,
			t,
			fingerprint: "fp-1",
			onComplete: vi.fn(),
		});

		expect(outcome).toBe("manual");
		expect(toast.error).toHaveBeenCalledWith(
			expect.stringContaining("task.manualCompletionChangeFailed"),
			{ taskId: "t1" },
		);
	});

	it("returns dismissed without throwing when the dismiss RPC fails", async () => {
		mockedConfirm.mockResolvedValue(false);
		mockedDismiss.mockRejectedValue(new Error("net down"));
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		const outcome = await offerMergeCompletion({
			context: wireContext,
			t,
			fingerprint: "fp-1",
			onComplete: vi.fn(),
		});

		expect(outcome).toBe("dismissed");
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();
	});

	it("builds the info card from the wire subject", async () => {
		mockedConfirm.mockResolvedValue(false);
		const subject: TaskDialogSubject = {
			seqLabel: "99",
			projectName: "Beta",
			priority: "P1",
			labels: [],
			overview: "some overview",
		};

		await offerMergeCompletion({
			context: { ...wireContext, subject },
			t,
			fingerprint: "fp-1",
			onComplete: vi.fn(),
		});

		expect(mockedConfirm).toHaveBeenCalledWith(
			expect.objectContaining({
				info: expect.objectContaining({
					title: "Wire Task",
					body: "some overview",
					seqLabel: "99",
					projectName: "Beta",
					priority: "P1",
				}),
			}),
		);
	});

	it("downgrades to a passive toast when the poller says notify-only (wire path)", async () => {
		const outcome = await offerMergeCompletion({
			context: wireContext,
			t,
			fingerprint: "fp-1",
			shouldPrompt: false,
			shouldNotify: true,
			onComplete: vi.fn(),
		});

		expect(outcome).toBe("notified");
		expect(toast.info).toHaveBeenCalledWith(expect.stringContaining("app.branchMergedToast"), { taskId: "t1" });
		expect(mockedConfirm).not.toHaveBeenCalled();
	});

	it("suppresses silently when shouldPrompt is false without notify", async () => {
		const outcome = await offerMergeCompletion({
			context: wireContext,
			t,
			fingerprint: "fp-1",
			shouldPrompt: false,
			onComplete: vi.fn(),
		});

		expect(outcome).toBe("suppressed");
		expect(toast.info).not.toHaveBeenCalled();
		expect(mockedConfirm).not.toHaveBeenCalled();
	});

	it("still prompts on the wire path when shouldPrompt is omitted (legacy happy path)", async () => {
		mockedConfirm.mockResolvedValue(true);

		const outcome = await offerMergeCompletion({
			context: wireContext,
			t,
			fingerprint: "fp-1",
			onComplete: vi.fn(),
		});

		expect(outcome).toBe("completed");
		expect(mockedConfirm).toHaveBeenCalled();
	});

	it("reserves via prepare and suppresses when the backend declines to prompt", async () => {
		mockedPrepare.mockResolvedValue({ shouldPrompt: false, fingerprint: "fp-server" });

		const outcome = await offerMergeCompletion({
			context: { task, project },
			t,
			fingerprint: "fp-client",
			reserve: true,
			onComplete: vi.fn(),
		});

		expect(outcome).toBe("suppressed");
		expect(mockedPrepare).toHaveBeenCalledWith({
			taskId: "t1",
			projectId: "p1",
			fingerprint: "fp-client",
			force: false,
		});
		expect(mockedConfirm).not.toHaveBeenCalled();
	});

	it("notifies when prepare returns notice-only (reserve path)", async () => {
		mockedPrepare.mockResolvedValue({ shouldPrompt: false, fingerprint: "fp-server", shouldNotify: true });

		const outcome = await offerMergeCompletion({
			context: { task, project },
			t,
			fingerprint: "fp-client",
			reserve: true,
			onComplete: vi.fn(),
		});

		expect(outcome).toBe("notified");
		expect(toast.info).toHaveBeenCalledWith(expect.stringContaining("app.branchMergedToast"), { taskId: "t1" });
	});

	it("dismisses with the server fingerprint returned by prepare (reserve path)", async () => {
		mockedPrepare.mockResolvedValue({ shouldPrompt: true, fingerprint: "fp-server" });
		mockedConfirm.mockResolvedValue(false);

		await offerMergeCompletion({
			context: { task, project },
			t,
			fingerprint: "fp-client",
			reserve: true,
			onComplete: vi.fn(),
		});

		expect(mockedDismiss).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1", fingerprint: "fp-server" });
	});

	it("derives title and branch from the live task+project context", async () => {
		mockedConfirm.mockResolvedValue(true);
		const onComplete = vi.fn();

		await offerMergeCompletion({
			context: { task, project },
			t,
			fingerprint: "fp-client",
			reserve: true,
			onComplete,
		});

		expect(mockedConfirm).toHaveBeenCalledWith(
			expect.objectContaining({
				outcomeCards: expect.objectContaining({ statusValue: "feat/x" }),
				info: expect.objectContaining({ title: "My Task", projectName: "Alpha" }),
			}),
		);
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it("forwards force to prepare and bypasses the once-guard", async () => {
		mockedPrepare.mockResolvedValue({ shouldPrompt: true, fingerprint: "fp-server" });
		mockedConfirm.mockResolvedValue(true);

		await offerMergeCompletion({
			context: { task, project },
			t,
			fingerprint: "fp-client",
			reserve: true,
			force: true,
			onComplete: vi.fn(),
		});

		expect(mockedPrepare).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
	});

	it("de-dupes a concurrent identical prompt (non-force)", async () => {
		let resolveConfirm: (v: boolean) => void = () => {};
		mockedConfirm.mockReturnValue(new Promise<boolean>((r) => (resolveConfirm = r)));

		const first = offerMergeCompletion({
			context: wireContext,
			t,
			fingerprint: "fp-dup",
			onComplete: vi.fn(),
		});
		const second = await offerMergeCompletion({
			context: wireContext,
			t,
			fingerprint: "fp-dup",
			onComplete: vi.fn(),
		});

		expect(second).toBe("deduped");
		expect(mockedConfirm).toHaveBeenCalledTimes(1);

		resolveConfirm(false);
		await first;
	});

	it("returns aborted when the prompt is resolved on another client", async () => {
		let resolveConfirm: (v: boolean) => void = () => {};
		mockedConfirm.mockReturnValue(new Promise<boolean>((r) => (resolveConfirm = r)));
		const onComplete = vi.fn();

		const pending = offerMergeCompletion({
			context: wireContext,
			t,
			fingerprint: "fp-abort",
			onComplete,
		});

		window.dispatchEvent(new CustomEvent("rpc:mergePromptResolved", { detail: { taskId: "t1" } }));
		resolveConfirm(false);

		expect(await pending).toBe("aborted");
		expect(onComplete).not.toHaveBeenCalled();
		expect(mockedDismiss).not.toHaveBeenCalled();
	});
});
