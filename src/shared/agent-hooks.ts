/**
 * Hook-building logic shared between the backend (bun/) and CLI.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionMode, TaskStatus } from "./types";
import { CLI_EXIT_CODE_APP_NOT_RUNNING } from "./cli-exit-codes";
import { type HookCliDialect, hookCliDialect } from "./dev3-cli-path";

/** Dialect of the machine generating the hooks (the frozen POSIX string on macOS/Linux). */
const DEFAULT_DIALECT = hookCliDialect();

export const DEV3_CLI = DEFAULT_DIALECT.cli;
export const CODEX_STOP_HOOK_FLAG = "--codex-stop-hook";
/** Makes the CLI exit 0 instead of `CLI_EXIT_CODE_APP_NOT_RUNNING`, still warning on stderr. */
export const TOLERATE_APP_OFFLINE_FLAG = "--tolerate-app-offline";
export const CODEX_STOP_HOOK_SUCCESS_JSON = "{}";
/**
 * The env var that tells a Codex hook it is running inside a dev3 task. dev3
 * injects it into every task pane (`buildAgentEnv`), so a Codex session the user
 * started themselves never has it.
 */
export const CODEX_HOOK_SESSION_ENV = "DEV3_TASK_ID";

/**
 * The command dev3 declares for every Codex status hook.
 *
 * Codex only reads hooks from sources that are visible in *every* session — the
 * user's `config.toml`, a project checkout, or session flags — and a linked
 * worktree's own `.codex/` is deliberately not one of them. So these entries sit
 * in `~/.codex/config.toml` and Codex fires them in unrelated workspaces too
 * (h0x91b/dev-3.0#1527). The env guard is what keeps that free: no dev3 process
 * is spawned at all unless the session is a dev3 task.
 *
 * It must exit 0 when it skips — a non-zero hook exit is a failure Codex reports
 * to the user, and exit 2 would block the tool call outright.
 *
 * POSIX goes through an explicit `sh -c` rather than relying on the caller's
 * shell: Codex runs hook commands through the session's own shell, which may be
 * zsh, bash or fish. Windows deliberately keeps the bare command — there the
 * same runner may be `cmd.exe /c` OR `powershell -Command` (Codex derives it
 * from the session shell), and no one guard expression is valid in both. A
 * broken guard would cost every Windows dev3 task its status moves, which is
 * worse than the leak it would close.
 */
export function codexHookCommand(dialect: HookCliDialect = DEFAULT_DIALECT): string {
	const run = `${dialect.cli} hook codex`;
	if (!dialect.posixShell) return run;
	return `sh -c '[ -z "$${CODEX_HOOK_SESSION_ENV}" ] || exec ${run}'`;
}

export const CODEX_DEV3_HOOK_COMMAND = codexHookCommand();

/**
 * The GitHub Copilot CLI lifecycle events dev3 subscribes to, each paired with
 * the generic status event it stands for.
 *
 * `permissionRequest` is deliberately absent. Verified on copilot 1.0.83: it
 * fires on every permission evaluation, including the ones `--allow-all-tools`
 * approves without ever showing the user anything — so treating it as
 * "waiting for a human" would park a working task in Has Questions on its first
 * tool call. Asking the human is a *tool* in Copilot, not an event, so that
 * signal is read off `preToolUse` instead — see `copilotStatusEvent`.
 */
export const COPILOT_STATUS_HOOK_EVENTS = {
	sessionStart: "SessionStart",
	userPromptSubmitted: "UserPromptSubmit",
	preToolUse: "PreToolUse",
	postToolUse: "PostToolUse",
	agentStop: "Stop",
} as const satisfies Record<string, AgentStatusHookEvent>;

export type CopilotStatusHookEvent = keyof typeof COPILOT_STATUS_HOOK_EVENTS;

/**
 * The tool Copilot calls to put a question to the human and wait for the answer
 * — its `AskUserQuestion`. `--no-ask-user` turns it off by this exact name.
 */
export const COPILOT_ASK_USER_TOOL = "ask_user";

