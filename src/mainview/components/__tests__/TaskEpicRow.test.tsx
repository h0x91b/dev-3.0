import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskEpicRow from "../TaskEpicRow";
import { I18nProvider } from "../../i18n";
import type { Epic, Task } from "../../../shared/types";
import { _resetEpicStoresForTest } from "../../hooks/useEpics";
import { api } from "../../rpc";

const registry = vi.hoisted(() => ({ epics: [] as Epic[] }));

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getEpics: vi.fn(async () => ({ version: 1, epics: registry.epics })),
			setTaskEpic: vi.fn(async () => ({})),
			createEpic: vi.fn(async ({ name }: { name: string }) => ({ id: "new-epic-0000", name, color: "#14b8a6", archived: false, createdAt: 0 })),
		},
	},
}));
vi.mock("../../toast", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const PAYMENTS: Epic = { id: "epicpay1-0000", name: "Payments v2", color: "#3b82f6", archived: false, createdAt: 0 };
const OLD: Epic = { id: "epicold1-0000", name: "Old effort", color: "#ef4444", archived: true, createdAt: 0 };

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "task-1", seq: 1, projectId: "p1", title: "T", description: "T", status: "todo", baseBranch: "main",
		worktreePath: null, branchName: null, groupId: null, variantIndex: null, agentId: null, configId: null,
		createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z", ...overrides,
	};
}

async function renderRow(task: Task) {
	await act(async () => {
		render(<I18nProvider><div className="grid"><TaskEpicRow task={task} /></div></I18nProvider>);
	});
}

describe("TaskEpicRow", () => {
	beforeEach(() => {
		_resetEpicStoresForTest();
		vi.clearAllMocks();
		registry.epics = [PAYMENTS, OLD];
	});

	it("sets an epic on a task that has none, and never offers an archived one", async () => {
		await renderRow(makeTask());
		await userEvent.click(screen.getByRole("button", { name: "Change epic" }));
		expect(screen.queryByRole("option", { name: /Old effort/ })).toBeNull();
		await userEvent.click(screen.getByRole("option", { name: /Payments v2/ }));
		expect(api.request.setTaskEpic).toHaveBeenCalledWith({ projectId: "p1", taskId: "task-1", epicId: PAYMENTS.id });
	});

	it("clears the epic", async () => {
		await renderRow(makeTask({ epicId: PAYMENTS.id }));
		expect(screen.getByRole("button", { name: "Change epic" }).textContent).toContain("Payments v2");
		await userEvent.click(screen.getByRole("button", { name: "Change epic" }));
		await userEvent.click(screen.getByRole("option", { name: "No epic" }));
		expect(api.request.setTaskEpic).toHaveBeenCalledWith({ projectId: "p1", taskId: "task-1", epicId: null });
	});

	it("keeps showing an archived epic the task already has", async () => {
		await renderRow(makeTask({ epicId: OLD.id }));
		expect(screen.getByRole("button", { name: "Change epic" }).textContent).toContain("Old effort");
	});

	it("creates an epic from a typed name and puts the task in it", async () => {
		await renderRow(makeTask());
		await userEvent.click(screen.getByRole("button", { name: "Change epic" }));
		await userEvent.type(screen.getByRole("combobox"), "Search revamp{Enter}");
		expect(api.request.createEpic).toHaveBeenCalledWith({ name: "Search revamp" });
		expect(api.request.setTaskEpic).toHaveBeenCalledWith({ projectId: "p1", taskId: "task-1", epicId: "new-epic-0000" });
	});
});
