import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, ResourceUsage, Task, UnsavedWork } from "../../../shared/types";
import { I18nProvider } from "../../i18n";

vi.mock("../../rpc", () => ({ api: { request: { getUnsavedWork: vi.fn(), getAllProjectTasks: vi.fn() } } }));
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
import { _resetCompletionOffersForTests, isCompletionOfferOnScreen, offerCompletion, type CompletionOfferAnswer, type CompletionOfferKind } from "../../completion-offers";
import ReadyToCompleteScreen, { waitingOffers, waitingRss } from "../ReadyToCompleteScreen";
import ReadyToCompleteCard from "../ReadyToCompleteCard";

const alpha = { id: "p1", name: "Alpha", path: "/a" } as Project;
const beta = { id: "p2", name: "Beta", path: "/b" } as Project;
const secret = { id: "p3", name: "Secret", path: "/s", sensitive: true } as Project;
const task = (id: string, projectId = "p1", title = `Task ${id}`) =>
	({ id, projectId, title, seq: Number(id.replace(/\D/g, "").slice(0, 3)) || 1, worktreePath: `/wt/${id}`, branchName: `feat/${id}`, status: "review-by-user" }) as unknown as Task;
const clean = { insertions: 0, deletions: 0, unpushed: 0, ahead: 0 } as UnsavedWork;
const dirty = { insertions: 3, deletions: 1, unpushed: 0, ahead: 0 } as UnsavedWork;
const usage = (entries: Array<[string, number]>) => new Map<string, ResourceUsage>(entries.map(([id, rss]) => [id, { cpu: 1, rss }]));
const MB = 1024 ** 2;

function load(tasks: Task[]) {
	const byProject = new Map<string, Task[]>();
	for (const item of tasks) byProject.set(item.projectId, [...(byProject.get(item.projectId) ?? []), item]);
	vi.mocked(api.request.getAllProjectTasks).mockResolvedValue(
		[...byProject].map(([projectId, list]) => ({ projectId, tasks: list, todoCount: 0 })) as never,
	);
}

async function renderScreen({ tasks = [task("t1"), task("t2")], projects = [alpha], rss = usage([]) }: { tasks?: Task[]; projects?: Project[]; rss?: Map<string, ResourceUsage> } = {}) {
	load(tasks);
	const navigate = vi.fn();
	render(<I18nProvider><ReadyToCompleteScreen projects={projects} usage={rss} navigate={navigate} /></I18nProvider>);
	await act(async () => {});
	return { navigate };
}

async function offer(taskId: string, kind: CompletionOfferKind = "agent", projectId = "p1"): Promise<{ answer: Promise<CompletionOfferAnswer | null> }> {
	let answer!: Promise<CompletionOfferAnswer | null>;
	await act(async () => { answer = offerCompletion({ taskId, projectId, kind, branchName: "feat/x" }); });
	return { answer };
}

const rowIds = () => screen.getAllByTestId(/^completions-row-/).map((row) => row.dataset.testid);