/**
 * The generic status event one Copilot hook delivery stands for.
 *
 * `preToolUse` normally means "working", but the tool about to run may be the
 * one that blocks on the human: `ask_user` does not return until they answer, so
 * that delivery is the task's only "waiting for you" signal. The matching
 * `postToolUse` carries the answer and moves it back to working on its own.
 */
export function copilotStatusEvent(
	event: string,
	toolName?: string,
): AgentStatusHookEvent | undefined {
	if (event === "preToolUse" && toolName === COPILOT_ASK_USER_TOOL) return "PermissionRequest";
	return COPILOT_STATUS_HOOK_EVENTS[event as CopilotStatusHookEvent];
}

/**
 * Where the Copilot CLI reads this machine's user-level hooks from. Verified
 * against copilot 1.0.83: a `<home>/hooks/*.json` file fires, while the
 * documented repository-level `.github/hooks/` was never even consulted in a
 * fresh checkout — so dev3 installs here and nowhere else.
 */
export const COPILOT_SETTINGS_FILE = "settings.json";

/**
 * Copilot's own state file, which is where folder trust actually lives.
 *
 * Verified on copilot 1.0.83 with one variable changed at a time: the same
 * worktree listed in `settings.json` still opens on "Confirm folder trust",
 * and listed in `config.json` opens straight into the session. It also holds
 * the signed-in account, so dev3 only ever merges into it — see
 * `updateCopilotConfig`.
 */
export const COPILOT_CONFIG_FILE = "config.json";

/**
 * The command dev3 declares for one Copilot status hook.
 *
 * Copilot has no worktree-scoped hook source either, so like Codex these live in
 * the user's own config dir and fire in unrelated repos too. The same
 * `DEV3_TASK_ID` guard keeps that free: outside a dev3 pane nothing is spawned.
 * The guard exits 0 and prints nothing, which Copilot reads as "no opinion" —
 * any other exit code on `preToolUse` is fail-closed and would block the tool.
 *
 * Copilot picks the `bash` or `powershell` entry by platform itself, so unlike
 * Codex there is no shell ambiguity to work around; this file is machine-local,
 * so only the local dialect is ever emitted.
 */
export function copilotHookCommand(
	event: CopilotStatusHookEvent,
	dialect: HookCliDialect = DEFAULT_DIALECT,
): { bash: string } | { powershell: string } {
	const run = `${dialect.cli} hook copilot ${event}`;
	if (dialect.posixShell) {
		return { bash: `[ -z "$${CODEX_HOOK_SESSION_ENV}" ] || exec ${run}` };
	}
	return { powershell: `if ($env:${CODEX_HOOK_SESSION_ENV}) { & ${run} }; exit 0` };
}

/** dev3's Copilot hook entries, keyed by event. */
export function buildCopilotHooks(
	dialect: HookCliDialect = DEFAULT_DIALECT,
): Record<string, unknown[]> {
	const hooks: Record<string, unknown[]> = {};
	for (const event of Object.keys(COPILOT_STATUS_HOOK_EVENTS) as CopilotStatusHookEvent[]) {
		hooks[event] = [{ type: "command", ...copilotHookCommand(event, dialect), timeoutSec: 5 }];
	}
	return hooks;
}

/** Whether a Copilot hook entry is one dev3 wrote (it names the dev3 CLI in
 *  whichever shell key this platform uses). */
function isDev3CopilotEntry(entry: unknown): boolean {
	const record = asRecord(entry);
	return mentionsDev3Cli(record.bash as string | undefined)
		|| mentionsDev3Cli(record.powershell as string | undefined);
}

/**
 * Merge dev3's hooks into a Copilot `settings.json` object, replacing whatever
 * dev3 wrote before and leaving every other entry — a colleague's, a plugin's —
 * exactly where it was. Idempotent.
 *
 * Inline in `settings.json` rather than a `hooks/dev3.json` of our own, even
 * though a private file would be tidier: `~/.copilot/hooks/` can belong to root.
 * A managed machine's MDM creates it to drop a policy hook in, and every later
 * write by the user's own processes fails with EACCES — which is exactly how
 * this shipped first, with the board silently never following a Copilot task.
 * `settings.json` sits in the Copilot home itself, which Copilot maintains as
 * the user, so it is writable wherever Copilot runs at all.
 */
