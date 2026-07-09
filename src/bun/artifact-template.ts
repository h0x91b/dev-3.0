import {
	copyFileSync,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Project, Task } from "../shared/types";

export const ARTIFACT_TEMPLATE_VERSION = 1;

const ARTIFACT_TEMPLATE_FILES = ["index.html", "AUTHORING.md", "dev3-icon.png"] as const;

interface EnsureArtifactTemplateOptions {
	sourceDir?: string;
	taskContainerDir?: string;
}

function bundledArtifactTemplateDir(): string {
	const executableDir = dirname(process.execPath);
	const moduleDir = import.meta.dir || import.meta.dirname || "";
	const candidates = [
		process.env.DEV3_VIEWS_DIR ? resolve(process.env.DEV3_VIEWS_DIR, "..", "artifact-template") : "",
		resolve(process.cwd(), "artifact-template"),
		join(executableDir, "artifact-template"),
		resolve(executableDir, "..", "Resources", "app", "artifact-template"),
		resolve(executableDir, "..", "resources", "app", "artifact-template"),
		moduleDir ? resolve(moduleDir, "..", "assets", "artifact-template") : "",
	].filter(Boolean);

	const found = candidates.find((candidate) =>
		ARTIFACT_TEMPLATE_FILES.every((name) => existsSync(join(candidate, name))),
	);
	if (!found) {
		throw new Error(`Bundled dev3 artifact template not found (checked: ${candidates.join(", ")})`);
	}
	return found;
}

function taskContainerDir(project: Project, task: Task, worktreePath?: string): string {
	if (project.kind === "virtual") return join(project.path, task.id.slice(0, 8));
	const activeWorktreePath = worktreePath ?? task.worktreePath;
	if (!activeWorktreePath) throw new Error("Cannot provision a dev3 artifact template before the worktree path is known");
	return dirname(activeWorktreePath);
}

export function artifactTemplateDir(project: Project, task: Task, worktreePath?: string): string {
	return join(taskContainerDir(project, task, worktreePath), `artifact-template-v${ARTIFACT_TEMPLATE_VERSION}`);
}

/**
 * Restore the app-owned pristine starter for one task. Only the three managed
 * files are replaced; unknown files are preserved so provisioning is additive
 * and remains safe across app versions sharing ~/.dev3.0.
 */
export function ensureArtifactTemplate(
	project: Project,
	task: Task,
	options: EnsureArtifactTemplateOptions & { worktreePath?: string } = {},
): string {
	const sourceDir = options.sourceDir ?? bundledArtifactTemplateDir();
	const containerDir = options.taskContainerDir ?? taskContainerDir(project, task, options.worktreePath);
	const targetDir = join(containerDir, `artifact-template-v${ARTIFACT_TEMPLATE_VERSION}`);
	mkdirSync(targetDir, { recursive: true });

	for (const name of ARTIFACT_TEMPLATE_FILES) {
		const source = join(sourceDir, name);
		if (!existsSync(source)) throw new Error(`Bundled dev3 artifact template is missing ${name}`);
		const target = join(targetDir, name);
		const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
		try {
			copyFileSync(source, temporary);
			renameSync(temporary, target);
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
	}

	return targetDir;
}

export function ensureArtifactTemplateEnv(project: Project, task: Task, worktreePath: string): Record<string, string> {
	return { DEV3_ARTIFACT_TEMPLATE_DIR: ensureArtifactTemplate(project, task, { worktreePath }) };
}
