import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { orderByMru, useTaskSwitcher } from "../useTaskSwitcher";
import { isMac } from "../../utils/platform";
import { api } from "../../rpc";
import type { Task, TaskStatus } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAllProjectTasks: vi.fn().mockResolvedValue([]),
			getTerminalPreview: vi.fn().mockResolvedValue(""),
		},
	},
}));

function task(id: string, seq: number, status: TaskStatus = "in-progress"): Task {
	return {
		id,
		seq,
		projectId: "p1",
		title: id.toUpperCase(),
		description: "",
		status,
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "",
		updatedAt: "",
	} as Task;
}

const MOD = isMac() ? { altKey: true } : { ctrlKey: true };
const RELEASE_KEY = isMac() ? "Alt" : "Control";

function keydown(opts: KeyboardEventInit) {
	act(() => {
		window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...opts }));
	});
}
function keyup(opts: KeyboardEventInit) {
	act(() => {
		window.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, ...opts }));
	});
}

function mount(overrides: Partial<Parameters<typeof useTaskSwitcher>[0]> = {}) {
	const navigate = vi.fn();
	const args = {
		projectTasks: [task("a", 1), task("b", 2), task("c", 3)],
		currentProjectId: "p1",
		currentTaskId: "a",
		mru: ["a", "b"],
		navigate,
		...overrides,
	};
	const view = renderHook(() => useTaskSwitcher(args));
	return { ...view, navigate };
}

beforeEach(() => {
	localStorage.clear();
	vi.mocked(api.request.getAllProjectTasks).mockResolvedValue([]);
});
afterEach(() => {
	cleanup();
});

describe("orderByMru", () => {
	it("orders by MRU first, then never-visited by descending seq", () => {
		const candidates = [task("a", 1), task("b", 2), task("c", 3)];
		expect(orderByMru(candidates, ["c", "a"]).map((t) => t.id)).toEqual(["c", "a", "b"]);
	});

	it("ignores MRU ids that are not candidates", () => {
		const candidates = [task("a", 1), task("b", 2)];
		expect(orderByMru(candidates, ["zzz", "b"]).map((t) => t.id)).toEqual(["b", "a"]);
	});
});

describe("useTaskSwitcher", () => {
	it("opens on the modifier+Tab with MRU order, landing on the previous task", () => {
		const { result } = mount();
		keydown({ key: "Tab", ...MOD });
		expect(result.current.session).not.toBeNull();
		expect(result.current.session!.scope).toBe("project");
		expect(result.current.session!.items.map((t) => t.id)).toEqual(["a", "b", "c"]);
		// current task is "a" (items[0]) → start on the previous one (index 1 = "b")
		expect(result.current.session!.index).toBe(1);
	});

	it("opens in global scope across projects when Shift is held", async () => {
		vi.mocked(api.request.getAllProjectTasks).mockResolvedValue([
			{ projectId: "p1", tasks: [task("a", 1), task("x", 5)] },
		]);
		const { result } = mount();
		// let the mount-time global fetch resolve and populate the snapshot
		await act(async () => {
			await Promise.resolve();
		});
		keydown({ key: "Tab", ...MOD, shiftKey: true });
		expect(result.current.session?.scope).toBe("global");
		expect(result.current.session!.items.map((t) => t.id)).toContain("x");
	});

	it("advances forward with Tab and wraps around", () => {
		const { result } = mount();
		keydown({ key: "Tab", ...MOD }); // index 1
		keydown({ key: "Tab", ...MOD }); // index 2
		expect(result.current.session!.index).toBe(2);
		keydown({ key: "Tab", ...MOD }); // wraps to 0
		expect(result.current.session!.index).toBe(0);
	});

	it("moves both directions with arrows", () => {
		const { result } = mount();
		keydown({ key: "Tab", ...MOD }); // index 1
		keydown({ key: "ArrowUp" });
		expect(result.current.session!.index).toBe(0);
		keydown({ key: "ArrowDown" });
		expect(result.current.session!.index).toBe(1);
	});

	it("commits on modifier release (split mode by default)", () => {
		const { result, navigate } = mount();
		keydown({ key: "Tab", ...MOD }); // selects "b"
		keyup({ key: RELEASE_KEY });
		expect(result.current.session).toBeNull();
		expect(navigate).toHaveBeenCalledWith({
			screen: "project",
			projectId: "p1",
			activeTaskId: "b",
		});
	});

	it("commits to a full-page task route in fullscreen mode", () => {
		localStorage.setItem("dev3-task-open-mode", "fullscreen");
		const { navigate } = mount();
		keydown({ key: "Tab", ...MOD });
		keyup({ key: RELEASE_KEY });
		expect(navigate).toHaveBeenCalledWith({ screen: "task", projectId: "p1", taskId: "b" });
	});

	it("commits via Enter", () => {
		const { result, navigate } = mount();
		keydown({ key: "Tab", ...MOD });
		keydown({ key: "Enter" });
		expect(result.current.session).toBeNull();
		expect(navigate).toHaveBeenCalledTimes(1);
	});

	it("cancels on Escape without navigating", () => {
		const { result, navigate } = mount();
		keydown({ key: "Tab", ...MOD });
		keydown({ key: "Escape" });
		expect(result.current.session).toBeNull();
		expect(navigate).not.toHaveBeenCalled();
	});

	it("does not open when there are no active tasks", () => {
		const { result } = mount({
			projectTasks: [task("a", 1, "todo"), task("b", 2, "completed")],
		});
		keydown({ key: "Tab", ...MOD });
		expect(result.current.session).toBeNull();
	});

	it("starts at index 0 when not currently inside a task", () => {
		const { result } = mount({ currentTaskId: null });
		keydown({ key: "Tab", ...MOD });
		expect(result.current.session!.index).toBe(0);
	});
});
