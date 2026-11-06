/**
 * The one schema for `.dev3/config.json` (committed) and `.dev3/config.local.json`
 * (personal). The `Dev3RepoConfig` type, the cascade defaults, `dev3 config`
 * validation, the Project Settings fallback controls and the generated docs all
 * read {@link CONFIG_FIELDS}. Add a field here and nowhere else.
 */
import { DEFAULT_REVIEW_AGENT_ID, DEFAULT_REVIEW_CONFIG_ID, type ColumnAgentConfig } from "./types/column-agents";
import { DEV_SERVER_NAME_PATTERN } from "./dev-servers";
import type { DevServerConfig } from "./types/project";

// ---- Value types ----

interface SpecBase<T> {
	/** Phantom: carries the TypeScript type of a valid value. Never set at runtime. */
	readonly __type?: T;
}

export type ValueSpec<T = unknown> =
	| (SpecBase<T> & { readonly kind: "string" })
	| (SpecBase<T> & { readonly kind: "boolean" })
	| (SpecBase<T> & { readonly kind: "integer"; readonly min?: number; readonly max?: number })
	| (SpecBase<T> & { readonly kind: "enum"; readonly values: readonly string[] })
	| (SpecBase<T> & { readonly kind: "list"; readonly item: ValueSpec })
	| (SpecBase<T> & { readonly kind: "record"; readonly value: ValueSpec; readonly keyPattern?: RegExp })
	| (SpecBase<T> & { readonly kind: "object"; readonly props: Readonly<Record<string, ValueSpec>>; readonly required: readonly string[] });

export type ValueKind = ValueSpec["kind"];

const str = (): ValueSpec<string> => ({ kind: "string" });
const bool = (): ValueSpec<boolean> => ({ kind: "boolean" });
const int = (min?: number, max?: number): ValueSpec<number> => ({ kind: "integer", min, max });
const oneOf = <const V extends readonly string[]>(...values: V): ValueSpec<V[number]> => ({ kind: "enum", values });
const list = <T>(item: ValueSpec<T>): ValueSpec<T[]> => ({ kind: "list", item });
const record = <T>(value: ValueSpec<T>, keyPattern?: RegExp): ValueSpec<Record<string, T>> => ({ kind: "record", value, keyPattern });
const object = <T>(props: Record<string, ValueSpec>, required: string[] = []): ValueSpec<T> => ({ kind: "object", props, required });

// ---- Field metadata ----

/** Where a field's control sits in Project Settings and in the docs. */
export type ConfigSection = "scripts" | "worktree" | "git";

/**
 * How Project Settings shows the field:
 * - `generic` (the default): rendered from the schema by `SchemaConfigFields`.
 * - `bespoke`: `ConfigForm` has a hand-built control carrying `data-config-key`.
 * - `none`: no control on this form; `uiNote` says why.
 */
export type ConfigFieldUi = "generic" | "bespoke" | "none";

export interface ConfigFieldSpec<T = unknown> {
	readonly type: ValueSpec<T>;
	/** One sentence: what the field does. */
	readonly description: string;
	/** Further notes for `dev3 config schema <key>` and the skill. */
	readonly details?: string;
	/** Built-in value the cascade applies when no layer sets one. */
	readonly default?: T;
	/** How the app behaves when nothing sets the field and there is no literal default. */
	readonly defaultNote?: string;
	readonly example: T;
	readonly section: ConfigSection;
	readonly ui?: ConfigFieldUi;
	readonly uiNote?: string;
	/** The value becomes a command dev3 runs. A foreign-code worktree may not supply it. */
	readonly executes?: boolean;
	/** Merged per key across layers instead of the highest layer winning. */
	readonly mergePerKey?: boolean;
	/** `[]` is a real value that overrides lower layers, not "not configured". */
	readonly emptyArrayIsExplicit?: boolean;
}

// T comes from `type` alone, so a literal `default` cannot widen an enum to string.
const field = <T>(spec: { type: ValueSpec<T> } & Omit<ConfigFieldSpec<NoInfer<T>>, "type">): ConfigFieldSpec<T> => spec;

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

const devServerSpec = object<DevServerConfig>(
	{
		script: str(),
		ports: list(str()),
		env: record(str(), ENV_KEY),
		cwd: str(),
		title: str(),
	},
	["script"],
);