export function mergeCopilotHooks(
	existing: Record<string, unknown>,
	dialect: HookCliDialect = DEFAULT_DIALECT,
): Record<string, unknown> {
	const settings = asRecord(existing);
	const merged: Record<string, unknown> = { ...asRecord(settings.hooks) };

	for (const [event, entries] of Object.entries(buildCopilotHooks(dialect))) {
		const current = merged[event];
		const kept = Array.isArray(current) ? current.filter((e) => !isDev3CopilotEntry(e)) : [];
		merged[event] = [...kept, ...entries];
	}

	return { ...settings, hooks: merged };
}

/**
 * Add a worktree to Copilot's `trustedFolders`, so the agent does not open on
 * "Confirm folder trust" in a pane nobody is watching. Idempotent; never removes
 * a folder the user trusted themselves.
 */
export function ensureCopilotTrustedFolder(
	existing: Record<string, unknown>,
	resolvedPath: string,
): Record<string, unknown> {
	const config = asRecord(existing);
	const current = Array.isArray(config.trustedFolders) ? config.trustedFolders : [];
	if (current.includes(resolvedPath)) return config;
	return { ...config, trustedFolders: [...current, resolvedPath] };
}

/**
 * Where Copilot remembers "Yes, and don't ask again for `<command>` in this
 * repo". Keyed by the repository's main working tree — dev3 worktrees of the
 * same project share one entry, which is what Copilot itself writes when the
 * user approves from inside a worktree.
 */
export const COPILOT_PERMISSIONS_FILE = "permissions-config.json";

/**
 * Pre-approve the dev3 CLI for one repository, so a task agent is not stopped by
 * "Do you want to run this command?" on the status move its own protocol told it
 * to make. Same intent as `DEV3_BASH_PERMISSION` for Claude. Idempotent, and it
 * only ever adds: an approval the user granted themselves is never dropped.
 */
export function ensureCopilotCommandApproval(
	existing: Record<string, unknown>,
	repoPath: string,
	command: string = DEV3_CLI,
): Record<string, unknown> {
	const config = asRecord(existing);
	const locations = asRecord(config.locations);
	const location = asRecord(locations[repoPath]);
	const approvals = Array.isArray(location.tool_approvals) ? location.tool_approvals : [];

	const commands = approvals.find(
		(entry) => asRecord(entry).kind === "commands",
	) as Record<string, unknown> | undefined;
	const identifiers = Array.isArray(commands?.commandIdentifiers) ? commands.commandIdentifiers : [];
	if (identifiers.includes(command)) return config;

	const updated = { kind: "commands", commandIdentifiers: [...identifiers, command] };
	return {
		...config,
		locations: {
			...locations,
			[repoPath]: {
				...location,
				tool_approvals: [...approvals.filter((e) => asRecord(e).kind !== "commands"), updated],
			},
		},
	};
}

/** `config.json` opens with `//` lines Copilot rewrites back every run; they are
 *  carried through verbatim so dev3's edit does not strip them. */
function splitConfigHeader(raw: string): { header: string; body: string } {
	const header = /^(?:[ \t]*\/\/[^\n]*\n)*/.exec(raw)?.[0] ?? "";
	return { header, body: raw.slice(header.length) };
}

/**
 * Read → merge → write Copilot's `config.json`, skipping an identical write.
 *
 * This file is Copilot's own, and it carries the signed-in account. An existing
 * file dev3 cannot parse is therefore left completely alone: a missing trust
 * entry costs one dialog, a clobbered `loggedInUsers` costs the login.
 */
export function updateCopilotConfig(
	copilotHome: string,
	update: (config: Record<string, unknown>) => Record<string, unknown>,
): boolean {
	const path = join(copilotHome, COPILOT_CONFIG_FILE);
	let header = "";
	let previous: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const split = splitConfigHeader(readFileSync(path, "utf-8").replace(/^﻿/, ""));
			header = split.header;
			previous = asRecord(JSON.parse(split.body));
		} catch {
			return false;
		}
	}
	const updated = update(previous);
	if (JSON.stringify(updated) === JSON.stringify(previous)) return false;
	mkdirSync(copilotHome, { recursive: true });
	writeFileSync(path, header + JSON.stringify(updated, null, 2) + "\n", "utf-8");
	return true;
}

