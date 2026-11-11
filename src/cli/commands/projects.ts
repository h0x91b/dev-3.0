import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Project, SpacesFile } from "../../shared/types";
import { EMPTY_SPACES_FILE } from "../../shared/types";
import { CLI_EXIT_CODE_PROJECT_ALREADY_REGISTERED } from "../../shared/cli-exit-codes";
import type { ClaudeFolderNotice } from "../../shared/claude-folder-notice";
import { looksLikeGitUrl, shortSpaceId, toCliProject, type ProjectRegistrationResult } from "../../shared/project-registration";
import { sendRequest } from "../socket-client";
import { printTable, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { rejectUnknownFlags } from "../flag-validation";
import { exitRequestFailed, flagValue, flagValues, isUnknownMethod, spaceNames, withBooleanFlags } from "./spaces";

const ADD_TIMEOUT_MS = 2 * 60_000;
// The whole clone happens inside this one request.
const CLONE_TIMEOUT_MS = 30 * 60_000;

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

function claudeFolderLine({ state, dir }: ClaudeFolderNotice): string {
	if (state === "refused") return `Claude folder: ~/.claude - git does not ignore ${dir}/.credentials.json, so ${dir} is not used`;
	return state === "ready" ? `Claude folder: ${dir}` : `Claude folder: ${dir} (no login yet - the first Claude task asks you to sign in)`;
}

/** Print an add/clone result; an already-registered folder exits with its own code. */
function report(result: ProjectRegistrationResult, json: boolean): void {
	const { project } = result;
	if (json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else if (result.outcome === "exists") {
		process.stdout.write(
			`Already a project: ${project.id.slice(0, 8)} "${project.name}" — ${project.path}\n` +
				`Spaces: ${spaceNames(project)}\n` +
				`Nothing changed. Change its spaces with: dev3 spaces add|set|remove <space> --project ${project.id.slice(0, 8)}\n`,
		);
	} else {
		for (const space of result.createdSpaces) {
			process.stdout.write(`Created space ${shortSpaceId(space.id)} "${space.name}"\n`);
		}
		process.stdout.write(
			`Added project ${project.id.slice(0, 8)} "${project.name}" — ${project.path}\n` +
				`Spaces: ${spaceNames(project)}\n`,
		);
		if (result.claudeFolder) process.stdout.write(`${claudeFolderLine(result.claudeFolder)}\n`);
	}
	if (result.outcome === "exists") process.exit(CLI_EXIT_CODE_PROJECT_ALREADY_REGISTERED);
}

async function addProject(args: ParsedArgs, socketPath: string): Promise<void> {
	rejectUnknownFlags(args, ["name", "init", "json", ...SPACE_FLAGS]);
	const [raw, ...extra] = args.positional;
	if (!raw || extra.length > 0) {
		exitUsage('Usage: dev3 projects add <path> [--name "..."] [--space <id|name>]... [--new-space "..."]... [--no-space] [--init] [--json]');
	}
	if (looksLikeGitUrl(raw)) {
		exitUsage(`"${raw}" is a git URL, not a folder. Clone and add it with: dev3 projects clone ${raw}`);
	}

	const resp = await sendRequest(socketPath, "projects.add", {
		path: absolutePath(raw),
		name: flagValue(args, "name"),
		init: "init" in args.flags,
		...spaceParams(args),
	}, { timeoutMs: ADD_TIMEOUT_MS });
	if (!resp.ok) exitRequestFailed(resp, "Failed to add project", SPACE_HINT);
	report(resp.data as ProjectRegistrationResult, "json" in args.flags);
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

export async function handleProjects(subcommand: string | undefined, args: ParsedArgs, socketPath: string): Promise<void> {
	args = withBooleanFlags(args, ["json", "init", "no-space"]);
	switch (subcommand) {
		case undefined:
		case "list":
			return listProjects(args, socketPath);
		case "add":
			return addProject(args, socketPath);
		case "clone":
			return cloneProject(args, socketPath);
		default:
			exitUsage(`Unknown subcommand: projects ${subcommand}\nAvailable: projects list, projects add, projects clone`);
	}
}