const columnAgentSpec = object<ColumnAgentConfig>(
	{ agentId: str(), configId: str(), prompt: str() },
	["agentId", "configId", "prompt"],
);

/** Bump when a stored shape changes, and add the step to {@link CONFIG_MIGRATIONS}. */
export const CONFIG_SCHEMA_VERSION = 1;

/** The file-level key that records which schema version a file was written for. */
export const SCHEMA_VERSION_KEY = "schemaVersion";

export const CONFIG_FIELDS = {
	setupScript: field({
		type: str(),
		description: "Shell command run in every new task worktree, e.g. to install dependencies.",
		details: "Runs with cwd = the worktree and the DEV3_* workspace env vars, plus DEV3_PORT* when portCount > 0.",
		default: "",
		example: "bun install",
		section: "scripts",
		ui: "bespoke",
		executes: true,
	}),
	setupScriptLaunchMode: field({
		type: oneOf("parallel", "blocking"),
		description: "Whether the agent starts alongside setupScript (parallel) or waits for it to finish (blocking).",
		default: "parallel",
		example: "blocking",
		section: "scripts",
		ui: "bespoke",
		executes: true,
	}),
	devScript: field({
		type: str(),
		description: "Command for the task's dev server named `dev` (the Dev Server button and `dev3 dev-server start`).",
		default: "",
		example: "PORT=${DEV3_PORT0:-3000} npm run dev",
		section: "scripts",
		ui: "bespoke",
		executes: true,
	}),
	devServers: field({
		type: record(devServerSpec, DEV_SERVER_NAME_PATTERN),
		description: "Dev servers beyond devScript, keyed by name: { script, ports?, env?, cwd?, title? }.",
		details: "Each `ports` entry becomes a pool port delivered to every server of the task as DEV3_PORT_<NAME>. Declaring `dev` here while devScript is set is an error.",
		defaultNote: "none: only devScript",
		example: { api: { script: "npm run api", ports: ["api"] } },
		section: "scripts",
		ui: "bespoke",
		executes: true,
	}),
	cleanupScript: field({
		type: str(),
		description: "Shell command run before a task worktree is removed (completed, cancelled, deleted, reset).",
		details: "Branch on $DEV3_TASK_STATUS, $DEV3_TASK_FROM_STATUS and $DEV3_TASK_TO_STATUS.",
		default: "",
		example: "docker compose down",
		section: "scripts",
		ui: "bespoke",
		executes: true,
	}),
	clonePaths: field({
		type: list(str()),
		description: "Git-ignored files and directories (globs allowed) copied from the project root into every new worktree before the agent starts.",
		details: "Missing sources are skipped; tracked paths are refused. `[]` in a file turns cloning off and overrides lower layers.",
		default: [],
		example: ["node_modules", ".env"],
		section: "worktree",
		ui: "bespoke",
		emptyArrayIsExplicit: true,
	}),
	defaultBaseBranch: field({
		type: str(),
		description: "Branch new task branches start from.",
		default: "main",
		example: "develop",
		section: "git",
		ui: "bespoke",
	}),
	defaultCompareRef: field({
		type: str(),
		description: "Ref the task diff compares against. Wins over defaultCompareRefMode.",
		defaultNote: "derived from defaultCompareRefMode, else auto-detected from git",
		example: "origin/main",
		section: "git",
		ui: "bespoke",
	}),
	defaultCompareRefMode: field({
		type: oneOf("remote", "local"),
		description: "Compare against origin/<defaultBaseBranch> (remote) or the local base branch (local) when defaultCompareRef is unset.",
		defaultNote: "auto-detected from git",
		example: "remote",
		section: "git",
		ui: "none",
		uiNote: "The compare-ref picker sets defaultCompareRef, which wins over the mode.",
	}),
	autoReviewEnabled: field({
		type: bool(),
		description: "Send finished work through the AI Review column before Your Review.",
		default: false,
		example: true,
		section: "git",
		ui: "bespoke",
	}),
	peerReviewEnabled: field({
		type: bool(),
		description: "Show the PR Review column.",
		default: true,
		example: false,
		section: "git",
		ui: "bespoke",
	}),
	sparseCheckoutEnabled: field({
		type: bool(),
		description: "Check out only sparseCheckoutPaths in task worktrees.",
		default: false,
		example: true,
		section: "worktree",
		ui: "bespoke",
	}),
	sparseCheckoutPaths: field({
		type: list(str()),
		description: "Paths kept in task worktrees while sparseCheckoutEnabled is true.",
		default: [],
		example: ["packages/web", "shared"],
		section: "worktree",
		ui: "bespoke",
	}),
	builtinColumnAgents: field({
		type: record(columnAgentSpec),
		description: "Agent that runs when a task enters a built-in column, keyed by status: { agentId, configId, prompt }.",
		defaultNote: "the built-in AI Review agent",
		example: { "review-by-ai": { agentId: DEFAULT_REVIEW_AGENT_ID, configId: DEFAULT_REVIEW_CONFIG_ID, prompt: "Review the diff." } },
		section: "git",
		ui: "none",
		uiNote: "Edited per column in the board's column settings.",
		executes: true,
	}),
	portCount: field({
		type: int(0, 20),
		description: "Ports allocated per task, exported as DEV3_PORT0..N, DEV3_PORTS and DEV3_PORT_COUNT.",
		details: "Map them onto the project's own port variables in devScript, e.g. PORT=${DEV3_PORT0:-3000}.",
		defaultNote: "0: no ports",
		example: 2,
		section: "worktree",
		ui: "bespoke",
	}),
	env: field({
		type: record(str(), ENV_KEY),
		description: "Environment variables exported into every task session and script.",
		details: "Merged per variable across layers. This field is not for secrets; `.dev3/config.json` is committed.",
		defaultNote: "none",
		example: { NODE_ENV: "development" },
		section: "scripts",
		ui: "bespoke",
		executes: true,
		mergePerKey: true,
	}),
} satisfies Record<string, ConfigFieldSpec<any>>;

