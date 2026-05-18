import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import StuckPreparationModal, { pickStuckTask } from "../StuckPreparationModal";
import { I18nProvider } from "../../i18n";
import type { Task } from "../../../shared/types";
import { STUCK_PREPARATION_FETCH_THRESHOLD_MS } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			openSystemSettings: vi.fn().mockResolvedValue({ ok: true }),
		},
	},
}));

import { api } from "../../rpc";
const mockedApi = vi.mocked(api, true);

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "task-aaaaaaaa",
		seq: 1,
		projectId: "proj-1",
		title: "Fix login",
		description: "Fix login",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2026-05-18T10:00:00Z",
		updatedAt: "2026-05-18T10:00:00Z",
		...overrides,
	};
}

function isoAgoMs(ms: number): string {
	return new Date(Date.now() - ms).toISOString();
}

function renderModal(tasks: Task[]) {
	return render(
		<I18nProvider>
			<StuckPreparationModal tasks={tasks} />
		</I18nProvider>,
	);
}

describe("pickStuckTask", () => {
	const now = Date.parse("2026-05-18T12:00:00Z");
	const stuckStart = new Date(now - STUCK_PREPARATION_FETCH_THRESHOLD_MS - 30_000).toISOString();
	const freshStart = new Date(now - 60_000).toISOString();

	it("returns null when no task is preparing", () => {
		expect(pickStuckTask([makeTask()], now, new Set())).toBeNull();
	});

	it("returns null when stage is not fetching-origin", () => {
		const task = makeTask({ preparing: true, preparingStage: "creating-worktree", preparingStartedAt: stuckStart });
		expect(pickStuckTask([task], now, new Set())).toBeNull();
	});

	it("returns null when fetching-origin but not yet over threshold", () => {
		const task = makeTask({ preparing: true, preparingStage: "fetching-origin", preparingStartedAt: freshStart });
		expect(pickStuckTask([task], now, new Set())).toBeNull();
	});

	it("returns the task when stuck on fetching-origin past threshold", () => {
		const task = makeTask({ preparing: true, preparingStage: "fetching-origin", preparingStartedAt: stuckStart });
		expect(pickStuckTask([task], now, new Set())?.id).toBe(task.id);
	});

	it("ignores tasks in the dismissed set", () => {
		const task = makeTask({ id: "x", preparing: true, preparingStage: "fetching-origin", preparingStartedAt: stuckStart });
		expect(pickStuckTask([task], now, new Set(["x"]))).toBeNull();
	});

	it("picks the task with the oldest preparingStartedAt", () => {
		const oldStart = new Date(now - STUCK_PREPARATION_FETCH_THRESHOLD_MS - 5 * 60_000).toISOString();
		const newerStart = new Date(now - STUCK_PREPARATION_FETCH_THRESHOLD_MS - 60_000).toISOString();
		const older = makeTask({ id: "older", preparing: true, preparingStage: "fetching-origin", preparingStartedAt: oldStart });
		const newer = makeTask({ id: "newer", preparing: true, preparingStage: "fetching-origin", preparingStartedAt: newerStart });
		expect(pickStuckTask([newer, older], now, new Set())?.id).toBe("older");
	});
});

describe("StuckPreparationModal", () => {
	beforeEach(() => {
		mockedApi.request.openSystemSettings.mockClear();
	});

	it("does not render when no task is stuck", () => {
		const task = makeTask({ preparing: true, preparingStage: "fetching-origin", preparingStartedAt: isoAgoMs(30_000) });
		renderModal([task]);
		expect(document.querySelector("[data-stuck-preparation-modal]")).toBeNull();
	});

	it("renders when a task has been fetching-origin past the threshold", () => {
		const task = makeTask({ preparing: true, preparingStage: "fetching-origin", preparingStartedAt: isoAgoMs(STUCK_PREPARATION_FETCH_THRESHOLD_MS + 30_000) });
		renderModal([task]);
		expect(document.querySelector("[data-stuck-preparation-modal]")).not.toBeNull();
		expect(screen.getByTestId("stuck-prep-intro").textContent).toContain("Fix login");
	});

	it("disappears after dismiss", async () => {
		const task = makeTask({ preparing: true, preparingStage: "fetching-origin", preparingStartedAt: isoAgoMs(STUCK_PREPARATION_FETCH_THRESHOLD_MS + 30_000) });
		const user = userEvent.setup();
		renderModal([task]);
		expect(document.querySelector("[data-stuck-preparation-modal]")).not.toBeNull();
		const dismiss = screen.getAllByRole("button", { name: /dismiss|cerrar|закрыть/i })[0];
		await user.click(dismiss);
		expect(document.querySelector("[data-stuck-preparation-modal]")).toBeNull();
	});

	it("disappears when the task is no longer preparing", () => {
		const task = makeTask({ preparing: true, preparingStage: "fetching-origin", preparingStartedAt: isoAgoMs(STUCK_PREPARATION_FETCH_THRESHOLD_MS + 30_000) });
		const { rerender } = renderModal([task]);
		expect(document.querySelector("[data-stuck-preparation-modal]")).not.toBeNull();
		const done = makeTask({ ...task, preparing: false, preparingStage: null, preparingStartedAt: null });
		rerender(
			<I18nProvider>
				<StuckPreparationModal tasks={[done]} />
			</I18nProvider>,
		);
		expect(document.querySelector("[data-stuck-preparation-modal]")).toBeNull();
	});

	it("does not render for a fetching task that is still under threshold", () => {
		vi.useFakeTimers({ shouldAdvanceTime: false });
		try {
			const task = makeTask({ preparing: true, preparingStage: "fetching-origin", preparingStartedAt: isoAgoMs(60_000) });
			renderModal([task]);
			expect(document.querySelector("[data-stuck-preparation-modal]")).toBeNull();
			act(() => {
				vi.advanceTimersByTime(STUCK_PREPARATION_FETCH_THRESHOLD_MS);
			});
			expect(document.querySelector("[data-stuck-preparation-modal]")).not.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("calls openSystemSettings when the FDA button is present and clicked", async () => {
		// jsdom navigator.platform on Linux CI is "Linux x86_64" — emulate macOS.
		const originalPlatform = navigator.platform;
		Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
		try {
			const task = makeTask({ preparing: true, preparingStage: "fetching-origin", preparingStartedAt: isoAgoMs(STUCK_PREPARATION_FETCH_THRESHOLD_MS + 30_000) });
			const user = userEvent.setup();
			renderModal([task]);
			const btn = screen.getByTestId("stuck-prep-open-settings");
			await user.click(btn);
			expect(mockedApi.request.openSystemSettings).toHaveBeenCalledWith({ pane: "fullDiskAccess" });
		} finally {
			Object.defineProperty(navigator, "platform", { value: originalPlatform, configurable: true });
		}
	});
});
