import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task, UnsavedWork } from "../../../shared/types";
import { I18nProvider } from "../../i18n";

vi.mock("../../rpc", () => ({ api: { request: { getUnsavedWork: vi.fn() } } }));
vi.mock("../../confirm", () => ({ confirm: vi.fn() }));
vi.mock("../../toast", () => ({ toast: { info: vi.fn() } }));
vi.mock("../../sensitive-projects", () => ({
	useProjectPrivacy: () => ({
		streamerMode: false,
		isLocked: (project: Project) => Boolean(project.sensitive),
		maskClass: () => "",
	}),
}));

import { api } from "../../rpc";
import { confirm } from "../../confirm";
import { toast } from "../../toast";
import { _resetCompletionOffersForTests, offerCompletion, type CompletionOfferAnswer, type CompletionOfferKind } from "../../completion-offers";
import ReadyToCompleteSection, { waitingOffers } from "../ReadyToCompleteSection";

const project = { id: "p1", name: "Alpha", path: "/a" } as Project;
const locked = { id: "p2", name: "Secret", path: "/s", sensitive: true } as Project;
const task = (id: string, projectId = "p1") =>
	({ id, projectId, title: `Task ${id}`, worktreePath: `/wt/${id}`, branchName: `feat/${id}`, status: "review-by-user" }) as unknown as Task;
const clean = { insertions: 0, deletions: 0, unpushed: 0, ahead: 0 } as UnsavedWork;
const dirty = { insertions: 3, deletions: 1, unpushed: 0, ahead: 0 } as UnsavedWork;

function renderSection(tasks: Task[] = [task("t1"), task("t2")], projects: Project[] = [project]) {
	const byProject = new Map<string, Task[]>();
	for (const item of tasks) byProject.set(item.projectId, [...(byProject.get(item.projectId) ?? []), item]);
	const onOpenTask = vi.fn();
	render(
		<I18nProvider>
			<ReadyToCompleteSection projects={projects} tasksByProject={byProject} usage={new Map([["abcdef12", { cpu: 1, rss: 512 * 1024 ** 2 }]])} onOpenTask={onOpenTask} />
		</I18nProvider>,
	);
	return { onOpenTask };
}

async function offer(taskId: string, kind: CompletionOfferKind = "agent", projectId = "p1"): Promise<{ answer: Promise<CompletionOfferAnswer | null> }> {
	let answer!: Promise<CompletionOfferAnswer | null>;
	await act(async () => { answer = offerCompletion({ taskId, projectId, kind, branchName: "feat/x", status: "completed" }); });
	return { answer };
}

beforeEach(() => {
	vi.mocked(api.request.getUnsavedWork).mockResolvedValue(clean);
});
afterEach(() => {
	_resetCompletionOffersForTests();
	vi.clearAllMocks();
});

describe("ReadyToCompleteSection", () => {
	it("is hidden while nothing waits", () => {
		renderSection();
		expect(screen.queryByTestId("ready-to-complete")).not.toBeInTheDocument();
	});

	it("lists merge and agent offers oldest first, never the user's own ask, with the memory each task holds", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		// Usage arrives keyed by the short (8-character) task id.
		const long = "abcdef12-0000-4000-8000-000000000000";
		renderSection([task(long), task("t2")]);
		vi.setSystemTime(2_000_000);
		await offer(long, "merge");
		vi.setSystemTime(1_000_000);
		await offer("t2", "agent");
		await offer(long, "user");
		vi.useRealTimers();
		const rows = screen.getAllByTestId(/^ready-to-complete-row-/);
		expect(rows.map((row) => row.dataset.testid)).toEqual(["ready-to-complete-row-t2", `ready-to-complete-row-${long}`]);
		expect(rows[1]).toHaveTextContent("512 MB");
	});

	it("answers the task's own offer: Complete when nothing would be lost, Keep open otherwise", async () => {
		renderSection();
		const first = await offer("t1");
		const second = await offer("t2");
		fireEvent.click(screen.getByTestId("ready-to-complete-complete-t1"));
		await expect(first.answer).resolves.toBe(true);
		fireEvent.click(screen.getByText("Keep open"));
		await expect(second.answer).resolves.toBe(false);
		expect(screen.queryByTestId("ready-to-complete")).not.toBeInTheDocument();
	});

	it("shows a loss first and completes only on a second click", async () => {
		vi.mocked(api.request.getUnsavedWork).mockResolvedValue(dirty);
		renderSection();
		const { answer } = await offer("t1");
		let settled = false;
		void answer.then(() => { settled = true; });
		fireEvent.click(screen.getByTestId("ready-to-complete-complete-t1"));
		expect(await screen.findByTestId("ready-to-complete-warning-t1")).toBeInTheDocument();
		await act(async () => {});
		expect(settled).toBe(false);
		fireEvent.click(screen.getByTestId("ready-to-complete-complete-t1"));
		await expect(answer).resolves.toBe(true);
	});

	it("completes all after one confirm, keeping open a task that would lose work", async () => {
		vi.mocked(confirm).mockResolvedValue(true);
		vi.mocked(api.request.getUnsavedWork).mockImplementation(async ({ taskId }) => (taskId === "t2" ? dirty : clean));
		renderSection();
		const first = await offer("t1");
		await offer("t2");
		fireEvent.click(screen.getByTestId("ready-to-complete-all"));
		await expect(first.answer).resolves.toBe(true);
		await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(1));
		expect(screen.getByTestId("ready-to-complete-row-t2")).toBeInTheDocument();
		expect(screen.getByTestId("ready-to-complete-warning-t2")).toBeInTheDocument();
	});

	it("offers no answer for a locked project's task", async () => {
		renderSection([task("t1"), task("t9", "p2")], [project, locked]);
		await offer("t1");
		await offer("t9", "agent", "p2");
		expect(screen.getByTestId("ready-to-complete-row-t9")).toBeInTheDocument();
		expect(screen.queryByTestId("ready-to-complete-complete-t9")).not.toBeInTheDocument();
		// One answerable row is not worth a bulk action.
		expect(screen.queryByTestId("ready-to-complete-all")).not.toBeInTheDocument();
	});

	it("opens the task from its title", async () => {
		const { onOpenTask } = renderSection();
		await offer("t1");
		fireEvent.click(screen.getByText("Task t1"));
		expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }), project);
	});
});

describe("waitingOffers", () => {
	it("leaves out an offer whose task this client has not loaded", () => {
		const ghost = { id: "o1", taskId: "ghost", projectId: "p1", kind: "agent", offeredAt: 1, answer: () => {} } as const;
		expect(waitingOffers([ghost], [project], new Map([["p1", [task("t1")]]]))).toEqual([]);
	});
});