type FieldValue<F> = F extends ConfigFieldSpec<infer T> ? T : never;

/** Every field a `.dev3` config file may set. Derived from {@link CONFIG_FIELDS}. */
export type ConfigFieldValues = { -readonly [K in keyof typeof CONFIG_FIELDS]?: FieldValue<(typeof CONFIG_FIELDS)[K]> };

export type ConfigKey = keyof typeof CONFIG_FIELDS;

export const CONFIG_KEYS = Object.keys(CONFIG_FIELDS) as ConfigKey[];

export function isConfigKey(key: string): key is ConfigKey {
	return Object.prototype.hasOwnProperty.call(CONFIG_FIELDS, key);
}

export function getFieldSpec(key: ConfigKey): ConfigFieldSpec {
	return CONFIG_FIELDS[key] as ConfigFieldSpec;
}

export function fieldUi(key: ConfigKey): ConfigFieldUi {
	return getFieldSpec(key).ui ?? "generic";
}

/** Cascade defaults: every field that declares a literal `default`. */
export function configDefaults(): ConfigFieldValues {
	const out: Record<string, unknown> = {};
	for (const key of CONFIG_KEYS) {
		const d = getFieldSpec(key).default;
		if (d !== undefined) out[key] = structuredClone(d);
	}
	return out as ConfigFieldValues;
}

export const COMMAND_BEARING_CONFIG_KEYS: ReadonlySet<ConfigKey> = new Set(CONFIG_KEYS.filter((k) => getFieldSpec(k).executes));
export const EXPLICIT_EMPTY_ARRAY_CONFIG_KEYS: ReadonlySet<ConfigKey> = new Set(CONFIG_KEYS.filter((k) => getFieldSpec(k).emptyArrayIsExplicit));

// ---- Type rendering ----

export function describeType(spec: ValueSpec): string {
	switch (spec.kind) {
		case "string": return "string";
		case "boolean": return "boolean";
		case "integer": {
			if (spec.min !== undefined && spec.max !== undefined) return `integer ${spec.min}-${spec.max}`;
			return "integer";
		}
		case "enum": return spec.values.map((v) => JSON.stringify(v)).join(" | ");
		case "list": return `${describeType(spec.item)}[]`;
		case "record": return `{ [name]: ${describeType(spec.value)} }`;
		case "object": {
			const parts = Object.entries(spec.props).map(([k, v]) => `${k}${spec.required.includes(k) ? "" : "?"}: ${describeType(v)}`);
			return `{ ${parts.join(", ")} }`;
		}
	}
}