/** Read → merge → write one of Copilot's plain-JSON files, skipping an identical
 *  write. `config.json` is not one of them — it has a comment header and the
 *  login, so it goes through `updateCopilotConfig`. */
function updateCopilotJsonFile(
	copilotHome: string,
	file: string,
	update: (contents: Record<string, unknown>) => Record<string, unknown>,
): boolean {
	mkdirSync(copilotHome, { recursive: true });
	const path = join(copilotHome, file);
	const previous = readSettingsFile(path);
	return writeIfChanged(path, update(previous), previous);
}

export function updateCopilotSettings(
	copilotHome: string,
	update: (settings: Record<string, unknown>) => Record<string, unknown>,
): boolean {
	return updateCopilotJsonFile(copilotHome, COPILOT_SETTINGS_FILE, update);
}

export function updateCopilotPermissions(
	copilotHome: string,
	update: (permissions: Record<string, unknown>) => Record<string, unknown>,
): boolean {
	return updateCopilotJsonFile(copilotHome, COPILOT_PERMISSIONS_FILE, update);
}

/** Install dev3's Copilot status hooks for this machine. */
export function writeCopilotHooks(copilotHome: string): boolean {
	return updateCopilotSettings(copilotHome, (settings) => mergeCopilotHooks(settings));
}
export const CLAUDE_STOP_FAILURE_HOOK_SUBCOMMAND = "hook claude-stop-failure";
/**
 * Reads the submitted prompt off stdin so agent traffic can show the human who
 * started a turn. A SECOND entry beside the status move rather than a rewrite of
 * it: every task's board status depends on that command, and folding a new job
 * into it would put recording and status sync in one blast radius.
 */
export const CLAUDE_PROMPT_HOOK_SUBCOMMAND = "hook claude-prompt";
/**
 * The lifecycle events dev3 turns into board status moves. Codex emits these
 * names verbatim; Copilot's adapter maps its own camelCase names onto them, so
 * one status machine serves both instead of a second copy per harness.
 */
export const AGENT_STATUS_HOOK_EVENTS = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PermissionRequest",
	"PostToolUse",
	"Stop",
	"Interrupt",
	"SessionEnd",
] as const;
export type AgentStatusHookEvent = typeof AGENT_STATUS_HOOK_EVENTS[number];

export function getAgentHookTargetStatus(
	event: AgentStatusHookEvent,
	currentStatus: TaskStatus,
	autoReviewEnabled: boolean,
	resumeStatus?: "in-progress" | "review-by-ai",
): TaskStatus | null {
	if (currentStatus === "completed" || currentStatus === "cancelled") return null;

	switch (event) {
		// Starting a session is not working: a scratch task launches parked in
		// user-questions with no prompt, and only a real prompt may claim it.
		case "SessionStart":
			if (currentStatus === "user-questions") return resumeStatus ?? null;
			return currentStatus === "review-by-ai" ? null : "in-progress";
		case "UserPromptSubmit":
		case "PreToolUse":
		case "PostToolUse":
			if (currentStatus === "user-questions" && resumeStatus) return resumeStatus;
			return currentStatus === "review-by-ai" ? null : "in-progress";
		case "PermissionRequest":
			return "user-questions";
		case "Interrupt":
		case "SessionEnd":
			return null;
		case "Stop":
			if (currentStatus === "in-progress") {
				return autoReviewEnabled ? "review-by-ai" : "review-by-user";
			}
			if (currentStatus === "review-by-ai") return "review-by-user";
			return null;
	}
}

export interface HookEntry {
	type: string;
	command: string;
	timeout?: number;
	timeoutSec?: number;
	statusMessage?: string;
}

