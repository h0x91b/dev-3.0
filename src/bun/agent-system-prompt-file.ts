/**
 * The dev3 protocol delivered as a FILE instead of a command-line argument, on
 * every platform. Two independent reasons, either one enough on its own:
 *
 * 1. Windows caps a process command line at `WINDOWS_COMMAND_LINE_LIMIT`
 *    characters and the protocol is most of that by itself, leaving the user's
 *    own task description to blow the ceiling. See
 *    decisions/2026/08/28/agent-command-lines-quote-in-the-launch-dialect.md.
 * 2. Inline, the body sits in every agent's `argv`, which is what `pkill -f` and
 *    `pgrep -f` match against. Any pattern that occurs as an ordinary word in
 *    that prose matched every running agent, so one agent's cleanup SIGTERMed
 *    all of its siblings (h0x91b/dev-3.0#1734).
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEV3_HOME } from "./paths";
import { createLogger } from "./logger";

const log = createLogger("agent-system-prompt");

export const AGENT_PROMPTS_DIR = join(DEV3_HOME, "data", "agent-prompts");

/**
 * Write (once) the body for `name` and return its path.
 *
 * Throws when it cannot be written. There is deliberately no inline fallback:
 * on Windows the launch would be over the ceiling anyway, and on POSIX it would
 * silently put the protocol back into argv — the exposure this file closes.
 */
export function ensureAgentSystemPromptFile(name: string, body: string): string {
	const path = join(AGENT_PROMPTS_DIR, `${name}.md`);
	try {
		mkdirSync(AGENT_PROMPTS_DIR, { recursive: true });
		if (readIfPresent(path) === body) return path;
		// Through a temp name in the same directory, because the reader is another
		// process: a launching agent must see either the old body or the new one,
		// never the middle of a rewrite.
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

function readIfPresent(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}
