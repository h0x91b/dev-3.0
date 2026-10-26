import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hookCliDialect, type HookCliDialect } from "../shared/dev3-cli-path";
import { symlinkOnWritePath } from "../shared/symlink-write-guard";
import { resolveUserHome } from "../shared/user-home";
import { atomicWriteFile } from "./atomic-write";
import { withFileLock } from "./file-lock";

type ObjectValue = Record<string, unknown>;
export interface CursorUsageHooksResult {
	status: "installed" | "removed" | "unchanged" | "skipped";
	path: string;
	reason?: "symlink" | "unreadable" | "unsupported" | "absent";
}

function object(value: unknown): ObjectValue | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
}

function managedHook(value: unknown): boolean {
	const command = object(value)?.command;
	if (typeof command !== "string") return false;
	const guarded = command.match(/^if \[ -x (.+) \]; then (.+) hook cursor-usage; fi$/)
		?? command.match(/^if \(Test-Path -LiteralPath (.+) -PathType Leaf\) \{ \$input \| & (.+) hook cursor-usage \}; exit 0$/);
	if (guarded) return guarded[1] === guarded[2] && dev3Executable(guarded[1]);
	const suffix = " hook cursor-usage";
	return command.endsWith(suffix) && dev3Executable(command.slice(0, -suffix.length));
}

function dev3Executable(command: string): boolean {
	const executable = command.replace(/^(["'])(.*)\1$/, "$2").replaceAll("\\", "/");
	return /^(dev3|dev3\.exe)$/.test(executable.split("/").pop() ?? "");
}

function hookCommand(dialect: HookCliDialect): string {
	return dialect.posixShell
		? `if [ -x ${dialect.cli} ]; then ${dialect.cli} hook cursor-usage; fi`
		: `if (Test-Path -LiteralPath ${dialect.cli} -PathType Leaf) { $input | & ${dialect.cli} hook cursor-usage }; exit 0`;
}

/** Install user-level accounting hooks without changing Cursor's lifecycle behavior. */
export async function writeCursorUsageHooks(
	home = resolveUserHome(),
	dialect: HookCliDialect = hookCliDialect(),
	options: { create?: boolean } = {},
): Promise<CursorUsageHooksResult> {
	return updateCursorUsageHooks(home, dialect, options.create ?? false);
}

/** Remove only dev3 accounting entries; leave the user's configuration file intact. */
export async function removeCursorUsageHooks(home = resolveUserHome()): Promise<CursorUsageHooksResult> {
	return updateCursorUsageHooks(home, undefined, false);
}

async function updateCursorUsageHooks(
	home: string,
	dialect: HookCliDialect | undefined,
	create: boolean,
): Promise<CursorUsageHooksResult> {
	const path = join(home, ".cursor", "hooks.json");
	const symlink = () => symlinkOnWritePath(home, path) || symlinkOnWritePath(home, `${path}.lock`);
	if (symlink()) return { status: "skipped", path, reason: "symlink" };
	try {
		if (!statSync(join(home, ".cursor")).isDirectory()) return { status: "skipped", path, reason: "unsupported" };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { status: "skipped", path, reason: "unreadable" };
		if (!create) return { status: "skipped", path, reason: "absent" };
	}
	return withFileLock<CursorUsageHooksResult>(path, async () => {
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
		for (const event of ["afterAgentResponse", "stop"]) {
			const existingEntries = (hooks[event] ?? []) as unknown[];
			const entries = existingEntries.filter((entry) => !managedHook(entry));
			removed ||= entries.length !== existingEntries.length;
			if (dialect) merged[event] = [...entries, { command: hookCommand(dialect) }];
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