/**
 * Build the Claude Code hooks object for a given task.
 *
 * Unified hooks that work for both the primary agent and the review agent
 * running in the same worktree (they share .claude/settings.local.json).
 *
 * - UserPromptSubmit/PreToolUse/PostToolUse: → in-progress (skipped when in review-by-ai)
 * - PermissionRequest: → user-questions
 * - Stop: primary agent → stopTarget; review agent → review-by-user
 * - StopFailure: → user-questions (fires INSTEAD of Stop on an API error)
 */
export interface MatcherGroup {
	matcher?: string;
	hooks: HookEntry[];
}

type HookMap = Record<string, MatcherGroup[]>;

function buildMoveCommand(
	status: string,
	extra?: string,
	options?: { codexStopHook?: boolean },
	dialect: HookCliDialect = DEFAULT_DIALECT,
): string {
	const parts = [`${dialect.cli} task move --status ${status}`];
	if (extra) parts.push(extra);
	if (options?.codexStopHook) parts.push(CODEX_STOP_HOOK_FLAG);
	return parts.join(" ");
}

// Status-move hooks must not hard-fail when the desktop app is down. The CLI
// exits `CLI_EXIT_CODE_APP_NOT_RUNNING` (2) in that case — but exit code 2 is
// ALSO how both Claude Code and Codex signal a *blocking* hook error (Claude:
// blocks the tool call / erases the prompt / blocks Stop; Codex: blocks prompt
// and tool execution). So a closed app would otherwise wedge the agent on every
// PreToolUse/PostToolUse/UserPromptSubmit/Stop. This guard collapses ONLY the app-offline
// exit code into success; any other failure still propagates. It is deliberately
// selective rather than `|| true`, which would mask real regressions (see
// decisions 032 and 089). The CLI still prints its "app not running" notice to
// stderr, so the warning survives — we just don't let it block the agent.
//
// Windows agents run hook commands without a POSIX shell, so there is no `$?`
// and no `||` to lean on. The same tolerance is requested from the CLI itself
// with `--tolerate-app-offline`, which exits 0 for that single condition and
// leaves every other failure code intact.
function withAppOfflineTolerance(command: string, dialect: HookCliDialect): string {
	if (!dialect.posixShell) return `${command} ${TOLERATE_APP_OFFLINE_FLAG}`;
	return `${command} || [ $? -eq ${CLI_EXIT_CODE_APP_NOT_RUNNING} ]`;
}

function buildStopGroups(
	stopTarget: TaskStatus,
	dialect: HookCliDialect,
): MatcherGroup[] {
	const move = (status: string, extra?: string) =>
		withAppOfflineTolerance(buildMoveCommand(status, extra, undefined, dialect), dialect);

	const stopGroups: MatcherGroup[] = [
		{
			hooks: [{ type: "command", command: move(stopTarget, "--if-status in-progress") }],
		},
	];

	if (stopTarget !== "review-by-user") {
		stopGroups.push({
			hooks: [{ type: "command", command: move("review-by-user", "--if-status review-by-ai") }],
		});
	}

	return stopGroups;
}

/**
 * A settings file is hand-edited and also rewritten by the agent itself, so any
 * slot can hold a shape we don't expect. Spreading a string or an array here
 * would inject numeric keys into the user's settings, and calling `.filter` on a
 * non-array would throw — and the caller swallows that, launching the agent with
 * no hooks at all. Anything that is not a plain object is treated as absent.
 */
function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function mergeHookMaps(
	existing: Record<string, unknown>,
	newHooks: HookMap,
): Record<string, unknown> {
	const settings = asRecord(existing);
	const merged: HookMap = { ...asRecord(settings.hooks) } as HookMap;

	for (const [event, groups] of Object.entries(newHooks)) {
		const current = merged[event];
		const filtered = Array.isArray(current) ? current.filter((g) => !isDev3Entry(g)) : [];
		merged[event] = [...filtered, ...groups];
	}

	return { ...settings, hooks: merged };
}

