/**
 * The sandbox: a small real git repo dev3 creates for itself so a first-run user
 * can watch the whole loop — prompt, worktree, agent, diff — without pointing the
 * app at anything they care about.
 *
 * It lives under `~/.dev3.0/sandbox`, which `addProject` deliberately refuses for
 * a user-picked folder (a real repo under the data dir could collide with the
 * synthetic `ops/<slug>` paths). This module is the one caller allowed there,
 * because it owns the path instead of accepting one: it goes to `data.addProject`
 * directly and the guard in `addProjectImpl` stays exactly as strict as it was.
 * See decisions/2026/08/22/the-sandbox-is-a-real-repo-dev3-owns.md.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as data from "./data";
import * as git from "./git";
import { createLogger } from "./logger";
import { SANDBOX_DIR } from "./paths";
import { SANDBOX_TASK_PROMPTS } from "../shared/sandbox-prompts";
import type { Project } from "../shared/types";

const log = createLogger("sandbox");

/** One sandbox per install. The folder name is what the user sees on disk. */
export const SANDBOX_REPO_PATH = join(SANDBOX_DIR, "dev3-sandbox");
export const SANDBOX_PROJECT_NAME = "Sandbox";

/**
 * Deliberately tiny and deliberately not a build: an agent must be able to finish
 * a task here on a laptop with no toolchain, no network and no npm registry.
 */
const SEED_FILES: Record<string, string> = {
	"README.md": [
		"# dev3 sandbox",
		"",
		"A throwaway repository, created by dev-3.0 so you can try it out on something",
		"that is not your own work. Break it freely — deleting this project from the",
		"dashboard, or the folder itself, costs you nothing.",
		"",
		"## Try a first task",
		"",
		"Create a task on the board and paste one of these as the prompt:",
		"",
		...SANDBOX_TASK_PROMPTS.map((prompt) => `- \`${prompt}\``),
		"",
		"Each one gives the agent its own branch in its own worktree. When it is done,",
		"read the diff on the task screen before you merge it.",
		"",
		"## What is in here",
		"",
		"- `prices.js` — a few lines of money arithmetic, with one real bug left in on",
		"  purpose so the first task has something to find.",
		"",
	].join("\n"),
	"prices.js": [
		"// Adds up a cart and applies a discount.",
		"//",
		"// There is a genuine rounding bug in here, left in on purpose: it is the",
		"// first thing to hand an agent. Everything else is honest.",
		"",
		"function total(items, discountPercent = 0) {",
		"\tlet sum = 0;",
		"\tfor (const item of items) {",
		"\t\tsum += item.price * item.quantity;",
		"\t}",
		"\tconst discounted = sum - (sum * discountPercent) / 100;",
		"\treturn Math.round(discounted);",
		"}",
		"",
		"const cart = [",
		"\t{ name: 'coffee', price: 7.4, quantity: 3 },",
		"\t{ name: 'mug', price: 12.5, quantity: 1 },",
		"];",
		"",
		"console.log(total(cart, 10));",
		"",
		"module.exports = { total };",
		"",
	].join("\n"),
};

/** Written into the sandbox's own commit only when the user has no git identity. */
const FALLBACK_IDENTITY = ["-c", "user.name=dev-3.0", "-c", "user.email=dev3@localhost"];

async function seedRepo(path: string): Promise<{ ok: true } | { ok: false; error: string }> {
	mkdirSync(path, { recursive: true });

	const init = await git.run(["git", "init"], path);
	if (!init.ok) return { ok: false, error: `git init failed: ${init.stderr || "unknown error"}` };

	// Not `init -b main`: that flag is younger than the git some users still run,
	// and `init.defaultBranch` may say anything. Retargeting the unborn HEAD works
	// everywhere and makes the branch name ours rather than the machine's.
	const head = await git.run(["git", "symbolic-ref", "HEAD", "refs/heads/main"], path);
	if (!head.ok) return { ok: false, error: `git symbolic-ref failed: ${head.stderr || "unknown error"}` };

	for (const [name, content] of Object.entries(SEED_FILES)) {
		writeFileSync(join(path, name), content, "utf8");
	}

	const add = await git.run(["git", "add", "."], path);
	if (!add.ok) return { ok: false, error: `git add failed: ${add.stderr || "unknown error"}` };

	const message = "Seed the dev3 sandbox";
	let commit = await git.run(["git", "commit", "-m", message], path);
	if (!commit.ok) {
		// The usual cause is an unset user.name/user.email. A throwaway repo is not
		// worth failing over, so retry under a dev3 identity — and only then, so a
		// user who does have one keeps their own name on the commit.
		log.warn("Sandbox commit failed, retrying with a fallback identity", { stderr: commit.stderr });
		commit = await git.run(["git", ...FALLBACK_IDENTITY, "commit", "-m", message], path);
	}
	if (!commit.ok) return { ok: false, error: `git commit failed: ${commit.stderr || "unknown error"}` };

	return { ok: true };
}

/**
 * Create the sandbox repo and register it as a project. Idempotent in both halves:
 * an existing repo is left untouched, and `data.addProject` returns the existing
 * record for a path it already knows (reviving it if it was soft-deleted).
 */
export async function createSandboxProject(): Promise<{ ok: true; project: Project } | { ok: false; error: string }> {
	log.info("→ createSandboxProject", { path: SANDBOX_REPO_PATH });
	try {
		const alreadyRepo = existsSync(SANDBOX_REPO_PATH) && (await git.isGitRepo(SANDBOX_REPO_PATH));
		if (!alreadyRepo) {
			const seeded = await seedRepo(SANDBOX_REPO_PATH);
			if (!seeded.ok) {
				log.error("Could not seed the sandbox", { error: seeded.error });
				return seeded;
			}
		}

		const project = await data.addProject(SANDBOX_REPO_PATH, SANDBOX_PROJECT_NAME);
		// `sandbox` is what the guided tour recognises the board by, so a tour
		// interrupted by a restart can pick itself up instead of leaving the user on
		// an empty board again. Cheaper and more honest than matching the path.
		const fixes: Partial<Project> = {};
		if (project.defaultBaseBranch !== "main") fixes.defaultBaseBranch = "main";
		if (!project.sandbox) fixes.sandbox = true;
		if (Object.keys(fixes).length > 0) {
			await data.updateProject(project.id, fixes);
			Object.assign(project, fixes);
		}
		log.info("← createSandboxProject OK", { projectId: project.id, seeded: !alreadyRepo });
		return { ok: true, project };
	} catch (err) {
		log.error("createSandboxProject failed", { error: String(err) });
		return { ok: false, error: String(err) };
	}
}
