/**
 * Agent account switcher — storage + swap mechanics (bun process only).
 *
 * On-disk layout (additive tree under ~/.dev3.0/, never renamed/migrated):
 *   ~/.dev3.0/agent-accounts/accounts.json        — registry (labels, active ids)
 *   ~/.dev3.0/agent-accounts/claude/<id>/          — full CLAUDE_CONFIG_DIR per account
 *       .claude.json                               — per-account identity/trust/onboarding
 *       .credentials.json                          — per-account OAuth token (0600)
 *       everything else                            — symlinks into ~/.claude,
 *                                                    minus CLAUDE_PRIVATE_ENTRIES
 *   ~/.dev3.0/agent-accounts/codex/<id>/auth.json  — per-account snapshot of ~/.codex/auth.json
 *   ~/.dev3.0/agent-accounts/omp-accounts.json     — omp registry (own file: older builds
 *                                                    rewrite accounts.json and would drop it)
 *   ~/.dev3.0/agent-accounts/omp/<id>/             — PI_CODING_AGENT_DIR per account: its own
 *                                                    agent.db + sessions, the rest symlinked
 *                                                    from ~/.omp/agent
 *   ~/.dev3.0/agent-accounts/pi-accounts.json      — pi registry (own file, same reason)
 *   ~/.dev3.0/agent-accounts/pi/<id>/              — PI_CODING_AGENT_DIR per account: its own
 *                                                    auth.json + sessions, the rest symlinked
 *                                                    from ~/.pi/agent
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
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
	AccountLoginPendingReason,
	AgentAccount,
	AgentAccountAuth,
	AgentAccountKind,
	AgentAccountsState,
	AgentAccountIdentity,
	AgentApiProfileInfo,
	AgentDirAccountKind,
	ClaudeSlotModel,
	ClaudeSlotModels,
	ProviderLogin,
} from "../shared/agent-accounts";
import {
	CLAUDE_MODEL_SLOTS,
	DEV3_AGENT_ACCOUNT_ID_ENV,
	ENV_UNSET,
	claudeApiProfileEnvKeys,
	defaultAccountLabel,
	defaultApiProfileLabel,
	AGENT_DIR_ACCOUNT_KINDS,
	isAgentDirAccountKind,
	parseClaudeIdentity,
	parseCodexIdentity,
	parseOmpAccounts,
	parsePiAuthLogins,
	providerLoginsIdentity,
	shortCodexWorkspaceId,
} from "../shared/agent-accounts";
import { writePiLoginExtension } from "../shared/pi-login-extension";
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
	/** ~/.omp/agent — omp's default agent dir, the source of shared entries. */
	ompAgentHome?: string;
	/** ~/.pi/agent — pi's default agent dir, the source of shared entries. */
	piAgentHome?: string;
}

export function defaultAccountPaths(): AccountPaths {
	const home = homedir();
	return {
		accountsDir: join(DEV3_HOME, "agent-accounts"),
		claudeHome: join(home, ".claude"),
		claudeJson: join(home, ".claude.json"),
		codexHome: join(home, ".codex"),
		ompAgentHome: join(home, ".omp", "agent"),
		piAgentHome: join(home, ".pi", "agent"),
	};
}

/** Every entry of ~/.claude is symlinked into each account dir EXCEPT these.
 *  Sharing is the default because it is already the proven behaviour: with the
 *  switcher off, every agent on the machine runs on ~/.claude directly and
 *  writes to the same sessions/cache/history. An allow-list instead lost the
 *  race against Claude Code releases — it silently missed `output-styles`, and
 *  `workflows`/`routines` were next (cli.js resolves six resource types by name
 *  out of its config dir). Only what makes an account BE an account stays
 *  private: its login, its identity, its usage and its org policy. */
export const CLAUDE_PRIVATE_ENTRIES = [
	".credentials.json",
	".claude.json",
	"stats-cache.json",
	"policy-limits.json",
	"statsig",
];

/** Safety net for files Claude Code has not shipped yet: never share anything
 *  credential-shaped, even when CLAUDE_PRIVATE_ENTRIES forgets to name it. */
const CLAUDE_PRIVATE_PATTERNS = [/credential/i, /^auth/i, /token/i, /\.key$/i];

/** OS junk — no reason to share, just noise in the account dir. */
const CLAUDE_IGNORED_ENTRIES = [".DS_Store", ".localized"];

export function isPrivateClaudeEntry(entry: string): boolean {
	if (CLAUDE_PRIVATE_ENTRIES.includes(entry)) return true;
	return CLAUDE_PRIVATE_PATTERNS.some((pattern) => pattern.test(entry));
}

/** Entries of ~/.codex shared across per-account CODEX_HOME dirs via symlinks:
 *  user configuration (config.toml) and prompts. auth.json stays per-account (it
 *  is the whole point of the switch); sessions/history are created per-account so
 *  usage/rate-limit tracking can attribute them (see rate-limit-monitor). Missing
 *  source entries are simply skipped — a fresh codex install may have none. */
export const CODEX_SHARED_ENTRIES = ["config.toml", "prompts"];

/** What an agent-dir account (omp, pi) keeps to itself; every other entry of the
 *  harness's own agent dir (config, skills, extensions, …) is symlinked in. */
const AGENT_DIR_PRIVATE: Record<AgentDirAccountKind, { entries: string[]; patterns: RegExp[] }> = {
	// SQLite files never are shared: a database opened through a link gets its -wal beside the link.
	omp: {
		entries: ["sessions", "terminal-sessions", "cache", "blobs"],
		patterns: [/\.db(-wal|-shm|-journal)?$/i, /credential/i, /^auth/i, /token/i, /\.key$/i],
	},
	// models-store.json caches provider catalogs fetched with this account's own keys.
	pi: {
		entries: ["sessions", "models-store.json"],
		patterns: [/credential/i, /^auth/i, /token/i, /\.key$/i, /\.lock$/i, /\.log$/i],
	},
};

/** Entries an account starts with as a COPY of the user's own, then keeps.
 *  pi's /login persists the new provider's default model into settings.json, so a
 *  linked file would let adding an account rewrite the user's own pi default. */
const AGENT_DIR_SEEDED: Record<AgentDirAccountKind, string[]> = { omp: [], pi: ["settings.json"] };

export function isPrivateAgentDirEntry(kind: AgentDirAccountKind, entry: string): boolean {
	const { entries, patterns } = AGENT_DIR_PRIVATE[kind];
	return entries.includes(entry) || patterns.some((pattern) => pattern.test(entry));
}

