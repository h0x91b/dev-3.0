import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { GitInitOffer } from "../shared/types";
import * as git from "./git";
import { createLogger } from "./logger";

const log = createLogger("git-init-in-place");

/** Junk macOS / Windows / editors leave behind; never counted as the user's files. */
export const IGNORED_FOLDER_JUNK = new Set([".DS_Store", "Thumbs.db", ".localized"]);

export const DEV3_README_RELATIVE = ".dev3/README.md";

export const DEV3_README_CONTENT = [
	"# .dev3/",
	"",
	"This folder is used by [dev-3.0](https://github.com/h0x91b/dev-3.0) to",
	"store project-level config (setup / dev / cleanup scripts, clone paths,",
	"base branch, etc). Check it in so the whole team shares the same setup.",
	"",
	"Local overrides go into `.dev3/config.local.json` (git-ignored).",
	"",
].join("\n");

/** Used for the app-owned first commit only when the user has no git identity. */
const FALLBACK_IDENTITY = ["-c", "user.name=dev-3.0", "-c", "user.email=dev3@localhost"];

const INIT_COMMIT_MESSAGE = "init";

function samePath(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

function userEntries(path: string): string[] {
	return readdirSync(path).filter((name) => name !== ".git" && !IGNORED_FOLDER_JUNK.has(name));
}

/** Our own placeholder may be committed; any other `.dev3/README.md` is the user's and stays untouched. */
function placeholderState(path: string): GitInitOffer["placeholder"] {
	const readme = join(path, ".dev3", "README.md");
	const dev3Dir = join(path, ".dev3");
	if (existsSync(dev3Dir) && !statSync(dev3Dir).isDirectory()) return "keep";
	if (!existsSync(readme)) return "create";
	try {
		return readFileSync(readme, "utf8") === DEV3_README_CONTENT ? "reuse" : "keep";
	} catch {
		return "keep";
	}
}

/**
 * Decide whether dev3 may make `path` a usable project in place. Returns null when
 * it must not: the folder belongs to a repo that already has history, sits inside
 * a parent repo or a git dir, or git cannot vouch for it (e.g. dubious ownership).
 */
export async function probeGitInit(path: string): Promise<GitInitOffer | null> {
	if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) return null;

	const inside = await git.run(["git", "rev-parse", "--is-inside-work-tree"], path);
	let mode: GitInitOffer["mode"];
	if (inside.ok && inside.stdout === "true") {
		const top = await git.run(["git", "rev-parse", "--show-toplevel"], path);
		if (!top.ok || !samePath(top.stdout, path)) return null;
		const head = await git.run(["git", "rev-parse", "--verify", "--quiet", "HEAD"], path);
		if (head.ok) return null;
		mode = "first-commit";
	} else {
		if (/dubious ownership/i.test(inside.stderr)) return null;
		// Inside a bare repo or a .git dir: rev-parse succeeds but there is no work tree.
		if ((await git.run(["git", "rev-parse", "--git-dir"], path)).ok) return null;
		// A `.git` git cannot read is somebody's broken repo, not a blank folder.
		if (existsSync(join(path, ".git"))) return null;
		mode = "init";
	}

	return { path, mode, placeholder: placeholderState(path), existingEntries: userEntries(path).length };
}

async function commitTree(path: string, tree: string): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
	let commit = await git.run(["git", "commit-tree", tree, "-m", INIT_COMMIT_MESSAGE], path);
	if (!commit.ok) {
		// Usually an unset user.name/user.email. Retry under a dev3 identity, and only
		// then, so a user who has one keeps their own name on the commit.
		log.warn("commit-tree failed, retrying with a fallback identity", { stderr: commit.stderr });
		commit = await git.run(["git", ...FALLBACK_IDENTITY, "commit-tree", tree, "-m", INIT_COMMIT_MESSAGE], path);
	}
	if (!commit.ok) return { ok: false, error: `git commit failed: ${commit.stderr || "unknown error"}` };
	return { ok: true, sha: commit.stdout };
}

