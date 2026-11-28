import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CURSOR_STATUS_HOOK_EVENTS, type CursorStatusHookEvent } from "../shared/agent-hooks";
import { hookCliDialect, type HookCliDialect } from "../shared/dev3-cli-path";
import { symlinkOnWritePath } from "../shared/symlink-write-guard";
import { resolveUserHome } from "../shared/user-home";
import { atomicWriteFile } from "./atomic-write";
import { withFileLock } from "./file-lock";

type ObjectValue = Record<string, unknown>;
export interface CursorHooksResult {
	status: "installed" | "removed" | "unchanged" | "skipped";
	path: string;
	reason?: "symlink" | "unreadable" | "unsupported" | "absent";
}

const USAGE_EVENTS = ["afterAgentResponse", "stop"] as const;
const STATUS_EVENTS = Object.keys(CURSOR_STATUS_HOOK_EVENTS) as CursorStatusHookEvent[];
const MANAGED_EVENTS = [...new Set<string>([...USAGE_EVENTS, ...STATUS_EVENTS])];
/** Seconds; the status hook's own socket request gives up after ~3 s. */
const STATUS_HOOK_TIMEOUT = 10;

function object(value: unknown): ObjectValue | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
}

const MANAGED_COMMANDS: RegExp[] = [
	/^if \[ -x (.+) \]; then (.+) hook cursor-usage; fi$/,
	/^if \(Test-Path -LiteralPath (.+) -PathType Leaf\) \{ \$input \| & (.+) hook cursor-usage \}; exit 0$/,
	/^if \[ -n "\$DEV3_TASK_ID" \] && \[ -x (.+) \]; then (.+) hook cursor \w+; else printf '\{\}'; fi$/,
	/^if \(\$env:DEV3_TASK_ID -and \(Test-Path -LiteralPath (.+) -PathType Leaf\)\) \{ \$input \| & (.+) hook cursor \w+ \} else \{ '\{\}' \}; exit 0$/,
];

/** Whether an entry is one dev3 wrote: a guarded or legacy bare call of the dev3 CLI. */
function managedHook(value: unknown): boolean {
	const command = object(value)?.command;
	if (typeof command !== "string") return false;
	for (const pattern of MANAGED_COMMANDS) {
		const guarded = command.match(pattern);
		if (guarded) return guarded[1] === guarded[2] && dev3Executable(guarded[1]);
	}
	const bare = command.match(/^(.+) hook (?:cursor-usage|cursor \w+)$/);
	return bare !== null && dev3Executable(bare[1]);
}

