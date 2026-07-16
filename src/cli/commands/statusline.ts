/**
 * `dev3 statusline` — internal statusLine wrapper for Claude Code sessions
 * launched by dev-3.0.
 *
 * The app injects `--settings <file>` into every Claude launch, where the file
 * sets `statusLine.command` to this command. Claude Code then pipes its
 * statusLine JSON (which includes `rate_limits` since v1.2.80) to us on every
 * refresh. We:
 *   1. dump the payload to ~/.dev3.0/data/rate-limits/claude.json (the app's
 *      rate-limit monitor reads it from there — no API calls anywhere);
 *   2. DELEGATE to the user's original statusLine command (resolved from the
 *      normal settings precedence: worktree settings.local.json → project
 *      settings.json → ~/.claude/settings.json), so injection never destroys
 *      an existing custom statusLine;
 *   3. append a compact usage segment (% used + time-to-reset per window,
 *      yellow ≥80%, red ≥95%).
 *
 * Never fails: any error degrades to printing whatever parts still work.
 * Works without the app running (statusLines outlive the app).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEV3_AGENT_ACCOUNT_ID_ENV } from "../../shared/agent-accounts";
import { formatStatusLineSegment, parseClaudeStatusLinePayload } from "../../shared/rate-limits";

export const RATE_LIMITS_DIR = join(homedir(), ".dev3.0", "data", "rate-limits");
export const CLAUDE_RATE_LIMIT_DUMP_PATH = join(RATE_LIMITS_DIR, "claude.json");
export const CLAUDE_ACCOUNT_RATE_LIMITS_DIR = join(RATE_LIMITS_DIR, "claude");

const SAFE_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
 */
export function resolveOriginalStatusLine(projectDir: string | null, home: string = homedir()): OriginalStatusLine | null {
	const candidates: string[] = [];
	if (projectDir) {
		candidates.push(join(projectDir, ".claude", "settings.local.json"));
		candidates.push(join(projectDir, ".claude", "settings.json"));
	}
	candidates.push(join(home, ".claude", "settings.json"));
	for (const path of candidates) {
		const found = readStatusLineCommand(path);
		if (!found) continue;
		// Recursion guard: if someone pointed their own statusLine at us, do not
		// spawn ourselves forever.
		if (found.command.includes("dev3") && found.command.includes("statusline")) continue;
		return found;
	}
	return null;
}

function runOriginalStatusLine(original: OriginalStatusLine, input: string, cwd: string | null): string {
	try {
		const result = spawnSync("bash", ["-c", original.command], {
			input,
			cwd: cwd && existsSync(cwd) ? cwd : undefined,
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

function managedAccountId(): string | null {
	const value = process.env[DEV3_AGENT_ACCOUNT_ID_ENV]?.trim();
	return value && SAFE_ACCOUNT_ID.test(value) ? value : null;
}

function dumpPayload(raw: string): void {
	try {
		const accountId = managedAccountId();
		const capturedAt = Date.now();
		const serialized = JSON.stringify({ capturedAt, accountId, payload: JSON.parse(raw) });
		mkdirSync(dirname(CLAUDE_RATE_LIMIT_DUMP_PATH), { recursive: true });
		// Single small write; the monitor tolerates a torn read by keeping the
		// previous snapshot (deliberately no tmp+rename — see the on-disk layout
		// invariants about renames under ~/.dev3.0/).
		writeFileSync(CLAUDE_RATE_LIMIT_DUMP_PATH, serialized);
		if (accountId) {
			mkdirSync(CLAUDE_ACCOUNT_RATE_LIMITS_DIR, { recursive: true });
			writeFileSync(join(CLAUDE_ACCOUNT_RATE_LIMITS_DIR, `${accountId}.json`), serialized);
		}
	} catch {
		// disk/parse trouble must never break the visible statusLine
	}
}

export async function handleStatusLine(): Promise<void> {
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

	const original = resolveOriginalStatusLine(projectDir);
	const originalOut = original ? runOriginalStatusLine(original, raw, root?.workspace?.current_dir ?? projectDir) : "";

	const snapshot = parseClaudeStatusLinePayload(payload, Date.now());
	const segment = formatStatusLineSegment(snapshot, Date.now());

	const combined = originalOut && segment ? `${originalOut} ${segment}` : originalOut || segment;
	if (combined) process.stdout.write(`${combined}\n`);
}
