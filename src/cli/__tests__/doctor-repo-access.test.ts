import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRepositoryAccess, classifyAccessError, findTerminalHost, type RepoAccessDeps } from "../commands/doctor-repo-access";

const HOME = "/Users/tester";
const WORKTREE = `${HOME}/.dev3.0/worktrees/Users-tester-Desktop-app/abc12345/worktree`;
const GITDIR = `${HOME}/Desktop/app/.git/worktrees/worktree3`;
const TMUX = "/Applications/dev-3.0.app/Contents/Resources/app/tmux/tmux";
const HOST = "/Applications/dev-3.0.app/Contents/Resources/app/native/dev3-terminal-host";

const TMUX_TREE: Record<number, { ppid: number; path: string }> = {
	500: { ppid: 400, path: "/Users/tester/.dev3.0/bin/dev3" },
	400: { ppid: 300, path: "/opt/homebrew/bin/zsh" },
	300: { ppid: 1, path: TMUX },
};

function deps(overrides: Partial<RepoAccessDeps> = {}, gitDirError: string | null = null): RepoAccessDeps {
	return {
		platform: "darwin",
		home: HOME,
		cwd: WORKTREE,
		pid: 500,
		probeDir: (p) => (p === GITDIR ? gitDirError : null),
		readDotGit: (p) => (p === `${WORKTREE}/.git` ? `gitdir: ${GITDIR}\n` : null),
		processInfo: (pid) => TMUX_TREE[pid] ?? null,
		...overrides,
	};
}

describe("repository access check", () => {
	it("is skipped outside a git checkout", () => {
		expect(checkRepositoryAccess(deps({ readDotGit: () => null }))).toBeNull();
	});

	it("passes when the worktree's git directory is readable", () => {
		expect(checkRepositoryAccess(deps())?.status).toBe("ok");
	});

	it("reports a deleted project repository as missing, not as a permission problem", () => {
		const result = checkRepositoryAccess(deps({}, "ENOENT"));
		expect(result?.status).toBe("fail");
		expect(result?.detail).toContain("does not exist");
		expect(result?.detail).not.toContain("privacy");
	});

	it("reports EPERM on a Desktop repo as access denied, listing privacy protection as one possible cause", () => {
		const result = checkRepositoryAccess(deps({}, "EPERM"));
		expect(result?.status).toBe("fail");
		expect(result?.detail).toContain("access denied");
		expect(result?.detail).not.toContain("privacy");
		expect(result?.detail).toContain(`tmux server ${TMUX}`);
		const hints = result?.hints?.join("\n") ?? "";
		expect(hints).toContain("~/Desktop");
		expect(hints).toContain(`adding ${TMUX}`);
		expect(hints).toContain("sandbox");
	});

	it("names the native terminal host when there is no tmux", () => {
		const tree = { 500: { ppid: 400, path: "/bin/zsh" }, 400: { ppid: 1, path: HOST } };
		const result = checkRepositoryAccess(deps({ processInfo: (pid) => tree[pid as 500 | 400] ?? null }, "EPERM"));
		expect(result?.detail).toContain(`native terminal host ${HOST}`);
	});

	it("does not suggest privacy protection for EPERM outside protected folders", () => {
		const gitDir = `${HOME}/src/app/.git/worktrees/w`;
		const result = checkRepositoryAccess(
			deps({ readDotGit: (p) => (p === `${WORKTREE}/.git` ? `gitdir: ${gitDir}` : null), probeDir: (p) => (p === gitDir ? "EPERM" : null) }),
		);
		expect(result?.detail).toContain("access denied");
		const hints = result?.hints?.join("\n") ?? "";
		expect(hints).toContain("sandbox");
		expect(hints).not.toContain("Full Disk Access");
	});

	it("does not suggest privacy protection on Linux even under ~/Desktop", () => {
		const hints = checkRepositoryAccess(deps({ platform: "linux" }, "EPERM"))?.hints?.join("\n") ?? "";
		expect(hints).not.toContain("Full Disk Access");
		expect(classifyAccessError("EPERM")).toBe("denied");
	});

	it("reports POSIX permission denial (EACCES) as a file-permission problem", () => {
		const result = checkRepositoryAccess(deps({}, "EACCES"));
		expect(result?.status).toBe("fail");
		expect(result?.detail).toContain("EACCES");
	});

	it("classifies a .git that cannot even be stat-ed under a protected folder", () => {
		const cwd = `${HOME}/Documents/proj`;
		const result = checkRepositoryAccess(
			deps({
				cwd,
				readDotGit: (p) => {
					if (p === `${cwd}/.git`) throw Object.assign(new Error("denied"), { code: "EPERM" });
					return null;
				},
			}),
		);
		expect(result?.hints?.join("\n")).toContain("~/Documents");
	});
});

describe("findTerminalHost", () => {
	it("returns null when no dev3 host is in the process chain", () => {
		const tree = { 500: { ppid: 1, path: "/bin/zsh" } };
		expect(findTerminalHost({ pid: 500, processInfo: (pid) => tree[pid as 500] ?? null })).toBeNull();
	});
});

// Real git on a synthetic worktree: every failure below prints the same
// "not a git repository", which is why the check probes the git dir itself.
describe("repository access check on a real filesystem", () => {
	function realDeps(cwd: string): RepoAccessDeps {
		return {
			platform: process.platform,
			home: "/nonexistent-home",
			cwd,
			pid: process.pid,
			probeDir: (p) => {
				try {
					readdirSync(p);
					return null;
				} catch (err) {
					return (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
				}
			},
			readDotGit: (p) => {
				try {
					return statSync(p).isDirectory() ? "dir" : readFileSync(p, "utf-8");
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
					throw err;
				}
			},
			processInfo: () => null,
		};
	}

	it("distinguishes a missing repository from a POSIX-permission denial", () => {
		const root = mkdtempSync(join(tmpdir(), "dev3-repo-access-"));
		try {
			const gitDir = join(root, "main", ".git", "worktrees", "w");
			const worktree = join(root, "w");
			mkdirSync(gitDir, { recursive: true });
			mkdirSync(worktree);
			writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);

			expect(checkRepositoryAccess(realDeps(worktree))?.status).toBe("ok");

			chmodSync(gitDir, 0o000);
			const denied = checkRepositoryAccess(realDeps(worktree));
			chmodSync(gitDir, 0o755);
			// root bypasses POSIX permissions, so only assert where the denial is real
			if (process.getuid?.() !== 0) expect(denied?.detail).toContain("EACCES");

			rmSync(join(root, "main"), { recursive: true });
			expect(checkRepositoryAccess(realDeps(worktree))?.detail).toContain("does not exist");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
