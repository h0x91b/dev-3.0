/**
 * Where the GitHub Copilot CLI keeps this machine's configuration.
 *
 * dev3 only ever ADDS a file under `hooks/` here. It never reads, rewrites or
 * removes the credential state, never changes the logged-in account, and never
 * points Copilot at a different home — `COPILOT_HOME` is honoured, not set, so
 * a user who relocated their Copilot config keeps their sessions and settings.
 */

import { join } from "node:path";
import { resolveUserHome } from "../shared/user-home";

export const COPILOT_HOME_ENV = "COPILOT_HOME";
export const COPILOT_DEFAULT_DIR = ".copilot";

/** `$COPILOT_HOME` when the user set one, else `~/.copilot` — the CLI's own rule. */
export function resolveCopilotHome(env: Record<string, string | undefined> = process.env): string {
	const override = (env[COPILOT_HOME_ENV] ?? "").trim();
	if (override) return override;
	return join(resolveUserHome(), COPILOT_DEFAULT_DIR);
}
