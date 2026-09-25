import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { Project, Task } from "../../shared/types";
import { RESET_REQUIRES_CONSENT_ERROR, TODO_OWNS_WORKTREE_ERROR } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/todo-reset-git`);

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../paths", () => ({ DEV3_HOME: TEST_HOME }));
// `beforeSpawn` lets a test play a racing process right before a given git call.
const race = vi.hoisted(() => ({ beforeSpawn: null as ((cmd: string[]) => string[] | void) | null }));
vi.mock("../spawn", async () => {
	const { createSpawnMock } = await import("./git-test-helpers");
	const inner = createSpawnMock();
	return {
		spawn: (cmd: string[], opts?: Record<string, unknown>) => {
			const replaced = race.beforeSpawn?.(cmd);
			return inner.spawn(replaced ?? cmd, opts);
		},
	};
});

import { createWorktree, removeWorktree, _resetFetchState, type OwnedBranchInfo } from "../git";
import { transition } from "../lifecycle/machine";
import { lifecycleStateFromTask } from "../lifecycle/state";
import { createTestRepo, cleanup, g, type TestRepo } from "./git-test-helpers";

const TASK_ID = "c1c1c1c1-0000-0000-0000-000000000000";
const OWN = "dev3/task-c1c1c1c1";

function project(path: string): Project {
	return { id: "p", name: "T", path, setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" };
}
function task(over: Partial<Task> = {}): Task {
	return {
		id: TASK_ID, seq: 1, projectId: "p", title: "t", description: "",
		status: "in-progress", baseBranch: "main", worktreePath: null, branchName: null, groupId: null,
		variantIndex: null, agentId: null, configId: null, createdAt: "", updatedAt: "", ...over,
	};
}
function rejection(effects: { type: string; message?: string }[]): string | undefined {
	return effects.find((effect) => effect.type === "reject")?.message;
}
function branchExists(repo: TestRepo, name: string): boolean {
	return g(`git branch --list ${name}`, repo.local).trim() !== "";
}
function commit(dir: string, file: string): string {
	writeFileSync(join(dir, file), `${file}\n`);
	g(`git add ${file} && git commit -m ${file}`, dir);
	return g("git rev-parse HEAD", dir).trim();
}

let repo: TestRepo;
beforeEach(() => { _resetFetchState(); repo = createTestRepo(); });
afterEach(() => cleanup(repo));

// Hunt finding C1 (agent S, 2026-09-25): a plain move to To Do kept the run, and the
// next activation's createWorktree wiped the branch and its commits. Both halves
// are refused now; this fails if either door reopens.
describe("C1 — a run is never discarded by a plain To Do move", () => {
	it("refuses active → todo (force too) and re-activating a To Do card that still owns a worktree", async () => {
		const p = project(repo.local);
		const first = await createWorktree(p, task());
		const workSha = commit(first.worktreePath, "work.txt");

		const running = task({ worktreePath: first.worktreePath, branchName: first.branchName });
		for (const force of [false, true]) {
			const toTodo = transition(lifecycleStateFromTask(p, running), { type: "moveRequested", target: { status: "todo" }, force });
			expect(rejection(toTodo.effects)).toBe(RESET_REQUIRES_CONSENT_ERROR);
			expect(toTodo.effects.map((e) => e.type)).not.toContain("removeWorktree");
		}

		// The legacy state an older dev3 version still produces.
		const parked = { ...running, status: "todo" as const };
		const launch = { launch: { label: "x", agentId: null, configId: null }, awaitCompletion: true, publishColumn: false };
		for (const preparation of [undefined, launch]) {
			const back = transition(lifecycleStateFromTask(p, parked), {
				type: "moveRequested", target: { status: "in-progress" }, preparation, explicitLaunch: true,
			});
			expect(rejection(back.effects)).toBe(TODO_OWNS_WORKTREE_ERROR);
			expect(back.effects.map((e) => e.type)).not.toContain("prepareTask");
		}
		expect(existsSync(join(first.worktreePath, "work.txt"))).toBe(true);
		expect(g("git rev-parse HEAD", first.worktreePath).trim()).toBe(workSha);
	});
});

// Hunt finding C2 stays out of this task's scope: the legacy complete/cancel policy
// still deletes a user branch checked out in the worktree. Kept as a record so the
// follow-up fix flips it. The reset path uses the "task-owned" policy below.
describe("C2 — legacy policy, unchanged", () => {
	it("complete/cancel teardown deletes a user branch checked out inside the worktree", async () => {
		const p = project(repo.local);
		g("git branch release/2.0", repo.local);
		const wt = await createWorktree(p, task());
		g("git checkout release/2.0", wt.worktreePath);
		const userSha = commit(wt.worktreePath, "user.txt");
		await removeWorktree(p, task({ worktreePath: wt.worktreePath, branchName: wt.branchName }));
		expect(branchExists(repo, "release/2.0")).toBe(false);
		expect(g(`git cat-file -t ${userSha}`, repo.local).trim()).toBe("commit");
	});
});

describe("reset branch policy (task-owned)", () => {
	const noted: OwnedBranchInfo[] = [];
	const note = async (branch: OwnedBranchInfo) => { noted.push(branch); };
	beforeEach(() => { noted.length = 0; });

	it("deletes dev3/task-<id> after noting its tip and the commits found nowhere else", async () => {
		const p = project(repo.local);
		const wt = await createWorktree(p, task());
		const sha = commit(wt.worktreePath, "a.txt");
		const outcome = await removeWorktree(p, task({ worktreePath: wt.worktreePath, branchName: OWN }), { branchPolicy: "task-owned", beforeBranchDelete: note });
		expect(outcome.deleted).toEqual([{ name: OWN, sha }]);
		expect(noted).toEqual([{ name: OWN, sha, commitsOnlyHere: 1 }]);
		expect(branchExists(repo, OWN)).toBe(false);
		// The recovery command the note hands out really brings the commit back.
		g(`git branch ${OWN}-recovered ${sha}`, repo.local);
		expect(g(`git rev-parse ${OWN}-recovered`, repo.local).trim()).toBe(sha);
	});

	it("deletes a branch the agent renamed from dev3/task-<id> (reflog proof)", async () => {
		const p = project(repo.local);
		const wt = await createWorktree(p, task());
		g(`git branch -m ${OWN} feat/dev3-renamed`, wt.worktreePath);
		commit(wt.worktreePath, "b.txt");
		const outcome = await removeWorktree(p, task({ worktreePath: wt.worktreePath, branchName: "feat/dev3-renamed" }), { branchPolicy: "task-owned", beforeBranchDelete: note });
		expect(outcome.deleted.map((b) => b.name)).toEqual(["feat/dev3-renamed"]);
		expect(branchExists(repo, "feat/dev3-renamed")).toBe(false);
	});

	it("keeps a user branch checked out in the worktree and still removes the task's own branch", async () => {
		const p = project(repo.local);
		g("git branch release/2.0", repo.local);
		const wt = await createWorktree(p, task());
		g("git checkout release/2.0", wt.worktreePath);
		commit(wt.worktreePath, "user.txt");
		const outcome = await removeWorktree(p, task({ worktreePath: wt.worktreePath, branchName: OWN }), { branchPolicy: "task-owned", beforeBranchDelete: note });
		expect(branchExists(repo, "release/2.0")).toBe(true);
		expect(outcome.kept).toContainEqual({ name: "release/2.0", reason: "not-owned" });
		expect(outcome.deleted.map((b) => b.name)).toEqual([OWN]);
		expect(existsSync(wt.worktreePath)).toBe(false);
	});

	it("keeps the branch when its recovery note cannot be written", async () => {
		const p = project(repo.local);
		const wt = await createWorktree(p, task());
		commit(wt.worktreePath, "c.txt");
		const outcome = await removeWorktree(p, task({ worktreePath: wt.worktreePath, branchName: OWN }), {
			branchPolicy: "task-owned",
			beforeBranchDelete: async () => { throw new Error("disk full"); },
		});
		expect(outcome.kept).toEqual([{ name: OWN, reason: "note-failed" }]);
		expect(branchExists(repo, OWN)).toBe(true);
	});

	it("keeps and reports a branch git refuses to delete (checked out in another worktree)", async () => {
		const p = project(repo.local);
		const wt = await createWorktree(p, task());
		g(`git checkout --detach`, wt.worktreePath);
		const other = join(repo.dir, "other-wt");
		g(`git worktree add "${other}" ${OWN}`, repo.local);
		const outcome = await removeWorktree(p, task({ worktreePath: wt.worktreePath, branchName: OWN }), { branchPolicy: "task-owned", beforeBranchDelete: note });
		expect(outcome.kept).toEqual([{ name: OWN, reason: "delete-failed" }]);
		expect(branchExists(repo, OWN)).toBe(true);
		g(`git worktree remove --force "${other}"`, repo.local);
	});

	it("worktree already gone (second reset): judges the recorded branch, notes it from rev-parse, then deletes", async () => {
		const p = project(repo.local);
		const wt = await createWorktree(p, task());
		g(`git branch -m ${OWN} feat/dev3-gone`, wt.worktreePath);
		const sha = commit(wt.worktreePath, "d.txt");
		rmSync(wt.worktreePath, { recursive: true, force: true });
		const outcome = await removeWorktree(p, task({ worktreePath: wt.worktreePath, branchName: "feat/dev3-gone" }), { branchPolicy: "task-owned", beforeBranchDelete: note });
		expect(noted.map((b) => [b.name, b.sha])).toEqual([["feat/dev3-gone", sha]]);
		expect(outcome.deleted.map((b) => b.name)).toEqual(["feat/dev3-gone"]);
		expect(g("git worktree list --porcelain", repo.local)).not.toContain(wt.worktreePath);
	});

	it("reports a recorded branch that no longer exists as missing, deleting nothing", async () => {
		const p = project(repo.local);
		const wt = await createWorktree(p, task());
		g(`git checkout --detach`, wt.worktreePath);
		g(`git branch -D ${OWN}`, repo.local);
		const outcome = await removeWorktree(p, task({ worktreePath: wt.worktreePath, branchName: OWN }), { branchPolicy: "task-owned", beforeBranchDelete: note });
		expect(outcome).toEqual({ deleted: [], kept: [{ name: OWN, reason: "missing" }] });
		expect(noted).toEqual([]);
	});

	it("keeps a renamed branch when the reflog cannot prove where it came from", async () => {
		const p = project(repo.local);
		const wt = await createWorktree(p, task());
		g(`git branch -m ${OWN} feat/dev3-noreflog`, wt.worktreePath);
		g("git reflog expire --expire=all --all", repo.local);
		const outcome = await removeWorktree(p, task({ worktreePath: wt.worktreePath, branchName: "feat/dev3-noreflog" }), { branchPolicy: "task-owned", beforeBranchDelete: note });
		expect(outcome.kept).toEqual([{ name: "feat/dev3-noreflog", reason: "not-owned" }]);
		expect(branchExists(repo, "feat/dev3-noreflog")).toBe(true);
	});
});

// S2 + C1/C2/C3 (Seq 2003 reviews 2003-010 / 2003-011): a later start must not
// silently destroy a branch or folder an earlier run left holding work.
describe("createWorktree judges leftovers before destroying anything", () => {
	it("refuses a leftover dev3/task-<id> with commits found nowhere else — branch and tip unchanged", async () => {
		const p = project(repo.local);
		const first = await createWorktree(p, task());
		const sha = commit(first.worktreePath, "kept.txt");
		g(`git worktree remove --force "${first.worktreePath}"`, repo.local);
		await expect(createWorktree(p, task())).rejects.toMatchObject({ name: "WorkspaceReclaimRefusedError", kind: "unique-commits" });
		expect(g(`git rev-parse ${OWN}`, repo.local).trim()).toBe(sha);
	});

	it("…the same with the stale folder still present: folder and branch both untouched", async () => {
		const p = project(repo.local);
		const first = await createWorktree(p, task());
		const sha = commit(first.worktreePath, "kept2.txt");
		await expect(createWorktree(p, task())).rejects.toMatchObject({ name: "WorkspaceReclaimRefusedError" });
		expect(existsSync(join(first.worktreePath, "kept2.txt"))).toBe(true);
		expect(g(`git rev-parse ${OWN}`, repo.local).trim()).toBe(sha);
	});

	it.each([
		["an uncommitted edit", (wt: string) => writeFileSync(join(wt, "README.md"), "edited\n")],
		["an untracked file", (wt: string) => writeFileSync(join(wt, "new.txt"), "new\n")],
	])("refuses a stale folder with %s, keeping it", async (_label, dirty) => {
		const p = project(repo.local);
		const first = await createWorktree(p, task());
		g(`git checkout --detach`, first.worktreePath);
		g(`git branch -D ${OWN}`, repo.local);
		dirty(first.worktreePath);
		await expect(createWorktree(p, task())).rejects.toMatchObject({ kind: "dirty-dir" });
		expect(existsSync(first.worktreePath)).toBe(true);
	});

	it("refuses a detached stale folder whose HEAD holds commits no ref reaches", async () => {
		const p = project(repo.local);
		const first = await createWorktree(p, task());
		g(`git checkout --detach`, first.worktreePath);
		g(`git branch -D ${OWN}`, repo.local);
		commit(first.worktreePath, "detached.txt");
		await expect(createWorktree(p, task())).rejects.toMatchObject({ kind: "unique-commits" });
	});

	it("refuses a non-empty folder git cannot inspect, and a broken .git link, instead of guessing", async () => {
		const p = project(repo.local);
		const first = await createWorktree(p, task());
		const dir = first.worktreePath;
		g(`git worktree remove --force "${dir}"`, repo.local);
		g(`git branch -D ${OWN}`, repo.local);
		const { mkdirSync } = await import("fs");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "leftover.txt"), "?\n");
		await expect(createWorktree(p, task())).rejects.toMatchObject({ kind: "unknown-dir" });
		writeFileSync(join(dir, ".git"), "gitdir: /nonexistent/admin\n");
		await expect(createWorktree(p, task())).rejects.toMatchObject({ kind: "inspect-failed" });
		expect(existsSync(join(dir, "leftover.txt"))).toBe(true);
	});

	it("still reclaims a clean stale folder and a fully merged leftover branch", async () => {
		const p = project(repo.local);
		const first = await createWorktree(p, task());
		g(`git -C "${first.worktreePath}" checkout -q --detach`, repo.local);
		// Leftover branch at a commit main already has: nothing unique.
		const second = await createWorktree(p, task());
		expect(second.branchName).toBe(OWN);
		expect(existsSync(second.worktreePath)).toBe(true);
	});

	it("reclaims an empty leftover folder", async () => {
		const p = project(repo.local);
		const first = await createWorktree(p, task());
		g(`git worktree remove --force "${first.worktreePath}"`, repo.local);
		const { mkdirSync } = await import("fs");
		mkdirSync(first.worktreePath, { recursive: true });
		await expect(createWorktree(p, task())).resolves.toMatchObject({ branchName: OWN });
	});

	it("reachability that cannot be computed counts as work (fail closed)", async () => {
		const { commitsReachableOnlyFrom } = await import("../git");
		expect(await commitsReachableOnlyFrom(repo.local, "0000000000000000000000000000000000000000")).toBeNull();
		expect(await commitsReachableOnlyFrom(repo.local, g("git rev-parse main", repo.local).trim())).toBe(0);
	});

	it("C3: the branch delete is compare-and-swap — git refuses it once the tip moved", () => {
		g("git branch cas-probe", repo.local);
		const old = g("git rev-parse cas-probe", repo.local).trim();
		const other = g("git worktree add -q --detach ../cas-wt main && echo ok", repo.local);
		expect(other.trim()).toBe("ok");
		const casWt = join(repo.dir, "cas-wt");
		commit(casWt, "moved.txt");
		g(`git branch -f cas-probe ${g("git -C ../cas-wt rev-parse HEAD", repo.local).trim()}`, repo.local);
		expect(() => g(`git update-ref -d refs/heads/cas-probe ${old}`, repo.local)).toThrow();
		expect(g("git branch --list cas-probe", repo.local).trim()).toContain("cas-probe");
		g(`git worktree remove --force "${casWt}"`, repo.local);
	});
});

describe("S3: a variant-looking name proves nothing", () => {
	it("keeps `<existing>-vN` on reset — a user may own a branch of that name", async () => {
		const p = project(repo.local);
		g("git branch feat/x", repo.local);
		const variant = task({ existingBranch: "origin/feat/x", variantIndex: 2 });
		const wt = await createWorktree(p, variant, "feat/x", "feat/x-v2");
		const outcome = await removeWorktree(p, { ...variant, worktreePath: wt.worktreePath, branchName: "feat/x-v2" }, { branchPolicy: "task-owned" });
		expect(outcome.kept).toContainEqual({ name: "feat/x-v2", reason: "variant-unproven" });
		expect(branchExists(repo, "feat/x-v2")).toBe(true);
	});
});

// F2 (Seq 2003 recheck 2003-012): the worktree-add retry loop only ever deletes a
// branch its own attempt created — never one that existed before the call.
describe("F2: retry cleanup never deletes a pre-existing branch", () => {
	it("a transient failure on the first attempt never deletes a branch that existed before the call", async () => {
		const { _setWorktreeAddRetryPolicy } = await import("../git");
		_setWorktreeAddRetryPolicy({ baseDelayMs: 10, maxDelayMs: 20, budgetMs: 200 });
		const p = project(repo.local);
		const first = await createWorktree(p, task());
		const sha = commit(first.worktreePath, "kept.txt");
		g(`git worktree remove --force "${first.worktreePath}"`, repo.local);
		// git itself reports "already exists" first, so play the transient failure
		// the reviewer described: the first add answers with lock contention.
		race.beforeSpawn = (cmd) => {
			if (!cmd.join(" ").includes(`worktree add -b ${OWN}`)) return;
			race.beforeSpawn = null;
			return ["sh", "-c", "echo \"error: could not lock config file .git/config: File exists\" >&2; exit 255"];
		};
		try {
			await expect(createWorktree(p, task(), "main")).rejects.toThrow();
		} finally {
			race.beforeSpawn = null;
			_setWorktreeAddRetryPolicy();
		}
		expect(g(`git rev-parse ${OWN}`, repo.local).trim()).toBe(sha);
	});

	it("existing-branch fallback with a kept dev3/task-<id> and lock contention leaves that branch alone", async () => {
		const { _setWorktreeAddRetryPolicy } = await import("../git");
		const { spawnedCommands } = await import("./git-test-helpers");
		const { rmSync } = await import("fs");
		_setWorktreeAddRetryPolicy({ baseDelayMs: 20, maxDelayMs: 40, budgetMs: 300 });
		const p = project(repo.local);
		const first = await createWorktree(p, task());
		const sha = commit(first.worktreePath, "kept.txt");
		g(`git worktree remove --force "${first.worktreePath}"`, repo.local);
		const lock = join(repo.local, ".git", "config.lock");
		writeFileSync(lock, "");
		const before = spawnedCommands.length;
		try {
			// `main` is checked out in the main repo → fallback to `add -b dev3/task-<id>`.
			await expect(createWorktree(p, task(), "main")).rejects.toThrow();
		} finally {
			rmSync(lock, { force: true });
			_setWorktreeAddRetryPolicy();
		}
		expect(g(`git rev-parse ${OWN}`, repo.local).trim()).toBe(sha);
		expect(spawnedCommands.slice(before).some((cmd) => cmd.join(" ").includes(`branch -D ${OWN}`))).toBe(false);
	});
});

// F4 (Seq 2003 check 2003-013, option A): a variant never adopts an earlier
// variant branch — it starts fresh on the next free name and deletes nothing.
describe("F4: fresh variant branch, old one kept", () => {
	const VARIANT = () => task({ existingBranch: "feat/x", variantIndex: 1 });
	afterEach(() => { race.beforeSpawn = null; });

	it("a kept -v1 with its own commits → the relaunch gets -v1-2 at the CURRENT base; -v1 and its tip untouched", async () => {
		const p = project(repo.local);
		g("git branch feat/x", repo.local);
		const first = await createWorktree(p, VARIANT(), "feat/x", "feat/x-v1");
		const oldTip = commit(first.worktreePath, "old-run.txt");
		g(`git worktree remove --force "${first.worktreePath}"`, repo.local);
		// The base moved on since the first run.
		g("git checkout -q feat/x && git commit -q --allow-empty -m base-moved && git checkout -q main", repo.local);
		const baseNow = g("git rev-parse feat/x", repo.local).trim();

		const second = await createWorktree(p, VARIANT(), "feat/x", "feat/x-v1");
		expect(second.branchName).toBe("feat/x-v1-2");
		expect(second.variantBranchesKept).toMatchObject({ kept: ["feat/x-v1"], created: "feat/x-v1-2", baseSha: baseNow });
		expect(g("git rev-parse HEAD", second.worktreePath).trim()).toBe(baseNow);
		expect(existsSync(join(second.worktreePath, "old-run.txt"))).toBe(false);
		expect(g("git rev-parse feat/x-v1", repo.local).trim()).toBe(oldTip);
	});

	it("a name another process creates between our probe and our create is theirs: we land on the next one", async () => {
		const p = project(repo.local);
		g("git branch feat/x", repo.local);
		g("git branch feat/x-v1", repo.local); // kept from an earlier run
		const theirs = g("git rev-parse main", repo.local).trim();
		race.beforeSpawn = (cmd) => {
			if (cmd.join(" ").includes("worktree add -b feat/x-v1-2 ")) {
				race.beforeSpawn = null;
				g(`git branch feat/x-v1-2 ${theirs}`, repo.local);
			}
		};
		const wt = await createWorktree(p, VARIANT(), "feat/x", "feat/x-v1");
		expect(wt.branchName).toBe("feat/x-v1-3");
		expect(g("git rev-parse feat/x-v1-2", repo.local).trim()).toBe(theirs);
		expect(branchExists(repo, "feat/x-v1")).toBe(true);
	});

	it("a remote-only branch of that name counts as taken", async () => {
		const p = project(repo.local);
		g("git branch feat/x", repo.local);
		g(`git update-ref refs/remotes/origin/feat/x-v1 ${g("git rev-parse main", repo.local).trim()}`, repo.local);
		const wt = await createWorktree(p, VARIANT(), "feat/x", "feat/x-v1");
		expect(wt.branchName).toBe("feat/x-v1-2");
	});

	it("all candidate names taken → typed refusal naming how to clean up; nothing created or deleted", async () => {
		const p = project(repo.local);
		g("git branch feat/x", repo.local);
		g("git branch feat/x-v1", repo.local);
		for (let i = 2; i <= 20; i++) g(`git branch feat/x-v1-${i}`, repo.local);
		const before = g("git for-each-ref '--format=%(refname)' refs/heads", repo.local);
		await expect(createWorktree(p, VARIANT(), "feat/x", "feat/x-v1")).rejects.toMatchObject({
			name: "WorkspaceReclaimRefusedError", kind: "no-fresh-branch", message: expect.stringContaining("git branch -D"),
		});
		expect(g("git for-each-ref '--format=%(refname)' refs/heads", repo.local)).toBe(before);
	});

	it("an invalid name → typed refusal", async () => {
		const p = project(repo.local);
		g("git branch feat/x", repo.local);
		await expect(createWorktree(p, VARIANT(), "feat/x", "feat/x..v1")).rejects.toMatchObject({ kind: "no-fresh-branch" });
	});

	it("a base that no longer exists → typed error, no stale fallback", async () => {
		const p = project(repo.local);
		await expect(createWorktree(p, VARIANT(), "feat/gone", "feat/gone-v1")).rejects.toMatchObject({ kind: "base-missing" });
	});

	it("complete/cancel afterwards (legacy policy) deletes only the NEW branch; the kept one survives", async () => {
		const p = project(repo.local);
		g("git branch feat/x", repo.local);
		g("git branch feat/x-v1", repo.local);
		const wt = await createWorktree(p, VARIANT(), "feat/x", "feat/x-v1");
		expect(wt.branchName).toBe("feat/x-v1-2");
		await removeWorktree(p, { ...VARIANT(), worktreePath: wt.worktreePath, branchName: wt.branchName });
		expect(branchExists(repo, "feat/x-v1-2")).toBe(false);
		expect(branchExists(repo, "feat/x-v1")).toBe(true);
	});

	it("reset reports a suffixed variant branch as a variant dev3 cannot prove it created", async () => {
		const p = project(repo.local);
		g("git branch feat/x", repo.local);
		g("git branch feat/x-v1", repo.local);
		const wt = await createWorktree(p, VARIANT(), "feat/x", "feat/x-v1");
		const outcome = await removeWorktree(p, { ...VARIANT(), worktreePath: wt.worktreePath, branchName: wt.branchName }, { branchPolicy: "task-owned" });
		expect(outcome.kept).toContainEqual({ name: "feat/x-v1-2", reason: "variant-unproven" });
	});
});

// R-A4a/b (Seq 2003 recheck 2003-014, coordinator ruling): a fresh variant base is
// VERIFIED against its remote whenever it has one — never a silent stale base.
describe("F4 base freshness", () => {
	const origin = () => join(repo.dir, "origin.git");
	function otherClonePush(branch: string, file: string): string {
		const other = join(repo.dir, `other-${file}`);
		g(`git clone -q "${origin()}" "${other}"`, repo.dir);
		g(`git checkout -q ${branch}`, other);
		commit(other, file);
		g(`git push -q origin ${branch}`, other);
		return g("git rev-parse HEAD", other).trim();
	}
	const heads = () => g("git for-each-ref '--format=%(refname) %(objectname)' refs/heads", repo.local);
	const variantTask = (existing: string) => task({ existingBranch: existing, variantIndex: 1 });

	it("remote branch deleted upstream (lingering origin/x ref) → base-missing, nothing created", async () => {
		const p = project(repo.local);
		g("git branch feat/r && git push -q origin feat/r && git branch -D feat/r", repo.local);
		g("git branch -D feat/r", origin());
		// The tracking ref is not pruned: it still looks usable.
		g(`git update-ref refs/remotes/origin/feat/r ${g("git rev-parse main", repo.local).trim()}`, repo.local);
		const before = heads();
		await expect(createWorktree(p, variantTask("origin/feat/r"), "origin/feat/r", "feat/r-v1")).rejects.toMatchObject({ kind: "base-missing" });
		expect(heads()).toBe(before);
	});

	it("plain local name BEHIND origin/x → starts from the remote tip", async () => {
		const p = project(repo.local);
		g("git branch feat/l && git push -q -u origin feat/l", repo.local);
		const remoteTip = otherClonePush("feat/l", "upstream.txt");
		const wt = await createWorktree(p, variantTask("feat/l"), "feat/l", "feat/l-v1");
		expect(g("git rev-parse HEAD", wt.worktreePath).trim()).toBe(remoteTip);
	});

	it("plain local name AHEAD of origin/x → starts from the local tip", async () => {
		const p = project(repo.local);
		g("git branch feat/a && git push -q -u origin feat/a", repo.local);
		g("git checkout -q feat/a", repo.local);
		const localTip = commit(repo.local, "local-only.txt");
		g("git checkout -q main", repo.local);
		const wt = await createWorktree(p, variantTask("feat/a"), "feat/a", "feat/a-v1");
		expect(g("git rev-parse HEAD", wt.worktreePath).trim()).toBe(localTip);
	});

	it("local and remote diverged → base-diverged, nothing created, neither side chosen", async () => {
		const p = project(repo.local);
		g("git branch feat/d && git push -q -u origin feat/d", repo.local);
		otherClonePush("feat/d", "theirs.txt");
		g("git checkout -q feat/d", repo.local);
		commit(repo.local, "mine.txt");
		g("git checkout -q main", repo.local);
		const before = heads();
		await expect(createWorktree(p, variantTask("feat/d"), "feat/d", "feat/d-v1")).rejects.toMatchObject({ kind: "base-diverged" });
		expect(heads()).toBe(before);
	});

	it("remote answers but the fetch fails → base-unverified, never the stale local or tracking tip", async () => {
		const p = project(repo.local);
		g("git branch feat/f && git push -q -u origin feat/f", repo.local);
		otherClonePush("feat/f", "newer.txt");
		race.beforeSpawn = (cmd) => {
			if (cmd.includes("fetch")) return ["sh", "-c", "echo 'fatal: unable to access remote' >&2; exit 128"];
		};
		try {
			const before = heads();
			await expect(createWorktree(p, variantTask("feat/f"), "feat/f", "feat/f-v1")).rejects.toMatchObject({ kind: "base-unverified" });
			expect(heads()).toBe(before);
		} finally {
			race.beforeSpawn = null;
		}
	});

	it("remote unreachable → base-unverified (retryable), no stale fallback, nothing created", async () => {
		const p = project(repo.local);
		g("git branch feat/n && git push -q -u origin feat/n", repo.local);
		g("git remote set-url origin /nonexistent/remote.git", repo.local);
		const before = heads();
		await expect(createWorktree(p, variantTask("origin/feat/n"), "origin/feat/n", "feat/n-v1")).rejects.toMatchObject({ kind: "base-unverified" });
		await expect(createWorktree(p, variantTask("feat/n"), "feat/n", "feat/n-v1")).rejects.toMatchObject({ kind: "base-unverified" });
		expect(heads()).toBe(before);
	});
});

// L-A4 (Seq 2003 recheck 2003-015): the counterpart comes from git's own upstream
// metadata — a LOCAL upstream is local-only, and remote names may contain "/".
describe("F4 base: upstream metadata", () => {
	const variantTask = (existing: string) => task({ existingBranch: existing, variantIndex: 1 });

	it("a branch tracking another LOCAL branch starts from its own local tip", async () => {
		const p = project(repo.local);
		g("git branch --track feat/t main", repo.local);
		g("git checkout -q feat/t", repo.local);
		const localTip = commit(repo.local, "tracked-local.txt");
		g("git checkout -q main", repo.local);
		const wt = await createWorktree(p, variantTask("feat/t"), "feat/t", "feat/t-v1");
		expect(g("git rev-parse HEAD", wt.worktreePath).trim()).toBe(localTip);
	});

	it("an upstream under another name on the remote is the one probed and used", async () => {
		const p = project(repo.local);
		g("git branch other-name && git push -q origin other-name", repo.local);
		g("git branch --track feat/u origin/other-name", repo.local);
		const other = join(repo.dir, "other-u");
		g(`git clone -q "${join(repo.dir, "origin.git")}" "${other}"`, repo.dir);
		g("git checkout -q other-name", other);
		const remoteTip = commit(other, "remote-side.txt");
		g("git push -q origin other-name", other);
		const wt = await createWorktree(p, variantTask("feat/u"), "feat/u", "feat/u-v1");
		expect(g("git rev-parse HEAD", wt.worktreePath).trim()).toBe(remoteTip);
	});

	it("a remote whose name contains '/' resolves to the right remote and branch", async () => {
		const p = project(repo.local);
		g("git branch feat/s && git push -q origin feat/s && git branch -D feat/s", repo.local);
		g(`git remote add team/fork "${join(repo.dir, "origin.git")}"`, repo.local);
		g("git fetch -q team/fork", repo.local);
		const tip = g("git rev-parse refs/remotes/team/fork/feat/s", repo.local).trim();
		const wt = await createWorktree(p, variantTask("team/fork/feat/s"), "team/fork/feat/s", "feat/s-v1");
		expect(g("git rev-parse HEAD", wt.worktreePath).trim()).toBe(tip);
	});
});
