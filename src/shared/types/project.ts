import type { PosixShellResolution, ShellFlavor } from "../posix-shell";
import type { TaskType } from "./task-type";
import type { ColumnAgentConfig } from "./column-agents";
import { COORDINATOR_PROMPT, DEFAULT_PR_REVIEW_PROMPT } from "./prompts";
import type { GlobalSettings } from "./global-settings";
import type { CustomColumn, Label } from "./labels-columns";

/** Extract repository name from a git URL (HTTPS or SSH). */
export function extractRepoName(url: string): string {
	const cleaned = url.replace(/\/+$/, "").replace(/\.git$/, "");
	const lastSlash = cleaned.lastIndexOf("/");
	const lastColon = cleaned.lastIndexOf(":");
	const pos = Math.max(lastSlash, lastColon);
	const name = pos >= 0 ? cleaned.slice(pos + 1) : cleaned;
	return name || "cloned-repo";
}

// ---- Repo-local config (.dev3/config.json) ----

export type CompareRefMode = "remote" | "local";
export type SetupScriptLaunchMode = "parallel" | "blocking";
export type GitHubCliAuthStatus = "authenticated" | "not_authenticated" | "not_installed";

export interface GitHubAccount {
	login: string;
	host: string;
	active: boolean;
	/**
	 * Where gh keeps this account's token, verbatim from `gh auth status --json`:
	 * an env var name (`GH_TOKEN`/`GITHUB_TOKEN`/`GH_ENTERPRISE_TOKEN`/
	 * `GITHUB_ENTERPRISE_TOKEN`), `keyring`, or a `hosts.yml` path. Undefined for
	 * old gh (plain-text status parsing). Env-backed accounts have no stored
	 * credential, so their token must be read from the environment — never via
	 * `gh auth token --user`, which errors "no oauth token found …" (decision 157).
	 */
	tokenSource?: string;
}

export interface GitHubCliStatus {
	authStatus: GitHubCliAuthStatus;
	binaryPath: string | null;
	accounts: GitHubAccount[];
}

/** A prompt style rendered by real zsh, as ANSI lines — or why it could not be. */
export type ShellPromptPreview =
	| { ok: true; afterSlowCommand: string[]; afterFailedCommand: string[] }
	| { ok: false; reason: "no-zsh" }
	| { ok: false; reason: "invalid"; error: string };

/** What the Settings screen needs to explain the `terminalShell` choice. */
export interface ShellAvailability {
	/** The shell dev3 runs right now; null on Windows, which has no POSIX shell. */
	resolved: PosixShellResolution | null;
	/** Path of each installed flavor. A missing key means it is not on this machine. */
	installed: Partial<Record<ShellFlavor, string>>;
}

/**
 * One dev server a project declares by name. `devScript` declares the server
 * named `dev` and is NOT written here — see `src/shared/dev-servers.ts`.
 */
export interface DevServerConfig {
	/** The command to run, verbatim, exactly like `devScript`. */
	script: string;
	/**
	 * Ports this server listens on, by name. Each becomes one pool port of the
	 * task, delivered to EVERY server of that task as `DEV3_PORT_<NAME>` so the
	 * front end knows where the API is.
	 */
	ports?: string[];
	/** Extra environment for this server only. Layers between the project env and the caller's. */
	env?: Record<string, string>;
	/** Worktree-relative working directory (a monorepo package). Absent = the worktree root. */
	cwd?: string;
	/** Display label for the pane and the UI. Absent = the server's name. */
	title?: string;
}

