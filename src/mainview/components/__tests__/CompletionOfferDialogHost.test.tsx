import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task, UnsavedWork } from "../../../shared/types";
import { I18nProvider } from "../../i18n";

vi.mock("../../rpc", () => ({ api: { request: { getUnsavedWork: vi.fn(), getTasks: vi.fn() } } }));
vi.mock("../../confirm", () => ({
	confirm: vi.fn(),
	whenConfirmHostMounted: vi.fn().mockResolvedValue(true),
}));

import { api } from "../../rpc";
import { confirm, type ConfirmOptions } from "../../confirm";
import { _resetCompletionOffersForTests, offerCompletion, setCompletionOfferStyle, type CompletionOfferAnswer, type CompletionOfferKind } from "../../completion-offers";
import CompletionOfferDialogHost from "../CompletionOfferDialogHost";

const project = { id: "p1", name: "Alpha", path: "/a" } as Project;
const task = { id: "t1", projectId: "p1", worktreePath: "/wt/t1", branchName: "feat/x", status: "review-by-user", seq: 1 } as Task;
const clean = { insertions: 0, deletions: 0, unpushed: 0, ahead: 0 } as UnsavedWork;

function renderHost(ready = true) {
	return render(<I18nProvider><CompletionOfferDialogHost ready={ready} projects={[project]} onOpenTask={vi.fn()} /></I18nProvider>);
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

beforeEach(() => {
	vi.mocked(api.request.getTasks).mockResolvedValue([task]);
	vi.mocked(api.request.getUnsavedWork).mockResolvedValue(clean);
});
afterEach(() => {
	_resetCompletionOffersForTests();
	vi.clearAllMocks();
});

describe("CompletionOfferDialogHost", () => {
	it("asks an agent request in the agent-request modal and hands the answer to the offer", async () => {
		vi.mocked(confirm).mockResolvedValue(true);
		renderHost();
		const { answer } = await offer("agent");
		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
		expect(lastConfirm()).toMatchObject({ agentInitiated: true, danger: true, dismissOnBackdrop: false });
		expect(lastConfirm().deferred?.gateConfirm).toBe(true);
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

	it("offers manual completion for a merge and passes it through", async () => {
		vi.mocked(confirm).mockResolvedValue("manual" as never);
		renderHost();
		const { answer } = await offer("merge");
		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
		expect(lastConfirm().alternativeAction).toEqual(expect.objectContaining({ value: "manual" }));
		expect(lastConfirm().agentInitiated).toBe(false);
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
		rerender(<I18nProvider><CompletionOfferDialogHost ready projects={[project]} onOpenTask={vi.fn()} /></I18nProvider>);
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

	it("settles every offer on the task when one is kept open", async () => {
		vi.mocked(confirm).mockResolvedValue(false);
		renderHost();
		const merge = await offer("merge");
		const agent = await offer("agent");
		await expect(agent.answer).resolves.toBe(false);
		await expect(merge.answer).resolves.toBe(false);
	});
});