interface RegistryEntry {
	id: string;
	label: string;
	/** Resolved ChatGPT workspace name for Codex accounts. Additive metadata;
	 *  older versions safely ignore it and the lookup can restore it. */
	workspaceName?: string;
	/** Absent = "oauth" (pre-API-profile registries stay readable as-is). */
	auth?: AgentAccountAuth;
	createdAt: number;
}

/** Kinds kept in accounts.json; omp and pi have their own registry files. */
type RegistryKind = Exclude<AgentAccountKind, AgentDirAccountKind>;

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
						workspaceName: typeof a.workspaceName === "string" && a.workspaceName.trim() ? a.workspaceName.trim() : undefined,
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

export function agentDirAccountDir(kind: AgentDirAccountKind, id: string, paths: AccountPaths = defaultAccountPaths()): string {
	assertSafeAccountId(id);
	return join(paths.accountsDir, kind, id);
}

interface AgentDirRegistryEntry {
	id: string;
	label: string;
	logins: ProviderLogin[];
	createdAt: number;
}

interface AgentDirRegistry {
	version: 1;
	activeId: string | null;
	accounts: AgentDirRegistryEntry[];
}

function agentDirRegistryFile(kind: AgentDirAccountKind, paths: AccountPaths): string {
	return join(paths.accountsDir, `${kind}-accounts.json`);
}

function storedProviderLogins(raw: unknown): ProviderLogin[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((row) => {
		const provider = typeof row?.provider === "string" && row.provider ? row.provider : null;
		if (!provider) return [];
		const authType = row.authType === "oauth" || row.authType === "api_key" ? row.authType : undefined;
		return [{
			provider,
			identityKey: typeof row.identityKey === "string" && row.identityKey ? row.identityKey : null,
			orgName: typeof row.orgName === "string" && row.orgName ? row.orgName : null,
			...(authType ? { authType } : {}),
		}];
	});
}

function loadAgentDirRegistry(kind: AgentDirAccountKind, paths: AccountPaths): AgentDirRegistry {
	const data = safeReadJson(agentDirRegistryFile(kind, paths)) as { activeId?: unknown; accounts?: unknown } | null;
	const accounts = Array.isArray(data?.accounts)
		? (data.accounts as any[])
				.filter((a) => typeof a?.id === "string" && isSafeAccountId(a.id))
				.map((a) => ({
					id: a.id as string,
					label: typeof a.label === "string" ? a.label : a.id,
					logins: storedProviderLogins(a.logins),
					createdAt: typeof a.createdAt === "number" ? a.createdAt : 0,
				}))
		: [];
	return { version: 1, activeId: typeof data?.activeId === "string" ? data.activeId : null, accounts };
}

function saveAgentDirRegistry(kind: AgentDirAccountKind, registry: AgentDirRegistry, paths: AccountPaths): void {
	mkdirSync(paths.accountsDir, { recursive: true });
	const target = agentDirRegistryFile(kind, paths);
	const tmp = `${target}.tmp`;
	writeFileSync(tmp, JSON.stringify(registry, null, 2));
	renameSync(tmp, target);
}

function agentDirToAccount(kind: AgentDirAccountKind, entry: AgentDirRegistryEntry): AgentAccount {
	return {
		id: entry.id,
		kind,
		label: entry.label,
		identity: providerLoginsIdentity(entry.logins),
		auth: "oauth",
		api: null,
		providerLogins: entry.logins,
		createdAt: entry.createdAt,
	};
}

function agentDirSourceHome(kind: AgentDirAccountKind, paths: AccountPaths): string {
	return (kind === "omp" ? paths.ompAgentHome : paths.piAgentHome) ?? join(homedir(), `.${kind}`, "agent");
}

/** Make the account dir a usable PI_CODING_AGENT_DIR: create it and symlink
 *  every non-private entry of the harness's own agent dir, so the user's config
 *  and dev3's skills stay visible. Idempotent and re-run per launch to pick up
 *  new entries; an entry already present in the account dir is never replaced. */
function scaffoldAgentDirAccount(kind: AgentDirAccountKind, id: string, paths: AccountPaths): string {
	const dir = agentDirAccountDir(kind, id, paths);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const source = agentDirSourceHome(kind, paths);
	let entries: string[] = [];
	try {
		entries = readdirSync(source);
	} catch {
		return dir; // the harness never ran yet — nothing to share
	}
	for (const entry of entries) {
		if (isPrivateAgentDirEntry(kind, entry) || CLAUDE_IGNORED_ENTRIES.includes(entry)) continue;
		const target = join(dir, entry);
		try {
			lstatSync(target);
			continue;
		} catch {
			// missing — create below
		}
		const seeded = AGENT_DIR_SEEDED[kind].includes(entry);
		try {
			if (seeded) copyFileSync(join(source, entry), target);
			else symlinkSync(join(source, entry), target);
		} catch (err) {
			log.warn("Failed to share agent-dir entry", { kind, entry, seeded, error: String(err) });
		}
	}
	return dir;
}

const CODEX_ACCOUNTS_ENDPOINT = "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function jsonRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Resolve every ChatGPT workspace visible to a Codex OAuth token. The caller
 *  owns fallback behavior because this first-party endpoint is best-effort. */
