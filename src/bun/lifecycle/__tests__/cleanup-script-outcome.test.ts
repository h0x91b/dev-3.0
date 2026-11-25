/**
 * A failing cleanup script shows an error toast and a task note, never blocks
 * teardown. The tmux client exits 0 regardless, so the verdict is the status file.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../../shared/types";

const tempRoot = vi.hoisted(() => ({ dir: "" }));

vi.mock("../../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../temp-paths", () => ({
	dev3TaskTempPath: vi.fn((taskId: string, suffix?: string) => `${tempRoot.dir}/dev3-${taskId}${suffix ? `-${suffix}` : ""}`),
	dev3TempPath: vi.fn((name: string) => `${tempRoot.dir}/${name}`),
}));
vi.mock("../../paths", () => ({ DEV3_HOME: "/home/.dev3.0", OPS_DIR: "/home/.dev3.0/ops" }));
vi.mock("../../shell-env", () => ({ getUserShell: vi.fn(() => "/bin/bash") }));
vi.mock("../../tmux", () => ({
	DEFAULT_TMUX_SOCKET: "dev3",
	activeTmuxConfigPath: vi.fn(() => "/tmp/dev3.tmux.conf"),
	cleanupSessionName: vi.fn((taskId: string) => `dev3-cleanup-${taskId.slice(0, 8)}`),
	tmux: {
		killSession: vi.fn(async () => undefined),
		hasSession: vi.fn(async () => true),
		spawnAttachedSession: vi.fn(),
	},
}));
vi.mock("../../rpc-handlers/settings-config", () => ({
	resolveOperationalProjectConfig: vi.fn(async () => ({ cleanupScript: "docker compose down", env: {} })),
}));
vi.mock("../../rpc-handlers/tmux-pty", () => ({
	cleanupTaskTmuxState: vi.fn(),
	killDevServerSession: vi.fn(async () => undefined),
	launchColumnAgent: vi.fn(async () => undefined),
	launchTaskPty: vi.fn(async () => undefined),
}));
vi.mock("../../rpc-handlers/shared", () => ({
	buildScriptRunnerCommand: vi.fn((path: string) => `/bin/bash ${path}`),
	buildTaskLifecycleEnv: vi.fn(() => ({})),
	getPushMessage: vi.fn(() => null),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	notifyWatchedTaskEvent: vi.fn(),
	notifyWatchedTaskStatusChange: vi.fn(),
	pushCliAttention: vi.fn(),
	pushCliToast: vi.fn(),
	dropQueuedQuestionsAttention: vi.fn(),
}));
vi.mock("../../board-operations/task-notes", () => ({ addNote: vi.fn(async () => ({})) }));
vi.mock("../../board-operations/runtime", () => ({ boardPorts: {} }));
vi.mock("../../board-operations/types", () => ({ AGENT_ACTOR: { kind: "agent" } }));

import { pushCliAttention, pushCliToast } from "../../rpc-handlers/shared";
import { addNote } from "../../board-operations/task-notes";
import { tmux } from "../../tmux";
import { CLEANUP_SCRIPT_HARD_TIMEOUT_MS, runCleanupScript } from "../executor";
import { buildCleanupWrapper, cleanupScriptFiles, readCleanupExitCode, readCleanupLogTail } from "../cleanup-script-run";
import { launchDialect } from "../../../shared/platform-launch";

const TASK_ID = "aabbccdd-1111-2222-3333-444444444444";

function project(): Project {
	return {
		id: "proj-1",
		name: "Project",
		path: "/repo",
		setupScript: "",
		devScript: "",
		cleanupScript: "docker compose down",
		defaultBaseBranch: "main",
		createdAt: "2026-07-01T00:00:00.000Z",
	};
}

function task(): Task {
	return {
		id: TASK_ID,
		seq: 7,
		projectId: "proj-1",
		title: "Task",
		description: "Task",
		status: "completed",
		baseBranch: "main",
		worktreePath: tempRoot.dir,
		tmuxSocket: "dev3",
	} as unknown as Task;
}

/** Stands in for the tmux client: the wrapper's side effects, then the client exit. */
function fakeSession(opts: { status?: string; log?: string; clientExit?: number }): void {
	vi.mocked(tmux.spawnAttachedSession).mockImplementation(() => {
		const files = cleanupScriptFiles(TASK_ID);
		if (opts.status !== undefined) writeFileSync(files.status, opts.status);
		if (opts.log !== undefined) writeFileSync(files.log, opts.log);
		return { exited: Promise.resolve(opts.clientExit ?? 0), kill: vi.fn() } as unknown as ReturnType<typeof tmux.spawnAttachedSession>;
	});
}

