import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Project, SpacesFile } from "../../shared/types";
import { EMPTY_SPACES_FILE } from "../../shared/types";
import { CLI_EXIT_CODE_PROJECT_ALREADY_REGISTERED, CLI_EXIT_CODE_PROJECT_SETTING_FORBIDDEN, CLI_EXIT_CODE_PROJECT_SETTING_UNAVAILABLE } from "../../shared/cli-exit-codes";
import { looksLikeGitUrl, shortSpaceId, toCliProject, type ProjectRegistrationResult } from "../../shared/project-registration";
import {
	PROJECT_CLI_SETTING_KEYS,
	PROJECT_CLI_SETTINGS,
	PROJECT_SETTING_FORBIDDEN_PREFIX,
	PROJECT_SETTING_UNAVAILABLE_PREFIX,
	formatProjectCliSettingValue,
	isProjectCliSettingKey,
	parseProjectCliSettingValue,
	type ProjectCliSettingKey,
	type ProjectCliSettingValue,
} from "../../shared/project-cli-settings";
import { resolveProjectId, type CliContext } from "../context";
import { sendRequest } from "../socket-client";
import { printTable, exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { rejectUnknownFlags } from "../flag-validation";
import { exitRequestFailed, flagValue, flagValues, isUnknownMethod, spaceNames, withBooleanFlags } from "./spaces";

const ADD_TIMEOUT_MS = 2 * 60_000;
// The whole clone happens inside this one request.
const CLONE_TIMEOUT_MS = 30 * 60_000;

// A storageRoot switch copies the whole board across inside this one request.
const SETTINGS_TIMEOUT_MS = 2 * 60_000;

const SPACE_FLAGS = ["space", "new-space", "no-space"];
const SPACE_HINT = 'See every space with: dev3 spaces list (--space joins one, --new-space "name" creates one)';

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

function absolutePath(raw: string): string {
	return resolve(expandHome(raw));
}

function spaceParams(args: ParsedArgs): { spaces: string[]; newSpaces: string[]; noSpace: boolean } {
	const spaces = flagValues(args, "space");
	const newSpaces = flagValues(args, "new-space");
	const noSpace = "no-space" in args.flags;
	if (noSpace && (spaces.length > 0 || newSpaces.length > 0)) {
		exitUsage("--no-space cannot be combined with --space or --new-space");
	}
	if (newSpaces.some((name) => !name.trim())) exitUsage("--new-space needs a name");
	return { spaces, newSpaces, noSpace };
}

async function listProjects(args: ParsedArgs, socketPath: string): Promise<void> {
	rejectUnknownFlags(args, ["json"]);
	const resp = await sendRequest(socketPath, "projects.list");
	if (!resp.ok) exitRequestFailed(resp, "Failed to list projects");
	const spacesResp = await sendRequest(socketPath, "spaces.list");
	// An app older than this CLI has no spaces.list; the list it printed before still works.
	if (!spacesResp.ok && !isUnknownMethod(spacesResp)) exitRequestFailed(spacesResp, "Failed to list spaces");

	const file = spacesResp.ok ? spacesResp.data as SpacesFile : EMPTY_SPACES_FILE;
	const projects = (resp.data as Project[]).map((p) => toCliProject(p, file));
	if ("json" in args.flags) {
		process.stdout.write(`${JSON.stringify(projects, null, 2)}\n`);
		return;
	}
	if (projects.length === 0) {
		process.stdout.write("No projects configured.\n");
		return;
	}

	printTable(
		["ID", "NAME", "SPACES", "PATH"],
		projects.map((p) => [p.id.slice(0, 8), p.name, p.spaces.length > 0 ? spaceNames(p) : "-", p.path]),
	);
}

/** Print an add/clone result; an already-registered folder exits with its own code. */
function report(result: ProjectRegistrationResult, json: boolean, noGitWorkflow = false): void {
	const { project } = result;
	const id8 = project.id.slice(0, 8);
	const workflowStillOn = noGitWorkflow && project.gitWorkflow !== false;
	if (json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else if (result.outcome === "exists") {
		process.stdout.write(
			`Already a project: ${project.id.slice(0, 8)} "${project.name}" — ${project.path}\n` +
				`Spaces: ${spaceNames(project)}\n` +
				`Nothing changed. Change its spaces with: dev3 spaces add|set|remove <space> --project ${id8}\n`,
		);
		if (workflowStillOn) process.stdout.write(`Its git workflow stays on. Switch it off with: dev3 projects set gitWorkflow off --project ${id8}\n`);
	} else {
		for (const space of result.createdSpaces) {
			process.stdout.write(`Created space ${shortSpaceId(space.id)} "${space.name}"\n`);
		}
		process.stdout.write(
			`Added project ${project.id.slice(0, 8)} "${project.name}" — ${project.path}\n` +
				`Spaces: ${spaceNames(project)}\n`,
		);
	}
	if (result.outcome === "exists") process.exit(CLI_EXIT_CODE_PROJECT_ALREADY_REGISTERED);
	// An app older than this CLI drops the flag and adds a repo with the workflow on.
	if (workflowStillOn) {
		exitError(`The app ignored --no-git-workflow: project ${id8} was added with the git workflow on. Update the app, or run: dev3 projects set gitWorkflow off --project ${id8}`);
	}
}

async function addProject(args: ParsedArgs, socketPath: string): Promise<void> {
	rejectUnknownFlags(args, ["name", "init", "no-git-workflow", "json", ...SPACE_FLAGS]);
	const [raw, ...extra] = args.positional;
	if (!raw || extra.length > 0) {
		exitUsage('Usage: dev3 projects add <path> [--name "..."] [--space <id|name>]... [--new-space "..."]... [--no-space] [--init | --no-git-workflow] [--json]');
	}
	if (looksLikeGitUrl(raw)) {
		exitUsage(`"${raw}" is a git URL, not a folder. Clone and add it with: dev3 projects clone ${raw}`);
	}
	const init = "init" in args.flags;
	const noGitWorkflow = "no-git-workflow" in args.flags;
	if (init && noGitWorkflow) exitUsage("--init cannot be combined with --no-git-workflow: one makes a git repo, the other needs none");

	const resp = await sendRequest(socketPath, "projects.add", {
		path: absolutePath(raw),
		name: flagValue(args, "name"),
		init,
		noGitWorkflow,
		...spaceParams(args),
	}, { timeoutMs: ADD_TIMEOUT_MS });
	if (!resp.ok) exitRequestFailed(resp, "Failed to add project", SPACE_HINT);
	report(resp.data as ProjectRegistrationResult, "json" in args.flags, noGitWorkflow);
}

async function cloneProject(args: ParsedArgs, socketPath: string): Promise<void> {
	rejectUnknownFlags(args, ["dir", "name", "json", ...SPACE_FLAGS]);
	const [url, ...extra] = args.positional;
	if (!url || extra.length > 0) {
		exitUsage('Usage: dev3 projects clone <git-url> [--dir <parent folder>] [--name "..."] [--space <id|name>]... [--new-space "..."]... [--no-space] [--json]');
	}
	const dir = flagValue(args, "dir");

	const resp = await sendRequest(socketPath, "projects.clone", {
		url,
		dir: dir === undefined ? undefined : absolutePath(dir),
		name: flagValue(args, "name"),
		...spaceParams(args),
	}, { timeoutMs: CLONE_TIMEOUT_MS });
	if (!resp.ok) exitRequestFailed(resp, "Failed to clone project", SPACE_HINT);
	report(resp.data as ProjectRegistrationResult, "json" in args.flags);
}

const SETTING_KEYS_HINT = `Settable: ${PROJECT_CLI_SETTING_KEYS.join(", ")}. Run "dev3 projects get" for the current values.`;

function settingsProjectId(args: ParsedArgs, context: CliContext | null): string {
	const projectId = resolveProjectId(args.flags.project, context);
	if (!projectId) exitUsage("Could not detect the project. Run this inside the project folder or a task, or pass --project <id>.");
	return projectId;
}

function settingKey(raw: string | undefined): ProjectCliSettingKey {
	if (raw === undefined) exitUsage(`Usage: dev3 projects set <key> <value> [--project <id>] [--json]\n${SETTING_KEYS_HINT}`);
	if (!isProjectCliSettingKey(raw)) exitUsage(`Unknown project setting "${raw}". ${SETTING_KEYS_HINT}`);
	return raw;
}

async function getSettings(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["project", "json"]);
	const [rawKey, ...extra] = args.positional;
	if (extra.length > 0) exitUsage("Usage: dev3 projects get [<key>] [--project <id>] [--json]");
	const key = rawKey === undefined ? undefined : settingKey(rawKey);
	const resp = await sendRequest(socketPath, "projects.settings.get", { projectId: settingsProjectId(args, context) });
	if (!resp.ok) exitRequestFailed(resp, "Failed to read project settings");
	const values = resp.data as Record<ProjectCliSettingKey, ProjectCliSettingValue>;
	const json = "json" in args.flags;
	if (key) {
		process.stdout.write(json ? `${JSON.stringify(values[key])}\n` : `${formatProjectCliSettingValue(values[key])}\n`);
		return;
	}
	if (json) {
		process.stdout.write(`${JSON.stringify(values, null, 2)}\n`);
		return;
	}
	printTable(
		["KEY", "VALUE", "MEANING"],
		PROJECT_CLI_SETTING_KEYS.map((k) => [k, formatProjectCliSettingValue(values[k]), PROJECT_CLI_SETTINGS[k].summary]),
	);
}

async function setSetting(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["project", "json"]);
	const [rawKey, rawValue, ...extra] = args.positional;
	const key = settingKey(rawKey);
	if (rawValue === undefined || extra.length > 0) exitUsage(`Usage: dev3 projects set ${key} <value> [--project <id>] [--json]`);
	const value = parseProjectCliSettingValue(key, rawValue);
	if (value instanceof Error) exitUsage(value.message);

	const params: Record<string, unknown> = { projectId: settingsProjectId(args, context), key, value };
	// The app decides who may change it: the user outside any task, or a coordinator.
	if (context?.taskId) params.sourceTaskId = context.taskId;
	const resp = await sendRequest(socketPath, "projects.settings.set", params, { timeoutMs: SETTINGS_TIMEOUT_MS });
	if (!resp.ok) {
		const error = resp.error ?? "";
		if (error.startsWith(PROJECT_SETTING_FORBIDDEN_PREFIX)) {
			exitError(error.slice(PROJECT_SETTING_FORBIDDEN_PREFIX.length), undefined, CLI_EXIT_CODE_PROJECT_SETTING_FORBIDDEN);
		}
		if (error.startsWith(PROJECT_SETTING_UNAVAILABLE_PREFIX)) {
			exitError(error.slice(PROJECT_SETTING_UNAVAILABLE_PREFIX.length), undefined, CLI_EXIT_CODE_PROJECT_SETTING_UNAVAILABLE);
		}
		exitRequestFailed(resp, `Failed to set ${key}`);
	}
	const result = resp.data as { key: ProjectCliSettingKey; previous: ProjectCliSettingValue; value: ProjectCliSettingValue };
	if ("json" in args.flags) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return;
	}
	const [before, after] = [formatProjectCliSettingValue(result.previous), formatProjectCliSettingValue(result.value)];
	process.stdout.write(before === after ? `${key} is already ${after}\n` : `${key}: ${before} -> ${after}\n`);
}

export async function handleProjects(subcommand: string | undefined, args: ParsedArgs, socketPath: string, context: CliContext | null = null): Promise<void> {
	args = withBooleanFlags(args, ["json", "init", "no-git-workflow", "no-space"]);
	switch (subcommand) {
		case undefined:
		case "list":
			return listProjects(args, socketPath);
		case "add":
			return addProject(args, socketPath);
		case "clone":
			return cloneProject(args, socketPath);
		case "get":
			return getSettings(args, socketPath, context);
		case "set":
			return setSetting(args, socketPath, context);
		default:
			exitUsage(`Unknown subcommand: projects ${subcommand}\nAvailable: projects list, projects add, projects clone, projects get, projects set`);
	}
}
