import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import StuckPreparationPopover, { computePosition, pickStuckTask } from "../StuckPreparationPopover";
import { I18nProvider } from "../../i18n";
import type { Task } from "../../../shared/types";
import { STUCK_PREPARATION_FETCH_THRESHOLD_MS } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			openSystemSettings: vi.fn().mockResolvedValue({ ok: true }),
			cancelTaskPreparation: vi.fn().mockResolvedValue({}),
			// Default 60_000 mirrors STUCK_PREPARATION_FETCH_THRESHOLD_MS — kept
			// inline because vi.mock hoists and cannot reference imports.
			getStuckPreparationThresholdMs: vi.fn().mockResolvedValue({ ms: 60_000 }),
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

function makeAnchor(taskId: string) {
	const el = document.createElement("div");
	el.setAttribute("data-task-id", taskId);
	el.style.position = "fixed";
	el.style.top = "100px";
	el.style.left = "100px";
	el.style.width = "200px";
	el.style.height = "120px";
	document.body.appendChild(el);
	return el;
}

function renderPopover(tasks: Task[], forcePlatformMac = true) {
	return render(
		<I18nProvider>
			<StuckPreparationPopover tasks={tasks} forcePlatformMac={forcePlatformMac} />
		</I18nProvider>,
	);
}

beforeEach(() => {
	document.body.innerHTML = "";
	mockedApi.request.openSystemSettings.mockClear();
	mockedApi.request.cancelTaskPreparation.mockClear();
	mockedApi.request.getStuckPreparationThresholdMs.mockClear();
});

describe("pickStuckTask", () => {
	const now = Date.parse("2026-05-18T12:00:00Z");
	const stuckStart = new Date(now - STUCK_PREPARATION_FETCH_THRESHOLD_MS - 30_000).toISOString();
	const freshStart = new Date(now - 30_000).toISOString();

	it("returns null when no task is preparing", () => {
		expect(pickStuckTask([makeTask()], now, new Set())).toBeNull();
	});

	it("returns null when stage is not fetching-origin", () => {
		const task = makeTask({ preparing: true, preparingStage: "creating-worktree", preparingStartedAt: stuckStart });
		expect(pickStuckTask([task], now, new Set())).toBeNull();
	});

	it("returns null when under threshold", () => {
		const task = makeTask({ preparing: true, preparingStage: "fetching-origin", preparingStartedAt: freshStart });
		expect(pickStuckTask([task], now, new Set())).toBeNull();
	});

	it("returns the task when stuck past threshold", () => {
		const task = makeTask({ preparing: true, preparingStage: "fetching-origin", preparingStartedAt: stuckStart });
		expect(pickStuckTask([task], now, new Set())?.id).toBe(task.id);
	});

	it("respects a custom threshold override", () => {
		const task = makeTask({ preparing: true, preparingStage: "fetching-origin", preparingStartedAt: isoAgoMs(45_000) });
		const customNow = Date.now();
		expect(pickStuckTask([task], customNow, new Set(), 30_000)?.id).toBe(task.id);
		expect(pickStuckTask([task], customNow, new Set(), 60_000)).toBeNull();
	});

	it("ignores dismissed tasks", () => {
		const task = makeTask({ id: "x", preparing: true, preparingStage: "fetching-origin", preparingStartedAt: stuckStart });
		expect(pickStuckTask([task], now, new Set(["x"]))).toBeNull();
	});

	it("picks the oldest stuck task", () => {
		const older = makeTask({ id: "older", preparing: true, preparingStage: "fetching-origin", preparingStartedAt: new Date(now - 5 * 60_000).toISOString() });
		const newer = makeTask({ id: "newer", preparing: true, preparingStage: "fetching-origin", preparingStartedAt: stuckStart });
		expect(pickStuckTask([newer, older], now, new Set())?.id).toBe("older");
	});
});

describe("computePosition", () => {
	beforeEach(() => {
		Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
		Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
	});

	it("places popover to the right when there is room", () => {
		const rect = { top: 100, bottom: 220, left: 200, right: 400, width: 200, height: 120 } as DOMRect;
		const pos = computePosition(rect);
		expect(pos.left).toBeGreaterThan(rect.right);
		expect(pos.top).toBe(100);
	});

	it("flips to the left when right is full but left fits", () => {
		const rect = { top: 60, bottom: 180, left: 950, right: 1250, width: 300, height: 120 } as DOMRect;
		const pos = computePosition(rect);
		expect(pos.left).toBeLessThan(rect.left);
		expect(pos.top).toBe(60);
	});

	it("flips below when neither side fits", () => {
		const rect = { top: 60, bottom: 180, left: 200, right: 1100, width: 900, height: 120 } as DOMRect;
		const pos = computePosition(rect);
		expect(pos.top).toBeGreaterThan(rect.bottom);
	});
});

