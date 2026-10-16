/**
 * `probeGitInit` / `initGitInPlace` against real git in throwaway temp folders.
 * The guarantees that matter — the user's files are never committed or touched,
 * a repo with history is never rewritten, a failed attempt can be retried — are
 * properties of what git actually does, which a mocked spawn cannot show.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../paths", () => ({ DEV3_HOME: "/tmp/dev3-test" }));

const identity: { env: Record<string, string> } = { env: {} };

vi.mock("../spawn", async () => {
	const { createSpawnMock } = await import("./git-test-helpers");
	const base = createSpawnMock();
	return {
		...base,
		// Like the real wrapper: the child sees process.env plus the caller's env.
		spawn: (cmd: string[], opts?: Record<string, unknown>) =>
			base.spawn(cmd, { ...opts, env: { ...process.env, ...identity.env, ...(opts?.env as object | undefined) } }),
	};
});

import { DEV3_README_CONTENT, initGitInPlace, probeGitInit } from "../git-init-in-place";
import { GIT_CONFIG_ISOLATION } from "./git-test-helpers";

const WITH_IDENTITY = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
};

/** Git must not guess an identity from the hostname, or "no identity" cannot be tested. */
const CONFIG_ONLY_IDENTITY = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.useConfigOnly", GIT_CONFIG_VALUE_0: "true" };

function sh(cmd: string, cwd: string): string {
	return execSync(cmd, {
		cwd,
		env: { ...process.env, ...WITH_IDENTITY, ...GIT_CONFIG_ISOLATION },
		stdio: "pipe",
		encoding: "utf-8",
	}).trim();
}

let root: string;
let folder: string;

beforeEach(() => {
	identity.env = { ...WITH_IDENTITY, ...CONFIG_ONLY_IDENTITY };
	root = mkdtempSync(join(tmpdir(), "dev3-git-init-"));
	folder = join(root, "project");
	mkdirSync(folder);
	writeFileSync(join(folder, "a.txt"), "hi\n");
	writeFileSync(join(folder, ".env"), "SECRET=1\n");
	mkdirSync(join(folder, "src"));
	writeFileSync(join(folder, "src", "index.ts"), "export {};\n");
});

afterEach(() => {
	chmodSync(folder, 0o755);
	rmSync(root, { recursive: true, force: true });
});

function committedFiles(path: string): string[] {
	return sh("git ls-tree -r --name-only HEAD", path).split("\n").filter(Boolean);
}

describe("probeGitInit", () => {
	it("offers git init for a non-empty plain folder", async () => {
		expect(await probeGitInit(folder)).toEqual({ path: folder, mode: "init", placeholder: "create", existingEntries: 3 });
	});

	it("offers nothing for a repo with history", async () => {
		sh("git init -q && git add a.txt && git commit -qm first", folder);
		expect(await probeGitInit(folder)).toBeNull();
	});

	it("offers nothing for a folder inside a parent repo", async () => {
		sh("git init -q && git commit -q --allow-empty -m first", root);
		expect(await probeGitInit(folder)).toBeNull();
	});

	it("never commits into a commit-less parent repo through a subfolder", async () => {
		sh("git init -q", root);
		expect(await probeGitInit(folder)).toBeNull();
		expect((await initGitInPlace(folder)).ok).toBe(false);
		expect(() => sh("git rev-parse --verify -q HEAD", root)).toThrow();
	});

	it("offers nothing when a .git exists that git cannot read", async () => {
		writeFileSync(join(folder, ".git"), "gitdir: /nowhere\n");
		expect(await probeGitInit(folder)).toBeNull();
	});

	it("offers a first commit for a repo that has none", async () => {
		sh("git init -q", folder);
		expect(await probeGitInit(folder)).toMatchObject({ mode: "first-commit", placeholder: "create" });
	});
});

