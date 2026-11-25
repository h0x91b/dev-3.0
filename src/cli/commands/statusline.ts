/**
 * `dev3 statusline` — internal statusLine wrapper for Claude Code sessions
 * launched by dev-3.0.
 *
 * The app injects `--settings <file>` into every Claude launch, where the file
 * sets `statusLine.command` to this command. Claude Code then pipes its
 * statusLine JSON (which includes `rate_limits` since v1.2.80) to us on every
 * refresh. We:
 *   1. dump the payload to ~/.dev3.0/data/rate-limits/claude.json (the app's
 *      rate-limit monitor reads it from there — no API calls anywhere), and
 *      inside a dev3 task also to rate-limits/sessions/<taskId>.json;
 *   2. DELEGATE to the user's original statusLine command (resolved from the
 *      normal settings precedence: worktree settings.local.json → project
 *      settings.json → user settings.json in $CLAUDE_CONFIG_DIR or ~/.claude), so injection never destroys
 *      an existing custom statusLine;
 *   3. append a compact usage segment (% used + time-to-reset per window,
 *      yellow ≥80%, red ≥95%).
 *
 * Never fails: any error degrades to printing whatever parts still work.
 * Works without the app running (statusLines outlive the app).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseClaudeIdentity } from "../../shared/agent-accounts";
import { claudeConfigLocation, managedClaudeAccountIdForConfigDir, pinnedClaudeConfigDir } from "../../shared/claude-config-dir";
import { resolveDev3Home } from "../../shared/dev3-home";
import { formatStatusLineSegment, parseClaudeStatusLinePayload } from "../../shared/rate-limits";

export const RATE_LIMITS_DIR = join(homedir(), ".dev3.0", "data", "rate-limits");
export const CLAUDE_RATE_LIMIT_DUMP_PATH = join(RATE_LIMITS_DIR, "claude.json");
export const CLAUDE_ACCOUNT_RATE_LIMITS_DIR = join(RATE_LIMITS_DIR, "claude");
export const CLAUDE_CONFIG_DIR_RATE_LIMITS_DIR = join(RATE_LIMITS_DIR, "claude-config-dirs");

const SAFE_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Set in the env of the user's statusLine we delegate to. A `dev3 statusline` reached again
 *  through any spelling, alias or wrapper script sees it and prints only its own segment. */
export const STATUSLINE_NESTED_ENV = "DEV3_STATUSLINE_NESTED";

/** Cheap first filter: a `dev3` binary token followed by the `statusline` subcommand, so
 *  `~/.dev3.0/bin/my-statusline.sh` is kept. A wrapper script that calls dev3 is out of reach
 *  of a string check; STATUSLINE_NESTED_ENV covers it. */