const transitionTo = (toStatus: "completed" | "deleted") => ({ fromStatus: "review-by-user" as const, toStatus });

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(tmux.hasSession).mockResolvedValue(true);
	tempRoot.dir = mkdtempSync(join(tmpdir(), "dev3-cleanup-outcome-"));
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(tempRoot.dir, { recursive: true, force: true });
});

describe("cleanup script outcome", () => {
	it("stays quiet when the script exits 0", async () => {
		fakeSession({ status: "0", log: "done\n" });

		await runCleanupScript(task(), project(), transitionTo("completed"));

		expect(pushCliToast).not.toHaveBeenCalled();
		expect(addNote).not.toHaveBeenCalled();
	});

	it("toasts and notes the exit code and the output tail when the script fails", async () => {
		fakeSession({ status: "3", log: "\u001b[31mdocker: no such network\u001b[0m\n" });

		await runCleanupScript(task(), project(), transitionTo("completed"));

		expect(pushCliToast).toHaveBeenCalledWith(expect.objectContaining({
			taskId: TASK_ID,
			projectId: "proj-1",
			level: "error",
			taskSeq: 7,
			projectName: "Project",
			message: "Cleanup script failed (exit 3). Leftovers may remain — see the task's notes.",
		}));
		const content = vi.mocked(addNote).mock.calls[0][3];
		expect(content).toContain("Cleanup script failed with exit code 3.");
		expect(content).toContain("```\ndocker: no such network\n```");
		expect(pushCliAttention).not.toHaveBeenCalled();
	});

	it("reports a script that never recorded a status, with the client exit code", async () => {
		fakeSession({ clientExit: 1 });

		await runCleanupScript(task(), project(), transitionTo("completed"));

		expect(vi.mocked(pushCliToast).mock.calls[0][0].message).toBe(
			"Cleanup script did not finish (no exit status was recorded, tmux client exit 1). Leftovers may remain — see the task's notes.",
		);
		const content = vi.mocked(addNote).mock.calls[0][3];
		expect(content).toContain("Cleanup script did not finish: no exit status was recorded, tmux client exit 1.");
		expect(content).toContain("(no output)");
	});

	it("reports a script abandoned at the hard timeout", async () => {
		vi.useFakeTimers();
		vi.mocked(tmux.spawnAttachedSession).mockImplementation(
			() => ({ exited: new Promise<number>(() => {}), kill: vi.fn() }) as unknown as ReturnType<typeof tmux.spawnAttachedSession>,
		);

		const run = runCleanupScript(task(), project(), transitionTo("completed"));
		await vi.waitFor(() => expect(tmux.spawnAttachedSession).toHaveBeenCalled());
		await vi.advanceTimersByTimeAsync(CLEANUP_SCRIPT_HARD_TIMEOUT_MS + 10_000);
		await run;

		expect(vi.mocked(pushCliToast).mock.calls[0][0].message).toContain("Cleanup script did not finish (it ran past the 10 minute limit");
		expect(vi.mocked(addNote).mock.calls[0][3]).toContain("Cleanup script did not finish: it ran past the 10 minute limit");
	});

	it.each([
		["a script that wrote 0 before its client wedged", "0", false],
		["a script that wrote 2 before its client wedged", "2", true],
	])("trusts the status file of %s", async (_name, status, failed) => {
		vi.useFakeTimers();
		vi.mocked(tmux.hasSession).mockResolvedValue(false);
		vi.mocked(tmux.spawnAttachedSession).mockImplementation(() => {
			writeFileSync(cleanupScriptFiles(TASK_ID).status, status);
			return { exited: new Promise<number>(() => {}), kill: vi.fn() } as unknown as ReturnType<typeof tmux.spawnAttachedSession>;
		});

		const run = runCleanupScript(task(), project(), transitionTo("completed"));
		await vi.waitFor(() => expect(tmux.spawnAttachedSession).toHaveBeenCalled());
		await vi.advanceTimersByTimeAsync(30_000);
		await run;

		expect(tmux.killSession).toHaveBeenCalled();
		expect(pushCliToast).toHaveBeenCalledTimes(failed ? 1 : 0);
		expect(addNote).toHaveBeenCalledTimes(failed ? 1 : 0);
		if (failed) expect(vi.mocked(pushCliToast).mock.calls[0][0].message).toContain("failed (exit 2)");
	});

	it("reports a failed session start and still returns, so teardown goes on", async () => {
		vi.mocked(tmux.spawnAttachedSession).mockImplementation(() => {
			throw new Error("open terminal failed");
		});

		await expect(runCleanupScript(task(), project(), transitionTo("completed"))).resolves.toBeUndefined();

		expect(vi.mocked(pushCliToast).mock.calls[0][0].message).toContain("Cleanup script did not finish (open terminal failed)");
		expect(addNote).toHaveBeenCalledTimes(1);
	});

	it("toasts but writes no note when the task is being deleted", async () => {
		fakeSession({ status: "3", log: "boom\n" });

		await runCleanupScript(task(), project(), transitionTo("deleted"));

		expect(pushCliToast).toHaveBeenCalledTimes(1);
		expect(vi.mocked(pushCliToast).mock.calls[0][0].message).toBe("Cleanup script failed (exit 3). Leftovers may remain.");
		expect(addNote).not.toHaveBeenCalled();
	});

	it("does not let a failing toast or note break the teardown", async () => {
		fakeSession({ status: "3" });
		vi.mocked(pushCliToast).mockImplementationOnce(() => {
			throw new Error("toast down");
		});
		vi.mocked(addNote).mockRejectedValueOnce(new Error("disk full"));

		await expect(runCleanupScript(task(), project(), transitionTo("completed"))).resolves.toBeUndefined();
	});
});