describe("StuckPreparationPopover", () => {
	it("does not render on non-mac platforms", () => {
		makeAnchor("task-aaaaaaaa");
		const task = makeTask({ preparing: true, preparingStage: "fetching-origin", preparingStartedAt: isoAgoMs(STUCK_PREPARATION_FETCH_THRESHOLD_MS + 30_000) });
		renderPopover([task], false);
		expect(document.querySelector("[data-stuck-preparation-popover]")).toBeNull();
	});

	it("does not render when no task is stuck", async () => {
		makeAnchor("task-aaaaaaaa");
		const task = makeTask({ preparing: true, preparingStage: "fetching-origin", preparingStartedAt: isoAgoMs(15_000) });
		renderPopover([task]);
		await new Promise((r) => setTimeout(r, 50));
		expect(document.querySelector("[data-stuck-preparation-popover]")).toBeNull();
	});

	it("renders when a task is stuck past threshold and the card is in DOM", async () => {
		makeAnchor("task-aaaaaaaa");
		const task = makeTask({ preparing: true, preparingStage: "fetching-origin", preparingStartedAt: isoAgoMs(STUCK_PREPARATION_FETCH_THRESHOLD_MS + 30_000) });
		renderPopover([task]);
		await waitFor(() => {
			expect(document.querySelector("[data-stuck-preparation-popover]")).not.toBeNull();
		});
	});

	it("does not render if the anchor card is missing", async () => {
		const task = makeTask({ preparing: true, preparingStage: "fetching-origin", preparingStartedAt: isoAgoMs(STUCK_PREPARATION_FETCH_THRESHOLD_MS + 30_000) });
		renderPopover([task]);
		await new Promise((r) => setTimeout(r, 100));
		expect(document.querySelector("[data-stuck-preparation-popover]")).toBeNull();
	});

	it("calls openSystemSettings when the FDA button is clicked", async () => {
		makeAnchor("task-aaaaaaaa");
		const task = makeTask({ preparing: true, preparingStage: "fetching-origin", preparingStartedAt: isoAgoMs(STUCK_PREPARATION_FETCH_THRESHOLD_MS + 30_000) });
		const user = userEvent.setup();
		renderPopover([task]);
		const btn = await screen.findByTestId("stuck-prep-popover-open-settings");
		await user.click(btn);
		expect(mockedApi.request.openSystemSettings).toHaveBeenCalledWith({ pane: "fullDiskAccess" });
		await waitFor(() => {
			expect(document.querySelector("[data-stuck-preparation-popover]")).toBeNull();
		});
	});

	it("calls cancelTaskPreparation when the Cancel button is clicked", async () => {
		makeAnchor("task-aaaaaaaa");
		const task = makeTask({ preparing: true, preparingStage: "fetching-origin", preparingStartedAt: isoAgoMs(STUCK_PREPARATION_FETCH_THRESHOLD_MS + 30_000) });
		const user = userEvent.setup();
		renderPopover([task]);
		const btn = await screen.findByTestId("stuck-prep-popover-cancel");
		await user.click(btn);
		expect(mockedApi.request.cancelTaskPreparation).toHaveBeenCalledWith({
			taskId: task.id,
			projectId: task.projectId,
		});
		await waitFor(() => {
			expect(document.querySelector("[data-stuck-preparation-popover]")).toBeNull();
		});
	});

	it("does not dismiss on Escape", async () => {
		makeAnchor("task-aaaaaaaa");
		const task = makeTask({ preparing: true, preparingStage: "fetching-origin", preparingStartedAt: isoAgoMs(STUCK_PREPARATION_FETCH_THRESHOLD_MS + 30_000) });
		const user = userEvent.setup();
		renderPopover([task]);
		await waitFor(() => {
			expect(document.querySelector("[data-stuck-preparation-popover]")).not.toBeNull();
		});
		await user.keyboard("{Escape}");
		expect(document.querySelector("[data-stuck-preparation-popover]")).not.toBeNull();
	});

	it("disappears when the underlying task stops preparing", async () => {
		makeAnchor("task-aaaaaaaa");
		const task = makeTask({ preparing: true, preparingStage: "fetching-origin", preparingStartedAt: isoAgoMs(STUCK_PREPARATION_FETCH_THRESHOLD_MS + 30_000) });
		const { rerender } = renderPopover([task]);
		await waitFor(() => {
			expect(document.querySelector("[data-stuck-preparation-popover]")).not.toBeNull();
		});
		const done = makeTask({ ...task, preparing: false, preparingStage: null, preparingStartedAt: null });
		rerender(
			<I18nProvider>
				<StuckPreparationPopover tasks={[done]} forcePlatformMac />
			</I18nProvider>,
		);
		await waitFor(() => {
			expect(document.querySelector("[data-stuck-preparation-popover]")).toBeNull();
		});
	});

	it("uses an env-overridden threshold from the RPC", async () => {
		makeAnchor("task-aaaaaaaa");
		mockedApi.request.getStuckPreparationThresholdMs.mockResolvedValueOnce({ ms: 10_000 });
		const task = makeTask({ preparing: true, preparingStage: "fetching-origin", preparingStartedAt: isoAgoMs(15_000) });
		// 15s elapsed — under default 60s, over the env-overridden 10s.
		renderPopover([task]);
		await waitFor(() => {
			expect(document.querySelector("[data-stuck-preparation-popover]")).not.toBeNull();
		});
	});

	it("becomes stuck after the timer ticks past the threshold", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			makeAnchor("task-aaaaaaaa");
			const task = makeTask({ preparing: true, preparingStage: "fetching-origin", preparingStartedAt: isoAgoMs(30_000) });
			renderPopover([task]);
			expect(document.querySelector("[data-stuck-preparation-popover]")).toBeNull();
			act(() => {
				vi.advanceTimersByTime(STUCK_PREPARATION_FETCH_THRESHOLD_MS);
			});
			await waitFor(() => {
				expect(document.querySelector("[data-stuck-preparation-popover]")).not.toBeNull();
			});
		} finally {
			vi.useRealTimers();
		}
	});
});
