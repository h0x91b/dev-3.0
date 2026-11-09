import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sendRequest } from "../socket-client";
import { printTable, exitError, exitUsage } from "../output";
import { resolveFileArgs, type ParsedArgs } from "../args";
import { rejectUnknownFlags } from "../flag-validation";
import { readStdin } from "../stdin";
import { projectOwningCwd, readProjectDirect, resolveProjectId, type CliContext } from "../context";
import { CLI_EXIT_CODE_CONFIG_INVALID } from "../../shared/cli-exit-codes";
import {
	CONFIG_KEYS,
	CONFIG_SCHEMA_VERSION,
	configJsonSchema,
	describeDefault,
	describeType,
	fieldJsonSchema,
	getFieldSpec,
	parseCliValue,
	resolveConfigPath,
	validateConfigFile,
	validateValue,
	type ConfigIssue,
	type ConfigKey,
} from "../../shared/config-schema";

const NO_PROJECT = "Could not detect project. Use --project <id>, or run from the project's worktree or checkout.";
const BOOLEAN_FLAGS = new Set(["json", "effective", "local", "main"]);
const VALUE_FLAGS = new Set(["project", "file"]);

/** Subcommands that read local files only and work while the app is closed. */
export const OFFLINE_CONFIG_SUBCOMMANDS: ReadonlySet<string> = new Set(["schema", "validate"]);

/**
 * Re-parse the raw words after `dev3 config <sub>`. The shared parser lets a
 * bare `--local` swallow the next word as its value, which would turn
 * `set --local clonePaths node_modules` into `--local=clonePaths`.
 */
export function parseConfigArgs(words: string[]): ParsedArgs {
	const flags: Record<string, string> = {};
	const positional: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		if (word === "--") { positional.push(...words.slice(i + 1)); break; }
		if (!word.startsWith("--") || word === "-") { positional.push(word); continue; }
		const eq = word.indexOf("=");
		const name = eq === -1 ? word.slice(2) : word.slice(2, eq);
		if (eq !== -1) flags[name] = word.slice(eq + 1);
		else if (BOOLEAN_FLAGS.has(name)) flags[name] = "true";
		else if (VALUE_FLAGS.has(name) && words[i + 1] !== undefined) flags[name] = words[++i];
		else flags[name] = "true";
	}
	return resolveFileArgs({ flags, positional });
}

/**
 * Render a resolved config value for the `dev3 config show` table. Arrays →
 * comma list, empty → "(empty)", objects → a readable summary, null → "(not set)".
 */
function formatConfigValue(field: string, value: unknown): string {
	if (Array.isArray(value)) return value.join(", ") || "(empty)";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") return String(value);
	if (typeof value === "string") return value || "(empty)";
	if (value !== null && typeof value === "object") {
		const keys = Object.keys(value as Record<string, unknown>);
		// Env values may be secrets — print key names only.
		if (field === "env") {
			return keys.length > 0 ? `${keys.join(", ")} (${keys.length} ${keys.length === 1 ? "var" : "vars"})` : "(empty)";
		}
		if (field === "builtinColumnAgents") {
			return keys.length === 1 ? "1 column" : `${keys.length} columns`;
		}
		return JSON.stringify(value);
	}
	return "(not set)";
}

interface ShowResult {
	settings: Record<string, unknown>;
	sources: Record<string, string>;
	envSources?: Record<string, string>;
	layers?: Array<{ id: string; path: string; exists: boolean; trusted: boolean }>;
	hasRepoConfig: boolean;
	repoConfigIgnored?: boolean;
}

