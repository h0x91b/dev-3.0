/**
 * The squash-merge commit subject (Seq 1640).
 *
 * The defect this guards against is permanent by nature: a merge subject cannot
 * be fixed after the fact without rewriting history, and this repo's own main
 * carries 86 subjects that are the first 80 characters of a task DESCRIPTION with
 * a trailing ellipsis. Two halves are covered here:
 *  - `buildMergeCommitMessage`, the pure choice of source — including every
 *    awkward title (scratch placeholder, ellipsis, newline, over-long, empty).
 *  - `listBranchCommitMessages` against a REAL repo, because a canned stdout
 *    would prove nothing about the `%B%x00` format or the merge-base range.
 *
 * The third describe is a SOURCE guard over the call sites, because the two above
 * are assertions on helpers: they stay green while a caller hands `task.title`
 * straight to `writeMergeCommitMessage`, which is exactly the bug. What it adds on
 * top of the behavioural coverage is the SECOND caller — a new merge path that
 * skips the builder fails here.
 *
 * The handler itself is covered where it can actually run:
 * `rpc-handlers/__tests__/git-op-pane-launch.test.ts` invokes `mergeTask` and
 * asserts the bytes handed to `git commit -F`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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

vi.mock("../spawn", async () => {
	const { createSpawnMock } = await import("./git-test-helpers");
	return createSpawnMock(() => "[]");
});

import { buildMergeCommitMessage } from "../git-op-script";
import { listBranchCommitMessages } from "../git";
import { createTestRepo, cleanup, g, type TestRepo } from "./git-test-helpers";

const TRUNCATED_TITLE = "The game draws its own cursor (`drawCursor()` in `src/render/draw-world.ts`,…";

describe("buildMergeCommitMessage", () => {
	it("reuses a single commit's message verbatim, subject and body", () => {
		const message = "Hide the OS pointer over the canvas\n\nThe canvas draws its own cursor.";
		expect(buildMergeCommitMessage({
			commits: [message],
			taskTitle: TRUNCATED_TITLE,
			branchName: "feat/cursor",
		})).toBe(`${message}\n`);
	});

	it("uses the task title as subject and the commit subjects as body", () => {
		expect(buildMergeCommitMessage({
			commits: ["Add the cursor sprite\n\nbody one", "Hide the OS pointer"],
			taskTitle: "Hide the OS cursor over the game canvas",
			branchName: "feat/cursor",
		})).toBe("Hide the OS cursor over the game canvas\n\n- Add the cursor sprite\n- Hide the OS pointer\n");
	});

	it("never lets a truncated description become the subject", () => {
		const message = buildMergeCommitMessage({
			commits: ["Add the cursor sprite", "Hide the OS pointer"],
			taskTitle: TRUNCATED_TITLE,
			branchName: "feat/cursor",
		});
		expect(message).not.toContain("…");
		expect(message.split("\n")[0]).toBe("Add the cursor sprite");
	});

	// Separate from the long real-world title above: a SHORT title ending in the
	// ellipsis must be rejected for the mark alone, not because it is over-long.
	it("rejects a short title that still ends in an ellipsis", () => {
		const message = buildMergeCommitMessage({
			commits: ["First commit", "Second commit"],
			taskTitle: "The game draws its own…",
			branchName: "feat/x",
		});
		expect(message.split("\n")[0]).toBe("First commit");
	});

	it("rejects an ASCII three-dot truncation too", () => {
		const message = buildMergeCommitMessage({
			commits: ["First commit", "Second commit"],
			taskTitle: "если мы в проекте что уже в спейсе каком-то то дефолт вью...",
			branchName: "feat/x",
		});
		expect(message.split("\n")[0]).toBe("First commit");
	});

	it("rejects a scratch placeholder title", () => {
		const message = buildMergeCommitMessage({
			commits: ["Rename the pane", "Fix the label"],
			taskTitle: "Scratch — 14:32",
			branchName: "chore/scratch",
		});
		expect(message.split("\n")[0]).toBe("Rename the pane");
	});

	it("yields an over-long title to a commit subject", () => {
		const long = `Do the thing ${"x".repeat(80)}`;
		const message = buildMergeCommitMessage({
			commits: ["Do the thing", "Then the other thing"],
			taskTitle: long,
			branchName: "feat/x",
		});
		expect(message.split("\n")[0]).toBe("Do the thing");
	});

	it("keeps an over-long title in full when there is no commit to borrow from", () => {
		const long = `Do the thing ${"x".repeat(80)}`;
		const message = buildMergeCommitMessage({ commits: [], taskTitle: long, branchName: "feat/x" });
		// Never truncated: an unabbreviated long subject is readable, a chopped one is not.
		expect(message).toBe(`${long}\n`);
	});

	it("keeps a subject on one line when the title carries a newline", () => {
		const message = buildMergeCommitMessage({
			commits: [],
			taskTitle: "Hide the OS cursor\nand draw ours instead",
			branchName: "feat/cursor",
		});
		expect(message).toBe("Hide the OS cursor\n");
	});

	it("passes backticks and quotes through untouched", () => {
		const title = "Fix `drawCursor()` and the \"quoted\" $HOME thing";
		expect(buildMergeCommitMessage({ commits: [], taskTitle: title, branchName: "feat/x" }))
			.toBe(`${title}\n`);
	});

	it("falls back to the branch name when there is neither a commit nor a usable title", () => {
		expect(buildMergeCommitMessage({ commits: [], taskTitle: "   ", branchName: "feat/x" }))
			.toBe("Merge feat/x\n");
	});

	it("ignores empty commit messages", () => {
		expect(buildMergeCommitMessage({
			commits: ["", "   \n\n", "Real work here"],
			taskTitle: TRUNCATED_TITLE,
			branchName: "feat/x",
		})).toBe("Real work here\n");
	});

	it("always ends in exactly one newline and never a blank subject", () => {
		for (const commits of [[], ["a"], ["a", "b"], ["a\n\nbody\n\n"]]) {
			const message = buildMergeCommitMessage({ commits, taskTitle: "A real title", branchName: "b" });
			expect(message.endsWith("\n")).toBe(true);
			expect(message.endsWith("\n\n")).toBe(false);
			expect(message.split("\n")[0]!.trim().length).toBeGreaterThan(0);
		}
	});
});

/**
 * Real repositories, so a saturated box makes these slow rather than wrong: the
 * sibling git-* suites run on the default 5 s and are the repo's best-known
 * under-load flakes. 30 s is still far above anything a working machine needs.
 */