describe("initGitInPlace", () => {
	it("commits only the placeholder and leaves every existing file untouched and untracked", async () => {
		const result = await initGitInPlace(folder);
		expect(result.ok).toBe(true);

		expect(committedFiles(folder)).toEqual([".dev3/README.md"]);
		expect(readFileSync(join(folder, ".dev3", "README.md"), "utf8")).toBe(DEV3_README_CONTENT);
		expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("hi\n");
		expect(readFileSync(join(folder, ".env"), "utf8")).toBe("SECRET=1\n");
		// The placeholder is clean (not "deleted"), the user's files are untracked, nothing is staged.
		expect(sh("git status --porcelain --untracked-files=all", folder).split("\n").sort()).toEqual(
			["?? .env", "?? a.txt", "?? src/index.ts"],
		);
		expect(sh("git log --format=%an%x09%s", folder)).toBe("Test\tinit");
		expect(existsSync(join(folder, ".git", "dev3-init-index"))).toBe(false);
	});

	it("never rewrites an existing .dev3/README.md and commits nothing of the user's", async () => {
		mkdirSync(join(folder, ".dev3"));
		writeFileSync(join(folder, ".dev3", "README.md"), "mine\n");
		writeFileSync(join(folder, ".dev3", "config.json"), "{}\n");

		const result = await initGitInPlace(folder);
		expect(result.ok && result.offer.placeholder).toBe("keep");
		expect(committedFiles(folder)).toEqual([]);
		expect(readFileSync(join(folder, ".dev3", "README.md"), "utf8")).toBe("mine\n");
		expect(readFileSync(join(folder, ".dev3", "config.json"), "utf8")).toBe("{}\n");
	});

	it("adds the placeholder beside existing .dev3 files without committing them", async () => {
		mkdirSync(join(folder, ".dev3"));
		writeFileSync(join(folder, ".dev3", "config.json"), "{}\n");

		expect((await initGitInPlace(folder)).ok).toBe(true);
		expect(committedFiles(folder)).toEqual([".dev3/README.md"]);
		expect(readFileSync(join(folder, ".dev3", "config.json"), "utf8")).toBe("{}\n");
	});

	it("refuses a repo with history and leaves it exactly as it was", async () => {
		sh("git init -q && git add a.txt && git commit -qm first", folder);
		const head = sh("git rev-parse HEAD", folder);

		const result = await initGitInPlace(folder);
		expect(result.ok).toBe(false);
		expect(sh("git rev-parse HEAD", folder)).toBe(head);
		expect(existsSync(join(folder, ".dev3"))).toBe(false);
	});

	it("never creates a nested repo inside a parent repo", async () => {
		sh("git init -q && git commit -q --allow-empty -m first", root);
		expect((await initGitInPlace(folder)).ok).toBe(false);
		expect(existsSync(join(folder, ".git"))).toBe(false);
	});

	it("finishes a commit-less repo without committing what the user staged", async () => {
		sh("git init -q && git add a.txt", folder);

		expect((await initGitInPlace(folder)).ok).toBe(true);
		expect(committedFiles(folder)).toEqual([".dev3/README.md"]);
		expect(sh("git diff --cached --name-only", folder)).toBe("a.txt");
	});

	it("falls back to a dev3 identity only when the user has none", async () => {
		identity.env = { ...CONFIG_ONLY_IDENTITY };

		expect((await initGitInPlace(folder)).ok).toBe(true);
		expect(sh("git log --format=%an%x09%ae", folder)).toBe("dev-3.0\tdev3@localhost");
		expect(sh("git config --local --get user.name || true", folder)).toBe("");
	});

	it("can be retried after a commit that never landed, reusing its own placeholder", async () => {
		// The state a failed earlier attempt leaves: repo initialized, placeholder written, no commit.
		sh("git init -q", folder);
		mkdirSync(join(folder, ".dev3"));
		writeFileSync(join(folder, ".dev3", "README.md"), DEV3_README_CONTENT);

		const result = await initGitInPlace(folder);
		expect(result.ok && result.offer).toMatchObject({ mode: "first-commit", placeholder: "reuse" });
		expect(committedFiles(folder)).toEqual([".dev3/README.md"]);
	});

	it.skipIf(process.getuid?.() === 0)("reports a permission error without touching the files", async () => {
		chmodSync(folder, 0o555);

		const result = await initGitInPlace(folder);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/git init failed/);
		chmodSync(folder, 0o755);
		expect(existsSync(join(folder, ".git"))).toBe(false);
		expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("hi\n");
	});
});
