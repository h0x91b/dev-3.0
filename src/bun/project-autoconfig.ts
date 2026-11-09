import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { hasGitWorkflow, repoConfigEnabled, type AutoConfigureKey, type AutoConfigureResult, type Dev3RepoConfig, type Project } from "../shared/types";
import * as git from "./git";
import { parsePackageScripts, resolveRunnerCommand } from "./package-scripts";
import * as repoConfig from "./repo-config";
import { createLogger } from "./logger";
import { whichSync } from "./which";

const log = createLogger("project-autoconfig");

/** Lockfile → install command, for the ecosystems besides JS (JS goes through `detectRunner`). */
const INSTALL_RULES: { file: string; command: string }[] = [
	{ file: "uv.lock", command: "uv sync" },
	{ file: "poetry.lock", command: "poetry install" },
	{ file: "Pipfile.lock", command: "pipenv install" },
	{ file: "Gemfile.lock", command: "bundle install" },
	{ file: "composer.lock", command: "composer install" },
	{ file: "go.sum", command: "go mod download" },
	{ file: "Cargo.lock", command: "cargo fetch" },
];

/** Dev-server script names, most specific first. */
const DEV_SCRIPT_NAMES = ["dev", "start", "serve"];

const LOCAL_CONFIG_PATH = ".dev3/config.local.json";

const AUTO_CONFIGURE_KEYS: AutoConfigureKey[] = ["setupScript", "devScript"];

/**
 * Read what a project folder already says about itself: the install command its
 * lockfiles imply, and the dev server its package.json declares. File reads and
 * PATH lookups only, nothing is run. `withSetup: false` leaves the setup script out.
 */
export function detectProjectConfig(
	projectPath: string,
	opts: { withSetup: boolean } = { withSetup: true },
): Pick<Dev3RepoConfig, AutoConfigureKey> {
	const config: Pick<Dev3RepoConfig, AutoConfigureKey> = {};
	const pkg = parsePackageScripts(projectPath);

	if (opts.withSetup) {
		const installs: string[] = [];
		if (pkg.exists) installs.push(`${pkg.runner} install`);
		for (const rule of INSTALL_RULES) {
			if (!existsSync(join(projectPath, rule.file))) continue;
			// The installs are chained with &&, so one missing toolchain would fail setup for every task.
			if (whichSync(rule.command.split(" ")[0])) installs.push(rule.command);
			else log.info("Skipping install, toolchain not on PATH", { file: rule.file, command: rule.command });
		}
		if (installs.length > 0) config.setupScript = installs.join(" && ");
	}

	const devName = DEV_SCRIPT_NAMES.find((name) => pkg.scripts.some((s) => s.name === name));
	if (devName) config.devScript = resolveRunnerCommand(pkg.runner, devName);

	return config;
}

/** Escape a literal path for a gitignore pattern: glob characters, and a leading `#` or `!`. */
function gitignoreLiteral(path: string): string {
	return path.replace(/[\\*?[]/g, "\\$&").replace(/^[#!]/, "\\$&");
}

/**
 * Ignore `entry` through the clone's own `info/exclude`, which is never committed,
 * so auto-configure leaves the tracked `.gitignore` and `git status` untouched.
 * The rule is anchored at the repository root, so a project in a subfolder gets its prefix.
 */
async function excludeLocally(projectPath: string, entry: string): Promise<void> {
	// One call, prefix on the second line: trimming the whole output keeps a prefix's leading spaces.
	const res = await git.run(["git", "rev-parse", "--git-path", "info/exclude", "--show-prefix"], projectPath);
	if (!res.ok) throw new Error(`git rev-parse failed: ${res.stderr || "unknown error"}`);
	const [gitPath, prefix = "", ...rest] = res.stdout.split("\n");
	if (rest.length > 0) throw new Error("Project path contains a newline, which info/exclude cannot express");
	const excludePath = isAbsolute(gitPath) ? gitPath : join(projectPath, gitPath);
	const rule = gitignoreLiteral(prefix + entry);
	const content = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
	if (content.split("\n").some((line) => line.trimEnd() === rule)) return;
	mkdirSync(dirname(excludePath), { recursive: true });
	const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
	writeFileSync(excludePath, `${content}${separator}${rule}\n`);
}

/**
 * Write the detected settings into `.dev3/config.local.json` of a freshly added
 * project. Never touches a project that is already configured - a `.dev3` file,
 * scripts on a re-added record, or repo config switched off - and says so in the result.
 */
export async function autoConfigureProject(project: Project): Promise<AutoConfigureResult> {
	const projectPath = project.path;
	if (!repoConfigEnabled(project) || project.setupScript || project.devScript
		|| repoConfig.hasRepoConfig(projectPath) || repoConfig.hasLocalConfig(projectPath)) {
		log.info("Skipping auto-configure, project is already configured", { path: projectPath });
		return { written: [], existingConfig: true };
	}
	// A task with the git workflow off skips the setup script, so writing one would be noise.
	const config = detectProjectConfig(projectPath, { withSetup: hasGitWorkflow(project) });
	const keys = AUTO_CONFIGURE_KEYS.filter((key) => config[key] !== undefined);
	if (keys.length === 0) return { written: [] };
	// Excluded first, so a failed exclude never leaves an unignored file behind.
	// A plain folder added with the git workflow off has no git to ignore it from.
	if (await git.isGitRepo(projectPath)) await excludeLocally(projectPath, LOCAL_CONFIG_PATH);
	mkdirSync(join(projectPath, ".dev3"), { recursive: true });
	writeFileSync(join(projectPath, LOCAL_CONFIG_PATH), JSON.stringify(config, null, 2) + "\n");
	log.info("Auto-configured project", { path: projectPath, fields: keys });
	return { written: keys };
}
