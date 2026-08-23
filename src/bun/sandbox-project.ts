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

/** What the project's dev-server button runs. One command, no install step, and
 *  node rather than python or bun because every machine that has an agent CLI
 *  installed from npm already has it. */
export const SANDBOX_DEV_SCRIPT = "node server.js";

/**
 * Deliberately tiny and deliberately not a build: an agent must be able to finish
 * a task here on a laptop with no toolchain, no network and no npm registry.
 *
 * It is a *page* rather than a script because the first task has to be visible.
 * A rounding bug in a library reads only as a diff; a button changing colour on a
 * page the dev server is already serving is something a newcomer can see.
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
		"- `index.html` — one page with one green button, which is the whole point: the",
		"  first task changes something you can see.",
		`- \`server.js\` — serves this folder, no dependencies. The task screen's dev-server`,
		`  button runs \`${SANDBOX_DEV_SCRIPT}\` for you on a port dev3 hands it.`,
		"",
	].join("\n"),
	"index.html": [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8" />',
		'<meta name="viewport" content="width=device-width, initial-scale=1" />',
		"<title>dev3 sandbox</title>",
		"<style>",
		"\tbody { margin: 0; min-height: 100vh; display: grid; place-items: center;",
		"\t\tfont: 16px/1.5 system-ui, sans-serif; background: #0f1115; color: #e6e8ee; }",
		"\t.card { padding: 2.5rem 3rem; border-radius: 1rem; background: #171a21; text-align: center; }",
		"\th1 { margin: 0 0 0.5rem; font-size: 1.35rem; }",
		"\tp { margin: 0 0 1.5rem; color: #9aa1b1; }",
		"\t/* The colour the first task changes. One line, on purpose. */",
		"\t.ship { background: #22c55e; color: #05210f; border: 0; border-radius: 0.6rem;",
		"\t\tpadding: 0.7rem 1.6rem; font-size: 1rem; font-weight: 600; cursor: pointer; }",
		"\t.ship:hover { filter: brightness(1.08); }",
		"</style>",
		"</head>",
		"<body>",
		'\t<main class="card">',
		"\t\t<h1>dev3 sandbox</h1>",
		"\t\t<p>A page that exists so you can watch an agent change it.</p>",
		'\t\t<button class="ship" onclick="alert(\'Shipped!\')">Ship it</button>',
		"\t</main>",
		"</body>",
		"</html>",
		"",
	].join("\n"),
	"server.js": [
		"// Serves this folder over HTTP. No dependencies and no build, so it starts on a",
		"// laptop with no npm registry. dev3 passes the port in as DEV3_PORT0.",
		'const http = require("node:http");',
		'const { readFile } = require("node:fs/promises");',
		'const { extname, join, normalize } = require("node:path");',
		"",
		"const port = Number(process.env.DEV3_PORT0 || 4173);",
		'const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };',
		"",
		"http",
		"\t.createServer(async (req, res) => {",
		'\t\tconst asked = normalize(decodeURIComponent((req.url || "/").split("?")[0]));',
		'\t\tconst file = asked === "/" ? "index.html" : asked.replace(/^[/\\\\]+/, "");',
		"\t\ttry {",
		"\t\t\tconst body = await readFile(join(__dirname, file));",
		'\t\t\tres.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });',
		"\t\t\tres.end(body);",
		"\t\t} catch {",
		'\t\t\tres.writeHead(404, { "content-type": "text/plain" });',
		'\t\t\tres.end("Not found");',
		"\t\t}",
		"\t})",
		'\t.listen(port, "127.0.0.1", () => console.log(`sandbox on http://127.0.0.1:${port}`));',
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
		// The dev server is half of what the sandbox is for: the first task changes
		// something on a page, so there has to be a page to look at. One port, handed
		// to `server.js` as DEV3_PORT0.
		if (project.devScript !== SANDBOX_DEV_SCRIPT) fixes.devScript = SANDBOX_DEV_SCRIPT;
		if (!project.portCount) fixes.portCount = 1;
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
