/**
 * Agent account switcher — pure types + identity parsing shared by the bun
 * process and the renderer. No fs / API calls here; everything operates on
 * already-read JSON payloads.
 *
 * Data sources (all local):
 * - Claude Code: `.claude.json` → `.oauthAccount` {emailAddress,
 *   organizationName, userRateLimitTier, accountUuid, ...}.
 * - Codex: `auth.json` → `tokens.id_token` (JWT whose payload carries `email`
 *   and the `https://api.openai.com/auth` claim with `chatgpt_plan_type` +
 *   `chatgpt_account_id`) and `tokens.account_id`.
 */

export type AgentAccountKind = "claude" | "codex";

/** How a managed account authenticates: an OAuth login (subscription) or an
 *  API profile (custom endpoint / API key / env vars, no login at all). */
export type AgentAccountAuth = "oauth" | "api";

/** The four Claude Code model-alias slots an API profile can override. Each maps
 *  to `ANTHROPIC_DEFAULT_<SLOT>_MODEL` (+ `_NAME` / `_DESCRIPTION`). Display order
 *  = most-capable first (Fable is currently the top model, above Opus). */
export type ClaudeModelSlot = "opus" | "sonnet" | "haiku" | "fable";
export const CLAUDE_MODEL_SLOTS: ClaudeModelSlot[] = ["fable", "opus", "sonnet", "haiku"];

/** Per-slot model override: the provider model id plus optional display
 *  name/description surfaced by Claude Code's `/model` picker. */
export interface ClaudeSlotModel {
	id: string;
	name?: string;
	description?: string;
}

export type ClaudeSlotModels = Partial<Record<ClaudeModelSlot, ClaudeSlotModel>>;

/** Sentinel value in a session-env record meaning "actively unset this variable
 *  in the launched shell" (emitted as `unset KEY` instead of `export KEY=…`).
 *  Needed because a previously active API profile leaks its ANTHROPIC_* vars
 *  into the long-lived tmux server env — merely omitting them from the next
 *  launch is not enough, they must be explicitly removed. */
export const ENV_UNSET = "\u0000dev3:unset\u0000";

/** Every fixed env var the Claude API-profile mechanism can set. When the
 *  active selection does not set one of these, it is actively unset so a value
 *  leaked from a previously active profile (or the ambient shell) cannot hijack
 *  the session's auth or model routing. */
export function claudeApiProfileEnvKeys(): string[] {
	const keys = ["CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL"];
	for (const slot of CLAUDE_MODEL_SLOTS) {
		const prefix = `ANTHROPIC_DEFAULT_${slot.toUpperCase()}_MODEL`;
		keys.push(prefix, `${prefix}_NAME`, `${prefix}_DESCRIPTION`);
	}
	return keys;
}

/** Display-safe description of a Claude API profile. `hasApiKey` tells the UI a
 *  key is stored; the key value travels only in the on-demand edit draft, never
 *  in the bulk accounts list. */
export interface AgentApiProfileInfo {
	baseUrl: string | null;
	/** Master override: one model id fanned out to every slot (wins over slotModels). */
	model: string | null;
	/** Per-slot overrides (ids + display metadata; used when no master is set). */
	slotModels: ClaudeSlotModels;
	hasApiKey: boolean;
	/** Names (not values) of extra env vars carried by the profile. */
	envKeys: string[];
}

export interface AgentAccountIdentity {
	/** Login email, when known. */
	email: string | null;
	/** Organization / workspace name, when known. */
	organization: string | null;
	/** Raw plan/tier string (e.g. "default_claude_max_5x", "plus"). */
	plan: string | null;
	/** Human-readable plan label derived from `plan` (e.g. "Max 5x", "Plus"). */
	planLabel: string | null;
	/** Stable provider-side account id. For Codex, `account_id` is the selected
	 *  ChatGPT workspace id, while `chatgpt_user_id` identifies the person. */
	accountId: string | null;
}

export interface AgentAccount {
	id: string;
	kind: AgentAccountKind;
	/** User-editable display name (defaults to the login email). */
	label: string;
	/** Re-derived from the stored credentials on every list — never persisted. */
	identity: AgentAccountIdentity | null;
	/** "oauth" (default) or "api" for API/custom-endpoint profiles. */
	auth: AgentAccountAuth;
	/** Present only when auth === "api". */
	api: AgentApiProfileInfo | null;
	createdAt: number;
}