/** Fields that can be stored in .dev3/config.json (repo-level, shareable). */
export interface Dev3RepoConfig {
	setupScript?: string;
	setupScriptLaunchMode?: SetupScriptLaunchMode;
	devScript?: string;
	/**
	 * Additional dev servers, by name. Independent of `devScript`, which keeps
	 * declaring the server named `dev` — declaring `dev` here while `devScript`
	 * is set is a config error, not a merge.
	 */
	devServers?: Record<string, DevServerConfig>;
	cleanupScript?: string;
	clonePaths?: string[];
	defaultBaseBranch?: string;
	defaultCompareRef?: string;
	defaultCompareRefMode?: CompareRefMode;
	autoReviewEnabled?: boolean;
	peerReviewEnabled?: boolean;
	sparseCheckoutEnabled?: boolean;
	sparseCheckoutPaths?: string[];
	builtinColumnAgents?: Record<string, ColumnAgentConfig>;
	/** Number of ports to allocate per task/worktree (injected as DEV3_PORT0..N). Default: 0. */
	portCount?: number;
	/** Env vars exported into every task session (agent terminals, setup/dev/cleanup
	 *  scripts, column agents). Merged PER KEY across config layers (decision 179). */
	env?: Record<string, string>;
}

/** Keys of Dev3RepoConfig — used for merge logic. */
export const DEV3_REPO_CONFIG_KEYS: (keyof Dev3RepoConfig)[] = [
	"setupScript",
	"setupScriptLaunchMode",
	"devScript",
	"devServers",
	"cleanupScript",
	"clonePaths",
	"defaultBaseBranch",
	"defaultCompareRef",
	"defaultCompareRefMode",
	"autoReviewEnabled",
	"peerReviewEnabled",
	"sparseCheckoutEnabled",
	"sparseCheckoutPaths",
	"builtinColumnAgents",
	"portCount",
	"env",
];

export type ConfigSource = "repo" | "local";

export interface ConfigSourceEntry {
	field: string;
	source: ConfigSource;
}

/**
 * Full provenance of a resolved config field, for `dev3 config show`.
 * Wider than ConfigSource (repo/local, used for the UI badge): it attributes
 * EVERY key to exactly one origin so the CLI never falls back to a blanket
 * label that hides where a value actually came from.
 *   local   → .dev3/config.local.json
 *   repo    → .dev3/config.json
 *   project → projects.json Project object (Project Settings → Project tab)
 *   default → built-in DEFAULTS or a derived value (e.g. defaultCompareRef)
 *   unset   → no value at any layer (rendered "(not set)")
 */
export type ResolvedConfigSource = "local" | "repo" | "project" | "default" | "unset";

export interface ProjectSettingsUpdate extends Dev3RepoConfig {
	/** Display name only — the project's path (and every slug derived from it) never moves. */
	name?: string;
	githubAuthHost?: string | null;
	githubAuthLogin?: string | null;
	sensitive?: boolean;
	/** Replaces the whole exclusion list; an empty array clears it. */
	autoAccountExclusions?: string[];
	/** Turns reading of this project's `.dev3/` config files on or off. */
	useRepoConfig?: boolean;
	/** Blank string clears the project override and falls back to global. */
	reviewModePrompt?: string;
	/** Blank string clears the project override and falls back to global. */
	coordinatorPrompt?: string;
	/** `"inherit"` clears the project override and falls back to global. */
	artifactTemplate?: ArtifactTemplateMode | "inherit";
	/** Blank string clears the project folder and falls back to the global one. */
	artifactTemplatePath?: string;
}

/**
 * What dev3 would do to make a folder a usable project in place. `init` runs
 * `git init`; `first-commit` finishes a repo that has no commit yet. The first
 * commit carries only dev3's `.dev3/README.md` placeholder (`create` / `reuse`)
 * or nothing (`keep`: a `.dev3/README.md` of the user's own is left alone).
 */
export interface GitInitOffer {
	path: string;
	mode: "init" | "first-commit";
	placeholder: "create" | "reuse" | "keep";
	/** Items already in the folder; they stay untracked. */
	existingEntries: number;
}