beforeEach(() => {
	vi.mocked(api.request.getUnsavedWork).mockResolvedValue(clean);
});
afterEach(() => {
	_resetCompletionOffersForTests();
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe("ReadyToCompleteScreen", () => {
	it("says nothing waits, and offers the way back", async () => {
		const { navigate } = await renderScreen();
		expect(screen.getByTestId("completions-empty")).toBeInTheDocument();
		fireEvent.click(screen.getByText("Back to dashboard"));
		expect(navigate).toHaveBeenCalledWith({ screen: "dashboard" });
	});

	it("lists every waiting task oldest first, or by memory, with the memory each holds", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		// Usage arrives keyed by the short (8-character) task id.
		const long = "abcdef12-0000-4000-8000-000000000000";
		await renderScreen({ tasks: [task(long), task("t2")], rss: usage([["abcdef12", 512 * MB], ["t2", 64 * MB]]) });
		vi.setSystemTime(2_000_000);
		await offer(long, "merge");
		vi.setSystemTime(1_000_000);
		await offer("t2");
		expect(rowIds()).toEqual(["completions-row-t2", `completions-row-${long}`]);
		expect(screen.getByTestId(`completions-row-${long}`)).toHaveTextContent("512 MB");
		expect(screen.getByTestId("completions-row-t2")).toHaveTextContent("#2");
		expect(screen.getByText(/576 MB/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("combobox", { name: "Sort" }));
		fireEvent.click(await screen.findByRole("option", { name: "Most memory" }));
		expect(rowIds()).toEqual([`completions-row-${long}`, "completions-row-t2"]);
	});

	it("filters by search and by project", async () => {
		await renderScreen({ tasks: [task("t1", "p1", "Fix login"), task("t2", "p2", "Ship docs")], projects: [alpha, beta] });
		await offer("t1");
		await offer("t2", "agent", "p2");
		fireEvent.change(screen.getByLabelText("Search tasks and projects"), { target: { value: "login" } });
		expect(rowIds()).toEqual(["completions-row-t1"]);
		fireEvent.change(screen.getByLabelText("Search tasks and projects"), { target: { value: "beta" } });
		expect(rowIds()).toEqual(["completions-row-t2"]);
		fireEvent.change(screen.getByLabelText("Search tasks and projects"), { target: { value: "nothing" } });
		expect(screen.getByTestId("completions-no-match")).toBeInTheDocument();
	});

	it("asks a row in the same modal as the Dialog style, and Keep open answers no", async () => {
		vi.mocked(confirm).mockResolvedValue(true);
		await renderScreen();
		const first = await offer("t1");
		const second = await offer("t2", "merge");
		fireEvent.click(screen.getByTestId("completions-complete-t1"));
		await expect(first.answer).resolves.toBe(true);
		const options = vi.mocked(confirm).mock.calls[0]![0];
		expect(options).toMatchObject({ agentInitiated: true, danger: true, dismissOnBackdrop: false });
		expect(options.deferred?.gateConfirm).toBe(true);
		fireEvent.click(screen.getByText("Keep open"));
		await expect(second.answer).resolves.toBe(false);
		expect(screen.getByTestId("completions-empty")).toBeInTheDocument();
	});

	it("leaves the row waiting when the modal is declined", async () => {
		vi.mocked(confirm).mockResolvedValue(false);
		await renderScreen();
		const { answer } = await offer("t1");
		fireEvent.click(screen.getByTestId("completions-complete-t1"));
		await expect(answer).resolves.toBe(false);
	});

	it("completes the selection after one confirm, keeping open a task that would lose work", async () => {
		vi.mocked(confirm).mockResolvedValue(true);
		vi.mocked(api.request.getUnsavedWork).mockImplementation(async ({ taskId }) => (taskId === "t2" ? dirty : clean));
		await renderScreen({ tasks: [task("t1"), task("t2"), task("t3")] });
		const first = await offer("t1");
		await offer("t2");
		const third = await offer("t3");
		fireEvent.click(screen.getByTestId("completions-select-all"));
		fireEvent.click(screen.getByTestId("completions-complete-selected"));
		await expect(first.answer).resolves.toBe(true);
		await expect(third.answer).resolves.toBe(true);
		await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(1));
		expect(rowIds()).toEqual(["completions-row-t2"]);
		expect(screen.getByTestId("completions-warning-t2")).toBeInTheDocument();
	});

	it("names at most twelve tasks in the confirm, however many are selected", async () => {
		vi.mocked(confirm).mockResolvedValue(false);
		const many = Array.from({ length: 20 }, (_, i) => task(`t${i}`));
		await renderScreen({ tasks: many });
		for (const item of many) await offer(item.id);
		fireEvent.click(screen.getByTestId("completions-select-all"));
		fireEvent.click(screen.getByTestId("completions-complete-selected"));
		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
		const { message, title } = vi.mocked(confirm).mock.calls[0]![0];
		expect(title).toBe("Complete 20 tasks?");
		expect(message.match(/^• /gm)).toHaveLength(12);
		expect(message).toContain("…and 8 more");
		// Scratch tasks share titles, so each name carries its task number.
		expect(message).toContain("• #3 Task t3");
	});

	it("offers no answer for a locked project's task", async () => {
		await renderScreen({ tasks: [task("t1"), task("t9", "p3")], projects: [alpha, secret] });
		await offer("t1");
		await offer("t9", "agent", "p3");
		expect(screen.getByTestId("completions-row-t9")).toBeInTheDocument();
		expect(screen.queryByTestId("completions-complete-t9")).not.toBeInTheDocument();
	});

	it("opens a task from its title", async () => {
		const { navigate } = await renderScreen();
		await offer("t1");
		fireEvent.click(screen.getByText("Task t1"));
		expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p1", activeTaskId: "t1" });
	});

	it("counts as on screen while mounted, so offers raise no toast", async () => {
		expect(isCompletionOfferOnScreen("t1")).toBe(false);
		await renderScreen();
		expect(isCompletionOfferOnScreen("t1")).toBe(true);
	});
});

describe("ReadyToCompleteCard", () => {
	it("is hidden while nothing waits, and names the count and memory otherwise", async () => {
		const navigate = vi.fn();
		render(<I18nProvider><ReadyToCompleteCard usage={usage([["t1", 300 * MB]])} navigate={navigate} /></I18nProvider>);
		expect(screen.queryByTestId("dashboard-ready-to-complete")).not.toBeInTheDocument();
		await offer("t1");
		await offer("t2", "merge");
		const card = screen.getByTestId("dashboard-ready-to-complete");
		expect(card).toHaveTextContent("2 tasks ready to complete");
		expect(card).toHaveTextContent("300 MB");
		fireEvent.click(card);
		expect(navigate).toHaveBeenCalledWith({ screen: "completions" });
	});
});

describe("waitingOffers", () => {
	it("leaves out an offer whose task this client has not loaded", () => {
		const ghost = { id: "o1", taskId: "ghost", projectId: "p1", kind: "agent", offeredAt: 1, answer: () => {} } as const;
		expect(waitingOffers([ghost], [alpha], new Map([["p1", [task("t1")]]]))).toEqual([]);
		expect(waitingRss([ghost], usage([["ghost", 5]]))).toBe(5);
	});
});
