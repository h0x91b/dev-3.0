import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hookCliDialect, type HookCliDialect } from "../shared/dev3-cli-path";
import { symlinkOnWritePath } from "../shared/symlink-write-guard";
import { resolveUserHome } from "../shared/user-home";
import { atomicWriteFile } from "./atomic-write";
import { withFileLock } from "./file-lock";

type ObjectValue = Record<string, unknown>;
export interface CursorUsageHooksResult {
	status: "installed" | "unchanged" | "skipped";
	path: string;
	reason?: "symlink" | "unreadable" | "unsupported";
}

function object(value: unknown): ObjectValue | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
}

function managedHook(value: unknown): boolean {
	const command = object(value)?.command;
	const suffix = " hook cursor-usage";
	if (typeof command !== "string" || !command.endsWith(suffix)) return false;
	const executable = command.slice(0, -suffix.length).replace(/^(["'])(.*)\1$/, "$2").replaceAll("\\", "/");
	return /^(dev3|dev3\.exe)$/.test(executable.split("/").pop() ?? "");
}

/** Install user-level accounting hooks without changing Cursor's lifecycle behavior. */
export async function writeCursorUsageHooks(
	home = resolveUserHome(),
	dialect: HookCliDialect = hookCliDialect(),
): Promise<CursorUsageHooksResult> {
	const path = join(home, ".cursor", "hooks.json");
	const symlink = () => symlinkOnWritePath(home, path) || symlinkOnWritePath(home, `${path}.lock`);
	if (symlink()) return { status: "skipped", path, reason: "symlink" };
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
		for (const event of ["afterAgentResponse", "stop"]) {
			merged[event] = [
				...((hooks[event] ?? []) as unknown[]).filter((entry) => !managedHook(entry)),
				{ command: `${dialect.cli} hook cursor-usage` },
			];
		}
		const updated = `${JSON.stringify({ ...existing, version: 1, hooks: merged }, null, 2)}\n`;
		if (updated === original) return { status: "unchanged", path };
		await atomicWriteFile(path, updated);
		return { status: "installed", path };
	}, { timeout: 1_000, retries: 0 });
}