export async function handleConfig(
	subcommand: string | undefined,
	parsed: ParsedArgs,
	socketPath: string | null,
	context: CliContext | null,
	rawWords?: string[],
): Promise<void> {
	const args = rawWords ? parseConfigArgs(rawWords) : parsed;
	const sub = subcommand ?? "show";

	if (sub === "schema") return handleSchema(args);
	if (sub === "validate") return handleValidate(args, context);

	const projectId = resolveProjectId(args.flags?.project, context);
	const worktreePath = context?.worktreePath;
	const base = { projectId, worktreePath, taskId: context?.taskId };
	if (!socketPath) exitError("dev3 is not running; this subcommand needs the app.");

	if (sub === "export") {
		rejectUnknownFlags(args, ["project"]);
		if (!projectId) exitError(NO_PROJECT);
		const resp = await sendRequest(socketPath, "config.export", { projectId, worktreePath });
		if (!resp.ok) exitError(resp.error || "Failed to export config");
		const result = resp.data as { path: string };
		process.stdout.write(`Exported project settings to ${result.path}\n`);
		return;
	}

	if (sub === "show" || sub === "get") {
		rejectUnknownFlags(args, ["project", "json", "effective"]);
		if (!projectId) exitError(NO_PROJECT);
		const resp = await sendRequest(socketPath, "config.show", base);
		if (!resp.ok) exitError(resp.error || "Failed to get config");
		const result = resp.data as ShowResult;
		if (sub === "get") return printGet(args, result);
		return printShow(args, result);
	}

	if (sub === "set" || sub === "unset") {
		rejectUnknownFlags(args, ["project", "local", "main", "json"]);
		if (!projectId) exitError(NO_PROJECT);
		const path = args.positional[0];
		if (!path) exitUsage(sub === "set" ? "Usage: dev3 config set <key>[.<name>] <value> [--local] [--main]" : "Usage: dev3 config unset <key>[.<name>] [--local] [--main]");
		const target = resolveOrExit(path);
		let value: unknown;
		if (sub === "set") {
			let input = args.positional[1];
			if (input === undefined) exitUsage(`Missing value. Usage: dev3 config set ${path} <value>  (\`-\` reads stdin)`);
			if (args.positional.length > 2) exitUsage(`Too many arguments: quote a value that contains spaces, e.g. dev3 config set ${path} "${args.positional.slice(1).join(" ")}"`);
			if (input === "-") input = (await readStdin()).replace(/\r?\n$/, "");
			try {
				value = parseCliValue(target.spec, input);
			} catch (err) {
				exitInvalid(`${path}: ${(err as Error).message}`, path);
			}
			const issues = validateValue(target.spec, value, path);
			if (issues.length > 0) exitInvalid(issues.map(formatIssue).join("\n"), path);
		}
		const resp = await sendRequest(socketPath, sub === "set" ? "config.set" : "config.unset", {
			...base,
			key: path,
			value,
			local: args.flags.local === "true",
			main: args.flags.main === "true",
		});
		if (!resp.ok) exitError(resp.error || `Failed to ${sub} ${path}`);
		const result = resp.data as { file: string; previous: unknown; value: unknown; shadowedBy?: string; ignoredAsForeign?: boolean };
		if (args.flags.json === "true") {
			process.stdout.write(JSON.stringify(result, null, 2) + "\n");
			return;
		}
		const was = result.previous === undefined ? "was not set" : `was ${JSON.stringify(result.previous)}`;
		process.stdout.write(sub === "set"
			? `Set ${path} = ${JSON.stringify(result.value)} in ${result.file} (${was})\n`
			: `Removed ${path} from ${result.file} (${was})\n`);
		if (result.shadowedBy) {
			process.stdout.write(`Note: the ${result.shadowedBy} layer also sets ${target.key} and wins, so the effective value is unchanged. \`dev3 config show\` lists the layers.\n`);
		}
		if (result.ignoredAsForeign) {
			process.stdout.write(`Note: this worktree holds foreign code, so dev3 ignores its ${target.key}; only the project's own checkout can supply it.\n`);
		}
		return;
	}

	exitUsage(`Unknown subcommand: config ${sub}\nAvailable: config show, get, set, unset, validate, schema, export`);
}

function resolveOrExit(path: string): ReturnType<typeof resolveConfigPath> {
	try {
		return resolveConfigPath(path);
	} catch (err) {
		exitUsage((err as Error).message);
	}
}

function formatIssue(issue: ConfigIssue): string {
	return `${issue.path || "(file)"}: ${issue.message}`;
}