export interface Project {
	id: string;
	name: string;
	path: string;
	setupScript: string;
	setupScriptLaunchMode?: SetupScriptLaunchMode;
	devScript: string;
	/** Dev servers beyond the one `devScript` declares, by name. Additive: absent = just `devScript`. */
	devServers?: Record<string, DevServerConfig>;
	cleanupScript: string;
	defaultBaseBranch: string;
	defaultCompareRef?: string;
	defaultCompareRefMode?: CompareRefMode;
	// Optional project-scoped gh account selection. Empty = use the current active gh account.
	githubAuthHost?: string | null;
	githubAuthLogin?: string | null;
	clonePaths?: string[];
	env?: Record<string, string>;
	createdAt: string;
	deleted?: boolean;
	labels?: Label[];
	customColumns?: CustomColumn[];
	// Ordered list of TaskStatus strings and custom column IDs; absent = default order
	columnOrder?: string[];
	// When true, completed work first moves through "AI Review" before "Your Review"
	autoReviewEnabled?: boolean;
	// When false, the "PR Review" column is hidden (default: true)
	peerReviewEnabled?: boolean;
	// Sparse checkout: when enabled, only specified directories are checked out in worktrees
	sparseCheckoutEnabled?: boolean;
	sparseCheckoutPaths?: string[];
	// Column agent configs for built-in columns (keyed by TaskStatus)
	builtinColumnAgents?: Record<string, ColumnAgentConfig>;
	// User-defined display names for built-in columns (keyed by TaskStatus)
	customStatusLabels?: Record<string, string>;
	// Number of ports to allocate per task/worktree (injected as DEV3_PORT0..N)
	portCount?: number;
	/**
	 * dev3's own throwaway repo, created by `createSandboxProject`. The guided tour
	 * recognises its board by this flag, so a tour cut short by a restart resumes
	 * instead of dropping the user back onto an empty board. Additive and ignored
	 * by older versions.
	 */
	sandbox?: boolean;
	/**
	 * Project kind. `"git"` (default when absent) is a normal repo-backed project
	 * with worktrees. `"virtual"` is an "Operations" board: tasks run in a managed
	 * temp dir (or a chosen folder) with NO git worktree, branch, diff, PR, or
	 * review columns. Virtual projects are stored in a separate
	 * `~/.dev3.0/virtual-projects.json` so older app versions stay forward-compatible.
	 */
	kind?: "git" | "virtual";
	/**
	 * Marks the single built-in "Operations" board. Pinned first, owns the ⌘0
	 * shortcut, and renders its name from a localized `t()` key while it still
	 * carries {@link BUILTIN_OPS_BOARD_NAME} — see {@link projectDisplayName}.
	 * Only ever set on virtual projects.
	 */
	builtin?: boolean;
	/**
	 * Marks a project the user must not show on camera. Inert on its own: every
	 * effect (masked name and tasks, blocked entry, silenced notifications) is
	 * gated on streamer mode being on. See PRODUCT_UX_BIBLE §10 + decision 197.
	 */
	sensitive?: boolean;
	/**
	 * Logins the usage-balanced "Auto" account choice must never pick for this
	 * project: managed account ids, or `system:<kind>` for a harness's own login.
	 * Machine-local (projects.json only) — account ids mean nothing on another box.
	 */
	autoAccountExclusions?: string[];
	/**
	 * Project-level override of the PR review preset's prompt. Absent/blank ⇒ the
	 * global setting, then the localized built-in. See resolvePresetPrompt.
	 */
	reviewModePrompt?: string;
	/**
	 * Project-level override of the Coordinator preset's prompt. Absent/blank ⇒
	 * the global setting, then the built-in. See resolvePresetPrompt.
	 */
	coordinatorPrompt?: string;
	/** Project override of {@link GlobalSettings.artifactTemplate}. Absent = follow the global setting. */
	artifactTemplate?: ArtifactTemplateMode;
	/** This project's own starter folder when its mode is `"custom"`. Absent = the global folder. */
	artifactTemplatePath?: string;
	/**
	 * When dev3 offered to import this project's outside-dev3 agent conversations
	 * on its own. Set once, whatever the answer was — the unprompted offer is
	 * spent, and every later import is one the user asked for. Absent means a
	 * project added before this existed, which is exactly who the offer is for.
	 */
	conversationImportOfferedAt?: string;
	/**
	 * When `false`, dev3 never reads `.dev3/config.json` or
	 * `.dev3/config.local.json` for this project — not from the checkout and not
	 * from a task worktree. Settings resolve from this record plus built-in
	 * defaults, and Project Settings saves land here instead of in a repo file.
	 *
	 * Deliberately NOT part of {@link Dev3RepoConfig}: a repository must not be
	 * able to grant itself back the trust the user withdrew. Absent means ON, so
	 * every existing project keeps today's behaviour. See {@link repoConfigEnabled}.
	 */
	useRepoConfig?: boolean;
}