export function buildClaudeHooks(
	options?: { stopTarget?: TaskStatus; dialect?: HookCliDialect },
): HookMap {
	const stopTarget: TaskStatus = options?.stopTarget ?? "review-by-user";
	const dialect = options?.dialect ?? DEFAULT_DIALECT;
	const move = (status: string, extra?: string) =>
		withAppOfflineTolerance(buildMoveCommand(status, extra, undefined, dialect), dialect);

	// Working hook: move to in-progress, but NOT when in review-by-ai
	// (the review agent shares the same hooks file and must not flip status).
	// review-by-user is intentionally allowed: when the user leaves feedback
	// and the primary agent resumes, UserPromptSubmit should move the task back.
	// PostToolUse also covers answers submitted to AskUserQuestion, which resume
	// an existing tool call without emitting a new user prompt event.
	const workingCmd = move("in-progress", "--if-status-not review-by-ai");

	return {
		UserPromptSubmit: [
			{ hooks: [{ type: "command", command: workingCmd }] },
			{
				hooks: [{
					type: "command",
					command: `${dialect.cli} ${CLAUDE_PROMPT_HOOK_SUBCOMMAND}`,
					timeout: 5,
				}],
			},
		],
		PreToolUse: [
			{ hooks: [{ type: "command", command: workingCmd }] },
		],
		PostToolUse: [
			{ hooks: [{ type: "command", command: workingCmd }] },
		],
		PermissionRequest: [
			{ hooks: [{ type: "command", command: move("user-questions") }] },
		],
		Stop: buildStopGroups(stopTarget, dialect),
		// No matcher: every API error that killed the turn leaves the agent idle at
		// its prompt, so all of them belong in front of the user. The handler owns
		// the app-offline case and always exits 0 — Claude ignores its exit code
		// anyway, StopFailure being fire-and-forget.
		StopFailure: [
			{ hooks: [{ type: "command", command: `${dialect.cli} ${CLAUDE_STOP_FAILURE_HOOK_SUBCOMMAND}`, timeout: 5 }] },
		],
	};
}

/**
 * Build the Codex hooks object for a given task.
 *
 * All entries call one stable handler from a worktree-local hooks file. The
 * handler receives the event JSON on stdin and asks dev3 to perform the status
 * transition atomically.
 *
 * `dev3 hook codex` always exits 0 (it owns the app-offline case internally), so
 * these commands need neither a shell fallback nor `--tolerate-app-offline`.
 */
export function buildCodexHooks(options?: { dialect?: HookCliDialect }): HookMap {
	const dialect = options?.dialect ?? DEFAULT_DIALECT;
	const handler: HookEntry = {
		type: "command",
		command: codexHookCommand(dialect),
		timeout: 5,
	};
	const toolMatcher = "Bash|Edit|Write|^apply_patch$|^mcp__.*|^(functions\\.)?request_user_input(_async)?$";

	return {
		SessionStart: [
			{
				matcher: "startup|resume",
				hooks: [handler],
			},
		],
		UserPromptSubmit: [
			{ hooks: [handler] },
		],
		PreToolUse: [
			{
				matcher: toolMatcher,
				hooks: [handler],
			},
		],
		PermissionRequest: [
			{
				matcher: toolMatcher,
				hooks: [handler],
			},
		],
		PostToolUse: [
			{
				matcher: toolMatcher,
				hooks: [handler],
			},
		],
		Stop: [{ hooks: [handler] }],
		Interrupt: [{ hooks: [{ ...handler, timeout: 3 }] }],
		SessionEnd: [{ hooks: [{ ...handler, timeout: 3 }] }],
	};
}

/**
 * Merge dev3 hooks into an existing settings.local.json object.
 * Preserves any existing hooks for other events, and any non-dev3 hooks
 * on the same events.  Idempotent: replaces previous dev3 hooks.
 */
/**
 * Recognize our own hook commands. A settings file can carry entries written by
 * a different platform's dev3 (a repo checked out on both), so the POSIX spelling
 * is always accepted alongside this platform's.
 */
export function mentionsDev3Cli(command?: string): boolean {
	if (typeof command !== "string" || !command) return false;
	// Trailing space so the last token gets the same boundary as the others.
	const normalized = `${normalizeCliMention(command)} `;
	return normalized.includes("/dev3 ") || normalized.includes("/dev3.exe ");
}

