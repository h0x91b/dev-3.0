import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ARTIFACT_TEMPLATE_FILES, artifactTemplateDirName } from "../shared/artifact-template";
import { resolveArtifactTemplate, type ArtifactTemplateMode, type GlobalSettings, type Project, type Task } from "../shared/types";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";
import { loadSettingsSync } from "./settings";

const log = createLogger("artifact-template");

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
	return join(taskContainerDir(project, task, worktreePath), artifactTemplateDirName());
}

/**
 * Restore the app-owned pristine starter for one task. Only the managed
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
	const targetDir = join(containerDir, artifactTemplateDirName());
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

/** Where "My template" lives until the user names another folder. */
export const DEFAULT_CUSTOM_ARTIFACT_TEMPLATE_DIR = join(DEV3_HOME, "artifact-template-custom");
const CUSTOM_STARTER_DIR_NAME = "artifact-template-custom";
/** Written into a freshly seeded folder for the human; never copied into a task. */
const CUSTOMIZE_NOTE = "CUSTOMIZE.md";
const CUSTOMIZE_TEXT = `# Your dev3 artifact template

dev3 copied its own artifact template here so you have something to start from.
Agents in projects set to "My template" start every report from a copy of this folder.

- Change anything: \`index.html\`, \`app.css\`, \`app.js\`, \`dev3-icon.png\`, or replace it all.
- \`AUTHORING.md\` is the card agents follow. Rewrite it so it describes YOUR template,
  including its contract (what every report must keep). Agents treat it as the rules.
- Changes reach agents launched or resumed after you save.
- Want the latest dev3 template again? Empty or delete this folder; dev3 seeds it anew.
`;

type StarterSettings = Pick<GlobalSettings, "artifactTemplate" | "artifactTemplatePath"> | null;

/** The absolute "My template" folder for a configured path (`~` expanded), or the default. */
export function customArtifactTemplateDir(path?: string): string {
	const trimmed = path?.trim();
	if (!trimmed) return DEFAULT_CUSTOM_ARTIFACT_TEMPLATE_DIR;
	if (trimmed === "~" || trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(1));
	return resolve(trimmed);
}

function hasVisibleEntries(dir: string): boolean {
	return readdirSync(dir).some((name) => !name.startsWith("."));
}

/**
 * Fill a missing or empty "My template" folder with a copy of the dev3 template.
 * A folder that already holds files is the user's work and is never touched.
 */
export function seedCustomArtifactTemplate(dir: string, options: { sourceDir?: string } = {}): { dir: string; seeded: boolean } {
	if (existsSync(dir)) {
		if (!statSync(dir).isDirectory()) throw new Error(`Not a folder: ${dir}`);
		if (hasVisibleEntries(dir)) return { dir, seeded: false };
	}
	const sourceDir = options.sourceDir ?? bundledArtifactTemplateDir();
	mkdirSync(dir, { recursive: true });
	for (const name of ARTIFACT_TEMPLATE_FILES) copyFileSync(join(sourceDir, name), join(dir, name));
	writeFileSync(join(dir, CUSTOMIZE_NOTE), CUSTOMIZE_TEXT);
	return { dir, seeded: true };
}

/** A fresh per-task copy of the user's folder, so an agent can never edit the original. */
function copyCustomStarter(sourceDir: string, containerDir: string): string {
	const target = join(containerDir, CUSTOM_STARTER_DIR_NAME);
	rmSync(target, { recursive: true, force: true });
	cpSync(sourceDir, target, {
		recursive: true,
		filter: (path) => {
			if (path === sourceDir) return true;
			const name = basename(path);
			return !name.startsWith(".") && name !== "node_modules" && name !== CUSTOMIZE_NOTE;
		},
	});
	return target;
}

/**
 * The starter this task's agents copy, and which kind it is. `custom` copies the
 * user's folder (seeding the default one on first use); a configured folder that
 * does not exist falls back to the dev3 template instead of being created at launch.
 */
export function provisionArtifactStarter(
	project: Project,
	task: Task,
	options: EnsureArtifactTemplateOptions & { worktreePath?: string; settings?: StarterSettings } = {},
): { dir: string; mode: ArtifactTemplateMode } {
	const resolved = resolveArtifactTemplate(project, options.settings === undefined ? loadSettingsSync() : options.settings);
	if (resolved.mode === "custom") {
		const customDir = customArtifactTemplateDir(resolved.path);
		try {
			if (resolved.path && !existsSync(customDir)) throw new Error(`Folder not found: ${customDir}`);
			seedCustomArtifactTemplate(customDir, { sourceDir: options.sourceDir });
			const containerDir = options.taskContainerDir ?? taskContainerDir(project, task, options.worktreePath);
			return { dir: copyCustomStarter(customDir, containerDir), mode: "custom" };
		} catch (err) {
			log.warn("Custom artifact template unavailable — using the dev3 template", {
				taskId: task.id.slice(0, 8),
				error: String(err),
			});
			return { dir: ensureArtifactTemplate(project, task, options), mode: "on" };
		}
	}
	return { dir: ensureArtifactTemplate(project, task, options), mode: resolved.mode };
}

/**
 * The starter path plus `DEV3_ARTIFACT_TEMPLATE=off|custom`. The dev3 template
 * adds no mode variable, so a default launch keeps today's env. Free-form still
 * provisions the dev3 starter, so "use the template for this one" works.
 */
export function ensureArtifactTemplateEnv(project: Project, task: Task, worktreePath: string): Record<string, string> {
	// Best-effort: the starter is only needed when the agent builds a dev3 HTML
	// artifact (a minority of tasks). A missing/broken bundle — e.g. a brew
	// install whose formula didn't ship artifact-template — must degrade the
	// feature, not block the task launch. Launched agents are told to report the
	// missing var, so an empty env is a safe, self-describing fallback.
	try {
		const { dir, mode } = provisionArtifactStarter(project, task, { worktreePath });
		return { ...(mode === "on" ? {} : { DEV3_ARTIFACT_TEMPLATE: mode }), DEV3_ARTIFACT_TEMPLATE_DIR: dir };
	} catch (err) {
		log.warn("Artifact template unavailable — launching without DEV3_ARTIFACT_TEMPLATE_DIR", {
			taskId: task.id.slice(0, 8),
			error: String(err),
		});
		// Free-form needs no starter, so losing the bundle must not lose the opt-out.
		return resolveArtifactTemplate(project, loadSettingsSync()).mode === "off" ? { DEV3_ARTIFACT_TEMPLATE: "off" } : {};
	}
}