const DEV3_STATUSLINE_INVOCATION = /(?:^|[\s/\\"'(`;&|=])dev3(?:\.exe|\.cmd)?["'`)]?\s+["']?statusline(?![\w.-])/i;

/** Max time the user's original statusLine command may take before we drop it. */
const ORIGINAL_STATUSLINE_TIMEOUT_MS = 2000;

interface OriginalStatusLine {
	command: string;
}

function readStatusLineCommand(settingsPath: string): OriginalStatusLine | null {
	try {
		if (!existsSync(settingsPath)) return null;
		const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as { statusLine?: { type?: string; command?: string } };
		const sl = parsed?.statusLine;
		if (sl && sl.type === "command" && typeof sl.command === "string" && sl.command.trim()) {
			return { command: sl.command };
		}
	} catch {
		// unreadable/corrupt settings file — fall through to the next level
	}
	return null;
}

/**
 * Resolve the statusLine the user would have had WITHOUT our `--settings`
 * injection, walking the same precedence Claude Code uses below the CLI level:
 * project settings.local.json → project settings.json → user settings.json.
 * The user level lives in CLAUDE_CONFIG_DIR when set, exactly as Claude Code reads it.
 */
export function resolveOriginalStatusLine(
	projectDir: string | null,
	home: string = homedir(),
	configDir: string | undefined = process.env.CLAUDE_CONFIG_DIR,
): OriginalStatusLine | null {
	const candidates: string[] = [];
	if (projectDir) {
		candidates.push(join(projectDir, ".claude", "settings.local.json"));
		candidates.push(join(projectDir, ".claude", "settings.json"));
	}
	candidates.push(join(claudeConfigLocation({ CLAUDE_CONFIG_DIR: configDir }, home).dir, "settings.json"));
	for (const path of candidates) {
		const found = readStatusLineCommand(path);
		if (!found) continue;
		// Recursion guard: if someone pointed their own statusLine at us, do not
		// spawn ourselves forever.
		if (DEV3_STATUSLINE_INVOCATION.test(found.command)) continue;
		return found;
	}
	return null;
}

function runOriginalStatusLine(original: OriginalStatusLine, input: string, cwd: string | null): string {
	try {
		const result = spawnSync("bash", ["-c", original.command], {
			input,
			cwd: cwd && existsSync(cwd) ? cwd : undefined,
			env: { ...process.env, [STATUSLINE_NESTED_ENV]: "1" },
			timeout: ORIGINAL_STATUSLINE_TIMEOUT_MS,
			encoding: "utf-8",
			maxBuffer: 1024 * 1024,
		});
		if (typeof result.stdout === "string") return result.stdout.replace(/\s+$/, "");
	} catch {
		// original statusLine crashed/timed out — show only our segment
	}
	return "";
}

/** Where the per-task session dump goes; null outside a dev3 task (no DEV3_TASK_ID). */
export function sessionDumpFilePath(taskId: string | undefined, baseDir: string = RATE_LIMITS_DIR): string | null {
	const id = taskId?.trim();
	return id && SAFE_ACCOUNT_ID.test(id) ? join(baseDir, "sessions", `${id}.json`) : null;
}

export interface ClaudeDumpOwner {
	accountId: string | null;
	configDir: string | null;
}

/**
 * Whose quota a statusLine payload reports: the login in the `CLAUDE_CONFIG_DIR`
 * Claude actually runs on. Any account id inherited through the environment can be
 * stale (a tmux session outlives the account it was created for), so none is read.
 */
export function claudeDumpOwner(
	env: Record<string, string | undefined>,
	home: string,
	cwd: string,
	dev3Home: string,
): ClaudeDumpOwner {
	const dir = pinnedClaudeConfigDir(env.CLAUDE_CONFIG_DIR, home, cwd);
	if (!dir) return { accountId: null, configDir: null };
	const accountId = managedClaudeAccountIdForConfigDir(dir, dev3Home);
	return accountId ? { accountId, configDir: null } : { accountId: null, configDir: dir };
}

function readJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

/**
 * The name `--account` puts before dev3's segment: a managed account's label from
 * the registry, else the email of the login Claude runs on. Control characters are
 * dropped so a hand-edited label cannot break the line.
 */
export function statusLineAccountLabel(
	env: Record<string, string | undefined>,
	home: string,
	cwd: string,
	dev3Home: string,
): string | null {
	const { accountId } = claudeDumpOwner(env, home, cwd, dev3Home);
	const registry = accountId ? readJsonFile(join(dev3Home, "agent-accounts", "accounts.json")) as
		{ claude?: { accounts?: Array<{ id?: unknown; label?: unknown }> } } | null : null;
	const label = registry?.claude?.accounts?.find((a) => a?.id === accountId)?.label;
	const name = typeof label === "string" && label.trim()
		? label
		: parseClaudeIdentity(readJsonFile(claudeConfigLocation(env, home, cwd).claudeJson))?.email;
	const clean = name?.replace(/[\x00-\x1f\x7f]/g, "").trim();
	return clean || null;
}

/**
 * Where a statusLine dump for `accountId` is written. A managed account writes
 * ONLY its own per-account file; a project-pinned `CLAUDE_CONFIG_DIR` writes one
 * file per directory; only `~/.claude` writes the shared claude.json. Keeping
 * them apart stops one login from clobbering another's slot - the cause of
 * accounts vanishing from the rate-limit panel the moment another account ran,
 * and of pinned logins' usage showing under the default `~/.claude` login.
 */
export function claudeDumpFilePaths(
	accountId: string | null,
	baseDir: string = RATE_LIMITS_DIR,
	configDir: string | null = null,
): string[] {
	if (accountId) return [join(baseDir, "claude", `${accountId}.json`)];
	if (configDir) return [join(baseDir, "claude-config-dirs", `${configDirDumpName(configDir)}.json`)];
	return [join(baseDir, "claude.json")];
}

/** A filesystem-safe, stable name for a config dir's dump. The dir itself is
 *  stored inside the dump, so the hash never has to be reversed. */
export function configDirDumpName(configDir: string): string {
	return createHash("sha256").update(configDir).digest("hex").slice(0, 16);
}

function dumpPayload(raw: string): void {
	try {
		const { accountId, configDir } = claudeDumpOwner(process.env, homedir(), process.cwd(), resolveDev3Home());
		const capturedAt = Date.now();
		const serialized = JSON.stringify({
			capturedAt,
			accountId,
			...(configDir ? { configDir } : {}),
			payload: JSON.parse(raw),
		});
		for (const target of claudeDumpFilePaths(accountId, RATE_LIMITS_DIR, configDir)) {
			// Single small write; the monitor tolerates a torn read by keeping the
			// previous snapshot (deliberately no tmp+rename — see the on-disk layout
			// invariants about renames under ~/.dev3.0/).
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, serialized);
		}
		// One file per task feeds the usage panel's Sessions block; the account dumps
		// above are last-writer-wins, so they cannot tell concurrent tasks apart.
		const sessionTarget = sessionDumpFilePath(process.env.DEV3_TASK_ID);
		if (sessionTarget) {
			mkdirSync(dirname(sessionTarget), { recursive: true });
			writeFileSync(sessionTarget, serialized);
		}
	} catch {
		// disk/parse trouble must never break the visible statusLine
	}
}

export async function handleStatusLine(options: { account?: boolean } = {}): Promise<void> {
	if (process.stdin.isTTY) {
		process.stdout.write("dev3 statusline is an internal Claude Code statusLine wrapper; it expects the statusLine JSON on stdin.\n");
		return;
	}
	const raw = await Bun.stdin.text();

	let payload: unknown = null;
	try {
		payload = JSON.parse(raw);
	} catch {
		return; // not JSON — nothing useful to dump or render
	}
	dumpPayload(raw);

	const root = payload as { workspace?: { project_dir?: string; current_dir?: string } };
	const projectDir = root?.workspace?.project_dir ?? root?.workspace?.current_dir ?? null;

	const original = process.env[STATUSLINE_NESTED_ENV] ? null : resolveOriginalStatusLine(projectDir);
	const originalOut = original ? runOriginalStatusLine(original, raw, root?.workspace?.current_dir ?? projectDir) : "";

	const snapshot = parseClaudeStatusLinePayload(payload, Date.now());
	const usage = formatStatusLineSegment(snapshot, Date.now());
	const account = options.account ? statusLineAccountLabel(process.env, homedir(), process.cwd(), resolveDev3Home()) : null;
	const segment = [account, usage].filter(Boolean).join(" · ");

	const combined = originalOut && segment ? `${originalOut} ${segment}` : originalOut || segment;
	if (combined) process.stdout.write(`${combined}\n`);
}