export function describeDefault(key: ConfigKey): string {
	const spec = getFieldSpec(key);
	if (spec.default !== undefined) return JSON.stringify(spec.default);
	return spec.defaultNote ?? "(none)";
}

// ---- Validation ----

export interface ConfigIssue {
	/** Dotted path inside the file, e.g. `devServers.api.script`. Empty for the file itself. */
	path: string;
	message: string;
}

export interface ConfigValidation {
	errors: ConfigIssue[];
	warnings: ConfigIssue[];
}

function typeOfValue(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	return typeof v;
}

/** Problems with one value against its spec. Empty when valid. */
export function validateValue(spec: ValueSpec, value: unknown, path: string): ConfigIssue[] {
	const wrong = (expected: string): ConfigIssue[] => [{ path, message: `expected ${expected}, got ${typeOfValue(value)}` }];
	switch (spec.kind) {
		case "string":
			return typeof value === "string" ? [] : wrong("a string");
		case "boolean":
			return typeof value === "boolean" ? [] : wrong("true or false");
		case "integer": {
			if (typeof value !== "number" || !Number.isInteger(value)) return wrong("an integer");
			if (spec.min !== undefined && value < spec.min) return [{ path, message: `must be at least ${spec.min}, got ${value}` }];
			if (spec.max !== undefined && value > spec.max) return [{ path, message: `must be at most ${spec.max}, got ${value}` }];
			return [];
		}
		case "enum":
			return typeof value === "string" && spec.values.includes(value)
				? []
				: [{ path, message: `must be one of ${spec.values.map((v) => JSON.stringify(v)).join(", ")}, got ${JSON.stringify(value)}` }];
		case "list":
			if (!Array.isArray(value)) return wrong("an array");
			return value.flatMap((item, i) => validateValue(spec.item, item, `${path}[${i}]`));
		case "record": {
			if (typeOfValue(value) !== "object") return wrong("an object");
			const issues: ConfigIssue[] = [];
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
				if (spec.keyPattern && !spec.keyPattern.test(k)) issues.push({ path: `${path}.${k}`, message: `invalid name "${k}"` });
				issues.push(...validateValue(spec.value, v, `${path}.${k}`));
			}
			return issues;
		}
		case "object": {
			if (typeOfValue(value) !== "object") return wrong("an object");
			const obj = value as Record<string, unknown>;
			const issues: ConfigIssue[] = [];
			for (const req of spec.required) {
				if (obj[req] === undefined) issues.push({ path: `${path}.${req}`, message: "is required" });
			}
			for (const [k, v] of Object.entries(obj)) {
				const prop = spec.props[k];
				if (!prop) issues.push({ path: `${path}.${k}`, message: `unknown property "${k}"` });
				else issues.push(...validateValue(prop, v, `${path}.${k}`));
			}
			return issues;
		}
	}
}

/** Closest known key within edit distance 2, case-insensitive, for "did you mean". */
export function suggestConfigKey(key: string): ConfigKey | undefined {
	let best: ConfigKey | undefined;
	let bestDist = 3;
	for (const candidate of CONFIG_KEYS) {
		const d = editDistance(key.toLowerCase(), candidate.toLowerCase());
		if (d < bestDist) { best = candidate; bestDist = d; }
	}
	return best;
}

function editDistance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let prev = row[0];
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = tmp;
		}
	}
	return row[b.length];
}

/**
 * Validate a parsed config file. Wrong types are errors; unknown keys and a
 * file from a newer schema are warnings, because the app ignores what it does
 * not know instead of failing.
 */
