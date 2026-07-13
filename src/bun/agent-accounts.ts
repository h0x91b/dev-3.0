/**
 * Agent account switcher — storage + swap mechanics (bun process only).
 *
 * On-disk layout (additive tree under ~/.dev3.0/, never renamed/migrated):
 *   ~/.dev3.0/agent-accounts/accounts.json        — registry (labels, active ids)
 *   ~/.dev3.0/agent-accounts/claude/<id>/          — full CLAUDE_CONFIG_DIR per account
 *       .claude.json                               — per-account identity/trust/onboarding
 *       .credentials.json                          — per-account OAuth token (0600)
 *       settings.json, skills/, projects/, ...     — symlinks into ~/.claude (shared)
 *   ~/.dev3.0/agent-accounts/codex/<id>/auth.json  — per-account snapshot of ~/.codex/auth.json
 *
 * Swap semantics:
 * - Claude: the active account's dir is injected as CLAUDE_CONFIG_DIR into newly
 *   launched agent sessions (agents.ts). activeId=null → no injection (~/.claude).
 *   The user's ~/.claude is never mutated beyond the pre-existing trust writes.
 * - Codex: the CLI reads exactly ~/.codex/auth.json, so activation copies the
 *   snapshot into place (after syncing refreshed tokens back into the snapshot
 *   that matches the outgoing login). Running sessions keep their in-memory
 *   token either way — a swap affects only new sessions.
 */

import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	AgentAccount,
	AgentAccountAuth,
	AgentAccountKind,
	AgentAccountsState,
	AgentAccountIdentity,
	AgentApiProfileInfo,
	ClaudeSlotModel,
	ClaudeSlotModels,
} from "../shared/agent-accounts";
import {
	CLAUDE_MODEL_SLOTS,
	ENV_UNSET,
	claudeApiProfileEnvKeys,
	defaultAccountLabel,
	defaultApiProfileLabel,
	parseClaudeIdentity,
	parseCodexIdentity,
	shortCodexWorkspaceId,
} from "../shared/agent-accounts";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";
import { spawn } from "./spawn";

const log = createLogger("agent-accounts");

export interface AccountPaths {
	/** ~/.dev3.0/agent-accounts */
	accountsDir: string;
	/** ~/.claude */
	claudeHome: string;
	/** ~/.claude.json */
	claudeJson: string;
	/** ~/.codex */
	codexHome: string;
}

export function defaultAccountPaths(): AccountPaths {
	const home = homedir();
	return {
		accountsDir: join(DEV3_HOME, "agent-accounts"),
		claudeHome: join(home, ".claude"),
		claudeJson: join(home, ".claude.json"),
		codexHome: join(home, ".codex"),
	};
}

/** Entries of ~/.claude shared across accounts via symlinks: user customization
 *  (settings/skills/agents/commands/plugins/memory) plus transcripts+todos so
 *  session resume and usage tracking keep working after an account switch.
 *  Credentials and .claude.json stay per-account by design. */
export const CLAUDE_SHARED_ENTRIES = [
	"settings.json",
	"CLAUDE.md",
	"skills",
	"agents",
	"commands",
	"plugins",
	"projects",
	"todos",
];

/** Entries of ~/.codex shared across per-account CODEX_HOME dirs via symlinks:
 *  user configuration (config.toml) and prompts. auth.json stays per-account (it
 *  is the whole point of the switch); sessions/history are created per-account so
 *  usage/rate-limit tracking can attribute them (see rate-limit-monitor). Missing
 *  source entries are simply skipped — a fresh codex install may have none. */
export const CODEX_SHARED_ENTRIES = ["config.toml", "prompts"];

interface RegistryEntry {
	id: string;
	label: string;
	/** Absent = "oauth" (pre-API-profile registries stay readable as-is). */
	auth?: AgentAccountAuth;
	createdAt: number;
}

interface Registry {
	version: 1;
	claude: { activeId: string | null; accounts: RegistryEntry[] };
	codex: { activeId: string | null; accounts: RegistryEntry[] };
}

function emptyRegistry(): Registry {
	return {
		version: 1,
		claude: { activeId: null, accounts: [] },
		codex: { activeId: null, accounts: [] },
	};
}

function registryFile(paths: AccountPaths): string {
	return join(paths.accountsDir, "accounts.json");
}

function loadRegistry(paths: AccountPaths): Registry {
	try {
		const raw = readFileSync(registryFile(paths), "utf-8");
		const data = JSON.parse(raw);
		if (!data || typeof data !== "object") return emptyRegistry();
		const norm = (v: any): { activeId: string | null; accounts: RegistryEntry[] } => ({
			activeId: typeof v?.activeId === "string" ? v.activeId : null,
			accounts: Array.isArray(v?.accounts)
				? v.accounts.filter((a: any) => typeof a?.id === "string" && isSafeAccountId(a.id)).map((a: any) => ({
						id: a.id,
						label: typeof a.label === "string" ? a.label : a.id,
						auth: a.auth === "api" ? ("api" as const) : undefined,
						createdAt: typeof a.createdAt === "number" ? a.createdAt : 0,
					}))
				: [],
		});
		return { version: 1, claude: norm(data.claude), codex: norm(data.codex) };
	} catch {
		return emptyRegistry();
	}
}

