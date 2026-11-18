import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";

vi.mock("../../confirm", () => ({
	confirm: vi.fn(),
	whenConfirmHostMounted: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../rpc", () => ({ api: { request: { getUnsavedWork: vi.fn() } } }));

import { confirm, type ConfirmOptions } from "../../confirm";
import { api } from "../../rpc";
import { _resetCompletionOffersForTests, hasCompletionOffer, offerCompletion, setCompletionOfferStyle, type CompletionOfferAnswer, type CompletionOfferKind } from "../../completion-offers";
import CompletionOfferDialogHost from "../CompletionOfferDialogHost";

function renderHost(ready = true) {
	return render(<I18nProvider><CompletionOfferDialogHost ready={ready} /></I18nProvider>);
}

/** Wrapped, because an async function would flatten the answer promise and wait on it. */
async function offer(kind: CompletionOfferKind): Promise<{ answer: Promise<CompletionOfferAnswer | null> }> {
	let answer!: Promise<CompletionOfferAnswer | null>;
	await act(async () => { answer = offerCompletion({ taskId: "t1", projectId: "p1", kind, branchName: "feat/x" }); });
	return { answer };
}

function lastConfirm(): ConfirmOptions {
	const calls = vi.mocked(confirm).mock.calls;
	return calls[calls.length - 1]![0];
}

afterEach(() => {
	_resetCompletionOffersForTests();
	vi.clearAllMocks();
});

describe("CompletionOfferDialogHost", () => {
	it("asks an agent request in main's agent-request modal and hands the answer to the offer", async () => {
		vi.mocked(confirm).mockResolvedValue(true);
		renderHost();
		const { answer } = await offer("agent");
		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
		expect(lastConfirm()).toMatchObject({
			title: "Agent requests completion",
			confirmLabel: "Complete task",
			cancelLabel: "Keep session",
			agentInitiated: true,
			danger: true,
		});
		expect(lastConfirm().message).toContain("Approving will destroy the worktree");
		expect(lastConfirm().deferred).toBeUndefined();
		// Opening the task from the card would decline the agent, so it has no click.
		expect(lastConfirm().info?.onClick).toBeUndefined();
		await expect(answer).resolves.toBe(true);
	});

	it("passes the agent's --reason to the modal", async () => {
		vi.mocked(confirm).mockResolvedValue(true);
		renderHost();
		await act(async () => { void offerCompletion({ taskId: "t1", projectId: "p1", kind: "agent", reason: { text: "PR merged" } }); });
		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
		expect(lastConfirm().reason).toEqual({ text: "PR merged" });
	});

	it("says the folder is kept when the agent's task has no worktree of its own", async () => {
		vi.mocked(confirm).mockResolvedValue(true);
		renderHost();
		await act(async () => { void offerCompletion({ taskId: "t1", projectId: "p1", kind: "agent", keepsFolder: true }); });
		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
		expect(lastConfirm().message).toContain("The working folder and its files are kept.");
	});

	it("streams the bound unsaved-work check into the agent modal when the task's repo lies in its own folder", async () => {
		const REPO_A = "/ops/t1/work/wt-a";
		vi.mocked(api.request.getUnsavedWork).mockResolvedValue({ insertions: 0, deletions: 0, unpushed: 0, ahead: 0 } as never);
		vi.mocked(confirm).mockImplementation(async (options) => {
			await options.deferred?.promise;
			return true;
		});
		renderHost();
		const onChecked = vi.fn();
		await act(async () => { void offerCompletion({ taskId: "t1", projectId: "p1", kind: "agent", attachedWorktree: { repo: REPO_A, onChecked } }); });
		await waitFor(() => expect(onChecked).toHaveBeenCalledWith(REPO_A));
		expect(api.request.getUnsavedWork).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1", expectedAttachedRepo: REPO_A });
		expect(lastConfirm()).toMatchObject({ deferred: { gateConfirm: true } });
		expect(lastConfirm().message).toContain("If the attached repository is a git worktree, it is removed; its branch is kept.");
	});

	it("reports nothing checked when the bound check is refused", async () => {
		vi.mocked(api.request.getUnsavedWork).mockRejectedValue(new Error("The attached repository changed since this dialog opened"));
		vi.mocked(confirm).mockImplementation(async (options) => {
			await options.deferred?.promise.catch(() => undefined);
			return true;
		});
		renderHost();
		const onChecked = vi.fn();
		let answer!: Promise<CompletionOfferAnswer | null>;
		await act(async () => { answer = offerCompletion({ taskId: "t1", projectId: "p1", kind: "agent", attachedWorktree: { repo: "/ops/t1/work/wt-a", onChecked } }); });
		await expect(answer).resolves.toBe(true);
		expect(onChecked).not.toHaveBeenCalled();
	});

	it("shows the task card the caller built", async () => {
		vi.mocked(confirm).mockResolvedValue(true);
		renderHost();
		const onClick = vi.fn();
		await act(async () => { void offerCompletion({ taskId: "t1", projectId: "p1", kind: "merge", branchName: "feat/x", dialogInfo: { title: "Wire Task", onClick } }); });
		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
		expect(lastConfirm().info).toEqual({ title: "Wire Task", onClick });
	});

	it("asks a merge in main's outcome-card dialog and passes manual completion through", async () => {
		vi.mocked(confirm).mockResolvedValue("manual" as never);
		renderHost();
		const { answer } = await offer("merge");
		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
		expect(lastConfirm()).toMatchObject({
			title: "The branch is in the base branch",
			cancelLabel: "Not now",
			alternativeAction: { value: "manual" },
			outcomeCards: { kicker: "Branch merged", statusLabel: "Merged", statusValue: "feat/x" },
			dismissOnBackdrop: false,
		});
		expect(lastConfirm().outcomeCards?.cancelDescription).toBe("Keep it open and ask again after the next merge.");
		expect(lastConfirm().agentInitiated).toBeUndefined();
		await expect(answer).resolves.toBe("manual");
	});

	it("closes the modal when the offer settles elsewhere", async () => {
		vi.mocked(confirm).mockReturnValue(new Promise(() => {}));
		renderHost();
		const controller = new AbortController();
		await act(async () => { void offerCompletion({ taskId: "t1", projectId: "p1", kind: "agent", signal: controller.signal }); });
		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
		const signal = lastConfirm().signal!;
		expect(signal.aborted).toBe(false);
		await act(async () => { controller.abort(); });
		expect(signal.aborted).toBe(true);
	});

	it("waits for the host's settings before asking", async () => {
		vi.mocked(confirm).mockResolvedValue(false);
		const { rerender } = renderHost(false);
		await offer("agent");
		await act(async () => {});
		expect(confirm).not.toHaveBeenCalled();
		rerender(<I18nProvider><CompletionOfferDialogHost ready /></I18nProvider>);
		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
	});

	// A switch to Dialog with many asks waiting must not chain one modal per ask,
	// which the user could only leave by answering or refusing every agent.
	it("leaves waiting offers on their task after a switch to Dialog, and asks new ones in it", async () => {
		setCompletionOfferStyle("inline");
		renderHost();
		await offer("agent");
		await act(async () => {});
		expect(confirm).not.toHaveBeenCalled();
		await act(async () => { setCompletionOfferStyle("dialog"); });
		await act(async () => {});
		expect(confirm).not.toHaveBeenCalled();
		await offer("merge");
		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
	});

	// Each ask has its own dialog, as before the setting existed: "Keep session"
	// says no to the agent and leaves a waiting merge dialog alone.
	it("answers only its own offer when a dialog is declined", async () => {
		vi.mocked(confirm).mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce(false);
		renderHost();
		await offer("merge");
		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
		const agent = await offer("agent");
		await expect(agent.answer).resolves.toBe(false);
		expect(hasCompletionOffer("t1", "merge")).toBe(true);
	});

	it("closes an open modal when the style switches to On the task", async () => {
		vi.mocked(confirm).mockReturnValue(new Promise(() => {}));
		renderHost();
		await offer("agent");
		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
		const signal = lastConfirm().signal!;
		await act(async () => { setCompletionOfferStyle("inline"); });
		expect(signal.aborted).toBe(true); // currently false
	});

	// A To Do task opens as its detail modal, which has no bar: the ask would be invisible.
	it("asks an offer for a task with no terminal view in the modal under On the task, and keeps it there", async () => {
		vi.mocked(confirm).mockReturnValue(new Promise(() => {}));
		setCompletionOfferStyle("inline");
		renderHost();
		await act(async () => { void offerCompletion({ taskId: "t1", projectId: "p1", kind: "agent", noTaskView: true }); });
		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
		const signal = lastConfirm().signal!;
		await act(async () => { setCompletionOfferStyle("dialog"); });
		await act(async () => { setCompletionOfferStyle("inline"); });
		expect(signal.aborted).toBe(false);
		expect(confirm).toHaveBeenCalledTimes(1);
	});
});