export function validateConfigFile(raw: unknown): ConfigValidation {
	const errors: ConfigIssue[] = [];
	const warnings: ConfigIssue[] = [];
	if (typeOfValue(raw) !== "object") {
		errors.push({ path: "", message: `the file must hold a JSON object, got ${typeOfValue(raw)}` });
		return { errors, warnings };
	}
	const obj = raw as Record<string, unknown>;
	for (const [key, value] of Object.entries(obj)) {
		if (key === SCHEMA_VERSION_KEY) {
			if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
				errors.push({ path: key, message: `must be a positive integer, got ${JSON.stringify(value)}` });
			} else if (value > CONFIG_SCHEMA_VERSION) {
				warnings.push({ path: key, message: `file uses schema ${value}, this dev3 knows ${CONFIG_SCHEMA_VERSION}; update dev3 to read every field` });
			}
			continue;
		}
		if (!isConfigKey(key)) {
			const hint = suggestConfigKey(key);
			warnings.push({ path: key, message: `unknown key, ignored${hint ? ` (did you mean "${hint}"?)` : ""}` });
			continue;
		}
		// `null` means "not set" to the cascade, so it is harmless.
		if (value === null) continue;
		errors.push(...validateValue(getFieldSpec(key).type, value, key));
	}
	const servers = obj.devServers;
	if (typeof obj.devScript === "string" && obj.devScript.trim() && typeOfValue(servers) === "object" && Object.prototype.hasOwnProperty.call(servers, "dev")) {
		errors.push({ path: "devServers.dev", message: "`dev` is already declared by devScript; rename this server or clear devScript" });
	}
	return { errors, warnings };
}

// ---- Migrations ----

export type ConfigMigration = (raw: Record<string, unknown>) => Record<string, unknown>;

/** Step `n` migrates a file from version `n` to `n + 1`. Empty until the first bump. */
export const CONFIG_MIGRATIONS: Readonly<Record<number, ConfigMigration>> = {};

export interface MigratedConfig {
	config: Record<string, unknown>;
	/** Version the file declared; a file without `schemaVersion` is version 1. */
	fromVersion: number;
	migrated: boolean;
}

/**
 * Bring a parsed file up to `target` in memory. The file on disk is rewritten
 * only by the next write (`dev3 config set`, a Project Settings save). A file
 * from a newer schema is returned as is: its unknown keys are ignored.
 */
export function migrateConfig(
	raw: Record<string, unknown>,
	migrations: Readonly<Record<number, ConfigMigration>> = CONFIG_MIGRATIONS,
	target: number = CONFIG_SCHEMA_VERSION,
): MigratedConfig {
	const declared = raw[SCHEMA_VERSION_KEY];
	const fromVersion = typeof declared === "number" && Number.isInteger(declared) && declared >= 1 ? declared : 1;
	let config = raw;
	let version = fromVersion;
	while (version < target) {
		const step = migrations[version];
		if (!step) throw new Error(`No config migration from schema ${version} to ${version + 1}`);
		config = step({ ...config });
		version++;
	}
	const migrated = version !== fromVersion;
	if (migrated) config = { ...config, [SCHEMA_VERSION_KEY]: version };
	return { config, fromVersion, migrated };
}

// ---- CLI value parsing ----

/**
 * Parse a command-line value for a spec. Strings are taken verbatim; every
 * other kind accepts JSON, and a list also accepts a comma-separated string.
 */
export function parseCliValue(spec: ValueSpec, input: string): unknown {
	if (spec.kind === "string") return input;
	if (spec.kind === "enum") return input;
	if (spec.kind === "boolean") {
		const v = input.trim().toLowerCase();
		if (["true", "yes", "on", "1"].includes(v)) return true;
		if (["false", "no", "off", "0"].includes(v)) return false;
		throw new Error(`expected true or false, got "${input}"`);
	}
	if (spec.kind === "integer") {
		if (!/^-?\d+$/.test(input.trim())) throw new Error(`expected an integer, got "${input}"`);
		return Number(input.trim());
	}
	const trimmed = input.trim();
	if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
		try {
			return JSON.parse(trimmed);
		} catch (err) {
			throw new Error(`invalid JSON: ${(err as Error).message}`);
		}
	}
	if (spec.kind === "list") return trimmed === "" ? [] : trimmed.split(",").map((s) => s.trim()).filter(Boolean);
	throw new Error(`expected a JSON object, e.g. ${JSON.stringify(spec.kind === "record" ? { name: "value" } : {})}`);
}

/**
 * Resolve `key` or `key.sub` to its field and spec. A dotted path addresses one
 * entry of a record field (`env.NODE_ENV`, `devServers.api`).
 */
