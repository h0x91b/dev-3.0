/**
 * The dev3 protocol delivered as a FILE instead of a command-line argument.
 *
 * Two independent reasons, and either one alone is enough:
 *
 * 1. Windows caps a process command line at `WINDOWS_COMMAND_LINE_LIMIT`
 *    characters and the protocol is most of that on its own, leaving the user's
 *    own task description to blow the ceiling.
 *    See decisions/2026/08/28/agent-command-lines-quote-in-the-launch-dialect.md.
 * 2. On POSIX the whole protocol used to sit in every agent's `argv`, so ~29 KB
 *    of ordinary English words was matchable by `pgrep -f` / `pkill -f`. One
 *    agent killing "its own" process by pattern SIGTERMed every sibling agent on
 *    the machine (h0x91b/dev-3.0#1734).
 *
 * So every platform now gets the file, and no platform carries the body in argv.
 *
 * The file name is content-addressed: two app versions running side by side
 * write different bodies to different paths, so neither can overwrite the file
 * the other's child process is about to read. Files are immutable once written
 * and are never pruned — an older version's `claude.md` and every past body stay
 * readable, which is what the on-disk layout invariants require.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEV3_HOME } from "./paths";
import { createLogger } from "./logger";

const log = createLogger("agent-system-prompt");

export const AGENT_PROMPTS_DIR = join(DEV3_HOME, "data", "agent-prompts");

/** Content address of a protocol body — the file name's stable half. */
export function systemPromptFileDigest(body: string): string {
	return createHash("sha256").update(body, "utf-8").digest("hex").slice(0, 16);
}

/**
 * Write (once) the body for `name` and return its path.
 *
 * Throws when the file cannot be written. There is deliberately no inline
 * fallback: on Windows it cannot be launched at all, and on POSIX it would
 * silently put the protocol back into every agent's argv — the bug this file
 * exists to close.
 */
export function ensureAgentSystemPromptFile(name: string, body: string): string {
	const path = join(AGENT_PROMPTS_DIR, `${name}-${systemPromptFileDigest(body)}.md`);
	try {
		mkdirSync(AGENT_PROMPTS_DIR, { recursive: true });
		if (readAsUtf8(path) === body) return path;
		// Write through a temp name in the same directory: a concurrent launch
		// must see either no file or the whole body, never a half-written one.
		const temp = `${path}.${process.pid}.tmp`;
		try {
			writeFileSync(temp, body, "utf-8");
			renameSync(temp, path);
		} catch (err) {
			rmSync(temp, { force: true });
			throw err;
		}
		return path;
	} catch (err) {
		log.warn("Failed to write the agent system-prompt file", { path, error: String(err) });
		throw new Error(`Could not write the agent system-prompt file ${path}: ${String(err)}`);
	}
}

function readAsUtf8(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}
