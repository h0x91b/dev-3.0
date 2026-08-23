/**
 * Is any agent CLI actually usable right now?
 *
 * `checkAgentAvailability` answers "is the binary on PATH", which is not the same
 * question: `claude` installed but never logged in launches, prints a login
 * prompt into a tmux pane, and the task sits there dead. The first-run sandbox is
 * where that hurts most — we would hand a newcomer a repo and a task that can
 * never run — so the sandbox button is gated on this instead.
 *
 * Sign-in is not observable in general: every CLI stores its credentials its own
 * way and none of them expose a cheap "am I logged in" command. So this reports
 * EVIDENCE, three-valued, and the gate only ever blocks on a positive "no":
 *
 * - `signed-in`     — a credential file or an API key for that CLI was found.
 * - `not-signed-in` — we know where that CLI keeps credentials, and there are none.
 * - `unknown`       — no probe for this CLI; installed is all we can say.
 *
 * A harness counts as usable when it is installed and NOT `not-signed-in`, so a
 * CLI we have no probe for is never blocked by our own ignorance.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveUserHome } from "../shared/user-home";
import { listClaudeAccountDirs, listCodexAccountDirs } from "./agent-accounts";
import { createLogger } from "./logger";
import type { AgentCheckResult, HarnessReadiness, HarnessReadinessReport, HarnessSignIn } from "../shared/types";

const log = createLogger("harness-readiness");

/** Injectable seam so the probes are testable without touching a real home dir. */
export interface ProbeEnv {
	home: string;
	env: Record<string, string | undefined>;
	exists: (path: string) => boolean;
	readJson: (path: string) => unknown;
	/** Extra per-account credential dirs dev3 manages itself. */
	claudeAccountDirs: () => string[];
	codexAccountDirs: () => string[];
}

function defaultReadJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

export function defaultProbeEnv(): ProbeEnv {
	return {
		home: resolveUserHome(),
		env: process.env,
		exists: existsSync,
		readJson: defaultReadJson,
		claudeAccountDirs: () => listClaudeAccountDirs(),
		codexAccountDirs: () => listCodexAccountDirs(),
	};
}

function anyEnv(p: ProbeEnv, keys: string[]): boolean {
	return keys.some((key) => (p.env[key] ?? "").trim().length > 0);
}

/** A non-empty JSON object at `path` — an empty `{}` is a logged-out store. */
function hasJsonKeys(p: ProbeEnv, path: string): boolean {
	const value = p.readJson(path);
	return !!value && typeof value === "object" && Object.keys(value as object).length > 0;
}

function claudeSignedIn(p: ProbeEnv): boolean {
	if (anyEnv(p, ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"])) return true;
	const homes = [p.home, ...p.claudeAccountDirs()];
	return homes.some(
		(dir) =>
			p.exists(join(dir, ".claude", ".credentials.json")) ||
			!!(p.readJson(join(dir, ".claude.json")) as { oauthAccount?: unknown } | null)?.oauthAccount,
	);
}

function codexSignedIn(p: ProbeEnv): boolean {
	if (anyEnv(p, ["OPENAI_API_KEY"])) return true;
	const homes = [join(p.home, ".codex"), ...p.codexAccountDirs()];
	return homes.some((dir) => hasJsonKeys(p, join(dir, "auth.json")));
}

function geminiSignedIn(p: ProbeEnv): boolean {
	if (anyEnv(p, ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"])) return true;
	const dir = join(p.home, ".gemini");
	if (p.exists(join(dir, "oauth_creds.json"))) return true;
	const accounts = p.readJson(join(dir, "google_accounts.json")) as { active?: unknown } | null;
	return typeof accounts?.active === "string" && accounts.active.length > 0;
}

function cursorSignedIn(p: ProbeEnv): boolean {
	const config = p.readJson(join(p.home, ".cursor", "cli-config.json")) as { authInfo?: unknown } | null;
	return !!config?.authInfo;
}

function opencodeSignedIn(p: ProbeEnv): boolean {
	// XDG-first, and the plain `~/.config` fallback for a machine with no
	// XDG_DATA_HOME set — the CLI writes one provider key per logged-in provider.
	const roots = [p.env.XDG_DATA_HOME, join(p.home, ".local", "share"), p.env.XDG_CONFIG_HOME, join(p.home, ".config")];
	return roots.some((root) => !!root && hasJsonKeys(p, join(root, "opencode", "auth.json")));
}

/** Probes keyed by the agent's `baseCommand`. Missing key ⇒ `unknown`. */
const SIGN_IN_PROBES: Record<string, (p: ProbeEnv) => boolean> = {
	claude: claudeSignedIn,
	codex: codexSignedIn,
	gemini: geminiSignedIn,
	// Cursor Agent's binary is `agent`.
	agent: cursorSignedIn,
	opencode: opencodeSignedIn,
};

export function harnessSignIn(baseCommand: string, p: ProbeEnv): HarnessSignIn {
	const probe = SIGN_IN_PROBES[baseCommand];
	if (!probe) return "unknown";
	try {
		return probe(p) ? "signed-in" : "not-signed-in";
	} catch (err) {
		// An unreadable credential store tells us nothing — it must not read as
		// "logged out" and block the sandbox.
		log.warn("Sign-in probe failed", { baseCommand, error: String(err) });
		return "unknown";
	}
}

/** Fold binary availability + sign-in evidence into the report the UI gates on. */
export function harnessReadinessFrom(availability: AgentCheckResult[], p: ProbeEnv = defaultProbeEnv()): HarnessReadinessReport {
	const harnesses: HarnessReadiness[] = availability.map((agent) => ({
		agentId: agent.agentId,
		name: agent.name,
		baseCommand: agent.baseCommand,
		installed: agent.installed,
		signIn: agent.installed ? harnessSignIn(agent.baseCommand, p) : "unknown",
	}));
	const installed = harnesses.filter((h) => h.installed);
	return {
		harnesses,
		usable: installed.filter((h) => h.signIn !== "not-signed-in").map((h) => h.agentId),
		noneInstalled: installed.length === 0,
	};
}