export function resolveConfigPath(path: string): { key: ConfigKey; sub?: string; spec: ValueSpec } {
	const dot = path.indexOf(".");
	const head = dot === -1 ? path : path.slice(0, dot);
	const sub = dot === -1 ? undefined : path.slice(dot + 1);
	if (!isConfigKey(head)) {
		const hint = suggestConfigKey(head);
		throw new Error(`Unknown config key "${head}".${hint ? ` Did you mean "${hint}"?` : ""} Run \`dev3 config schema\` for the list.`);
	}
	const spec = getFieldSpec(head).type;
	if (sub === undefined) return { key: head, spec };
	if (spec.kind !== "record") throw new Error(`"${head}" is a ${describeType(spec)}; only record fields take a ".name" suffix`);
	if (!sub) throw new Error(`Missing entry name after "${head}."`);
	return { key: head, sub, spec: spec.value };
}

// ---- JSON Schema export ----

function toJsonSchemaValue(spec: ValueSpec): Record<string, unknown> {
	switch (spec.kind) {
		case "string": return { type: "string" };
		case "boolean": return { type: "boolean" };
		case "integer": return { type: "integer", ...(spec.min !== undefined ? { minimum: spec.min } : {}), ...(spec.max !== undefined ? { maximum: spec.max } : {}) };
		case "enum": return { type: "string", enum: [...spec.values] };
		case "list": return { type: "array", items: toJsonSchemaValue(spec.item) };
		case "record": return {
			type: "object",
			...(spec.keyPattern ? { propertyNames: { pattern: spec.keyPattern.source } } : {}),
			additionalProperties: toJsonSchemaValue(spec.value),
		};
		case "object": return {
			type: "object",
			properties: Object.fromEntries(Object.entries(spec.props).map(([k, v]) => [k, toJsonSchemaValue(v)])),
			required: [...spec.required],
			additionalProperties: false,
		};
	}
}

/** JSON Schema (draft 2020-12) for one field: the shape `dev3 config schema <key> --json` prints. */
export function fieldJsonSchema(key: ConfigKey): Record<string, unknown> {
	const spec = getFieldSpec(key);
	return {
		...toJsonSchemaValue(spec.type),
		description: spec.details ? `${spec.description} ${spec.details}` : spec.description,
		...(spec.default !== undefined ? { default: spec.default } : {}),
		examples: [spec.example],
	};
}

/** JSON Schema (draft 2020-12) for a whole `.dev3` config file. */
export function configJsonSchema(): Record<string, unknown> {
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		title: "dev3 project config (.dev3/config.json, .dev3/config.local.json)",
		type: "object",
		properties: {
			[SCHEMA_VERSION_KEY]: { type: "integer", minimum: 1, description: `Schema version the file was written for. Absent = 1. Current: ${CONFIG_SCHEMA_VERSION}.` },
			...Object.fromEntries(CONFIG_KEYS.map((k) => [k, fieldJsonSchema(k)])),
		},
		// Unknown keys are warnings, never errors: a newer dev3 may have written them.
		additionalProperties: true,
	};
}

// ---- Generated docs ----

const LAYER_DOC = [
	"Precedence, highest first: `.dev3/config.local.json` (personal, git-ignored), `.dev3/config.json` (committed),",
	"Project Settings → Project tab, built-in default. Inside a task worktree, the worktree's two files outrank the",
	"main checkout's two files. Per field, the highest layer that sets it wins; `env` merges per variable.",
].join(" ");

/** Markdown table of every field, for the `dev3-project-config` skill. */
export function renderConfigFieldTable(): string {
	const esc = (s: string) => s.replaceAll("|", "\\|");
	const rows = CONFIG_KEYS.map((key) => {
		const spec = getFieldSpec(key);
		const text = spec.details ? `${spec.description} ${spec.details}` : spec.description;
		return `| \`${key}\` | ${esc(describeType(spec.type))} | ${esc(describeDefault(key))} | ${esc(text)} | \`${esc(JSON.stringify(spec.example))}\` |`;
	});
	return [
		LAYER_DOC,
		"",
		"| Field | Type | Default | Description | Example |",
		"|-------|------|---------|-------------|---------|",
		...rows,
	].join("\n");
}
