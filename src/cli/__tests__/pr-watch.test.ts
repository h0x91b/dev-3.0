import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedArgs } from "../args";
import type { CliContext } from "../context";
import { CLI_EXIT_CODE_PR_WATCH_NO_PR, CLI_EXIT_CODE_PR_WATCH_PR_FINISHED } from "../../shared/cli-exit-codes";
import { PR_WATCH_NO_PR_PREFIX, PR_WATCH_PR_FINISHED_PREFIX } from "../../shared/pr-watch";

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));
vi.mock("../context", () => ({
	expandShortId: (id: string) => id,
	resolveProjectId: (flag: string | undefined, context: { projectId?: string } | null) => flag ?? context?.projectId,
	readTaskDirect: vi.fn(),
	readProjectDirect: vi.fn(),
}));

import { sendRequest } from "../socket-client";
import { handlePrWatch } from "../commands/pr-watch";

const send = vi.mocked(sendRequest);
const ctx: CliContext = { projectId: "proj-1", taskId: "task-1", socketPath: "/tmp/x.sock", worktreePath: "/wt" };

let stdout = "";
let stderr = "";
const spies: Array<{ mockRestore(): void }> = [];

function args(flags: Record<string, string> = {}): ParsedArgs {
	return { positional: [], flags };
}

/** Run the command; returns the exit code it asked for, or null when it returned normally. */
async function run(flags: Record<string, string>, context: CliContext | null = ctx): Promise<number | null> {
	try {
		await handlePrWatch(args(flags), "/tmp/x.sock", context);
		return null;
	} catch (err) {
		const match = /^EXIT_(\d+)$/.exec((err as Error).message);
		if (!match) throw err;
		return Number(match[1]);
	}
}

beforeEach(() => {
	vi.stubEnv("TMUX_PANE", "");
	vi.stubEnv("DEV3_PANE_ID", "");
	stdout = "";
	stderr = "";
	send.mockReset();
	spies.push(
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			stdout += String(chunk);
			return true;
		}),
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			stderr += String(chunk);
			return true;
		}),
		vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
			throw new Error(`EXIT_${code ?? 0}`);
		}) as unknown as { mockRestore(): void },
	);
});