function dev3Executable(command: string): boolean {
	const executable = command.replace(/^(["'])(.*)\1$/, "$2").replaceAll("\\", "/");
	return /^(dev3|dev3\.exe)$/.test(executable.split("/").pop() ?? "");
}

/** Accounting runs for every local Cursor session, as long as the dev3 CLI exists. */
function usageCommand(dialect: HookCliDialect): string {
	return dialect.posixShell
		? `if [ -x ${dialect.cli} ]; then ${dialect.cli} hook cursor-usage; fi`
		: `if (Test-Path -LiteralPath ${dialect.cli} -PathType Leaf) { $input | & ${dialect.cli} hook cursor-usage }; exit 0`;
}

/**
 * Status runs only inside a dev3 pane: Cursor hands the agent's own environment
 * to hook commands, so `DEV3_TASK_ID` decides it before any dev3 process starts.
 * Elsewhere the hook answers `{}` — Cursor's "no opinion" for every event.
 */
export function cursorStatusHookCommand(event: CursorStatusHookEvent, dialect: HookCliDialect): string {
	return dialect.posixShell
		? `if [ -n "$DEV3_TASK_ID" ] && [ -x ${dialect.cli} ]; then ${dialect.cli} hook cursor ${event}; else printf '{}'; fi`
		: `if ($env:DEV3_TASK_ID -and (Test-Path -LiteralPath ${dialect.cli} -PathType Leaf)) { $input | & ${dialect.cli} hook cursor ${event} } else { '{}' }; exit 0`;
}

/** dev3's entries for one Cursor event, in the order they are appended. */
function managedEntries(event: string, dialect: HookCliDialect): ObjectValue[] {
	const entries: ObjectValue[] = [];
	if ((STATUS_EVENTS as string[]).includes(event)) {
		entries.push({ command: cursorStatusHookCommand(event as CursorStatusHookEvent, dialect), timeout: STATUS_HOOK_TIMEOUT });
	}
	if ((USAGE_EVENTS as readonly string[]).includes(event)) entries.push({ command: usageCommand(dialect) });
	return entries;
}

/**
 * Merge dev3's user-level Cursor hooks — task-guarded status lifecycle plus
 * session accounting — into `~/.cursor/hooks.json`, replacing only entries dev3
 * wrote before. Cursor has no per-launch hook flag, and a project
 * `.cursor/hooks.json` would land in the user's repository, so user level it is.
 */
export async function writeCursorHooks(
	home = resolveUserHome(),
	dialect: HookCliDialect = hookCliDialect(),
	options: { create?: boolean } = {},
): Promise<CursorHooksResult> {
	return updateCursorHooks(home, dialect, options.create ?? false);
}

/** Remove only dev3's entries; leave the user's configuration file intact. */
export async function removeCursorHooks(home = resolveUserHome()): Promise<CursorHooksResult> {
	return updateCursorHooks(home, undefined, false);
}

async function updateCursorHooks(
	home: string,
	dialect: HookCliDialect | undefined,
	create: boolean,
): Promise<CursorHooksResult> {
	const path = join(home, ".cursor", "hooks.json");
	const symlink = () => symlinkOnWritePath(home, path) || symlinkOnWritePath(home, `${path}.lock`);
	if (symlink()) return { status: "skipped", path, reason: "symlink" };
	try {
		if (!statSync(join(home, ".cursor")).isDirectory()) return { status: "skipped", path, reason: "unsupported" };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { status: "skipped", path, reason: "unreadable" };
		if (!create) return { status: "skipped", path, reason: "absent" };
	}
	return withFileLock<CursorHooksResult>(path, async () => {
		if (symlink()) return { status: "skipped", path, reason: "symlink" };
		let existing: ObjectValue = {};
		let original = "";
		try {
			original = readFileSync(path, "utf8");
			const parsed = object(JSON.parse(original));
			if (!parsed) return { status: "skipped", path, reason: "unsupported" };
			existing = parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				return { status: "skipped", path, reason: error instanceof SyntaxError ? "unsupported" : "unreadable" };
			}
		}
		const hooks = existing.hooks === undefined ? {} : object(existing.hooks);
		if (existing.version !== undefined && existing.version !== 1 || !hooks ||
			Object.values(hooks).some((entries) => !Array.isArray(entries) || entries.some((entry) => !object(entry)))) {
			return { status: "skipped", path, reason: "unsupported" };
		}
		const merged = { ...hooks };
		let removed = false;
		for (const event of MANAGED_EVENTS) {
			const existingEntries = (hooks[event] ?? []) as unknown[];
			const entries = existingEntries.filter((entry) => !managedHook(entry));
			removed ||= entries.length !== existingEntries.length;
			if (dialect) merged[event] = [...entries, ...managedEntries(event, dialect)];
			else if (entries.length) merged[event] = entries;
			else delete merged[event];
		}
		if (!dialect && !removed) return { status: "unchanged", path };
		const updated = `${JSON.stringify({ ...existing, version: 1, hooks: merged }, null, 2)}\n`;
		if (updated === original) return { status: "unchanged", path };
		await atomicWriteFile(path, updated);
		return { status: dialect ? "installed" : "removed", path };
	}, { timeout: 1_000, retries: 0 });
}
