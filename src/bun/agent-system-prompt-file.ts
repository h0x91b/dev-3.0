/**
 * The dev3 protocol delivered as a FILE instead of a command-line argument.
 *
 * Windows caps a process command line at 32 767 characters (`CreateProcess`
 * returns ERROR_FILENAME_EXCED_RANGE past it, which PowerShell reports as
 * `ApplicationFailedException` with no useful text). The dev3 system prompt is
 * ~34 000 characters on its own, so it can never travel inline there — measured
 * on a real Windows runner, see
 * decisions/2026/08/28/agent-command-lines-quote-in-the-launch-dialect.md.
 *
 * POSIX has no such ceiling worth caring about (`ARG_MAX` is 1 MB on macOS,
 * 2 MB on Linux), so it keeps the inline form and this file is never written
 * there. The dialect decides, not the caller.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEV3_HOME } from "./paths";
import { launchDialectId } from "../shared/platform-launch";
import { createLogger } from "./logger";

const log = createLogger("agent-system-prompt");

export const AGENT_PROMPTS_DIR = join(DEV3_HOME, "data", "agent-prompts");

/** Windows `CreateProcess` command-line ceiling, in characters. */
export const WINDOWS_COMMAND_LINE_LIMIT = 32767;

/** True when this platform cannot carry the protocol on the command line. */
export function systemPromptNeedsFile(platform: NodeJS.Platform = process.platform): boolean {
	return launchDialectId(platform) === "windows-powershell";
}

/**
 * Write (once) the body for `name` and return its path, or null when the write
 * fails — the caller then falls back to the inline form, which is broken on
 * Windows but is still better than refusing to launch.
 */
export function ensureAgentSystemPromptFile(name: string, body: string): string | null {
	const path = join(AGENT_PROMPTS_DIR, `${name}.md`);
	try {
		mkdirSync(AGENT_PROMPTS_DIR, { recursive: true });
		let current = "";
		try {
			current = readFileSync(path, "utf-8");
		} catch {
			// missing — written below
		}
		if (current !== body) writeFileSync(path, body, "utf-8");
		return path;
	} catch (err) {
		log.warn("Failed to write the agent system-prompt file", { path, error: String(err) });
		return null;
	}
}