/**
 * Make `path` a repo with one commit holding only dev3's placeholder (or nothing).
 * The commit is assembled through a private index, so the user's files, their
 * index and their hooks are never involved: nothing of theirs gets staged or
 * committed. Safe to retry after any partial failure — nothing here deletes.
 */
export async function initGitInPlace(path: string): Promise<{ ok: true; offer: GitInitOffer } | { ok: false; error: string }> {
	const offer = await probeGitInit(path);
	if (!offer) return { ok: false, error: "This folder cannot be initialized: it already belongs to a Git repository" };
	log.info("initGitInPlace", { mode: offer.mode, placeholder: offer.placeholder, existingEntries: offer.existingEntries });

	if (offer.mode === "init") {
		const init = await git.run(["git", "init"], path);
		if (!init.ok) return { ok: false, error: `git init failed: ${init.stderr || "unknown error"}` };
	}

	let commitPlaceholder = offer.placeholder !== "keep";
	if (offer.placeholder === "create") {
		try {
			mkdirSync(join(path, ".dev3"), { recursive: true });
			writeFileSync(join(path, ".dev3", "README.md"), DEV3_README_CONTENT, { encoding: "utf8", flag: "wx" });
		} catch (err) {
			// The first commit does not need the placeholder; an empty one serves as well.
			log.warn("Could not write the .dev3 placeholder, committing without it", { error: String(err) });
			commitPlaceholder = false;
		}
	}

	const indexPath = await git.run(["git", "rev-parse", "--git-path", "dev3-init-index"], path);
	if (!indexPath.ok) return { ok: false, error: `git rev-parse failed: ${indexPath.stderr || "unknown error"}` };
	const privateIndex = isAbsolute(indexPath.stdout) ? indexPath.stdout : join(path, indexPath.stdout);
	const env = { GIT_INDEX_FILE: privateIndex };
	try {
		rmSync(privateIndex, { force: true });
		let blob = "";
		if (commitPlaceholder) {
			const hashed = await git.run(["git", "hash-object", "-w", "--", DEV3_README_RELATIVE], path);
			if (!hashed.ok) return { ok: false, error: `git hash-object failed: ${hashed.stderr || "unknown error"}` };
			blob = hashed.stdout;
			const staged = await git.run(["git", "update-index", "--add", "--cacheinfo", `100644,${blob},${DEV3_README_RELATIVE}`], path, { env });
			if (!staged.ok) return { ok: false, error: `git update-index failed: ${staged.stderr || "unknown error"}` };
		}
		const tree = await git.run(["git", "write-tree"], path, { env });
		if (!tree.ok) return { ok: false, error: `git write-tree failed: ${tree.stderr || "unknown error"}` };

		const commit = await commitTree(path, tree.stdout);
		if (!commit.ok) return commit;

		const headRef = await git.run(["git", "symbolic-ref", "HEAD"], path);
		if (!headRef.ok) return { ok: false, error: `git symbolic-ref failed: ${headRef.stderr || "unknown error"}` };
		// The empty old value makes git refuse if the branch appeared meanwhile.
		const ref = await git.run(["git", "update-ref", "-m", "dev3: initial commit", headRef.stdout, commit.sha, ""], path);
		if (!ref.ok) return { ok: false, error: `git update-ref failed: ${ref.stderr || "unknown error"}` };

		if (blob) {
			// Without this the real index lacks the placeholder and git reports it deleted.
			const track = await git.run(["git", "update-index", "--add", "--cacheinfo", `100644,${blob},${DEV3_README_RELATIVE}`], path);
			if (!track.ok) log.warn("Could not record the placeholder in the index", { stderr: track.stderr });
		}
		return { ok: true, offer };
	} finally {
		rmSync(privateIndex, { force: true });
	}
}