export async function fetchCodexWorkspaceNames(
	authJson: unknown,
	fetchImpl: FetchLike = globalThis.fetch,
): Promise<Record<string, string>> {
	const root = jsonRecord(authJson);
	const tokens = jsonRecord(root?.tokens);
	const accessToken = nonEmptyString(tokens?.access_token);
	if (!accessToken) throw new Error("Codex access token is missing");

	const response = await fetchImpl(CODEX_ACCOUNTS_ENDPOINT, {
		headers: { authorization: `Bearer ${accessToken}` },
		signal: AbortSignal.timeout(5_000),
	});
	if (!response.ok) throw new Error(`ChatGPT workspace lookup failed (HTTP ${response.status})`);

	const payload = jsonRecord(await response.json());
	const accounts = jsonRecord(payload?.accounts);
	const names: Record<string, string> = {};
	for (const item of Object.values(accounts ?? {})) {
		const account = jsonRecord(jsonRecord(item)?.account);
		const accountId = nonEmptyString(account?.account_id);
		const name = nonEmptyString(account?.name);
		if (accountId && name) names[accountId] = name;
	}
	return names;
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

/** Identity of the Claude login stored in a `CLAUDE_CONFIG_DIR`. Claude Code keeps
 *  `.claude.json` inside that directory when the variable is set. */
export function readClaudeConfigDirIdentity(configDir: string): AgentAccountIdentity | null {
	return parseClaudeIdentity(safeReadJson(join(configDir, ".claude.json")));
}

function withCodexWorkspaceName(
	identity: AgentAccountIdentity | null,
	workspaceName: string | null | undefined,
): AgentAccountIdentity | null {
	return identity && workspaceName ? { ...identity, organization: workspaceName } : identity;
}

async function lookupCodexWorkspaceNames(authJson: unknown): Promise<Record<string, string>> {
	const selected = parseCodexIdentity(authJson);
	try {
		const names = await fetchCodexWorkspaceNames(authJson);
		log.info("Codex workspace lookup succeeded", {
			selectedWorkspaceId: shortCodexWorkspaceId(selected),
			selectedWorkspaceName: selected?.accountId ? names[selected.accountId] ?? null : null,
			workspaceCount: Object.keys(names).length,
		});
		return names;
	} catch (error) {
		log.warn("Codex workspace lookup unavailable; using id fallback", {
			selectedWorkspaceId: shortCodexWorkspaceId(selected),
			error: String(error),
		});
		return {};
	}
}

function applyCodexWorkspaceNames(
	registry: Registry,
	names: Record<string, string>,
	paths: AccountPaths,
): boolean {
	let changed = false;
	for (const entry of registry.codex.accounts) {
		const identity = parseCodexIdentity(safeReadJson(codexAccountAuthFile(entry.id, paths)));
		const name = identity?.accountId ? names[identity.accountId] ?? entry.workspaceName : null;
		if (!name) continue;
		if (entry.workspaceName !== name) {
			entry.workspaceName = name;
			changed = true;
		}
		const workspaceId = shortCodexWorkspaceId(identity);
		const email = identity?.email;
		const legacyAutoLabel = email && workspaceId ? `${email} (Workspace ${workspaceId})` : null;
		if (legacyAutoLabel && entry.label === legacyAutoLabel) {
			entry.label = `${email} (${name})`;
			changed = true;
		}
	}
	return changed;
}

const codexWorkspaceBackfills = new Map<string, Promise<void>>();

async function backfillCodexWorkspaceNames(registry: Registry, paths: AccountPaths): Promise<void> {
	const missingWorkspaceIds = registry.codex.accounts
		.filter((entry) => !entry.workspaceName)
		.map((entry) => codexAccountIdentity(entry.id, paths)?.accountId ?? entry.id)
		.sort();
	if (missingWorkspaceIds.length === 0) return;
	const key = `${paths.accountsDir}:${missingWorkspaceIds.join(",")}`;
	let pending = codexWorkspaceBackfills.get(key);
	if (!pending) {
		pending = (async () => {
			const source = registry.codex.accounts.find((entry) => existsSync(codexAccountAuthFile(entry.id, paths)));
			if (!source) return;
			const authJson = safeReadJson(codexAccountAuthFile(source.id, paths));
			const names = await lookupCodexWorkspaceNames(authJson);
			if (applyCodexWorkspaceNames(registry, names, paths)) saveRegistry(registry, paths);
		})();
		codexWorkspaceBackfills.set(key, pending);
	}
	await pending;
}

function claudeAccountIdentity(id: string, paths: AccountPaths): AgentAccountIdentity | null {
	return parseClaudeIdentity(safeReadJson(join(claudeAccountDir(id, paths), ".claude.json")));
}

function codexAccountIdentity(id: string, paths: AccountPaths, workspaceName?: string): AgentAccountIdentity | null {
	return withCodexWorkspaceName(parseCodexIdentity(safeReadJson(codexAccountAuthFile(id, paths))), workspaceName);
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

function toAccount(entry: RegistryEntry, kind: RegistryKind, paths: AccountPaths): AgentAccount {
	const isApi = kind === "claude" && entry.auth === "api";
	return {
		id: entry.id,
		kind,
		label: entry.label,
		identity: isApi
			? null
			: kind === "claude"
				? claudeAccountIdentity(entry.id, paths)
				: codexAccountIdentity(entry.id, paths, entry.workspaceName),
		auth: isApi ? "api" : "oauth",
		api: isApi ? apiProfileInfo(readApiProfile(entry.id, paths)) : null,
		createdAt: entry.createdAt,
	};
}

function currentCodexIdentity(paths: AccountPaths, registry: Registry): AgentAccountIdentity | null {
	const identity = parseCodexIdentity(safeReadJson(join(paths.codexHome, "auth.json")));
	if (!identity?.accountId) return identity;
	const matchingEntry = registry.codex.accounts.find((entry) => {
		return codexAccountIdentity(entry.id, paths)?.accountId === identity.accountId;
	});
	return withCodexWorkspaceName(identity, matchingEntry?.workspaceName);
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

/** Snapshot only a registered managed home; custom homes retain their explicit config. */
export function codexAccountIdForHome(home: string | undefined, paths: AccountPaths = defaultAccountPaths()): string | undefined {
	if (!home) return undefined;
	const matched = listCodexAccountDirs(paths).find((dir) => resolve(dir) === resolve(home));
	return matched ? basename(matched) : undefined;
}

/** Absolute dirs of every managed Claude account. The rate-limit monitor uses
 * these to locate account-attributed statusline snapshots. */
export function listClaudeAccountDirs(paths: AccountPaths = defaultAccountPaths()): string[] {
	try {
		return loadRegistry(paths).claude.accounts.map((e) => claudeAccountDir(e.id, paths));
	} catch {
		return [];
	}
}

/** Absolute dirs of every managed omp/pi account (each a per-account agent dir
 * with private sessions). Best-effort: [] when the registry is unreadable. */
export function listAgentDirAccountDirs(kind: AgentDirAccountKind, paths: AccountPaths = defaultAccountPaths()): string[] {
	try {
		return loadAgentDirRegistry(kind, paths).accounts.map((e) => agentDirAccountDir(kind, e.id, paths));
	} catch {
		return [];
	}
}

export async function listAgentAccounts(paths: AccountPaths = defaultAccountPaths()): Promise<AgentAccountsState> {
	let registry = loadRegistry(paths);
	if (applyCodexWorkspaceNames(registry, {}, paths)) saveRegistry(registry, paths);
	await backfillCodexWorkspaceNames(registry, paths);
	registry = loadRegistry(paths);
	return {
		claude: {
			accounts: registry.claude.accounts.map((e) => toAccount(e, "claude", paths)),
			activeId: registry.claude.accounts.some((e) => e.id === registry.claude.activeId) ? registry.claude.activeId : null,
			systemConfigDir: paths.claudeHome,
			systemIdentity: parseClaudeIdentity(safeReadJson(paths.claudeJson)),
		},
		codex: {
			accounts: registry.codex.accounts.map((e) => toAccount(e, "codex", paths)),
			activeId: registry.codex.accounts.some((e) => e.id === registry.codex.activeId) ? registry.codex.activeId : null,
			currentIdentity: currentCodexIdentity(paths, registry),
		},
		omp: agentDirAccountsState("omp", paths),
		pi: agentDirAccountsState("pi", paths),
	};
}

function agentDirAccountsState(kind: AgentDirAccountKind, paths: AccountPaths): AgentAccountsState[AgentDirAccountKind] {
	const registry = loadAgentDirRegistry(kind, paths);
	return {
		accounts: registry.accounts.map((entry) => agentDirToAccount(kind, entry)),
		activeId: registry.accounts.some((e) => e.id === registry.activeId) ? registry.activeId : null,
	};
}

/** Resolve a per-launch account override against a provider's registry default.
 *  `accountIdOverride === undefined` → the default (`activeId`, i.e. the
 *  preselect); `null` → force the system login (~/.claude / ~/.codex); a string →
 *  that specific managed account. Shared by both providers' env resolution. */
function resolveAccountIdOverride(activeId: string | null, accountIdOverride: string | null | undefined): string | null {
	return accountIdOverride === undefined ? activeId : accountIdOverride;
}

/** The account a launch really lands on once the default is applied: a managed
 *  id that exists, or null for the system login. What a pane records so a resume
 *  cannot drift onto whatever the default became since. */
export function effectiveAccountId(
	kind: AgentAccountKind,
	accountIdOverride: string | null | undefined,
	paths: AccountPaths = defaultAccountPaths(),
): string | null {
	const r = isAgentDirAccountKind(kind) ? loadAgentDirRegistry(kind, paths) : loadRegistry(paths)[kind];
	const activeId = r.activeId;
	const ids = r.accounts.map((e) => e.id);
	const id = resolveAccountIdOverride(activeId, accountIdOverride);
	return id && ids.includes(id) ? id : null;
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
	if (!existsSync(join(dir, ".claude.json"))) return null;
	scaffoldClaudeAccountDir(dir, paths); // backfill entries added since this account was created
	return dir;
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
	let selectedDir: string | null = null;
	if (entry) {
		const dir = claudeAccountDir(entry.id, paths);
		if (existsSync(join(dir, ".claude.json"))) {
			selectedDir = dir;
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
	// This is deliberately unset for the system login and for a missing account
	// snapshot, so a long-lived tmux server cannot attribute a later system-login
	// session to the account that was selected before it.
	if (registry.claude.accounts.length > 0) {
		env[DEV3_AGENT_ACCOUNT_ID_ENV] = selectedDir && entry ? entry.id : ENV_UNSET;
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

/** PI_CODING_AGENT_DIR for a new omp or pi session. Same override semantics as
 *  Codex. omp and pi read the same variable, and a tmux session keeps whatever a
 *  previous launch in it set, so once an account of EITHER harness exists the
 *  system login actively unsets it — an omp account dir must never reach pi, nor
 *  a pi one omp. Empty record while neither has accounts (feature unused). */
export async function getActiveAgentDirSessionEnv(
	kind: AgentDirAccountKind,
	accountIdOverride?: string | null,
	paths: AccountPaths = defaultAccountPaths(),
): Promise<Record<string, string>> {
	const registry = loadAgentDirRegistry(kind, paths);
	const id = resolveAccountIdOverride(registry.activeId, accountIdOverride);
	if (id && registry.accounts.some((e) => e.id === id)) return { PI_CODING_AGENT_DIR: scaffoldAgentDirAccount(kind, id, paths) };
	const anyAccount = AGENT_DIR_ACCOUNT_KINDS.some((k) => (k === kind ? registry : loadAgentDirRegistry(k, paths)).accounts.length > 0);
	return anyAccount ? { PI_CODING_AGENT_DIR: ENV_UNSET } : {};
}

/** Create the per-account config dir, symlinking every non-private entry of
 *  ~/.claude into it. Idempotent and re-run on every account resolution, so an
 *  entry that appeared in ~/.claude after the account was created gets picked up
 *  instead of staying silently absent. An entry that already exists in the
 *  account dir is left exactly as it is — never replaced, never deleted, so
 *  real per-account state written by older builds survives untouched. */
function scaffoldClaudeAccountDir(dir: string, paths: AccountPaths): void {
	mkdirSync(dir, { recursive: true });
	let entries: string[] = [];
	try {
		entries = readdirSync(paths.claudeHome);
	} catch (err) {
		log.warn("Cannot read ~/.claude — account dir gets no shared entries", { error: String(err) });
	}
	for (const entry of entries) {
		if (isPrivateClaudeEntry(entry) || CLAUDE_IGNORED_ENTRIES.includes(entry)) continue;
		const linkPath = join(dir, entry);
		try {
			lstatSync(linkPath);
			continue; // already scaffolded, or real state from an older build
		} catch {
			// missing — create below
		}
		try {
			symlinkSync(join(paths.claudeHome, entry), linkPath);
		} catch (err) {
			log.warn("Failed to symlink shared claude entry", { entry, error: String(err) });
		}
	}
	warnOnUnresolvableOutputStyle(dir);
}

/** Output styles Claude Code ships in-binary — they need no config-dir file. */
const BUILTIN_OUTPUT_STYLES = new Set(["default", "explanatory", "learning", "proactive"]);

/** The name Claude Code registers a style file under: frontmatter `name` REPLACES
 *  the filename slug, it is not an alias for it (cli.js: `A.name ?? basename`).
 *  So `low-battery.md` with `name: Low Battery` is only reachable as "Low Battery". */
export function registeredOutputStyleName(file: string, contents: string): string {
	const slug = file.replace(/\.md$/, "");
	if (!contents.startsWith("---")) return slug;
	const end = contents.indexOf("\n---", 3);
	const frontmatter = end === -1 ? contents : contents.slice(0, end);
	const declared = /^name:[ \t]*(.+)$/m.exec(frontmatter)?.[1]?.trim().replace(/^["']|["']$/g, "");
	return declared || slug;
}

/** A settings.json `outputStyle` that resolves to nothing is always a config bug:
 *  Claude Code looks the name up as an exact map key and falls back to the default
 *  style without a single log line, so the setting looks correct while doing
 *  nothing. Only user-level styles are checked — a project `.claude/output-styles`
 *  could still define the name, hence the wording. */
function warnOnUnresolvableOutputStyle(dir: string): void {
	const configured = (safeReadJson(join(dir, "settings.json")) as { outputStyle?: unknown } | null)?.outputStyle;
	if (typeof configured !== "string" || !configured.trim()) return;
	const name = configured.trim();
	if (BUILTIN_OUTPUT_STYLES.has(name.toLowerCase())) return;

	const stylesDir = join(dir, "output-styles");
	let available: string[] = [];
	try {
		available = readdirSync(stylesDir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => registeredOutputStyleName(f, readFileSync(join(stylesDir, f), "utf-8")));
	} catch {
		// missing or unreadable dir → nothing resolves, reported below
	}
	if (available.includes(name)) return;
	log.warn("settings.json outputStyle matches no user-level output style — Claude Code will use the default", {
		outputStyle: name,
		available,
		dir,
	});
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

/** Written into every dir a sign-in stages, so an abandoned one is recognisably ours. */
export const STAGED_LOGIN_MARKER = ".dev3-staged-login";

function markStagedLogin(dir: string): void {
	writeFileSync(join(dir, STAGED_LOGIN_MARKER), JSON.stringify({ createdAt: Date.now() }));
}

function unmarkStagedLogin(dir: string): void {
	rmSync(join(dir, STAGED_LOGIN_MARKER), { force: true });
}

export type LoginPendingReason = AccountLoginPendingReason;

/** The provider has not finished the login (or it cannot be confirmed yet) — keep watching, not an error. */
export class LoginNotReadyError extends Error {
	constructor(message: string, readonly reason: LoginPendingReason | null = null) {
		super(message);
		this.name = "LoginNotReadyError";
	}
}

/** Env that authenticates Claude Code without the login being checked. Stripped from
 *  the sign-in and from its status probe, so neither can pass on a key from the env. */
export const CLAUDE_ENV_AUTH_KEYS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
] as const;

/** Same for Codex: an API key in the env would make `codex login` moot. */
export const CODEX_ENV_AUTH_KEYS = ["OPENAI_API_KEY", "CODEX_API_KEY"] as const;

/** `claude auth status` (JSON by default) output — never carries a token. Read from
 *  the 2.1.x binary: `{loggedIn, authMethod, apiProvider, configDirectory, email, …}`,
 *  `apiKeySource` only when a key source exists; exit 0 iff `loggedIn`. */
export interface ClaudeAuthStatus {
	loggedIn?: unknown;
	authMethod?: unknown;
	apiProvider?: unknown;
	apiKeySource?: unknown;
	configDirectory?: unknown;
	email?: unknown;
}

/** Runs `claude auth status` against `configDir`; null when it cannot run or is aborted. */
export type ClaudeAuthStatusProbe = (configDir: string, signal: AbortSignal) => Promise<{ exitCode: number | null; stdout: string } | null>;

export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatus | null {
	const start = stdout.indexOf("{");
	const end = stdout.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	try {
		const parsed = JSON.parse(stdout.slice(start, end + 1));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ClaudeAuthStatus) : null;
	} catch {
		return null;
	}
}

/**
 * Does the provider confirm THIS login in THIS dir? `loggedIn` alone is not enough:
 * Claude Code also reports it for an env API key, a cloud provider or an
 * apiKeyHelper. Accepted: a subscription login, or a Console login whose key
 * `/login` itself manages — first-party, in the staged dir, for the staged email.
 */
export function claudeAuthStatusMismatch(status: ClaudeAuthStatus, exitCode: number | null, dir: string, email: string | null): string | null {
	if (exitCode !== 0 || status.loggedIn !== true) return "not signed in";
	if (status.apiProvider !== "firstParty") return "not the Anthropic API";
	const subscription = status.authMethod === "claude.ai";
	const consoleLogin = status.authMethod === "api_key" && status.apiKeySource === "/login managed key";
	if (!subscription && !consoleLogin) return "not a /login sign-in";
	if (typeof status.configDirectory !== "string" || resolve(status.configDirectory) !== resolve(dir)) return "a different config folder";
	if (!email || status.email !== email) return "a different account";
	return null;
}

/** How a staged sign-in is launched; `env` is all that scopes it to its own dir. */
export interface AccountLoginLaunch {
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd: string;
}

export interface PreparedAccountLogin {
	accountId: string;
	loginCommand: string;
	launch: AccountLoginLaunch;
}

function assertNoDuplicate(
	registry: Registry,
	kind: RegistryKind,
	identity: AgentAccountIdentity | null,
	paths: AccountPaths,
	excludeId?: string,
): void {
	if (!identity?.accountId) return;
	for (const entry of registry[kind].accounts) {
		if (entry.id === excludeId) continue;
		const existing =
			kind === "claude"
				? claudeAccountIdentity(entry.id, paths)
				: codexAccountIdentity(entry.id, paths, entry.workspaceName);
		// Codex account_id is the selected ChatGPT workspace, not the person. The
		// same email/chatgpt_user_id may therefore own several valid accounts.
		const isDuplicate =
			kind === "codex"
				? existing?.accountId === identity.accountId
				: existing?.accountId === identity.accountId &&
					(existing.organization ?? null) === (identity.organization ?? null);
		if (!isDuplicate) continue;
		if (kind === "codex") {
			const workspaceId = shortCodexWorkspaceId(identity);
			const workspaceName = identity.organization ?? existing?.organization;
			const workspace = workspaceName
				? `"${workspaceName}"${workspaceId ? ` (${workspaceId})` : ""}`
				: workspaceId
					? `"${workspaceId}"`
					: "with an unknown id";
			log.warn("Codex workspace duplicate rejected", {
				workspaceId,
				workspaceName: workspaceName ?? null,
				existingAccountId: entry.id.slice(0, 8),
				existingLabel: entry.label,
			});
			throw new Error(`Codex workspace ${workspace} is already added as "${entry.label}".`);
		}
		throw new Error(`This account is already added ("${entry.label}")`);
	}
}

function registerAccount(
	registry: Registry,
	kind: RegistryKind,
	id: string,
	identity: AgentAccountIdentity | null,
	paths: AccountPaths,
	opts?: { auth?: AgentAccountAuth; label?: string; workspaceName?: string | null },
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
			const workspace = identity.organization ?? (workspaceId ? `Workspace ${workspaceId}` : null);
			if (workspace) label = `${identity.email} (${workspace})`;
		} else if (emailTaken && identity.organization) {
			label = `${identity.email} (${identity.organization})`;
		}
	}
	const entry: RegistryEntry = {
		id,
		label,
		workspaceName: kind === "codex" ? opts?.workspaceName ?? undefined : undefined,
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

/** Scaffold a fresh config dir for a new login and return how to run it.
 *  The dir is NOT registered until the login is verified (completeClaudeLogin). */
export async function prepareClaudeLogin(paths: AccountPaths = defaultAccountPaths()): Promise<PreparedAccountLogin> {
	const id = crypto.randomUUID();
	const dir = claudeAccountDir(id, paths);
	scaffoldClaudeAccountDir(dir, paths);
	// Seed .claude.json without the identity — its appearance is when
	// completeClaudeLogin starts asking `claude auth status`. The embedded terminal
	// runs in the staging dir itself, so pre-trust it: a folder-trust prompt there is noise.
	const seeded = seedClaudeJson(paths);
	const projects = seeded.projects && typeof seeded.projects === "object" && !Array.isArray(seeded.projects)
		? { ...(seeded.projects as Record<string, unknown>) }
		: {};
	projects[dir] = { ...(projects[dir] as Record<string, unknown> | undefined), hasTrustDialogAccepted: true };
	seeded.projects = projects;
	writeFileSync(join(dir, ".claude.json"), JSON.stringify(seeded, null, 2));
	markStagedLogin(dir);
	return {
		accountId: id,
		loginCommand: `CLAUDE_CONFIG_DIR='${dir}' claude /login`,
		launch: { command: "claude", args: ["/login"], env: { CLAUDE_CONFIG_DIR: dir }, cwd: dir },
	};
}

/** Verify a prepared login dir and register it as an account. */
/**
 * Verify a staged sign-in and register it. Success is the provider's own
 * `claude auth status` for the staged dir, strictly matched — never the identity
 * alone, and never credentials copied from the system login (on macOS the new
 * token lives in a Keychain item keyed to this dir, which Claude Code finds by
 * itself). `stillWanted` guards against a cancel that landed during the probe.
 */
export async function completeClaudeLogin(
	accountId: string,
	paths: AccountPaths,
	probe: ClaudeAuthStatusProbe,
	opts: { signal?: AbortSignal; stillWanted?: () => boolean } = {},
): Promise<AgentAccount> {
	const dir = claudeAccountDir(accountId, paths);
	const identity = parseClaudeIdentity(safeReadJson(join(dir, ".claude.json")));
	if (!identity) {
		throw new LoginNotReadyError("Login not detected yet. Finish the sign-in in the terminal.");
	}
	assertNoDuplicate(loadRegistry(paths), "claude", identity, paths, accountId);
	const result = await probe(dir, opts.signal ?? new AbortController().signal);
	const status = result ? parseClaudeAuthStatus(result.stdout) : null;
	if (!result || !status) {
		throw new LoginNotReadyError("dev3 couldn't confirm the sign-in with `claude auth status` yet.", "status-unavailable");
	}
	const mismatch = claudeAuthStatusMismatch(status, result.exitCode, dir, identity.email);
	if (mismatch) {
		log.info("Claude sign-in not confirmed by auth status", { pendingAccountId: accountId.slice(0, 8), mismatch });
		throw new LoginNotReadyError(`Claude Code reports ${mismatch} for this sign-in.`, "status-mismatch");
	}
	if (opts.stillWanted && !opts.stillWanted()) throw new LoginNotReadyError("This sign-in was closed.");
	// Reloaded after the probe: the registry may have changed while it ran.
	const registry = loadRegistry(paths);
	assertNoDuplicate(registry, "claude", identity, paths, accountId);
	if (registry.claude.accounts.some((e) => e.id === accountId)) {
		saveRegistry(registry, paths);
		return toAccount(registry.claude.accounts.find((e) => e.id === accountId)!, "claude", paths);
	}
	const account = registerAccount(registry, "claude", accountId, identity, paths);
	unmarkStagedLogin(dir);
	return account;
}

/** Import the login currently in ~/.codex/auth.json as a managed snapshot. */
export async function importCurrentCodexAccount(paths: AccountPaths = defaultAccountPaths()): Promise<AgentAccount> {
	const authFile = join(paths.codexHome, "auth.json");
	const authJson = safeReadJson(authFile);
	let identity = parseCodexIdentity(authJson);
	if (!identity?.accountId) {
		throw new Error("No Codex login found (~/.codex/auth.json missing or not a ChatGPT login). Run `codex login` first.");
	}
	const registry = loadRegistry(paths);
	const workspaceNames = await lookupCodexWorkspaceNames(authJson);
	const workspaceName = workspaceNames[identity.accountId] ?? null;
	identity = withCodexWorkspaceName(identity, workspaceName)!;
	if (applyCodexWorkspaceNames(registry, workspaceNames, paths)) saveRegistry(registry, paths);
	assertNoDuplicate(registry, "codex", identity, paths);

	const id = crypto.randomUUID();
	ensureCodexAccountHome(id, paths);
	const target = codexAccountAuthFile(id, paths);
	copyFileSync(authFile, target);
	chmodSync(target, 0o600);
	const account = registerAccount(registry, "codex", id, identity, paths, { workspaceName });
	registry.codex.activeId = id; // newly imported becomes the default preselect
	saveRegistry(registry, paths);
	log.info("Codex account imported", {
		accountId: id.slice(0, 8),
		workspaceId: shortCodexWorkspaceId(identity),
		workspaceName,
	});
	return account;
}

/** Scaffold a fresh CODEX_HOME for a new login and return how to run it.
 *  The dir is NOT registered until the login is verified (completeCodexLogin) —
 *  the user's ~/.codex is never touched, mirroring the Claude login flow.
 *  `deviceAuth`: the browser finishing the login is not on this host (a headless
 *  box, or a remote viewer), so `codex login`'s localhost:1455 callback is a dead
 *  end — `--device-auth` prints a URL + code that works from any device. */
export async function prepareCodexLogin(
	paths: AccountPaths = defaultAccountPaths(),
	opts: { deviceAuth?: boolean } = {},
): Promise<PreparedAccountLogin> {
	const id = crypto.randomUUID();
	const dir = ensureCodexAccountHome(id, paths);
	markStagedLogin(dir);
	const deviceAuth = opts.deviceAuth === true || process.env.DEV3_HEADLESS === "1";
	const args = deviceAuth ? ["login", "--device-auth"] : ["login"];
	return {
		accountId: id,
		loginCommand: `CODEX_HOME='${dir}' codex ${args.join(" ")}`,
		launch: { command: "codex", args, env: { CODEX_HOME: dir }, cwd: dir },
	};
}

/** Verify a prepared CODEX_HOME login dir and register it as an account. */
export async function completeCodexLogin(
	accountId: string,
	paths: AccountPaths = defaultAccountPaths(),
	opts: { stillWanted?: () => boolean } = {},
): Promise<AgentAccount> {
	const authFile = codexAccountAuthFile(accountId, paths);
	const authJson = safeReadJson(authFile);
	let identity = parseCodexIdentity(authJson);
	if (!identity?.accountId) {
		throw new LoginNotReadyError("Login not detected yet. Finish the sign-in in the terminal.");
	}
	const registry = loadRegistry(paths);
	const workspaceNames = await lookupCodexWorkspaceNames(authJson);
	const workspaceName = workspaceNames[identity.accountId] ?? null;
	identity = withCodexWorkspaceName(identity, workspaceName)!;
	if (applyCodexWorkspaceNames(registry, workspaceNames, paths)) saveRegistry(registry, paths);
	log.info("Codex login identity detected", {
		pendingAccountId: accountId.slice(0, 8),
		workspaceId: shortCodexWorkspaceId(identity),
		workspaceName,
		managedCodexAccounts: registry.codex.accounts.length,
	});
	assertNoDuplicate(registry, "codex", identity, paths, accountId);
	// The workspace lookup awaited the network; a cancel may have discarded the dir meanwhile.
	if (opts.stillWanted && !opts.stillWanted()) throw new LoginNotReadyError("This sign-in was closed.");
	chmodSync(authFile, 0o600);
	if (registry.codex.accounts.some((e) => e.id === accountId)) {
		saveRegistry(registry, paths);
		return toAccount(registry.codex.accounts.find((e) => e.id === accountId)!, "codex", paths);
	}
	const account = registerAccount(registry, "codex", accountId, identity, paths, { workspaceName });
	unmarkStagedLogin(codexAccountDir(accountId, paths));
	registry.codex.activeId = accountId; // newly added becomes the default preselect
	saveRegistry(registry, paths);
	return account;
}

/** Has the provider written an identity into a staged login dir yet? Read-only. */
export function stagedLoginHasIdentity(kind: AgentAccountKind, accountId: string, paths: AccountPaths = defaultAccountPaths()): boolean {
	if (kind === "claude") return parseClaudeIdentity(safeReadJson(join(claudeAccountDir(accountId, paths), ".claude.json"))) !== null;
	if (isAgentDirAccountKind(kind)) {
		return authStoreFingerprint(kind, agentDirAccountDir(kind, accountId, paths)) !== checkedAuthFingerprints.get(accountId);
	}
	return Boolean(parseCodexIdentity(safeReadJson(codexAccountAuthFile(accountId, paths)))?.accountId);
}

function registeredAccountIds(kind: AgentAccountKind, paths: AccountPaths): Set<string> {
	const accounts = isAgentDirAccountKind(kind) ? loadAgentDirRegistry(kind, paths).accounts : loadRegistry(paths)[kind].accounts;
	return new Set(accounts.map((e) => e.id));
}

function stagedAccountDir(kind: AgentAccountKind, accountId: string, paths: AccountPaths): string {
	if (kind === "claude") return claudeAccountDir(accountId, paths);
	return isAgentDirAccountKind(kind) ? agentDirAccountDir(kind, accountId, paths) : codexAccountDir(accountId, paths);
}

/** Delete a staged login dir that never became an account. A registered id is
 *  refused: its dir IS a saved login, and only an explicit Remove may delete it. */
export function discardStagedLogin(kind: AgentAccountKind, accountId: string, paths: AccountPaths = defaultAccountPaths()): boolean {
	if (registeredAccountIds(kind, paths).has(accountId)) return false;
	rmSync(stagedAccountDir(kind, accountId, paths), { recursive: true, force: true });
	checkedAuthFingerprints.delete(accountId);
	return true;
}

/**
 * Delete staged sign-in dirs a killed app left behind: only dirs carrying our
 * marker, never registered, and older than `olderThanMs` — any sign-in that old
 * has expired in whichever app instance started it. Runs when the user starts a
 * new sign-in, never at load time.
 */
export function sweepAbandonedStagedLogins(
	kind: AgentAccountKind,
	olderThanMs: number,
	now: number = Date.now(),
	paths: AccountPaths = defaultAccountPaths(),
): number {
	const root = join(paths.accountsDir, kind);
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return 0;
	}
	const registered = registeredAccountIds(kind, paths);
	let swept = 0;
	for (const id of entries) {
		if (!isSafeAccountId(id) || registered.has(id)) continue;
		const marker = safeReadJson(join(root, id, STAGED_LOGIN_MARKER)) as { createdAt?: unknown } | null;
		if (typeof marker?.createdAt !== "number" || now - marker.createdAt < olderThanMs) continue;
		rmSync(join(root, id), { recursive: true, force: true });
		swept += 1;
	}
	if (swept > 0) log.info("Abandoned staged sign-ins removed", { kind, swept });
	return swept;
}

/** How each agent-dir harness signs in. omp ships `omp login`; pi has no such
 *  subcommand, so pi starts interactive with a tiny extension that types
 *  `/login` into its editor (see pi-login-extension.ts). */
function agentDirLoginLaunch(kind: AgentDirAccountKind, dir: string, paths: AccountPaths): Omit<PreparedAccountLogin, "accountId"> {
	if (kind === "omp") {
		return {
			loginCommand: `PI_CODING_AGENT_DIR='${dir}' omp login`,
			launch: { command: "omp", args: ["login"], env: { PI_CODING_AGENT_DIR: dir }, cwd: dir },
		};
	}
	// accountsDir is <dev3 home>/agent-accounts; the extension sits beside the status ones.
	const args = ["--no-session", "-e", writePiLoginExtension(dirname(paths.accountsDir))];
	return {
		loginCommand: `PI_CODING_AGENT_DIR='${dir}' pi --no-session   # then type /login`,
		launch: { command: "pi", args, env: { PI_CODING_AGENT_DIR: dir }, cwd: dir },
	};
}

/** Scaffold a fresh agent dir for the harness's own sign-in; its picker chooses
 *  the provider. The account is not registered until completeAgentDirLogin finds one. */
export async function prepareAgentDirLogin(kind: AgentDirAccountKind, paths: AccountPaths = defaultAccountPaths()): Promise<PreparedAccountLogin> {
	const id = crypto.randomUUID();
	const dir = scaffoldAgentDirAccount(kind, id, paths);
	markStagedLogin(dir);
	return { accountId: id, ...agentDirLoginLaunch(kind, dir, paths) };
}

/** omp keeps its sign-ins in agent.db (WAL mode), pi in auth.json; size and mtime
 *  change on every write, so a fingerprint tells "worth asking again". */
const AUTH_STORE_FILES: Record<AgentDirAccountKind, string[]> = {
	omp: ["agent.db", "agent.db-wal"],
	pi: ["auth.json"],
};

function authStoreFingerprint(kind: AgentDirAccountKind, dir: string): string {
	return AUTH_STORE_FILES[kind]
		.map((name) => {
			try {
				const stat = statSync(join(dir, name));
				return `${stat.size}:${stat.mtimeMs}`;
			} catch {
				return "-";
			}
		})
		.join("|");
}

/** Fingerprint of the auth store when the last check found no sign-in, per staged
 *  id: the sign-in watch asks again only after the store changed. */
const checkedAuthFingerprints = new Map<string, string>();

/** Ask omp which OAuth sign-ins an agent dir holds. omp prints provider and
 *  identity key only — no token ever reaches dev3. */
export async function listOmpLogins(agentDir: string | null): Promise<ProviderLogin[]> {
	const proc = spawn(["omp", "usage", "accounts", "--json"], {
		env: agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {},
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill(), 20_000);
	try {
		const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
		if (code !== 0) throw new Error(`omp usage accounts exited with code ${code}`);
		return parseOmpAccounts(JSON.parse(out));
	} finally {
		clearTimeout(timer);
	}
}

/** The sign-ins pi stored in an agent dir's auth.json — OAuth and API keys alike.
 *  pi also authenticates from env vars and models.json; those are the user's
 *  own setup, not the account's, so they are deliberately not counted. */
export async function listPiLogins(agentDir: string | null): Promise<ProviderLogin[]> {
	const file = join(agentDir ?? join(homedir(), ".pi", "agent"), "auth.json");
	if (!existsSync(file)) return [];
	return parsePiAuthLogins(JSON.parse(readFileSync(file, "utf-8")));
}

export function listAgentDirLogins(kind: AgentDirAccountKind, agentDir: string | null): Promise<ProviderLogin[]> {
	return kind === "omp" ? listOmpLogins(agentDir) : listPiLogins(agentDir);
}

/** Verify a prepared agent dir and register (or re-verify) it as an account. */
export async function completeAgentDirLogin(
	kind: AgentDirAccountKind,
	accountId: string,
	paths: AccountPaths = defaultAccountPaths(),
	listLogins: (agentDir: string) => Promise<ProviderLogin[]> = (dir) => listAgentDirLogins(kind, dir),
	opts: { stillWanted?: () => boolean } = {},
): Promise<AgentAccount> {
	const dir = agentDirAccountDir(kind, accountId, paths);
	if (!existsSync(dir)) throw new Error(`Unknown ${kind} account: ${accountId}`);
	const fingerprint = authStoreFingerprint(kind, dir);
	let logins: ProviderLogin[];
	try {
		logins = await listLogins(dir);
	} catch (err) {
		// The watch asks again once the auth store changes; a listing hiccup is not a verdict.
		log.warn("Agent-dir sign-in listing failed", { kind, accountId: accountId.slice(0, 8), error: String(err) });
		logins = [];
	}
	if (logins.length === 0) {
		checkedAuthFingerprints.set(accountId, fingerprint);
		throw new LoginNotReadyError("Login not detected yet. Finish the sign-in in the terminal.");
	}
	if (opts.stillWanted && !opts.stillWanted()) throw new LoginNotReadyError("This sign-in was closed.");
	checkedAuthFingerprints.delete(accountId);
	const registry = loadAgentDirRegistry(kind, paths);
	let entry = registry.accounts.find((e) => e.id === accountId);
	if (entry) {
		entry.logins = logins;
	} else {
		const identity = providerLoginsIdentity(logins);
		entry = {
			id: accountId,
			label: identity?.email ?? `${kind} account ${registry.accounts.length + 1}`,
			logins,
			createdAt: Date.now(),
		};
		registry.accounts.push(entry);
		registry.activeId = accountId; // newly added becomes the default preselect
	}
	saveAgentDirRegistry(kind, registry, paths);
	unmarkStagedLogin(dir);
	log.info("Agent-dir account verified", { kind, accountId: accountId.slice(0, 8), providers: logins.map((l) => l.provider) });
	return agentDirToAccount(kind, entry);
}

export async function setActiveAgentDirAccount(
	kind: AgentDirAccountKind,
	accountId: string | null,
	paths: AccountPaths = defaultAccountPaths(),
): Promise<void> {
	const registry = loadAgentDirRegistry(kind, paths);
	if (accountId !== null && !registry.accounts.some((e) => e.id === accountId)) {
		throw new Error(`Unknown ${kind} account: ${accountId}`);
	}
	registry.activeId = accountId;
	saveAgentDirRegistry(kind, registry, paths);
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
	if (isAgentDirAccountKind(kind)) {
		const dir = agentDirAccountDir(kind, accountId, paths);
		const registry = loadAgentDirRegistry(kind, paths);
		registry.accounts = registry.accounts.filter((e) => e.id !== accountId);
		if (registry.activeId === accountId) registry.activeId = null;
		saveAgentDirRegistry(kind, registry, paths);
		rmSync(dir, { recursive: true, force: true }); // symlinks only — their targets stay
		return;
	}
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
	if (isAgentDirAccountKind(kind)) {
		const registry = loadAgentDirRegistry(kind, paths);
		const entry = registry.accounts.find((e) => e.id === accountId);
		if (!entry) throw new Error(`Unknown ${kind} account: ${accountId}`);
		entry.label = trimmed;
		saveAgentDirRegistry(kind, registry, paths);
		return;
	}
	const registry = loadRegistry(paths);
	const entry = registry[kind].accounts.find((e) => e.id === accountId);
	if (!entry) throw new Error(`Unknown ${kind} account: ${accountId}`);
	entry.label = trimmed;
	saveRegistry(registry, paths);
}
