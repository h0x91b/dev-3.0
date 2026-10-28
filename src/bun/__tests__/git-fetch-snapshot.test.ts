/**
 * Tests for fetchOrigin (dedup/cooldown logic) and saveDiffSnapshot
 * using mocked spawn() responses. No real git repos needed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { gzipSync } from "zlib";
import type { Project, Task } from "../../shared/types";

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: "/tmp/dev3-test",
}));

type SpawnResponse = {
	exitCode: number;
	stdout: string;
	stderr: string;
	hang?: boolean;
	holdStreamsOpen?: boolean;
	/** Stays running until the test calls the matching `gates` releaser. */
	gated?: boolean;
};

let spawnResponses: SpawnResponse[] = [];
let lastSpawnOptions: { env?: Record<string, string> } | undefined;
let spawnCommands: string[][] = [];
let killedProcesses = 0;
let gates: Array<() => void> = [];
let activeSpawns = 0;
let maxActiveSpawns = 0;

function queueResponse(exitCode: number, stdout: string, stderr = "") {
	spawnResponses.push({ exitCode, stdout, stderr });
}

let remoteUrl = "git@github.com:o/r.git";
let repoSshCommand = "";

/** The two reads behind the fetch ssh command; answered here so the queue holds fetches only. */
function sshEnvLookupResponse(cmd: string[]): SpawnResponse | null {
	const args = cmd.filter((arg) => arg !== "-c" && arg !== "core.quotepath=false");
	if (args[1] === "ls-remote" && args[2] === "--get-url") return { exitCode: 0, stdout: `${remoteUrl}\n`, stderr: "" };
	if (args[1] === "config" && args[3] === "core.sshCommand") {
		return repoSshCommand ? { exitCode: 0, stdout: `${repoSshCommand}\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
	}
	return null;
}

vi.mock("../spawn", () => ({
	spawn: (cmd: string[], opts?: { env?: Record<string, string> }) => {
		const lookup = sshEnvLookupResponse(cmd);
		if (!lookup) {
			lastSpawnOptions = opts;
			spawnCommands.push(cmd);
		}
		const response = lookup ?? spawnResponses.shift() ?? { exitCode: 1, stdout: "", stderr: "no response queued" };
		const encoder = new TextEncoder();
		let resolveExit!: (code: number) => void;
		const exited = response.hang
			? new Promise<number>((resolve) => {
				resolveExit = resolve;
			})
			: response.gated
				? new Promise<number>((resolve) => {
					gates.push(() => resolve(response.exitCode));
				})
				: Promise.resolve(response.exitCode);
		if (!lookup) {
			activeSpawns += 1;
			maxActiveSpawns = Math.max(maxActiveSpawns, activeSpawns);
			void exited.then(() => { activeSpawns -= 1; });
		}
		return {
			exited,
			kill: () => {
				killedProcesses += 1;
				resolveExit?.(143);
			},
			stdout: new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(response.stdout));
					if (!response.holdStreamsOpen) controller.close();
				},
			}),
			stderr: new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(response.stderr));
					if (!response.holdStreamsOpen) controller.close();
				},
			}),
		};
	},
}));

import {
	fetchCompareRef,
	fetchOrigin,
	fetchOriginBranches,
	fetchSshCommand,
	lastOriginFetchError,
	sshEndpointOf,
	_resetFetchState,
	saveDiffSnapshot,
	taskDir,
} from "../git";
import { listDiffSnapshots, readDiffSnapshot } from "../diff-snapshots";

beforeEach(() => {
	remoteUrl = "git@github.com:o/r.git";
	repoSshCommand = "";
	lastSpawnOptions = undefined;
	spawnResponses = [];
	spawnCommands = [];
	killedProcesses = 0;
	gates = [];
	activeSpawns = 0;
	maxActiveSpawns = 0;
	_resetFetchState();
});

// ─── fetchOrigin ─────────────────────────────────────────────────────────────

describe("fetchOrigin", () => {
	it("returns true on successful fetch", async () => {
		queueResponse(0, "");
		const ok = await fetchOrigin("/repo");
		expect(lastSpawnOptions?.env).toMatchObject({
			GIT_TERMINAL_PROMPT: "0",
			GIT_SSH_COMMAND: expect.stringContaining("ssh -o BatchMode=yes -o ConnectTimeout=10"),
		});
		expect(ok).toBe(true);
	});

	it("returns false when fetch fails", async () => {
		queueResponse(128, "", "fatal: no remote");
		const ok = await fetchOrigin("/repo");
		expect(ok).toBe(false);
	});

	it("kills a fetch that exceeds its deadline and releases the project queue", async () => {
		spawnResponses.push({
			exitCode: 0,
			stdout: "",
			stderr: "",
			hang: true,
			holdStreamsOpen: true,
		});
		const startedAt = performance.now();

		const ok = await fetchOrigin("/repo", "main", 10);
		expect(performance.now() - startedAt).toBeLessThan(2_500);

		expect(ok).toBe(false);
		expect(killedProcesses).toBe(1);

		queueResponse(0, "");
		expect(await fetchOrigin("/repo", "develop", 10)).toBe(true);
		expect(spawnResponses).toHaveLength(0);
	});

	it("deduplicates concurrent fetches for the same project", async () => {
		// Only one spawn call should happen despite 3 concurrent requests
		queueResponse(0, "");
		const results = await Promise.all([
			fetchOrigin("/repo"),
			fetchOrigin("/repo"),
			fetchOrigin("/repo"),
		]);
		expect(results).toEqual([true, true, true]);
		// Only 1 response consumed — the other 2 reused the same promise
		expect(spawnResponses).toHaveLength(0);
	});

	it("skips fetch within cooldown period", async () => {
		queueResponse(0, "");
		const ok1 = await fetchOrigin("/repo");
		expect(ok1).toBe(true);

		// Second call should skip (no spawn needed)
		const ok2 = await fetchOrigin("/repo");
		expect(ok2).toBe(true);
	});

	it("skips retry while in failure backoff", async () => {
		queueResponse(128, "", "fatal: no remote");
		const ok1 = await fetchOrigin("/repo");
		expect(ok1).toBe(false);

		// Immediate retry must be skipped without spawning git
		queueResponse(0, "");
		const ok2 = await fetchOrigin("/repo");
		expect(ok2).toBe(false);
		expect(spawnResponses).toHaveLength(1); // queued response not consumed
	});

	it("force bypasses the success cooldown", async () => {
		queueResponse(0, "");
		expect(await fetchOrigin("/repo")).toBe(true);

		queueResponse(0, "");
		expect(await fetchOrigin("/repo", undefined, undefined, { force: true })).toBe(true);
		expect(spawnResponses).toHaveLength(0); // second fetch actually ran
	});

	it("force bypasses the failure backoff and clears it on success", async () => {
		queueResponse(128, "", "fatal: no remote");
		expect(await fetchOrigin("/repo")).toBe(false);

		queueResponse(0, "");
		expect(await fetchOrigin("/repo", undefined, undefined, { force: true })).toBe(true);
		expect(spawnResponses).toHaveLength(0);
	});

	it("force still reuses an in-flight fetch for the same key", async () => {
		queueResponse(0, "");
		queueResponse(0, "");
		const [a, b] = await Promise.all([
			fetchOrigin("/repo", "main"),
			fetchOrigin("/repo", "main", undefined, { force: true }),
		]);
		expect(a && b).toBe(true);
		expect(spawnResponses).toHaveLength(1);
	});

	it("fetchCompareRef passes force through", async () => {
		queueResponse(128, "", "fatal");
		expect(await fetchCompareRef("/repo", "main")).toBe(false);

		queueResponse(0, "");
		expect(await fetchCompareRef("/repo", "main", undefined, { force: true })).toBe(true);
	});

	it("retries after the failure backoff window elapses", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			queueResponse(128, "", "fatal: no remote");
			expect(await fetchOrigin("/repo")).toBe(false);

			// First failure backoff is 2 minutes — jump past it
			vi.setSystemTime(Date.now() + 3 * 60_000);
			queueResponse(0, "");
			expect(await fetchOrigin("/repo")).toBe(true);
			expect(spawnResponses).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("doubles the backoff on consecutive failures", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			queueResponse(128, "", "fatal: no remote");
			expect(await fetchOrigin("/repo")).toBe(false);

			vi.setSystemTime(Date.now() + 3 * 60_000);
			queueResponse(128, "", "fatal: no remote");
			expect(await fetchOrigin("/repo")).toBe(false);

			// Second failure backoff is 4 minutes — 3 minutes later is still inside it
			vi.setSystemTime(Date.now() + 3 * 60_000);
			queueResponse(0, "");
			expect(await fetchOrigin("/repo")).toBe(false);
			expect(spawnResponses).toHaveLength(1);

			// Another 2 minutes (5 total) clears the 4-minute backoff
			vi.setSystemTime(Date.now() + 2 * 60_000);
			expect(await fetchOrigin("/repo")).toBe(true);
			expect(spawnResponses).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("remembers what git said about a failed branch fetch until one succeeds", async () => {
		queueResponse(128, "", "ERROR: Repository not found.\nfatal: Could not read from remote repository.");
		expect(await fetchOrigin("/repo", "feat/x")).toBe(false);
		expect(lastOriginFetchError("/repo", "feat/x")).toContain("Repository not found");
		expect(lastOriginFetchError("/repo", "other")).toBeNull();

		queueResponse(0, "");
		expect(await fetchOrigin("/repo", "feat/x", undefined, { force: true })).toBe(true);
		expect(lastOriginFetchError("/repo", "feat/x")).toBeNull();
	});

	it("a successful fetch clears the failure backoff", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			queueResponse(128, "", "fatal: no remote");
			expect(await fetchOrigin("/repo")).toBe(false);

			vi.setSystemTime(Date.now() + 3 * 60_000);
			queueResponse(0, "");
			expect(await fetchOrigin("/repo")).toBe(true);

			// Past the success cooldown: next fetch runs immediately (no backoff left)
			vi.setSystemTime(Date.now() + 10_000);
			queueResponse(0, "");
			expect(await fetchOrigin("/repo")).toBe(true);
			expect(spawnResponses).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("allows fetch for different projects concurrently", async () => {
		queueResponse(0, ""); // for /repo-a
		queueResponse(0, ""); // for /repo-b
		const [ok1, ok2] = await Promise.all([
			fetchOrigin("/repo-a"),
			fetchOrigin("/repo-b"),
		]);
		expect(ok1).toBe(true);
		expect(ok2).toBe(true);
		expect(spawnResponses).toHaveLength(0); // both consumed
	});
});

// ─── fetchCompareRef ─────────────────────────────────────────────────────────

/** Spawned fetches, minus the `-c core.quotepath=false` every git call carries. */
function fetchArgs(): string[][] {
	return spawnCommands
		.map((cmd) => cmd.filter((arg) => arg !== "-c" && arg !== "core.quotepath=false"))
		.filter((cmd) => cmd[1] === "fetch");
}

describe("fetch SSH connection reuse", () => {
	const base = "ssh -o BatchMode=yes -o ConnectTimeout=10";
	const work = "git@github.com-work:";
	const socketOf = (cmd: string) => /ControlPath="([^"]+)"/.exec(cmd)?.[1];

	it("adds ControlMaster options on unix", () => {
		for (const platform of ["darwin", "linux"] as const) {
			const cmd = fetchSshCommand(platform, "/home/u/.dev3.0/ssh-mux", work);
			expect(cmd).toContain(`${base} -o ControlMaster=auto`);
			expect(socketOf(cmd)).toMatch(/^\/home\/u\/\.dev3\.0\/ssh-mux\/[0-9a-f]{16}$/);
			expect(cmd).toContain("-o ControlPersist=300");
		}
	});

	// Two ~/.ssh/config aliases resolving to one HostName share ssh's %C, and so one
	// master: every repo then authenticated as whichever GitHub account connected first.
	it("gives each ssh alias of one host its own socket, never ssh's %C", () => {
		const dir = "/home/u/.dev3.0/ssh-mux";
		const workCmd = fetchSshCommand("darwin", dir, sshEndpointOf("git@github.com-work:base44-dev/apper.git"));
		const personalCmd = fetchSshCommand("darwin", dir, sshEndpointOf("git@github.com-personal:h0x91b/dev-3.0.git"));
		expect(workCmd).not.toContain("%C");
		expect(socketOf(workCmd)).not.toBe(socketOf(personalCmd));
		const sameWorkRepo = fetchSshCommand("darwin", dir, sshEndpointOf("git@github.com-work:base44-dev/other.git"));
		expect(socketOf(sameWorkRepo)).toBe(socketOf(workCmd));
	});

	it("reads the ssh endpoint a remote URL names", () => {
		expect(sshEndpointOf("git@github.com-work:base44-dev/apper.git")).toBe("git@github.com-work:");
		expect(sshEndpointOf("github.com:o/r")).toBe("@github.com:");
		expect(sshEndpointOf("ssh://git@github.com-work/o/r.git")).toBe("git@github.com-work:");
		expect(sshEndpointOf("ssh://me@host:2222/o/r.git")).toBe("me@host:2222");
		expect(sshEndpointOf("git+ssh://[::1]:22/o/r")).toBe("@[::1]:22");
		expect(sshEndpointOf("https://github.com/o/r.git")).toBeNull();
		expect(sshEndpointOf("file:///srv/r.git")).toBeNull();
		expect(sshEndpointOf("/srv/r.git")).toBeNull();
		expect(sshEndpointOf("./sub:dir/r.git")).toBeNull();
	});

	it("leaves the command unchanged on Windows, without a control dir, or without an ssh endpoint", () => {
		expect(fetchSshCommand("win32", "C:/dev3/ssh-mux", work)).toBe(base);
		expect(fetchSshCommand("linux", null, work)).toBe(base);
		expect(fetchSshCommand("linux", "/home/u/.dev3.0/ssh-mux", null)).toBe(base);
	});

	it("drops connection reuse when the socket path would not fit sun_path", () => {
		const qaHome = "/var/folders/04/ym_1nnl161n0p59pjl247ynr0000gn/T/dev3-qa/0123456789ab/seeded/home/.dev3.0/ssh-mux";
		expect(fetchSshCommand("darwin", qaHome, work)).toBe(base);
		expect(fetchSshCommand("darwin", `/${"a".repeat(68)}`, work)).toContain("ControlMaster=auto");
		expect(fetchSshCommand("darwin", `/${"a".repeat(69)}`, work)).toBe(base);
		expect(fetchSshCommand("linux", `/${"é".repeat(35)}`, work)).toBe(base);
	});

	it("quotes a control dir with spaces and single quotes for sh", () => {
		expect(fetchSshCommand("linux", "/Users/a b/it's/ssh-mux", work)).toMatch(
			/-o 'ControlPath="\/Users\/a b\/it'\\''s\/ssh-mux\/[0-9a-f]{16}"'/,
		);
	});

	it("fetchOrigin passes the platform's command to git", async () => {
		const platform = vi.spyOn(process, "platform", "get");
		try {
			platform.mockReturnValue("linux");
			queueResponse(0, "");
			await fetchOrigin("/repo", "a");
			expect(lastSpawnOptions?.env?.GIT_SSH_COMMAND).toContain("ControlMaster=auto");
			expect(socketOf(lastSpawnOptions?.env?.GIT_SSH_COMMAND ?? "")).toMatch(/^\/tmp\/dev3-test\/ssh-mux\/[0-9a-f]{16}$/);

			platform.mockReturnValue("win32");
			queueResponse(0, "");
			await fetchOrigin("/repo", "b");
			expect(lastSpawnOptions?.env?.GIT_SSH_COMMAND).not.toContain("ControlMaster");
		} finally {
			platform.mockRestore();
		}
	});

	it("keys the socket by the remote being fetched", async () => {
		const platform = vi.spyOn(process, "platform", "get");
		try {
			platform.mockReturnValue("darwin");
			remoteUrl = "git@github.com-work:base44-dev/apper.git";
			queueResponse(0, "");
			await fetchOrigin("/work", "main");
			const workSocket = socketOf(lastSpawnOptions?.env?.GIT_SSH_COMMAND ?? "");
			remoteUrl = "git@github.com-personal:h0x91b/dev-3.0.git";
			queueResponse(0, "");
			await fetchOrigin("/personal", "main");
			expect(workSocket).toBeDefined();
			expect(socketOf(lastSpawnOptions?.env?.GIT_SSH_COMMAND ?? "")).not.toBe(workSocket);
		} finally {
			platform.mockRestore();
		}
	});

	it("leaves a repo's own core.sshCommand in charge", async () => {
		repoSshCommand = "ssh -i ~/.ssh/work";
		queueResponse(0, "");
		await fetchOrigin("/repo", "main");
		expect(lastSpawnOptions?.env?.GIT_SSH_COMMAND).toBeUndefined();
		expect(lastSpawnOptions?.env?.GIT_TERMINAL_PROMPT).toBe("0");
	});
});

describe("fetch queue priority", () => {
	it("runs a priority job before a queued normal job, one git fetch at a time", async () => {
		spawnResponses.push({ exitCode: 0, stdout: "", stderr: "", gated: true }); // running job
		queueResponse(0, "");
		queueResponse(0, "");

		const running = fetchOrigin("/repo", "running");
		await vi.waitFor(() => expect(gates).toHaveLength(1));
		const normal = fetchOrigin("/repo", "normal");
		const priority = fetchOrigin("/repo", "urgent", undefined, { priority: true });
		await new Promise((r) => setTimeout(r, 20));
		expect(fetchArgs()).toHaveLength(1); // nothing else started while the first runs

		gates[0]();
		await Promise.all([running, normal, priority]);

		expect(fetchArgs().map((cmd) => cmd[3])).toEqual(["running", "urgent", "normal"]);
		expect(maxActiveSpawns).toBe(1);
	});

	it("keeps FIFO order among priority jobs", async () => {
		spawnResponses.push({ exitCode: 0, stdout: "", stderr: "", gated: true });
		queueResponse(0, "");
		queueResponse(0, "");
		queueResponse(0, "");

		const running = fetchOrigin("/repo", "running");
		await vi.waitFor(() => expect(gates).toHaveLength(1));
		const jobs = [
			fetchOrigin("/repo", "n1"),
			fetchOrigin("/repo", "p1", undefined, { priority: true }),
			fetchOrigin("/repo", "p2", undefined, { priority: true }),
		];
		await new Promise((r) => setTimeout(r, 20));
		gates[0]();
		await Promise.all([running, ...jobs]);

		expect(fetchArgs().map((cmd) => cmd[3])).toEqual(["running", "p1", "p2", "n1"]);
	});
});

describe("fetchOriginBranches", () => {
	it("fetches both branches in one git process and sets each cooldown", async () => {
		queueResponse(0, "");
		expect(await fetchOriginBranches("/repo", ["main", "dev3/t"])).toBe(true);
		expect(fetchArgs()).toEqual([["git", "fetch", "origin", "main", "dev3/t", "--quiet"]]);

		// Single-branch fetches now see the cooldown: no further git process.
		expect(await fetchOrigin("/repo", "main")).toBe(true);
		expect(await fetchOrigin("/repo", "dev3/t")).toBe(true);
		expect(await fetchOriginBranches("/repo", ["main", "dev3/t"])).toBe(true);
		expect(fetchArgs()).toHaveLength(1);
	});

	it("skips only the branches in cooldown", async () => {
		queueResponse(0, "");
		await fetchOrigin("/repo", "main");
		queueResponse(0, "");
		expect(await fetchOriginBranches("/repo", ["main", "dev3/t"])).toBe(true);
		expect(fetchArgs().map((cmd) => cmd.slice(2))).toEqual([["origin", "main", "--quiet"], ["origin", "dev3/t", "--quiet"]]);
	});

	it("force fetches branches that are in cooldown", async () => {
		queueResponse(0, "");
		await fetchOriginBranches("/repo", ["a", "b"]);
		queueResponse(0, "");
		expect(await fetchOriginBranches("/repo", ["a", "b"], undefined, { force: true })).toBe(true);
		expect(fetchArgs()).toHaveLength(2);
	});

	it("falls back to per-branch fetches when the combined fetch fails", async () => {
		queueResponse(128, "", "fatal: couldn't find remote ref dead");
		queueResponse(0, ""); // main
		queueResponse(128, "", "fatal: couldn't find remote ref dead"); // dead
		expect(await fetchOriginBranches("/repo", ["main", "dead"])).toBe(false);
		expect(fetchArgs().map((cmd) => cmd.slice(2))).toEqual([
			["origin", "main", "dead", "--quiet"],
			["origin", "main", "--quiet"],
			["origin", "dead", "--quiet"],
		]);

		// main is in cooldown, dead is in backoff: nothing spawns, and the miss is reported.
		expect(await fetchOriginBranches("/repo", ["main", "dead"])).toBe(false);
		expect(fetchArgs()).toHaveLength(3);
	});

	it("does nothing for an empty list", async () => {
		expect(await fetchOriginBranches("/repo", [])).toBe(true);
		expect(spawnCommands).toHaveLength(0);
	});
});

describe("fetchCompareRef", () => {
	/** Spawned fetches, minus the `-c core.quotepath=false` every git call carries. */
	function fetchCommands(): string[][] {
		return spawnCommands
			.map((cmd) => cmd.filter((arg) => arg !== "-c" && arg !== "core.quotepath=false"))
			.filter((cmd) => cmd[1] === "fetch");
	}

	it("fetches a fork-qualified base from the remote that owns it", async () => {
		queueResponse(0, "origin\narditti\n"); // git remote
		queueResponse(0, ""); // git fetch

		expect(await fetchCompareRef("/repo", "arditti/feat/file-path-open")).toBe(true);
		expect(fetchCommands()).toEqual([[
			"git", "fetch", "arditti",
			"+refs/heads/feat/file-path-open:refs/remotes/arditti/feat/file-path-open",
			"--quiet",
		]]);
	});

	it("treats a slashed branch name as an origin branch when no such remote exists", async () => {
		queueResponse(0, "origin\n"); // git remote
		queueResponse(0, ""); // git fetch

		expect(await fetchCompareRef("/repo", "feat/file-path-open")).toBe(true);
		expect(fetchCommands()).toEqual([["git", "fetch", "origin", "feat/file-path-open", "--quiet"]]);
	});

	it("does not consult remotes for an unslashed branch", async () => {
		queueResponse(0, ""); // git fetch

		expect(await fetchCompareRef("/repo", "main")).toBe(true);
		expect(spawnCommands.some((cmd) => cmd[cmd.length - 1] === "remote")).toBe(false);
	});

	it("keeps the origin and fork fetches of the same branch on separate cooldowns", async () => {
		queueResponse(0, "origin\narditti\n");
		queueResponse(0, "");
		expect(await fetchCompareRef("/repo", "arditti/feat/x")).toBe(true);

		queueResponse(0, "");
		expect(await fetchOrigin("/repo", "arditti/feat/x")).toBe(true);
		expect(fetchCommands()).toHaveLength(2);
	});
});

// ─── saveDiffSnapshot ────────────────────────────────────────────────────────

describe("saveDiffSnapshot", () => {
	let tmpDir: string;
	const project: Project = { id: "proj-1", name: "Test", path: "" } as Project;
	const task: Task = { id: "task-1000-0000-0000" } as Task;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "dev3-snap-test-"));
		project.path = tmpDir;
		(task as { worktreePath: string }).worktreePath = tmpDir;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("saves a gzip-compressed .patch.gz file when there are changes", async () => {
		queueResponse(0, " 1 file changed, 1 insertion(+)"); // shortstat
		queueResponse(0, "diff --git a/feature.ts b/feature.ts\n+export const add = 1;\n");
		await saveDiffSnapshot(project, task, "origin/main");

		const diffsDir = join(taskDir(project, task), "diffs");
		expect(existsSync(diffsDir)).toBe(true);

		const files = listDiffSnapshots(diffsDir);
		expect(files).toHaveLength(1);

		expect(files[0]).toMatch(/\.patch\.gz$/);
		expect(readFileSync(join(diffsDir, files[0])).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
		expect(readDiffSnapshot(join(diffsDir, files[0]))).toContain("feature.ts");
	});

	it("skips saving when there is no diff", async () => {
		queueResponse(0, ""); // empty shortstat → no diff
		await saveDiffSnapshot(project, task, "origin/main");

		const diffsDir = join(taskDir(project, task), "diffs");
		const files = listDiffSnapshots(diffsDir);
		expect(files).toHaveLength(0);
	});

	it("skips saving when diff is unchanged from the last snapshot", async () => {
		const diffContent = "diff --git a/f.ts b/f.ts\n+line\n";
		queueResponse(0, " 1 file changed, 1 insertion(+)"); // shortstat
		queueResponse(0, diffContent);
		await saveDiffSnapshot(project, task, "origin/main");

		queueResponse(0, " 1 file changed, 1 insertion(+)"); // shortstat
		queueResponse(0, diffContent); // same diff
		await saveDiffSnapshot(project, task, "origin/main");

		const diffsDir = join(taskDir(project, task), "diffs");
		const files = listDiffSnapshots(diffsDir);
		expect(files).toHaveLength(1);
	});

	it("saves a new file when diff changes", async () => {
		queueResponse(0, " 1 file changed, 1 insertion(+)"); // shortstat
		queueResponse(0, "diff v1\n");
		await saveDiffSnapshot(project, task, "origin/main");

		// Advance time to get a different timestamp
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.advanceTimersByTime(60_000);
		queueResponse(0, " 1 file changed, 1 insertion(+)"); // shortstat
		queueResponse(0, "diff v2\n");
		await saveDiffSnapshot(project, task, "origin/main");
		vi.useRealTimers();

		const diffsDir = join(taskDir(project, task), "diffs");
		const files = listDiffSnapshots(diffsDir);
		expect(files).toHaveLength(2);
	});

	it("prunes old snapshots beyond MAX_DIFF_SNAPSHOTS", async () => {
		const diffsDir = join(taskDir(project, task), "diffs");
		mkdirSync(diffsDir, { recursive: true });

		for (let i = 0; i < 55; i++) {
			const name = `2025-01-01T00-00-${String(i).padStart(2, "0")}.patch`;
			writeFileSync(join(diffsDir, name), `patch-${i}`);
		}

		queueResponse(0, " 1 file changed, 1 insertion(+)"); // shortstat
		queueResponse(0, "new diff content\n");
		await saveDiffSnapshot(project, task, "origin/main");

		const files = listDiffSnapshots(diffsDir);
		expect(files.length).toBeLessThanOrEqual(50);
	});

	it("skips saving when the newest snapshot is an older version's plain .patch with the same diff", async () => {
		const diffsDir = join(taskDir(project, task), "diffs");
		mkdirSync(diffsDir, { recursive: true });
		writeFileSync(join(diffsDir, "2025-01-01T00-00-00.patch"), "same diff");

		queueResponse(0, " 1 file changed, 1 insertion(+)");
		queueResponse(0, "same diff\n");
		await saveDiffSnapshot(project, task, "origin/main");

		expect(listDiffSnapshots(diffsDir)).toEqual(["2025-01-01T00-00-00.patch"]);
	});

	it("prunes plain and gzip snapshots together, oldest first", async () => {
		const diffsDir = join(taskDir(project, task), "diffs");
		mkdirSync(diffsDir, { recursive: true });
		for (let i = 0; i < 30; i++) {
			writeFileSync(join(diffsDir, `2025-01-01T00-00-${String(i * 2).padStart(2, "0")}.patch`), `plain-${i}`);
			writeFileSync(join(diffsDir, `2025-01-01T00-01-${String(i * 2).padStart(2, "0")}.patch.gz`), gzipSync(`gz-${i}`));
		}

		queueResponse(0, " 1 file changed, 1 insertion(+)");
		queueResponse(0, "new diff content\n");
		await saveDiffSnapshot(project, task, "origin/main");

		const files = listDiffSnapshots(diffsDir);
		expect(files).toHaveLength(50);
		expect(files[0]).toBe("2025-01-01T00-00-22.patch");
		expect(files[files.length - 1]).toMatch(/\.patch\.gz$/);
		expect(readDiffSnapshot(join(diffsDir, files[files.length - 1]))).toBe("new diff content");
	});

	it("skips saving when shortstat estimates diff exceeds 1 MB", async () => {
		// 20000 insertions × 80 bytes/line = ~1.6 MB → exceeds 1 MB limit
		queueResponse(0, " 100 files changed, 20000 insertions(+), 5000 deletions(-)");
		// No second spawn should happen — pre-check aborts early
		await saveDiffSnapshot(project, task, "origin/main");

		const diffsDir = join(taskDir(project, task), "diffs");
		const files = listDiffSnapshots(diffsDir);
		expect(files).toHaveLength(0);
	});

	it("skips saving when actual diff exceeds 1 MB despite small shortstat estimate", async () => {
		// shortstat looks small but actual diff is huge (e.g. binary-like content)
		queueResponse(0, " 1 file changed, 10 insertions(+)"); // shortstat
		queueResponse(0, "x".repeat(1_100_000) + "\n"); // actual diff exceeds limit
		await saveDiffSnapshot(project, task, "origin/main");

		const diffsDir = join(taskDir(project, task), "diffs");
		const files = listDiffSnapshots(diffsDir);
		expect(files).toHaveLength(0);
	});
});