function saveRegistry(registry: Registry, paths: AccountPaths): void {
	mkdirSync(paths.accountsDir, { recursive: true });
	const target = registryFile(paths);
	const tmp = `${target}.tmp`;
	writeFileSync(tmp, JSON.stringify(registry, null, 2));
	renameSync(tmp, target);
}

/** Account ids are crypto.randomUUID()s minted by this module. Reject anything
 *  else before an id is used as a path segment — RPC-supplied ids would
 *  otherwise allow traversal out of the accounts dir (removeAgentAccount does a
 *  recursive rmSync on the derived path, so this must never be reachable). */
function isSafeAccountId(id: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

function assertSafeAccountId(id: string): void {
	if (!isSafeAccountId(id)) {
		throw new Error(`Invalid account id: ${id}`);
	}
}

export function claudeAccountDir(id: string, paths: AccountPaths = defaultAccountPaths()): string {
	assertSafeAccountId(id);
	return join(paths.accountsDir, "claude", id);
}

export function codexAccountDir(id: string, paths: AccountPaths = defaultAccountPaths()): string {
	assertSafeAccountId(id);
	return join(paths.accountsDir, "codex", id);
}

function codexAccountAuthFile(id: string, paths: AccountPaths): string {
	return join(codexAccountDir(id, paths), "auth.json");
}

/** Make the account dir a usable CODEX_HOME: ensure it exists and symlink the
 *  shared config entries from ~/.codex (idempotent — safe to call on every env
 *  build and on import/login). auth.json is written separately and stays
 *  per-account. Symlink failures are non-fatal (codex falls back to defaults). */
function ensureCodexAccountHome(id: string, paths: AccountPaths): string {
	const dir = codexAccountDir(id, paths);
	mkdirSync(dir, { recursive: true });
	for (const entry of CODEX_SHARED_ENTRIES) {
		const source = join(paths.codexHome, entry);
		if (!existsSync(source)) continue;
		const linkPath = join(dir, entry);
		try {
			lstatSync(linkPath);
			continue; // already linked
		} catch {
			// missing — create below
		}
		try {
			symlinkSync(source, linkPath);
		} catch (err) {
			log.warn("Failed to symlink shared codex entry", { entry, error: String(err) });
		}
	}
	return dir;
}

function safeReadJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

function claudeAccountIdentity(id: string, paths: AccountPaths): AgentAccountIdentity | null {
	return parseClaudeIdentity(safeReadJson(join(claudeAccountDir(id, paths), ".claude.json")));
}

function codexAccountIdentity(id: string, paths: AccountPaths): AgentAccountIdentity | null {
	return parseCodexIdentity(safeReadJson(codexAccountAuthFile(id, paths)));
}

/** On-disk shape of <claude account dir>/api-profile.json (0600 — holds the key). */
interface ApiProfileFile {
	baseUrl: string | null;
	apiKey: string | null;
	/** Master override: one model id fanned out to every alias slot. */
	model: string | null;
	/** Per-slot overrides (used when `model` master is empty). */
	slotModels: ClaudeSlotModels;
	env: Record<string, string>;
}

/** Parse the persisted per-slot overrides, keeping only well-formed entries. */
function parseSlotModels(raw: unknown): ClaudeSlotModels {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: ClaudeSlotModels = {};
	for (const slot of CLAUDE_MODEL_SLOTS) {
		const entry = (raw as Record<string, unknown>)[slot];
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const rec = entry as Record<string, unknown>;
		const id = typeof rec.id === "string" ? rec.id.trim() : "";
		if (!id) continue;
		const model: ClaudeSlotModel = { id };
		if (typeof rec.name === "string" && rec.name.trim()) model.name = rec.name.trim();
		if (typeof rec.description === "string" && rec.description.trim()) model.description = rec.description.trim();
		out[slot] = model;
	}
	return out;
}

function apiProfileFile(id: string, paths: AccountPaths): string {
	return join(claudeAccountDir(id, paths), "api-profile.json");
}

function readApiProfile(id: string, paths: AccountPaths): ApiProfileFile | null {
	const raw = safeReadJson(apiProfileFile(id, paths));
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const data = raw as Record<string, unknown>;
	const env: Record<string, string> = {};
	if (data.env && typeof data.env === "object" && !Array.isArray(data.env)) {
		for (const [k, v] of Object.entries(data.env as Record<string, unknown>)) {
			if (typeof v === "string") env[k] = v;
		}
	}
	return {
		baseUrl: typeof data.baseUrl === "string" ? data.baseUrl : null,
		apiKey: typeof data.apiKey === "string" ? data.apiKey : null,
		model: typeof data.model === "string" ? data.model : null,
		slotModels: parseSlotModels(data.slotModels),
		env,
	};
}

function apiProfileInfo(profile: ApiProfileFile | null): AgentApiProfileInfo | null {
	if (!profile) return null;
	return {
		baseUrl: profile.baseUrl,
		model: profile.model,
		slotModels: profile.slotModels,
		hasApiKey: !!profile.apiKey,
		envKeys: Object.keys(profile.env),
	};
}

function toAccount(entry: RegistryEntry, kind: AgentAccountKind, paths: AccountPaths): AgentAccount {
	const isApi = kind === "claude" && entry.auth === "api";
	return {
		id: entry.id,
		kind,
		label: entry.label,
		identity: isApi
			? null
			: kind === "claude"
				? claudeAccountIdentity(entry.id, paths)
				: codexAccountIdentity(entry.id, paths),
		auth: isApi ? "api" : "oauth",
		api: isApi ? apiProfileInfo(readApiProfile(entry.id, paths)) : null,
		createdAt: entry.createdAt,
	};
}

function currentCodexIdentity(paths: AccountPaths): AgentAccountIdentity | null {
	return parseCodexIdentity(safeReadJson(join(paths.codexHome, "auth.json")));
}

/** Absolute dirs of every managed codex account (each a per-account CODEX_HOME).
 *  The rate-limit monitor uses this to find rollout/session files that per-launch
 *  CODEX_HOME injection scatters out of ~/.codex/sessions. Best-effort: returns
 *  [] when the registry is unreadable. */
export function listCodexAccountDirs(paths: AccountPaths = defaultAccountPaths()): string[] {
	try {
		return loadRegistry(paths).codex.accounts.map((e) => codexAccountDir(e.id, paths));
	} catch {
		return [];
	}
}

export async function listAgentAccounts(paths: AccountPaths = defaultAccountPaths()): Promise<AgentAccountsState> {
	const registry = loadRegistry(paths);
	return {
		claude: {
			accounts: registry.claude.accounts.map((e) => toAccount(e, "claude", paths)),
			activeId: registry.claude.accounts.some((e) => e.id === registry.claude.activeId) ? registry.claude.activeId : null,
			systemIdentity: parseClaudeIdentity(safeReadJson(paths.claudeJson)),
		},
		codex: {
			accounts: registry.codex.accounts.map((e) => toAccount(e, "codex", paths)),
			activeId: registry.codex.accounts.some((e) => e.id === registry.codex.activeId) ? registry.codex.activeId : null,
			currentIdentity: currentCodexIdentity(paths),
		},
	};
}

/** Resolve a per-launch account override against a provider's registry default.
 *  `accountIdOverride === undefined` → the default (`activeId`, i.e. the
 *  preselect); `null` → force the system login (~/.claude / ~/.codex); a string →
 *  that specific managed account. Shared by both providers' env resolution. */
function resolveAccountIdOverride(activeId: string | null, accountIdOverride: string | null | undefined): string | null {
	return accountIdOverride === undefined ? activeId : accountIdOverride;
}

/** CLAUDE_CONFIG_DIR to inject into new Claude sessions, or null for ~/.claude.
 *  `accountIdOverride` selects a specific account for THIS launch (per-launch
 *  selector); omit it to use the registry default. */
export async function getActiveClaudeConfigDir(
	accountIdOverride?: string | null,
	paths: AccountPaths = defaultAccountPaths(),
): Promise<string | null> {
	const registry = loadRegistry(paths);
	const id = resolveAccountIdOverride(registry.claude.activeId, accountIdOverride);
	if (!id || !registry.claude.accounts.some((e) => e.id === id)) return null;
	const dir = claudeAccountDir(id, paths);
	return existsSync(join(dir, ".claude.json")) ? dir : null;
}

/** Fan the profile's model overrides into the four Claude alias slots
 *  (`ANTHROPIC_DEFAULT_<SLOT>_MODEL` + `_NAME`/`_DESCRIPTION`). A non-empty
 *  master `model` wins and sets every slot to the same id (no display metadata);
 *  otherwise each configured per-slot override is emitted. `ANTHROPIC_MODEL` is
 *  deliberately never set — the alias slots (plus the family-based `--model`
 *  rewrite in agents.ts) drive model selection. */
function applyApiProfileModelEnv(env: Record<string, string>, profile: ApiProfileFile): void {
	for (const slot of CLAUDE_MODEL_SLOTS) {
		const prefix = `ANTHROPIC_DEFAULT_${slot.toUpperCase()}_MODEL`;
		if (profile.model) {
			env[prefix] = profile.model;
			continue;
		}
		const override = profile.slotModels[slot];
		if (!override?.id) continue;
		env[prefix] = override.id;
		if (override.name) env[`${prefix}_NAME`] = override.name;
		if (override.description) env[`${prefix}_DESCRIPTION`] = override.description;
	}
}

/** Every env key any registered API profile could have set: the fixed
 *  ANTHROPIC_* + CLAUDE_CONFIG_DIR set plus the union of all profiles' extra
 *  env keys. Used to actively unset stale values after an account switch. */
function collectClearableEnvKeys(registry: Registry, paths: AccountPaths): Set<string> {
	const keys = new Set(claudeApiProfileEnvKeys());
	for (const entry of registry.claude.accounts) {
		if (entry.auth !== "api") continue;
		const profile = readApiProfile(entry.id, paths);
		for (const key of Object.keys(profile?.env ?? {})) keys.add(key);
	}
	return keys;
}

/** Full env to inject into new Claude sessions for the active account:
 *  CLAUDE_CONFIG_DIR always; for API profiles additionally ANTHROPIC_BASE_URL /
 *  ANTHROPIC_API_KEY / the ANTHROPIC_DEFAULT_*_MODEL alias slots plus the
 *  profile's extra env vars.
 *
 *  Every clearable key (see collectClearableEnvKeys) the active selection does
 *  NOT set is returned as ENV_UNSET: a previously active API profile leaks its
 *  vars into the long-lived tmux server env, and a leaked ANTHROPIC_API_KEY /
 *  ANTHROPIC_BASE_URL silently hijacks an OAuth (subscription) login. Callers
 *  that fill env on top (config envVars, provider env) still win — the
 *  sentinels only apply to keys nothing else claimed.
 *
 *  Empty record when no accounts are registered at all (feature unused —
 *  never touch the ambient env of users who don't use the switcher). */
export async function getActiveClaudeSessionEnv(
	accountIdOverride?: string | null,
	paths: AccountPaths = defaultAccountPaths(),
): Promise<Record<string, string>> {
	const registry = loadRegistry(paths);
	if (registry.claude.accounts.length === 0) return {};

	const env: Record<string, string> = {};
	const id = resolveAccountIdOverride(registry.claude.activeId, accountIdOverride);
	const entry = id ? registry.claude.accounts.find((e) => e.id === id) : undefined;
	if (entry) {
		const dir = claudeAccountDir(entry.id, paths);
		if (existsSync(join(dir, ".claude.json"))) {
			env.CLAUDE_CONFIG_DIR = dir;
			if (entry.auth === "api") {
				const profile = readApiProfile(entry.id, paths);
				if (profile) {
					// Profile-level vars first, specific fields last so the structured fields win.
					Object.assign(env, profile.env);
					if (profile.baseUrl) env.ANTHROPIC_BASE_URL = profile.baseUrl;
					if (profile.apiKey) env.ANTHROPIC_API_KEY = profile.apiKey;
					applyApiProfileModelEnv(env, profile);
					env.CLAUDE_CONFIG_DIR = dir;
				} else {
					log.warn("Active Claude API profile has no api-profile.json", { id: entry.id });
				}
			}
		}
	}
	for (const key of collectClearableEnvKeys(registry, paths)) {
		if (!(key in env)) env[key] = ENV_UNSET;
	}
	return env;
}

/** CODEX_HOME to inject into a new Codex session, or {} for the system login
 *  (~/.codex, no override). `accountIdOverride`: undefined → the registry default
 *  (`activeId`); null → force the system login; a string → that managed account.
 *  Unlike the old model this NEVER swaps ~/.codex/auth.json — each session gets
 *  its own CODEX_HOME, so concurrent sessions can run on different accounts. */
export async function getActiveCodexSessionEnv(
	accountIdOverride?: string | null,
	paths: AccountPaths = defaultAccountPaths(),
): Promise<Record<string, string>> {
	const registry = loadRegistry(paths);
	const id = resolveAccountIdOverride(registry.codex.activeId, accountIdOverride);
	if (!id || !registry.codex.accounts.some((e) => e.id === id)) return {};
	// Missing snapshot (account added but creds gone) → fall back to system login.
	if (!existsSync(codexAccountAuthFile(id, paths))) return {};
	return { CODEX_HOME: ensureCodexAccountHome(id, paths) };
}

/** Create the per-account config dir with symlinks into ~/.claude for shared state. */
function scaffoldClaudeAccountDir(dir: string, paths: AccountPaths): void {
	mkdirSync(dir, { recursive: true });
	for (const entry of CLAUDE_SHARED_ENTRIES) {
		const linkPath = join(dir, entry);
		try {
			lstatSync(linkPath);
			continue; // already scaffolded (re-run after a failed login attempt)
		} catch {
			// missing — create below
		}
		try {
			symlinkSync(join(paths.claudeHome, entry), linkPath);
		} catch (err) {
			log.warn("Failed to symlink shared claude entry", { entry, error: String(err) });
		}
	}
}

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** Read the Claude Code OAuth credentials from the macOS Keychain (may raise a
 *  one-time Keychain permission prompt). Returns the raw credentials JSON string. */
async function readClaudeKeychainCredentials(): Promise<string | null> {
	if (process.platform !== "darwin") return null;
	try {
		const proc = spawn(["security", "find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
		if (code !== 0) return null;
		const trimmed = out.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch (err) {
		log.warn("Keychain read failed", { error: String(err) });
		return null;
	}
}

/** Ensure `<dir>/.credentials.json` exists: copy the ~/.claude file when present,
 *  otherwise export from the macOS Keychain. The file WINS over the Keychain in
 *  Claude Code's own resolution, which is what makes per-dir accounts work. */
async function ensureClaudeCredentialsFile(dir: string, paths: AccountPaths): Promise<boolean> {
	const target = join(dir, ".credentials.json");
	if (existsSync(target)) return true;
	const homeFile = join(paths.claudeHome, ".credentials.json");
	if (existsSync(homeFile)) {
		copyFileSync(homeFile, target);
		chmodSync(target, 0o600);
		return true;
	}
	const fromKeychain = await readClaudeKeychainCredentials();
	if (fromKeychain) {
		writeFileSync(target, fromKeychain, { mode: 0o600 });
		chmodSync(target, 0o600);
		return true;
	}
	return false;
}

function assertNoDuplicate(
	registry: Registry,
	kind: AgentAccountKind,
	identity: AgentAccountIdentity | null,
	paths: AccountPaths,
	excludeId?: string,
): void {
	if (!identity?.accountId) return;
	for (const entry of registry[kind].accounts) {
		if (entry.id === excludeId) continue;
		const existing = kind === "claude" ? claudeAccountIdentity(entry.id, paths) : codexAccountIdentity(entry.id, paths);
		// Codex account_id is the selected ChatGPT workspace, not the person. The
		// same email/chatgpt_user_id may therefore own several valid accounts.
		const isDuplicate =
			kind === "codex"
				? existing?.accountId === identity.accountId
				: existing?.accountId === identity.accountId &&
					(existing.organization ?? null) === (identity.organization ?? null);
		if (!isDuplicate) continue;
		if (kind === "codex") {
			throw new Error(`This Codex workspace is already added ("${entry.label}")`);
		}
		throw new Error(`This account is already added ("${entry.label}")`);
	}
}

function registerAccount(
	registry: Registry,
	kind: AgentAccountKind,
	id: string,
	identity: AgentAccountIdentity | null,
	paths: AccountPaths,
	opts?: { auth?: AgentAccountAuth; label?: string },
): AgentAccount {
	let label = opts?.label ?? defaultAccountLabel(identity, registry[kind].accounts.length + 1);
	// Same login email may represent several Claude organizations or Codex
	// workspaces. Append the provider-specific discriminator to later rows.
	if (!opts?.label && identity?.email) {
		const emailTaken = registry[kind].accounts.some((existing) => {
			const other = kind === "claude" ? claudeAccountIdentity(existing.id, paths) : codexAccountIdentity(existing.id, paths);
			return other?.email === identity.email;
		});
		if (emailTaken && kind === "codex") {
			const workspaceId = shortCodexWorkspaceId(identity);
			if (workspaceId) label = `${identity.email} (Workspace ${workspaceId})`;
		} else if (emailTaken && identity.organization) {
			label = `${identity.email} (${identity.organization})`;
		}
	}
	const entry: RegistryEntry = {
		id,
		label,
		auth: opts?.auth === "api" ? "api" : undefined,
		createdAt: Date.now(),
	};
	registry[kind].accounts.push(entry);
	saveRegistry(registry, paths);
	return toAccount(entry, kind, paths);
}

/** Import the login currently active in ~/.claude as a managed account. */
export async function importCurrentClaudeAccount(paths: AccountPaths = defaultAccountPaths()): Promise<AgentAccount> {
	const claudeJson = safeReadJson(paths.claudeJson);
	const identity = parseClaudeIdentity(claudeJson);
	if (!identity) {
		throw new Error("No Claude Code login found (~/.claude.json has no account info). Run `claude` and log in first.");
	}
	const registry = loadRegistry(paths);
	assertNoDuplicate(registry, "claude", identity, paths);

	const id = crypto.randomUUID();
	const dir = claudeAccountDir(id, paths);
	scaffoldClaudeAccountDir(dir, paths);
	copyFileSync(paths.claudeJson, join(dir, ".claude.json"));
	if (!(await ensureClaudeCredentialsFile(dir, paths))) {
		rmSync(dir, { recursive: true, force: true });
		throw new Error("Could not read Claude Code credentials (no ~/.claude/.credentials.json and Keychain read failed).");
	}
	return registerAccount(registry, "claude", id, identity, paths);
}

export interface ClaudeApiProfileInput {
	label?: string;
	baseUrl?: string;
	apiKey?: string;
	/** Master override: one model id for every alias slot. */
	model?: string;
	/** Per-slot overrides (id + optional display name/description). */
	slotModels?: ClaudeSlotModels;
	env?: Record<string, string>;
}

/** Seed a fresh per-account .claude.json from the system one: keeps onboarding
 *  state, drops the identity. Shared by the login flow and API profiles. */
function seedClaudeJson(paths: AccountPaths): Record<string, unknown> {
	const seed = safeReadJson(paths.claudeJson);
	const seeded: Record<string, unknown> =
		seed && typeof seed === "object" && !Array.isArray(seed) ? { ...(seed as Record<string, unknown>) } : { hasCompletedOnboarding: true };
	delete seeded.oauthAccount;
	return seeded;
}

/** Pre-approve an API key in a seeded `.claude.json` so Claude Code skips its
 *  "detected an API key, use it?" prompt (the approval list stores the key's
 *  last 20 characters). Mutates `seeded` in place. */
function approveApiKeyTail(seeded: Record<string, unknown>, apiKey: string): void {
	const responses =
		seeded.customApiKeyResponses && typeof seeded.customApiKeyResponses === "object" && !Array.isArray(seeded.customApiKeyResponses)
			? { ...(seeded.customApiKeyResponses as Record<string, unknown>) }
			: {};
	const approved = Array.isArray(responses.approved) ? [...responses.approved] : [];
	const tail = apiKey.slice(-20);
	if (!approved.includes(tail)) approved.push(tail);
	seeded.customApiKeyResponses = { ...responses, approved };
}

function validateBaseUrl(baseUrl: string | null): void {
	if (!baseUrl) return;
	try {
		new URL(baseUrl);
	} catch {
		throw new Error(`Invalid base URL: ${baseUrl}`);
	}
}

/** Add an API profile: no login at all — the profile carries ANTHROPIC_* env
 *  (and arbitrary extra vars, e.g. CLAUDE_CODE_USE_BEDROCK=1 + AWS_*) that get
 *  injected into new sessions alongside its own CLAUDE_CONFIG_DIR. */
export async function addClaudeApiProfile(
	input: ClaudeApiProfileInput,
	paths: AccountPaths = defaultAccountPaths(),
): Promise<AgentAccount> {
	const baseUrl = input.baseUrl?.trim() || null;
	const apiKey = input.apiKey?.trim() || null;
	const model = input.model?.trim() || null;
	const slotModels = parseSlotModels(input.slotModels);
	const env = input.env ?? {};
	if (!baseUrl && !apiKey && Object.keys(env).length === 0) {
		throw new Error("Provide an API key, a base URL, or environment variables.");
	}
	validateBaseUrl(baseUrl);

	const registry = loadRegistry(paths);
	const id = crypto.randomUUID();
	const dir = claudeAccountDir(id, paths);
	scaffoldClaudeAccountDir(dir, paths);

	const seeded = seedClaudeJson(paths);
	if (apiKey) approveApiKeyTail(seeded, apiKey);
	writeFileSync(join(dir, ".claude.json"), JSON.stringify(seeded, null, 2));

	const profile: ApiProfileFile = { baseUrl, apiKey, model, slotModels, env };
	writeFileSync(apiProfileFile(id, paths), JSON.stringify(profile, null, 2), { mode: 0o600 });
	chmodSync(apiProfileFile(id, paths), 0o600);

	const apiOrdinal = registry.claude.accounts.filter((e) => e.auth === "api").length + 1;
	const label = input.label?.trim() || defaultApiProfileLabel(baseUrl, apiOrdinal);
	return registerAccount(registry, "claude", id, null, paths, { auth: "api", label });
}

/** Editable snapshot of an API profile for the settings form. Includes the API
 *  key value: it is the user's own key and the form shows it (masked, with a
 *  reveal toggle). It travels only in this on-demand draft, never in the bulk
 *  `listAgentAccounts` state. */
export interface ClaudeApiProfileDraft {
	label: string;
	baseUrl: string;
	apiKey: string;
	model: string;
	slotModels: ClaudeSlotModels;
	/** Extra env vars as newline-joined KEY=value lines (empty when none). */
	envText: string;
	hasApiKey: boolean;
}

export async function getClaudeApiProfileDraft(
	accountId: string,
	paths: AccountPaths = defaultAccountPaths(),
): Promise<ClaudeApiProfileDraft> {
	const registry = loadRegistry(paths);
	const entry = registry.claude.accounts.find((e) => e.id === accountId);
	if (!entry) throw new Error(`Unknown Claude account: ${accountId}`);
	if (entry.auth !== "api") throw new Error("Only API profiles can be edited this way");
	const profile = readApiProfile(accountId, paths);
	const envText = profile
		? Object.entries(profile.env)
				.map(([k, v]) => `${k}=${v}`)
				.join("\n")
		: "";
	return {
		label: entry.label,
		baseUrl: profile?.baseUrl ?? "",
		apiKey: profile?.apiKey ?? "",
		model: profile?.model ?? "",
		slotModels: profile?.slotModels ?? {},
		envText,
		hasApiKey: !!profile?.apiKey,
	};
}

/** Edit an existing API profile in place. `apiKey === undefined` keeps the
 *  stored key untouched (the form prefills the key, so it normally sends it);
 *  `baseUrl`, `model`, `slotModels` and `env` are full replacements; an empty
 *  `label` keeps the current one. */
export async function updateClaudeApiProfile(
	accountId: string,
	input: ClaudeApiProfileInput,
	paths: AccountPaths = defaultAccountPaths(),
): Promise<AgentAccount> {
	const registry = loadRegistry(paths);
	const entry = registry.claude.accounts.find((e) => e.id === accountId);
	if (!entry) throw new Error(`Unknown Claude account: ${accountId}`);
	if (entry.auth !== "api") throw new Error("Only API profiles can be edited this way");

	const existing = readApiProfile(accountId, paths);
	const baseUrl = input.baseUrl?.trim() || null;
	const model = input.model?.trim() || null;
	const slotModels = input.slotModels !== undefined ? parseSlotModels(input.slotModels) : (existing?.slotModels ?? {});
	const env = input.env ?? existing?.env ?? {};
	// undefined → keep the stored key; a provided string replaces it (empty clears).
	const apiKey = input.apiKey === undefined ? (existing?.apiKey ?? null) : (input.apiKey.trim() || null);

	if (!baseUrl && !apiKey && Object.keys(env).length === 0) {
		throw new Error("Provide an API key, a base URL, or environment variables.");
	}
	validateBaseUrl(baseUrl);

	const dir = claudeAccountDir(accountId, paths);
	const seededRaw = safeReadJson(join(dir, ".claude.json"));
	const seeded: Record<string, unknown> =
		seededRaw && typeof seededRaw === "object" && !Array.isArray(seededRaw)
			? { ...(seededRaw as Record<string, unknown>) }
			: seedClaudeJson(paths);
	if (apiKey) approveApiKeyTail(seeded, apiKey);
	writeFileSync(join(dir, ".claude.json"), JSON.stringify(seeded, null, 2));

	const profile: ApiProfileFile = { baseUrl, apiKey, model, slotModels, env };
	writeFileSync(apiProfileFile(accountId, paths), JSON.stringify(profile, null, 2), { mode: 0o600 });
	chmodSync(apiProfileFile(accountId, paths), 0o600);

	entry.label = input.label?.trim() || entry.label;
	saveRegistry(registry, paths);
	return toAccount(entry, "claude", paths);
}

/** Scaffold a fresh config dir for a new login and return the command to run.
 *  The dir is NOT registered until the login is verified (completeClaudeLogin). */
export async function prepareClaudeLogin(paths: AccountPaths = defaultAccountPaths()): Promise<{ accountId: string; loginCommand: string }> {
	const id = crypto.randomUUID();
	const dir = claudeAccountDir(id, paths);
	scaffoldClaudeAccountDir(dir, paths);
	// Seed .claude.json without the identity — its presence after the login is
	// how completeClaudeLogin verifies success.
	writeFileSync(join(dir, ".claude.json"), JSON.stringify(seedClaudeJson(paths), null, 2));
	return { accountId: id, loginCommand: `CLAUDE_CONFIG_DIR='${dir}' claude /login` };
}

/** Verify a prepared login dir and register it as an account. */
export async function completeClaudeLogin(accountId: string, paths: AccountPaths = defaultAccountPaths()): Promise<AgentAccount> {
	const dir = claudeAccountDir(accountId, paths);
	const identity = parseClaudeIdentity(safeReadJson(join(dir, ".claude.json")));
	if (!identity) {
		throw new Error("Login not detected yet. Run the login command, finish the OAuth flow, then verify again.");
	}
	const registry = loadRegistry(paths);
	assertNoDuplicate(registry, "claude", identity, paths, accountId);
	if (!(await ensureClaudeCredentialsFile(dir, paths))) {
		throw new Error("Login detected but credentials are missing. Finish the login in the terminal, then verify again.");
	}
	if (registry.claude.accounts.some((e) => e.id === accountId)) {
		saveRegistry(registry, paths);
		return toAccount(registry.claude.accounts.find((e) => e.id === accountId)!, "claude", paths);
	}
	return registerAccount(registry, "claude", accountId, identity, paths);
}

/** Import the login currently in ~/.codex/auth.json as a managed snapshot. */
export async function importCurrentCodexAccount(paths: AccountPaths = defaultAccountPaths()): Promise<AgentAccount> {
	const authFile = join(paths.codexHome, "auth.json");
	const identity = parseCodexIdentity(safeReadJson(authFile));
	if (!identity?.accountId) {
		throw new Error("No Codex login found (~/.codex/auth.json missing or not a ChatGPT login). Run `codex login` first.");
	}
	const registry = loadRegistry(paths);
	assertNoDuplicate(registry, "codex", identity, paths);

	const id = crypto.randomUUID();
	ensureCodexAccountHome(id, paths);
	const target = codexAccountAuthFile(id, paths);
	copyFileSync(authFile, target);
	chmodSync(target, 0o600);
	const account = registerAccount(registry, "codex", id, identity, paths);
	registry.codex.activeId = id; // newly imported becomes the default preselect
	saveRegistry(registry, paths);
	return account;
}

/** Scaffold a fresh CODEX_HOME for a new login and return the command to run.
 *  The dir is NOT registered until the login is verified (completeCodexLogin) —
 *  the user's ~/.codex is never touched, mirroring the Claude login flow. */
export async function prepareCodexLogin(paths: AccountPaths = defaultAccountPaths()): Promise<{ accountId: string; loginCommand: string }> {
	const id = crypto.randomUUID();
	const dir = ensureCodexAccountHome(id, paths);
	return { accountId: id, loginCommand: `CODEX_HOME='${dir}' codex login` };
}

/** Verify a prepared CODEX_HOME login dir and register it as an account. */
export async function completeCodexLogin(accountId: string, paths: AccountPaths = defaultAccountPaths()): Promise<AgentAccount> {
	const authFile = codexAccountAuthFile(accountId, paths);
	const identity = parseCodexIdentity(safeReadJson(authFile));
	if (!identity?.accountId) {
		throw new Error("Login not detected yet. Run the login command, finish the flow, then verify again.");
	}
	const registry = loadRegistry(paths);
	assertNoDuplicate(registry, "codex", identity, paths, accountId);
	chmodSync(authFile, 0o600);
	if (registry.codex.accounts.some((e) => e.id === accountId)) {
		saveRegistry(registry, paths);
		return toAccount(registry.codex.accounts.find((e) => e.id === accountId)!, "codex", paths);
	}
	const account = registerAccount(registry, "codex", accountId, identity, paths);
	registry.codex.activeId = accountId; // newly added becomes the default preselect
	saveRegistry(registry, paths);
	return account;
}

/** Claude activation is registry-only: new sessions pick up CLAUDE_CONFIG_DIR. */
export async function setActiveClaudeAccount(accountId: string | null, paths: AccountPaths = defaultAccountPaths()): Promise<void> {
	const registry = loadRegistry(paths);
	if (accountId !== null && !registry.claude.accounts.some((e) => e.id === accountId)) {
		throw new Error(`Unknown Claude account: ${accountId}`);
	}
	registry.claude.activeId = accountId;
	saveRegistry(registry, paths);
}

/** Codex activation is now registry-only — it just moves the default pointer.
 *  Each launch injects its own CODEX_HOME (getActiveCodexSessionEnv), so nothing
 *  swaps ~/.codex/auth.json anymore. `null` → the system login (~/.codex) is the
 *  default. Concurrent sessions on different accounts are therefore possible. */
export async function setActiveCodexAccount(accountId: string | null, paths: AccountPaths = defaultAccountPaths()): Promise<void> {
	const registry = loadRegistry(paths);
	if (accountId !== null && !registry.codex.accounts.some((e) => e.id === accountId)) {
		throw new Error(`Unknown Codex account: ${accountId}`);
	}
	registry.codex.activeId = accountId;
	saveRegistry(registry, paths);
	log.info("Codex default account set", { accountId });
}

/** Remove a managed account (stored snapshot/config dir). The provider-side
 *  login is untouched; for Codex the current ~/.codex/auth.json stays as-is. */
export async function removeAgentAccount(kind: AgentAccountKind, accountId: string, paths: AccountPaths = defaultAccountPaths()): Promise<void> {
	const registry = loadRegistry(paths);
	registry[kind].accounts = registry[kind].accounts.filter((e) => e.id !== accountId);
	if (registry[kind].activeId === accountId) registry[kind].activeId = null;
	saveRegistry(registry, paths);
	const dir = kind === "claude" ? claudeAccountDir(accountId, paths) : codexAccountDir(accountId, paths);
	rmSync(dir, { recursive: true, force: true });
}

export async function renameAgentAccount(kind: AgentAccountKind, accountId: string, label: string, paths: AccountPaths = defaultAccountPaths()): Promise<void> {
	const trimmed = label.trim();
	if (!trimmed) throw new Error("Label cannot be empty");
	const registry = loadRegistry(paths);
	const entry = registry[kind].accounts.find((e) => e.id === accountId);
	if (!entry) throw new Error(`Unknown ${kind} account: ${accountId}`);
	entry.label = trimmed;
	saveRegistry(registry, paths);
}
