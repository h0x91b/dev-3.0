import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../../shared/types";

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
}));

vi.mock("../../data", () => ({
	loadProjects: vi.fn(),
	loadVirtualProjects: vi.fn(() => Promise.resolve([])),
	loadTasks: vi.fn(),
}));

vi.mock("../../git", () => ({
	taskDir: vi.fn((_project: Project, task: Task) => `/managed/${task.id.slice(0, 8)}`),
	virtualWorkDir: vi.fn(),
	getCurrentBranch: vi.fn(() => Promise.resolve("fix/active")),
	recoverStaleInitializingWorktrees: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../pty-server", () => ({
	tmuxSessionExists: vi.fn(() => Promise.resolve(true)),
	reattachNativeTaskSession: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../../native-task-terminal", () => ({
	nativeTaskTerminalAlive: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../../tmux", () => ({
	DEFAULT_TMUX_SOCKET: "dev3",
}));

vi.mock("../../rpc-handlers/shared", () => ({
	log: {
		warn: vi.fn(),
	},
}));

vi.mock("../service", () => ({
	dispatchLifecycleEvent: vi.fn(() => Promise.resolve()),
}));

import * as data from "../../data";
import * as git from "../../git";
import { nativeTaskTerminalAlive } from "../../native-task-terminal";
import * as pty from "../../pty-server";
import { dispatchLifecycleEvent } from "../service";
import { rehydrateTaskLifecycles } from "../rehydrate";

function project(): Project {
	return {
		id: "project-1",
		name: "Project",
		path: "/repo",
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2026-07-22T00:00:00.000Z",
	};
}

function task(overrides: Partial<Task>): Task {
	return {
		id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		seq: 1,
		projectId: "project-1",
		title: "Task",
		description: "Task",
		status: "todo",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2026-07-22T00:00:00.000Z",
		updatedAt: "2026-07-22T00:00:00.000Z",
		...overrides,
	};
}

describe("rehydrateTaskLifecycles", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("recovers unowned initializing entries while protecting active worktrees", async () => {
		const currentProject = project();
		const activePath = "/managed/active/worktree";
		const activeTask = task({
			id: "active00-bbbb-cccc-dddd-eeeeeeeeeeee",
			status: "in-progress",
			worktreePath: activePath,
			branchName: "fix/active",
			runtimeState: { runtime: "running", updatedAt: 1 },
		});
		const staleTask = task({ id: "stale000-bbbb-cccc-dddd-eeeeeeeeeeee" });
		vi.mocked(data.loadProjects).mockResolvedValue([currentProject]);
		vi.mocked(data.loadTasks).mockResolvedValue([activeTask, staleTask]);

		await rehydrateTaskLifecycles();

		expect(git.recoverStaleInitializingWorktrees).toHaveBeenCalledTimes(1);
		const [recoveryProject, protectedPaths] = vi.mocked(git.recoverStaleInitializingWorktrees).mock.calls[0];
		expect(recoveryProject).toBe(currentProject);
		expect([...protectedPaths]).toEqual([activePath]);
	});
});

// The boot probe only READS. Attaching here bound a writer client and started an
// idle timer for a session nobody was looking at; the real reattach belongs to
// opening the task.
describe("boot terminal probe", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	function bootReality(): { terminalAlive: boolean } {
		const [, , event] = vi.mocked(dispatchLifecycleEvent).mock.calls[0];
		return (event as { type: "bootObserved"; reality: { terminalAlive: boolean } }).reality;
	}

	async function bootWith(overrides: Partial<Task>): Promise<void> {
		vi.mocked(data.loadProjects).mockResolvedValue([project()]);
		vi.mocked(data.loadTasks).mockResolvedValue([
			task({ status: "in-progress", worktreePath: "/managed/active/worktree", branchName: "fix/active", ...overrides }),
		]);
		await rehydrateTaskLifecycles();
	}

	it("probes a native task for presence instead of reattaching to it", async () => {
		await bootWith({ terminalBackend: "native" });

		expect(nativeTaskTerminalAlive).toHaveBeenCalledTimes(1);
		expect(pty.reattachNativeTaskSession).not.toHaveBeenCalled();
	});

	it("reports what the native probe found", async () => {
		vi.mocked(nativeTaskTerminalAlive).mockResolvedValueOnce(false);

		await bootWith({ terminalBackend: "native" });

		expect(bootReality().terminalAlive).toBe(false);
		expect(pty.tmuxSessionExists).not.toHaveBeenCalled();
	});

	it("keeps tmux has-session as the only probe for an unmarked task", async () => {
		await bootWith({});

		expect(pty.tmuxSessionExists).toHaveBeenCalledTimes(1);
		expect(nativeTaskTerminalAlive).not.toHaveBeenCalled();
		expect(pty.reattachNativeTaskSession).not.toHaveBeenCalled();
		expect(bootReality().terminalAlive).toBe(true);
	});
});