describe("listBranchCommitMessages", { timeout: 30_000 }, () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
	});

	afterEach(() => {
		cleanup(repo);
	});

	function commit(subject: string, body?: string): void {
		g(`git commit --allow-empty -m "${subject}"${body ? ` -m "${body}"` : ""}`, repo.local);
	}

	it("returns the branch's own commits, oldest first, with their bodies", async () => {
		g("git checkout -b feature", repo.local);
		commit("First thing", "Why the first thing.");
		commit("Second thing");

		const messages = await listBranchCommitMessages(repo.local, "main");
		expect(messages).toEqual(["First thing\n\nWhy the first thing.", "Second thing"]);
	});

	it("returns one message for a single-commit branch and excludes base history", async () => {
		g("git checkout -b feature", repo.local);
		commit("Only commit", "With a body\n\nand a blank line inside it.");

		const messages = await listBranchCommitMessages(repo.local, "main");
		expect(messages).toEqual(["Only commit\n\nWith a body\n\nand a blank line inside it."]);
	});

	it("returns nothing for a branch with zero commits", async () => {
		g("git checkout -b feature", repo.local);
		expect(await listBranchCommitMessages(repo.local, "main")).toEqual([]);
	});

	it("returns nothing when the base ref does not resolve", async () => {
		g("git checkout -b feature", repo.local);
		commit("Some work");
		expect(await listBranchCommitMessages(repo.local, "origin/nope")).toEqual([]);
	});

	it("keeps commits made after a merge of the base branch into the branch", async () => {
		g("git checkout -b feature", repo.local);
		commit("Branch work");
		g("git checkout main", repo.local);
		commit("Base work");
		g("git checkout feature", repo.local);
		g("git merge main --no-edit", repo.local);
		commit("More branch work");

		// The integration merge commit is dropped: its message describes the merge,
		// not the work being landed.
		const messages = await listBranchCommitMessages(repo.local, "main");
		expect(messages).toEqual(["Branch work", "More branch work"]);
	});
});

// ── Source guard: the call site, not just the helper ─────────────────────────

const BUN_DIR = join(import.meta.dirname, "..");

function tsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "__tests__" || entry.name === "prototypes" || entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...tsFiles(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/** The argument list of every `writeMergeCommitMessage(...)` call in `source`. */
function messageCallArgs(source: string): string[] {
	const calls: string[] = [];
	const needle = "writeMergeCommitMessage(";
	for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
		let depth = 0;
		let i = at + needle.length - 1;
		for (; i < source.length; i++) {
			if (source[i] === "(") depth++;
			else if (source[i] === ")" && --depth === 0) break;
		}
		calls.push(source.slice(at + needle.length, i));
	}
	return calls;
}

describe("the merge handler's call site", () => {
	const callers = tsFiles(BUN_DIR)
		.map((file) => ({ file, args: messageCallArgs(readFileSync(file, "utf-8")) }))
		.filter(({ file, args }) => args.length > 0 && !file.endsWith("git-op-script.ts"));

	it("has exactly one caller, in the git-operations handler", () => {
		expect(callers.map((c) => c.file.slice(BUN_DIR.length + 1))).toEqual([
			join("rpc-handlers", "git-operations.ts"),
		]);
	});

	it("builds every message with buildMergeCommitMessage", () => {
		expect(callers.length).toBeGreaterThan(0);
		for (const { file, args } of callers) {
			for (const arg of args) {
				expect(arg, `${file} passes a raw message to writeMergeCommitMessage`)
					.toContain("buildMergeCommitMessage(");
			}
		}
	});
});