afterEach(() => {
	vi.unstubAllEnvs();
	for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("dev3 pr watch", () => {
	it("subscribes until CI by default and prints one line", async () => {
		send.mockResolvedValue({ id: "1", ok: true, data: { prNumber: 2041 } });

		expect(await run({})).toBeNull();

		expect(send).toHaveBeenCalledWith(
			"/tmp/x.sock",
			"pr.watch.add",
			{ taskId: "task-1", projectId: "proj-1", until: "ci", sourceTaskId: "task-1" },
			{ timeoutMs: 45_000 },
		);
		expect(stdout).toBe("Watching PR #2041 until CI finishes — dev3 will message this agent. No need to poll gh.\n");
	});

	it("passes --until merged, --pr, --task and --project through", async () => {
		send.mockResolvedValue({ id: "1", ok: true, data: { prNumber: 9 } });

		await run({ until: "merged", pr: "9", task: "seq:12", project: "proj-2" });

		expect(send.mock.calls[0][2]).toMatchObject({ taskId: "seq:12", projectId: "proj-2", until: "merged", prNumber: 9 });
		expect(stdout).toContain("until it is merged or closed");
	});

	it("sends this agent's pane and pid so the message comes back to it", async () => {
		vi.stubEnv("TMUX_PANE", "%4");
		send.mockResolvedValue({ id: "1", ok: true, data: { prNumber: 2041 } });

		await run({});

		expect(send.mock.calls[0][2]).toMatchObject({ sourceTaskId: "task-1", sourcePaneId: "%4", sourcePid: process.pid });
	});

	it("waits longer for the app than the app waits for gh", async () => {
		send.mockResolvedValue({ id: "1", ok: true, data: { prNumber: 1 } });
		await run({});
		expect(send.mock.calls[0][3]?.timeoutMs).toBeGreaterThan(15_000);
	});

	it("exits with the no-PR code and subscribes nothing when no PR is found", async () => {
		send.mockResolvedValue({ id: "1", ok: false, error: `${PR_WATCH_NO_PR_PREFIX}No open pull request found for feat/x.` });

		expect(await run({})).toBe(CLI_EXIT_CODE_PR_WATCH_NO_PR);
		expect(stderr).toContain("No open pull request found for feat/x.");
		expect(stderr).not.toContain(PR_WATCH_NO_PR_PREFIX);
	});

	it("exits with its own code when --pr names a PR that is already merged or closed", async () => {
		send.mockResolvedValue({ id: "1", ok: false, error: `${PR_WATCH_PR_FINISHED_PREFIX}Pull request #2111 is already merged; there is nothing left to watch.` });

		expect(await run({ pr: "2111" })).toBe(CLI_EXIT_CODE_PR_WATCH_PR_FINISHED);
		expect(stderr).toContain("Pull request #2111 is already merged");
		expect(stderr).not.toContain(PR_WATCH_PR_FINISHED_PREFIX);
	});

	it("says when the watched PR is not the task's own", async () => {
		send.mockResolvedValue({ id: "1", ok: true, data: { prNumber: 2111, pinned: true } });
		await run({ pr: "2111", until: "merged" });
		expect(stdout).toBe("Watching PR #2111 (not this task's own PR) until it is merged or closed — dev3 will message this agent. No need to poll gh.\n");
	});

	it("removes only one PR's watches with --off --pr", async () => {
		send.mockResolvedValue({ id: "1", ok: true, data: { removed: 1 } });

		await run({ off: "true", pr: "2111" });

		expect(send).toHaveBeenCalledWith("/tmp/x.sock", "pr.watch.off", { taskId: "task-1", projectId: "proj-1", prNumber: 2111 });
		expect(stdout).toBe("Removed 1 PR watch on PR #2111.\n");
	});

	it("refuses --list with --pr", async () => {
		expect(await run({ list: "true", pr: "7" })).toBe(3);
		expect(send).not.toHaveBeenCalled();
	});

	it("marks a followed PR in --list", async () => {
		send.mockResolvedValue({
			id: "1",
			ok: true,
			data: { watches: [{ until: "ci", prNumber: 2111, headSha: "fffffff", createdAt: "2026-10-31T10:00:00.000Z", pinned: true }] },
		});
		await run({ list: "true" });
		expect(stdout).toBe("PR #2111  until ci  head fffffff  since 2026-10-31T10:00:00.000Z  (followed, not this task's PR)\n");
	});

	it("exits 1 on any other app error", async () => {
		send.mockResolvedValue({ id: "1", ok: false, error: "boom" });
		expect(await run({})).toBe(1);
	});

	it("refuses an unknown --until value without calling the app", async () => {
		expect(await run({ until: "review" })).toBe(3);
		expect(send).not.toHaveBeenCalled();
	});

	it("refuses a --pr that is not a number", async () => {
		expect(await run({ pr: "abc" })).toBe(3);
		expect(await run({ pr: "0" })).toBe(3);
		expect(send).not.toHaveBeenCalled();
	});

	it("refuses --off together with --until, and --off with a value", async () => {
		expect(await run({ off: "true", until: "ci" })).toBe(3);
		expect(await run({ off: "1722" })).toBe(3);
		expect(send).not.toHaveBeenCalled();
	});

	it("asks for a task when run outside a worktree", async () => {
		expect(await run({}, null)).toBe(3);
		expect(stderr).toContain("No task in context");
	});

	it("removes the watches with --off", async () => {
		send.mockResolvedValue({ id: "1", ok: true, data: { removed: 2 } });

		await run({ off: "true" });

		expect(send).toHaveBeenCalledWith("/tmp/x.sock", "pr.watch.off", { taskId: "task-1", projectId: "proj-1" });
		expect(stdout).toBe("Removed 2 PR watches.\n");
	});

	it("lists the watches with --list", async () => {
		send.mockResolvedValue({
			id: "1",
			ok: true,
			data: { watches: [{ until: "merged", prNumber: 7, headSha: "abc1234", createdAt: "2026-10-22T10:00:00.000Z" }] },
		});

		await run({ list: "true" });

		expect(send).toHaveBeenCalledWith("/tmp/x.sock", "pr.watch.list", { taskId: "task-1", projectId: "proj-1" });
		expect(stdout).toBe("PR #7  until merged  head abc1234  since 2026-10-22T10:00:00.000Z\n");
	});

	it("says so when there is nothing to list", async () => {
		send.mockResolvedValue({ id: "1", ok: true, data: { watches: [] } });
		await run({ list: "true" });
		expect(stdout).toBe("No PR watches on this task.\n");
	});
});