/**
 * Recognize the CLI however it was spelled when the entry was written: quoted or
 * bare, backslashes or forward slashes, `~/.dev3.0/bin/dev3`, a per-user
 * `dev3.exe`, or a bundle-relative one — a repo checked out on two platforms, or
 * an older build, leaves any of those behind. Matching only the current spelling
 * would stop replacing them, and the refreshed hooks would pile up next to the
 * broken ones.
 */
function normalizeCliMention(text: string): string {
	return text.replaceAll("\\", "/").replaceAll('"', "").toLowerCase();
}

/** Check if a matcher group (or legacy flat entry) contains a dev3 hook. */
function isDev3Entry(group: MatcherGroup | HookEntry): boolean {
	const entry = asRecord(group);
	// New format: matcher group with nested hooks array
	if (Array.isArray(entry.hooks)) {
		return entry.hooks.some((h) => mentionsDev3Cli(asRecord(h).command as string | undefined));
	}
	// Legacy flat format: { type, command } at top level
	return mentionsDev3Cli(entry.command as string | undefined);
}

export const DEV3_BASH_PERMISSION = "Bash(dev3:*)";

/**
 * Claude Code matches a Bash rule against the literal command text, so one rule
 * per spelling the agent may type. The bare `dev3` covers what the protocol asks
 * for; the dialect spelling covers the `~/.dev3.0/bin/dev3` (or absolute
 * `dev3.exe`) form our own generated skills and hooks put in front of the agent.
 * The worktree file has to carry both on its own — `~/.claude/settings.json`
 * holds only the dialect one, and a session can run with that file missing.
 */
export function dev3BashPermissions(dialect: HookCliDialect = DEFAULT_DIALECT): string[] {
	const dialectRule = `Bash(${dialect.cli} *)`;
	return dialectRule === `Bash(dev3 *)` ? [DEV3_BASH_PERMISSION] : [DEV3_BASH_PERMISSION, dialectRule];
}

/**
 * Write `permissions.defaultMode` into a settings object. Idempotent.
 *
 * The `--permission-mode` CLI flag only governs the *lead* Claude session.
 * Teammates spawned via the experimental agent-teams feature
 * (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 + the TeamCreate tool) take their
 * starting mode from the worktree's settings files, NOT from the lead's CLI
 * flag — so without a settings-file baseline they fall back to "default" and
 * prompt "Waiting for tool approval" on every tool call. Writing defaultMode
 * into .claude/settings.local.json gives the lead AND every teammate the same
 * auto-approve baseline. dev3's PermissionMode values map 1:1 to the modes
 * Claude Code accepts here, so we write them through verbatim. See
 * decision 085.
 */
export function ensureDefaultMode(
	settings: Record<string, unknown>,
	mode: PermissionMode,
): Record<string, unknown> {
	const base = asRecord(settings);
	return { ...base, permissions: { ...asRecord(base.permissions), defaultMode: mode } };
}

export function mergeClaudeHooks(
	existing: Record<string, unknown>,
	options?: { stopTarget?: TaskStatus; dialect?: HookCliDialect },
): Record<string, unknown> {
	return mergeHookMaps(existing, buildClaudeHooks(options));
}

export function mergeCodexHooks(
	existing: Record<string, unknown>,
	options?: { dialect?: HookCliDialect },
): Record<string, unknown> {
	return mergeHookMaps(existing, buildCodexHooks(options));
}

/**
 * Add the dev3 CLI bash rules to permissions.allow in a settings object.
 * Idempotent.
 */
export function ensureDevPermission(
	settings: Record<string, unknown>,
	dialect: HookCliDialect = DEFAULT_DIALECT,
): Record<string, unknown> {
	const base = asRecord(settings);
	const permissions = asRecord(base.permissions);
	const allow = Array.isArray(permissions.allow) ? [...permissions.allow as string[]] : [];
	for (const rule of dev3BashPermissions(dialect)) {
		if (!allow.includes(rule)) allow.push(rule);
	}
	return { ...base, permissions: { ...permissions, allow } };
}

/**
 * Resolve which .claude/settings file to write the dev3 permission to:
 * 1. settings.local.json exists → use it
 * 2. settings.json exists → use it
 * 3. neither → create settings.local.json
 */