function exitInvalid(message: string, path: string): never {
	const key = path.split(".")[0];
	exitError(message, `Expected: ${describeType(getFieldSpec(key as ConfigKey).type)}. See \`dev3 config schema ${key}\`.`, CLI_EXIT_CODE_CONFIG_INVALID);
}

function printShow(args: ParsedArgs, result: ShowResult): void {
	if (args.flags.json === "true") {
		process.stdout.write(JSON.stringify(result, null, 2) + "\n");
		return;
	}
	const repoState = result.repoConfigIgnored
		? `${result.hasRepoConfig ? "exists" : "not found"} — IGNORED (\"Use repository dev3 configuration\" is off)`
		: (result.hasRepoConfig ? "exists" : "not found");
	process.stdout.write(`Repo config (.dev3/config.json): ${repoState}\n`);
	for (const layer of result.layers ?? []) {
		const state = layer.exists ? (layer.trusted ? "" : " (foreign code: commands ignored)") : " (not found)";
		process.stdout.write(`  ${layer.id.padEnd(10)} ${layer.path}${state}\n`);
	}
	process.stdout.write("\n");
	printTable(
		["FIELD", "VALUE", "SOURCE"],
		Object.entries(result.settings).map(([field, value]) => {
			const display = formatConfigValue(field, value);
			return [field, display.length > 60 ? display.slice(0, 57) + "..." : display, result.sources[field] || "unset"];
		}),
	);
}

function printGet(args: ParsedArgs, result: ShowResult): void {
	const path = args.positional[0];
	if (!path) exitUsage("Usage: dev3 config get <key>[.<name>] [--json]");
	const { key, sub } = resolveOrExit(path);
	const whole = result.settings[key];
	const value = sub === undefined
		? whole
		: (whole && typeof whole === "object" ? (whole as Record<string, unknown>)[sub] : undefined);
	const source = sub !== undefined && key === "env"
		? (result.envSources?.[sub] ?? "unset")
		: (value == null ? "unset" : result.sources[key] ?? "unset");
	if (args.flags.json === "true") {
		process.stdout.write(JSON.stringify({ key: path, value: value ?? null, source }, null, 2) + "\n");
		return;
	}
	if (value == null) exitError(`${path} is not set`, `Default: ${describeDefault(key)}`);
	process.stdout.write((typeof value === "string" ? value : JSON.stringify(value)) + "\n");
}

// ---- schema (offline) ----

function handleSchema(args: ParsedArgs): void {
	rejectUnknownFlags(args, ["json"]);
	const path = args.positional[0];
	const json = args.flags.json === "true";
	if (!path) {
		if (json) {
			process.stdout.write(JSON.stringify(configJsonSchema(), null, 2) + "\n");
			return;
		}
		const lines = [
			`dev3 project config, schema version ${CONFIG_SCHEMA_VERSION}`,
			"Files: .dev3/config.json (committed, shared) and .dev3/config.local.json (personal, git-ignored).",
			"Precedence, highest first: config.local.json, config.json, Project Settings, built-in default.",
			"In a task worktree, its own two files outrank the project root's two files. env merges per variable.",
			"",
		];
		for (const key of CONFIG_KEYS) {
			const spec = getFieldSpec(key);
			lines.push(`${key}  ${describeType(spec.type)}  (default: ${describeDefault(key)})`);
			lines.push(`    ${spec.description}`);
		}
		lines.push("", "Details: dev3 config schema <key>    Read: dev3 config show | get <key>    Write: dev3 config set <key> <value> [--local]");
		process.stdout.write(lines.join("\n") + "\n");
		return;
	}
	const { key, sub, spec } = resolveOrExit(path);
	if (json) {
		process.stdout.write(JSON.stringify(sub === undefined ? fieldJsonSchema(key) : { key: path, type: describeType(spec) }, null, 2) + "\n");
		return;
	}
	const field = getFieldSpec(key);
	const example = field.example;
	const exampleArg = typeof example === "string" ? example : JSON.stringify(example);
	const lines = [
		`${key}${sub !== undefined ? ` (entry "${sub}")` : ""}`,
		`  ${field.description}`,
		...(field.details ? [`  ${field.details}`] : []),
		`  Type:     ${describeType(sub === undefined ? field.type : spec)}`,
		`  Default:  ${describeDefault(key)}`,
		`  Example:  ${JSON.stringify(example)}`,
		`  Set:      dev3 config set ${key} '${exampleArg.replaceAll("'", "'\\''")}' [--local]`,
		...(field.mergePerKey ? ["  Layers:   merged per entry across layers (set one with `dev3 config set " + key + ".<NAME> <value>`)"] : ["  Layers:   the highest layer that sets it wins"]),
		...(field.executes ? ["  Security: can run code, so dev3 ignores it from a foreign-code worktree"] : []),
	];
	process.stdout.write(lines.join("\n") + "\n");
}