describe("cleanup wrapper", () => {
	it("records the script's exit status and its output, in a real shell", async () => {
		const files = cleanupScriptFiles(TASK_ID);
		mkdirSync(tempRoot.dir, { recursive: true });
		writeFileSync(files.body, "#!/bin/bash\necho hi; exit 3\n");
		const wrapper = buildCleanupWrapper(files, launchDialect().runScript(files.body, { shellPath: "/bin/bash" }));
		writeFileSync(files.wrapper, wrapper);

		spawnSync("/bin/bash", [files.wrapper], { encoding: "utf8" });

		expect(readFileSync(files.status, "utf8")).toBe("3");
		expect(await readCleanupExitCode(files)).toBe(3);
		expect(await readCleanupLogTail(files)).toBe("hi");
	});

	it("keeps the last 20 lines of the output, without escape sequences", async () => {
		const files = cleanupScriptFiles(TASK_ID);
		const lines = Array.from({ length: 30 }, (_, i) => `\u001b[1mline ${i + 1}\u001b[0m`);
		writeFileSync(files.log, `${lines.join("\n")}\n`);

		const tail = (await readCleanupLogTail(files)).split("\n");

		expect(tail).toHaveLength(20);
		expect(tail[0]).toBe("line 11");
		expect(tail[19]).toBe("line 30");
	});
});
