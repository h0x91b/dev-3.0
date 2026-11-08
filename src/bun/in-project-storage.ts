import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { inProjectDataDir, projectWorktreesRoot } from "../shared/project-storage";
import { DEV3_HOME } from "./paths";
import { excludeFromBackups } from "./backup-exclusion";

/** `*` ignores the folder AND this file, so the repo never sees it and the user's `.gitignore` is never touched. */
export const IN_PROJECT_GITIGNORE = "*\n";

function ensureSelfIgnoringDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
	const file = `${dir}/.gitignore`;
	if (existsSync(file) && readFileSync(file, "utf-8") === IN_PROJECT_GITIGNORE) return;
	writeFileSync(file, IN_PROJECT_GITIGNORE);
}

/** Creates `<project>/.dev3/data` and `.dev3/worktrees`, each ignoring itself in git, worktrees kept out of backups. */
export async function ensureInProjectStorageDirs(projectPath: string): Promise<void> {
	ensureSelfIgnoringDir(inProjectDataDir(projectPath));
	const worktrees = projectWorktreesRoot(DEV3_HOME, projectPath, "project");
	ensureSelfIgnoringDir(worktrees);
	// `tmutil` can take seconds; it is best-effort and never throws, so nothing waits on it.
	void excludeFromBackups(worktrees);
}