// ---- validate (offline) ----

interface FileReport {
	path: string;
	exists: boolean;
	errors: ConfigIssue[];
	warnings: ConfigIssue[];
}

/** Every `.dev3` config file `validate` checks for the current directory. */
export function configFilesToValidate(context: CliContext | null, cwd: string = process.cwd(), file?: string): string[] {
	if (file) return [resolve(cwd, file)];
	const roots: string[] = [];
	if (context?.worktreePath) {
		roots.push(context.worktreePath);
		const project = readProjectDirect(context.projectId);
		if (project?.path) roots.push(project.path);
	} else {
		// The checkout you stand in first, then the project root that owns it.
		const here = nearestDev3Root(cwd);
		const owner = projectOwningCwd(cwd)?.path;
		if (here) roots.push(here);
		if (owner) roots.push(owner);
		if (roots.length === 0) roots.push(cwd);
	}
	// Through realpath: the same checkout reached via a symlink (/var vs /private/var) is one root.
	const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
	return [...new Map(roots.map((r) => [real(r), r])).values()].flatMap((root) => [join(root, ".dev3", "config.local.json"), join(root, ".dev3", "config.json")]);
}

function nearestDev3Root(start: string): string | null {
	let dir = resolve(start);
	for (;;) {
		const candidate = join(dir, ".dev3");
		if (existsSync(candidate) && statSync(candidate).isDirectory()) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export function validateConfigPath(path: string): FileReport {
	if (!existsSync(path)) return { path, exists: false, errors: [], warnings: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		return { path, exists: true, errors: [{ path: "", message: `invalid JSON: ${(err as Error).message}` }], warnings: [] };
	}
	return { path, exists: true, ...validateConfigFile(parsed) };
}

function handleValidate(args: ParsedArgs, context: CliContext | null): void {
	rejectUnknownFlags(args, ["json", "file"]);
	const reports = configFilesToValidate(context, process.cwd(), args.flags.file).map(validateConfigPath);
	// A named file that is missing is a wrong path, not a repo that uses the defaults.
	if (args.flags.file && !reports[0].exists) exitError(`${reports[0].path} does not exist`);
	const errorCount = reports.reduce((n, r) => n + r.errors.length, 0);
	if (args.flags.json === "true") {
		process.stdout.write(JSON.stringify({ ok: errorCount === 0, schemaVersion: CONFIG_SCHEMA_VERSION, files: reports }, null, 2) + "\n");
	} else {
		for (const report of reports) {
			if (!report.exists) {
				process.stdout.write(`- ${report.path}: not found\n`);
				continue;
			}
			const status = report.errors.length > 0 ? "INVALID" : "ok";
			process.stdout.write(`${report.errors.length > 0 ? "✗" : "✓"} ${report.path}: ${status}\n`);
			for (const e of report.errors) process.stdout.write(`    error    ${formatIssue(e)}\n`);
			for (const w of report.warnings) process.stdout.write(`    warning  ${formatIssue(w)}\n`);
		}
		if (!reports.some((r) => r.exists)) process.stdout.write("No .dev3 config files here; every field uses its default.\n");
	}
	if (errorCount > 0) process.exit(CLI_EXIT_CODE_CONFIG_INVALID);
}