/**
 * Whether dev3 may read this project's `.dev3/` config files at all.
 * Absent `useRepoConfig` means yes — the default that preserves the behaviour
 * every project had before the setting existed.
 */
export function repoConfigEnabled(project: Pick<Project, "useRepoConfig">): boolean {
	return project.useRepoConfig !== false;
}

/** `on` = the bundled dev3 template, `off` = free-form HTML, `custom` = the user's own starter folder. */
export type ArtifactTemplateMode = "on" | "off" | "custom";

export interface ResolvedArtifactTemplate {
	mode: ArtifactTemplateMode;
	/** Only for `custom`: the configured folder, or undefined for the default one. */
	path?: string;
}

/**
 * The artifact template in effect for a project: its override, then the global
 * setting, then on. A custom project without its own folder uses the global one.
 */
export function resolveArtifactTemplate(
	project: Pick<Project, "artifactTemplate" | "artifactTemplatePath">,
	settings: Pick<GlobalSettings, "artifactTemplate" | "artifactTemplatePath"> | null | undefined,
): ResolvedArtifactTemplate {
	const mode = project.artifactTemplate ?? settings?.artifactTemplate ?? "on";
	if (mode !== "custom") return { mode };
	const path = (project.artifactTemplate === "custom" ? project.artifactTemplatePath?.trim() : "") || settings?.artifactTemplatePath?.trim();
	return { mode, path: path || undefined };
}

/**
 * A task-type preset's prompt in effect: project override, then the global custom
 * one, then the built-in text. Blank at a layer means "not set", so a cleared
 * field falls through instead of injecting an empty prompt.
 */
export function resolvePresetPrompt(
	projectValue: string | undefined,
	globalValue: string | undefined,
	builtinDefault: string,
): string {
	const set = (value: string | undefined) => (value && value.trim() ? value : undefined);
	return set(projectValue) ?? set(globalValue) ?? builtinDefault;
}

/**
 * The preamble a task type puts above the user's own text: project override,
 * then app-wide setting, then the built-in default. One function so the create
 * flow and `dev3 task update --type` can never disagree about what a type means.
 */
export function presetPromptForTaskType(
	type: TaskType,
	project: Pick<Project, "coordinatorPrompt" | "reviewModePrompt">,
	settings: Pick<GlobalSettings, "coordinatorPrompt" | "reviewModePrompt"> | null | undefined,
): string {
	return type === "coordinator"
		? resolvePresetPrompt(project.coordinatorPrompt, settings?.coordinatorPrompt, COORDINATOR_PROMPT)
		: resolvePresetPrompt(project.reviewModePrompt, settings?.reviewModePrompt, DEFAULT_PR_REVIEW_PROMPT);
}

/** Where {@link presetPromptForTaskType} took its text from, so a reader can tell an override from the default. */
export type PresetPromptSource = "project" | "settings" | "built-in";

export function presetPromptSourceForTaskType(
	type: TaskType,
	project: Pick<Project, "coordinatorPrompt" | "reviewModePrompt">,
	settings: Pick<GlobalSettings, "coordinatorPrompt" | "reviewModePrompt"> | null | undefined,
): PresetPromptSource {
	const field = type === "coordinator" ? "coordinatorPrompt" : "reviewModePrompt";
	if (project[field]?.trim()) return "project";
	if (settings?.[field]?.trim()) return "settings";
	return "built-in";
}