function resolvePermissionSettingsPath(claudeDir: string): string {
	const localPath = join(claudeDir, "settings.local.json");
	const sharedPath = join(claudeDir, "settings.json");

	if (existsSync(localPath)) return localPath;
	if (existsSync(sharedPath)) return sharedPath;
	return localPath;
}

/**
 * Read a settings file, tolerating what editors and other tools leave behind: a
 * missing file, a UTF-8 byte-order mark, or content that parses but is not an
 * object. Unreadable content yields `{}`, which the callers then overwrite.
 */
function readSettingsFile(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		return asRecord(JSON.parse(readFileSync(path, "utf-8").replace(/^﻿/, "")));
	} catch {
		return {};
	}
}

/**
 * Read .claude/settings.local.json, merge dev3 hooks, write back.
 * Also ensures Bash(dev3:*) permission in the appropriate settings file.
 * Creates the .claude/ directory if it doesn't exist.
 *
 * Returns whether anything was actually written. Callers that re-assert the
 * hooks periodically (see `agent-hooks-refresh.ts`) lean on the no-write path:
 * Claude Code holds this file open, so rewriting identical bytes would churn its
 * mtime on every prompt for nothing.
 */
export function writeClaudeHooks(
	worktreePath: string,
	options?: { stopTarget?: TaskStatus; permissionMode?: PermissionMode },
): boolean {
	const claudeDir = join(worktreePath, ".claude");
	mkdirSync(claudeDir, { recursive: true });

	const hooksPath = join(claudeDir, "settings.local.json");
	const permPath = resolvePermissionSettingsPath(claudeDir);
	const sameFile = permPath === hooksPath;

	// Read the hooks target (always settings.local.json)
	const hooksSettings = readSettingsFile(hooksPath);

	let updatedHooks = mergeClaudeHooks(hooksSettings, options);

	// defaultMode always lives in settings.local.json (local scope, gitignored)
	// so it never leaks into a committed settings.json. "default" is Claude's
	// baseline — writing it would be a no-op, so we skip it.
	if (options?.permissionMode && options.permissionMode !== "default") {
		updatedHooks = ensureDefaultMode(updatedHooks, options.permissionMode);
	}

	if (sameFile) {
		// Permission goes into the same file — apply on top of merged hooks
		updatedHooks = ensureDevPermission(updatedHooks);
		return writeIfChanged(hooksPath, updatedHooks, hooksSettings);
	}

	// Hooks and permission go to different files
	const hooksWritten = writeIfChanged(hooksPath, updatedHooks, hooksSettings);

	const permSettings = readSettingsFile(permPath);
	const permWritten = writeIfChanged(permPath, ensureDevPermission(permSettings), permSettings);
	return hooksWritten || permWritten;
}

/**
 * Serialize and write only when the result differs from what was read. The
 * comparison is on the parsed shapes, so reformatting alone never triggers a
 * write — but a file we could not parse always does, since `readSettingsFile`
 * reports it as `{}`.
 */
function writeIfChanged(
	path: string,
	updated: Record<string, unknown>,
	previous: Record<string, unknown>,
): boolean {
	const serialized = JSON.stringify(updated, null, 2) + "\n";
	if (existsSync(path) && JSON.stringify(previous) === JSON.stringify(updated)) return false;
	writeFileSync(path, serialized, "utf-8");
	return true;
}

/**
 * Read the generated worktree-local .codex/hooks.json, merge dev3 hooks, and
 * write it back. The file is gitignored and disappears with the worktree.
 */
export function writeCodexHooks(worktreePath: string): void {
	const codexDir = join(worktreePath, ".codex");
	mkdirSync(codexDir, { recursive: true });

	const hooksPath = join(codexDir, "hooks.json");

	// This is generated, gitignored worktree state. Corruption is replaced rather
	// than blocking every future Codex launch in this task.
	const settings = readSettingsFile(hooksPath);

	const updated = mergeCodexHooks(settings);
	if (JSON.stringify(updated) === JSON.stringify(settings)) return;
	writeFileSync(hooksPath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
}