export interface AgentAccountsState {
	claude: {
		accounts: AgentAccount[];
		/** Active managed account; null = system login (~/.claude, no env override). */
		activeId: string | null;
		/** Identity of the system login parsed from ~/.claude.json (null when absent). */
		systemIdentity: AgentAccountIdentity | null;
	};
	codex: {
		accounts: AgentAccount[];
		/** Snapshot matching the current ~/.codex/auth.json; null = unmanaged/none. */
		activeId: string | null;
		/** Identity currently held by ~/.codex/auth.json (null when absent/unreadable). */
		currentIdentity: AgentAccountIdentity | null;
	};
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

function titleCaseToken(token: string): string {
	return token.length > 0 ? token[0].toUpperCase() + token.slice(1) : token;
}

/**
 * "default_claude_max_5x" → "Max 5x", "default_claude_pro" → "Pro",
 * "default" → null (no meaningful tier). Unknown shapes fall back to a
 * title-cased underscore split so new tiers still render something sane.
 */
export function claudePlanLabel(tier: string | null): string | null {
	if (!tier) return null;
	const stripped = tier.replace(/^default_claude_/, "").replace(/^default$/, "");
	if (!stripped) return null;
	return stripped.split("_").map(titleCaseToken).join(" ");
}

/** "plus" → "Plus", "enterprise_cbp_usage_based" → "Enterprise". Enterprise plan
 *  ids carry billing-mode suffixes that are noise for a badge. */
export function codexPlanLabel(plan: string | null): string | null {
	if (!plan) return null;
	if (plan.startsWith("enterprise")) return "Enterprise";
	return plan.split("_").map(titleCaseToken).join(" ");
}

/** Parse a Claude Code `.claude.json` payload into an identity (via `.oauthAccount`). */
export function parseClaudeIdentity(claudeJson: unknown): AgentAccountIdentity | null {
	const root = asRecord(claudeJson);
	const oauth = asRecord(root?.oauthAccount);
	if (!oauth) return null;
	const plan = asString(oauth.userRateLimitTier);
	return {
		email: asString(oauth.emailAddress),
		organization: asString(oauth.organizationName),
		plan,
		planLabel: claudePlanLabel(plan),
		accountId: asString(oauth.accountUuid),
	};
}

/** Decode a JWT payload without verifying the signature (local trust, display only). */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
	const parts = jwt.split(".");
	if (parts.length < 2) return null;
	try {
		const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
		return asRecord(JSON.parse(atob(padded)));
	} catch {
		return null;
	}
}

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

/** Parse a Codex `auth.json` payload into an identity (email + plan from the id_token JWT). */
export function parseCodexIdentity(authJson: unknown): AgentAccountIdentity | null {
	const root = asRecord(authJson);
	const tokens = asRecord(root?.tokens);
	if (!tokens) return null;
	const accountId = asString(tokens.account_id);
	const idToken = asString(tokens.id_token);
	const payload = idToken ? decodeJwtPayload(idToken) : null;
	const authClaim = asRecord(payload?.[OPENAI_AUTH_CLAIM]);
	const plan = asString(authClaim?.chatgpt_plan_type);
	const orgs = Array.isArray(authClaim?.organizations) ? authClaim.organizations : [];
	const firstOrg = asRecord(orgs[0]);
	if (!accountId && !payload) return null;
	return {
		email: asString(payload?.email),
		organization: asString(firstOrg?.title),
		plan,
		planLabel: codexPlanLabel(plan),
		accountId: accountId ?? asString(authClaim?.chatgpt_account_id),
	};
}

/** Compact, display-safe prefix for a Codex ChatGPT workspace id. */
export function shortCodexWorkspaceId(identity: AgentAccountIdentity | null): string | null {
	return identity?.accountId?.slice(0, 8) ?? null;
}

/** Default display label for a freshly added account. */
export function defaultAccountLabel(identity: AgentAccountIdentity | null, ordinal: number): string {
	return identity?.email ?? `Account ${ordinal}`;
}

/** Parse "KEY=value" lines (one per line; blank lines and #comments skipped)
 *  into an env record. Throws on a malformed line so the UI can surface it. */
export function parseEnvLines(text: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		const key = eq > 0 ? line.slice(0, eq).trim() : "";
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			throw new Error(`Invalid env line: "${rawLine.trim()}" (expected KEY=value)`);
		}
		env[key] = line.slice(eq + 1).trim();
	}
	return env;
}

/** Default display label for a freshly added API profile. */
export function defaultApiProfileLabel(baseUrl: string | null, ordinal: number): string {
	if (baseUrl) {
		try {
			return new URL(baseUrl).host;
		} catch {
			// fall through to the generic label
		}
	}
	return `API profile ${ordinal}`;
}