/** Divider between a preset preamble and the user's own text in a description. */
export const PRESET_PROMPT_SEPARATOR = "\n\n---\n\n";

/** A description made of `prompt`, then the user's own text when there is any. */
/** Why a pull-request link could not be turned into a branch. */
export type PrResolveFailureReason =
	| "gh-missing"
	| "gh-auth"
	| "no-github-remote"
	| "foreign-repo"
	| "fork-fetch"
	| "not-found";

export function withPresetPrompt(userText: string, prompt: string): string {
	const own = userText.trim();
	return own ? prompt + PRESET_PROMPT_SEPARATOR + own : prompt;
}

/**
 * Inverse of {@link withPresetPrompt}, and a no-op when the preamble is not
 * there. It runs over a description a human has been editing freely, so it is
 * written to never cost a character of their text:
 *
 * - The separator is matched at exactly `prompt.length`, never by first
 *   occurrence, so a user's own `---` line cannot be taken for the boundary.
 * - A preamble edited by hand no longer matches, so nothing is removed at all —
 *   a stale copy left in place is recoverable, deleted words are not.
 * - A missing separator returns everything after the preamble rather than
 *   nothing, so deleting the `---` line and typing on does not erase the text.
 */
export function withoutPresetPrompt(description: string, prompt: string): string {
	if (!description.startsWith(prompt)) return description;
	const rest = description.slice(prompt.length);
	return rest.startsWith(PRESET_PROMPT_SEPARATOR) ? rest.slice(PRESET_PROMPT_SEPARATOR.length) : rest;
}

/**
 * True for the single hardcoded "Operations" board — the special, pinned virtual
 * project. Distinct from user-created virtual boards (which have `kind: "virtual"`
 * but `builtin` unset). Used for pin-first ordering, the ⌘0 shortcut, and the
 * special `[ Operations ]` / SYSTEM identity treatment.
 */
export function isBuiltinOpsProject(p: Pick<Project, "kind" | "builtin">): boolean {
	return p.builtin === true && p.kind === "virtual";
}

/** The name the built-in Operations board is seeded with, in every locale. */
export const BUILTIN_OPS_BOARD_NAME = "Operations";

/** Longest project name accepted by a rename; long enough for any real name. */
export const PROJECT_NAME_MAX_LENGTH = 120;

/**
 * A user-supplied project name, trimmed — or `null` when it is blank or over
 * the length cap. The UI and the RPC boundary both go through this so they can
 * never disagree about what a valid rename is.
 */
export function normalizeProjectName(raw: string): string | null {
	const name = raw.trim();
	if (!name || name.length > PROJECT_NAME_MAX_LENGTH) return null;
	return name;
}

/**
 * What to render as a project's name. The built-in Operations board shows the
 * localized `[ Operations ]` chrome only while it still carries its seeded
 * name; once renamed, the user's own name wins and the board keeps its pin,
 * its ⌘0 shortcut and its SYSTEM identity.
 */
export function projectDisplayName(p: Pick<Project, "kind" | "builtin" | "name">, opsBoardName: string): string {
	return isBuiltinOpsProject(p) && p.name === BUILTIN_OPS_BOARD_NAME ? opsBoardName : p.name;
}

/**
 * Display order for any project list (dashboard tiles, switcher dropdown): the
 * built-in Operations board is pinned first; all other projects keep their
 * existing relative order. Pure + stable.
 */
export function orderProjectsForDisplay<T extends Pick<Project, "kind" | "builtin">>(projects: T[]): T[] {
	const builtin = projects.filter(isBuiltinOpsProject);
	if (builtin.length === 0) return projects;
	return [...builtin, ...projects.filter((p) => !isBuiltinOpsProject(p))];
}
