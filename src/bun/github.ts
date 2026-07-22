import type { GitHubAccount, GitHubCliStatus, Project } from "../shared/types";
import { createLogger } from "./logger";
import { spawn } from "./spawn";
import { which } from "./which";

const log = createLogger("github");

type GhJsonAccount = {
	active?: boolean;
	host?: string;
	login?: string;
	state?: string;
	tokenSource?: string;
};

// `gh auth status --json` reports where each account's token lives. When the
// source is one of these env var names, gh has NO stored credential — the token
// exists only in the environment (e.g. a Coder workspace that injects GH_TOKEN
// and never ran `gh auth login`). `gh auth token --user <login>` then has
// nothing to return and errors "no oauth token found for … account …" on some
// gh versions (decision 157). For those accounts we read the token straight from
// process.env instead.
const ENV_TOKEN_SOURCES = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);

// Passed as the env for stored-account `gh auth token --user` calls: empty
// values neutralize any ambient token env var (gh treats "" as unset), so a
// stray GH_TOKEN can't override the requested --user and hand back a different
// identity's token. spawn() merges over process.env, so "" is how we "unset".
const NEUTRALIZE_TOKEN_ENV: Record<string, string> = {
	GH_TOKEN: "",
	GITHUB_TOKEN: "",
	GH_ENTERPRISE_TOKEN: "",
	GITHUB_ENTERPRISE_TOKEN: "",
};

function isEnvTokenSource(source: string | undefined): source is string {
	return !!source && ENV_TOKEN_SOURCES.has(source);
}

type GhAuthStatusResponse = {
	hosts?: Record<string, GhJsonAccount[]>;
};

type GitHubCommandResult = {
	code: number;
	ok: boolean;
	stdout: string;
	stderr: string;
};

type ProjectGitHubSelection = Pick<Project, "githubAuthHost" | "githubAuthLogin">;

function shellQuote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

function isPublicGitHubHost(host: string): boolean {
	return host === "github.com" || host.endsWith(".ghe.com");
}

function buildTokenEnv(host: string, token: string): Record<string, string> {
	if (isPublicGitHubHost(host)) {
		return {
			GH_TOKEN: token,
			GITHUB_TOKEN: token,
		};
	}
	return {
		GH_ENTERPRISE_TOKEN: token,
		GITHUB_ENTERPRISE_TOKEN: token,
	};
}

// Exit code reported when a gh command is killed for exceeding its timeout
// (matches GNU `timeout`'s convention).
const GH_TIMEOUT_EXIT_CODE = 124;

async function runGh(
	args: string[],
	options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<GitHubCommandResult> {
	log.debug(`gh ${args.join(" ")}`, { cwd: options?.cwd });
	const proc = spawn(["gh", ...args], {
		cwd: options?.cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: options?.env,
	});
	// Start draining stdout/stderr immediately, BEFORE awaiting exit. If we
	// waited for exit first, a command whose output exceeds the OS pipe buffer
	// (~64KB) would block on write with nobody reading — proc.exited never
	// resolves and we deadlock (or, with a timeout, get killed and lose output).
	// `.catch` is required: on the timeout path below we kill the process and
	// return without awaiting these, so a stream error must not surface as an
	// unhandled rejection (mirrors git.ts run()).
	const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
	const stderrPromise = new Response(proc.stderr).text().catch(() => "");

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const outcome = options?.timeoutMs
		? await Promise.race([
			proc.exited.then((code) => ({ code, timedOut: false as const })),
			new Promise<{ code: null; timedOut: true }>((resolve) => {
				timeoutId = setTimeout(() => resolve({ code: null, timedOut: true }), options.timeoutMs);
			}),
		])
		: { code: await proc.exited, timedOut: false as const };
	if (timeoutId) clearTimeout(timeoutId);
	if (outcome.timedOut) {
		// Kill the hung process so it can't keep holding resources (e.g. a
		// branch-status semaphore slot) after we've given up on it.
		proc.kill();
		log.warn(`gh ${args.join(" ")} timed out`, { timeoutMs: options?.timeoutMs });
		return { code: GH_TIMEOUT_EXIT_CODE, ok: false, stdout: "", stderr: `gh timed out after ${options?.timeoutMs}ms` };
	}
	const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
	return {
		code: outcome.code,
		ok: outcome.code === 0,
		stdout: stdout.trim(),
		stderr: stderr.trim(),
	};
}

const UNSUPPORTED_JSON_FLAG_PATTERN = /unknown (flag|command|option)/i;

function isJsonFlagUnsupported(result: GitHubCommandResult): boolean {
	if (result.ok) return false;
	return UNSUPPORTED_JSON_FLAG_PATTERN.test(result.stderr);
}

function parsePlainAuthStatus(output: string): GitHubAccount[] {
	const accounts: GitHubAccount[] = [];
	const seen = new Set<string>();
	// gh < ~2.50 prints "Logged in to <host> as <login>"; newer versions
	// (e.g. v2.63) print "Logged in to <host> account <login>" and add an
	// explicit "- Active account: true/false" line under each account.
	const loggedInPattern = /Logged in to (\S+) (?:as|account) ([^\s(]+)/;
	const activePattern = /Active account:\s*true/;
	let lastAccount: GitHubAccount | null = null;
	for (const line of output.split("\n")) {
		const loggedIn = loggedInPattern.exec(line);
		if (loggedIn) {
			const [, host, login] = loggedIn;
			const key = `${host}\0${login}`;
			if (seen.has(key)) {
				lastAccount = null;
				continue;
			}
			seen.add(key);
			lastAccount = { host, login, active: false };
			accounts.push(lastAccount);
			continue;
		}
		if (lastAccount && activePattern.test(line)) {
			lastAccount.active = true;
		}
	}
	// Old-format output has no "Active account" lines — treat the first
	// listed account as active, matching gh's own ordering.
	if (accounts.length > 0 && !accounts.some((account) => account.active)) {
		accounts[0].active = true;
	}
	return accounts.sort((a, b) => {
		if (a.active !== b.active) return a.active ? -1 : 1;
		if (a.host !== b.host) return a.host.localeCompare(b.host);
		return a.login.localeCompare(b.login);
	});
}

function parseAccounts(payload: GhAuthStatusResponse): GitHubAccount[] {
	const seen = new Set<string>();
	const accounts: GitHubAccount[] = [];

	for (const [host, hostAccounts] of Object.entries(payload.hosts ?? {})) {
		for (const account of hostAccounts) {
			if (account.state !== "success" || !account.login) {
				continue;
			}
			const normalizedHost = account.host || host;
			const key = `${normalizedHost}\0${account.login}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			accounts.push({
				host: normalizedHost,
				login: account.login,
				active: !!account.active,
				tokenSource: account.tokenSource,
			});
		}
	}

	return accounts.sort((a, b) => {
		if (a.active !== b.active) return a.active ? -1 : 1;
		if (a.host !== b.host) return a.host.localeCompare(b.host);
		return a.login.localeCompare(b.login);
	});
}

// gh auth status/token are resolved by spawning the gh binary — three subprocesses
// per GitHub operation without caching. Background pollers (merge/PR detection) hit
// this constantly, so both are cached with a TTL. Only "authenticated" status is
// cached: after `gh auth login` the user sees the new state immediately.
const AUTH_STATUS_CACHE_TTL_MS = 60_000;
const TOKEN_CACHE_TTL_MS = 5 * 60_000;

let authStatusCache: { at: number; promise: Promise<GitHubCliStatus> } | null = null;
const tokenCache = new Map<string, { at: number; promise: Promise<string> }>();

/** Test-only: clear gh auth caches. */
export function _resetGitHubAuthCache(): void {
	authStatusCache = null;
	tokenCache.clear();
}

export async function getGitHubCliStatus(): Promise<GitHubCliStatus> {
	if (authStatusCache && Date.now() - authStatusCache.at < AUTH_STATUS_CACHE_TTL_MS) {
		return authStatusCache.promise;
	}
	const promise = getGitHubCliStatusUncached();
	const entry = { at: Date.now(), promise };
	authStatusCache = entry;
	promise.then(
		(status) => {
			if (status.authStatus !== "authenticated" && authStatusCache === entry) {
				authStatusCache = null;
			}
		},
		() => {
			if (authStatusCache === entry) authStatusCache = null;
		},
	);
	return promise;
}

async function getGitHubCliStatusUncached(): Promise<GitHubCliStatus> {
	const binaryPath = await which("gh");
	if (!binaryPath) {
		return {
			authStatus: "not_installed",
			binaryPath: null,
			accounts: [],
		};
	}

	const result = await runGh(["auth", "status", "--json", "hosts"]);

	// Older gh versions (e.g. v2.45.0) don't support --json. Fall back to plain text parsing.
	if (isJsonFlagUnsupported(result)) {
		log.info("gh --json unsupported, falling back to plain `gh auth status`", { stderr: result.stderr });
		const fallback = await runGh(["auth", "status"]);
		// Old gh writes auth status to stderr; newer versions to stdout. Check both.
		const text = `${fallback.stdout}\n${fallback.stderr}`;
		const accounts = parsePlainAuthStatus(text);
		if (accounts.length === 0) {
			log.warn("gh auth status (plain) reported no accounts", { code: fallback.code, stderr: fallback.stderr });
			return {
				authStatus: "not_authenticated",
				binaryPath,
				accounts: [],
			};
		}
		return {
			authStatus: "authenticated",
			binaryPath,
			accounts,
		};
	}

	if (!result.ok || !result.stdout) {
		log.warn("gh auth status failed", { code: result.code, stderr: result.stderr });
		return {
			authStatus: "not_authenticated",
			binaryPath,
			accounts: [],
		};
	}

	try {
		const payload = JSON.parse(result.stdout) as GhAuthStatusResponse;
		const accounts = parseAccounts(payload);
		return {
			authStatus: accounts.length > 0 ? "authenticated" : "not_authenticated",
			binaryPath,
			accounts,
		};
	} catch (error) {
		log.warn("Failed to parse gh auth status JSON", { error: String(error) });
		return {
			authStatus: "not_authenticated",
			binaryPath,
			accounts: [],
		};
	}
}

function resolveSelectedAccount(
	status: GitHubCliStatus,
	project: ProjectGitHubSelection,
): GitHubAccount | null {
	const selectedLogin = project.githubAuthLogin?.trim();
	const selectedHost = project.githubAuthHost?.trim();
	if (selectedLogin) {
		return status.accounts.find((account) =>
			account.login === selectedLogin && (!selectedHost || account.host === selectedHost),
		) ?? null;
	}

	return status.accounts.find((account) => account.active) ?? status.accounts[0] ?? null;
}

export async function resolveGitHubAccount(project: ProjectGitHubSelection): Promise<GitHubAccount> {
	const status = await getGitHubCliStatus();
	if (status.authStatus === "not_installed") {
		throw new Error("GitHub CLI (gh) is not installed");
	}
	if (status.authStatus !== "authenticated" || status.accounts.length === 0) {
		throw new Error("GitHub CLI (gh) is not authenticated");
	}

	const account = resolveSelectedAccount(status, project);
	if (!account) {
		const suffix = project.githubAuthHost ? ` on ${project.githubAuthHost}` : "";
		throw new Error(`Configured GitHub account ${project.githubAuthLogin}${suffix} is not authenticated in gh`);
	}
	return account;
}

async function getAccountToken(account: GitHubAccount): Promise<string> {
	const key = `${account.host}\0${account.login}`;
	const cached = tokenCache.get(key);
	if (cached && Date.now() - cached.at < TOKEN_CACHE_TTL_MS) {
		return cached.promise;
	}
	const promise = resolveAccountToken(account);
	tokenCache.set(key, { at: Date.now(), promise });
	promise.catch(() => tokenCache.delete(key));
	return promise;
}

async function resolveAccountToken(account: GitHubAccount): Promise<string> {
	// Env-backed account (no `gh auth login`, token only in the environment):
	// the token lives in process.env[tokenSource]; `gh auth token --user` cannot
	// retrieve it. Read it directly. (decision 157)
	if (isEnvTokenSource(account.tokenSource)) {
		const envToken = process.env[account.tokenSource]?.trim();
		if (envToken) return envToken;
		throw new Error(
			`GitHub account ${account.login}@${account.host} is authenticated via ${account.tokenSource}, but that variable is empty in dev3's environment`,
		);
	}

	// Stored account: read gh's per-account credential, with ambient token env
	// vars neutralized so they can't override the requested --user.
	const result = await runGh(
		["auth", "token", "--hostname", account.host, "--user", account.login],
		{ env: NEUTRALIZE_TOKEN_ENV },
	);
	if (!result.ok || !result.stdout) {
		throw new Error(result.stderr || `Failed to resolve GitHub token for ${account.login}@${account.host}`);
	}
	return result.stdout;
}

export async function getGitHubAuthEnv(project: ProjectGitHubSelection): Promise<Record<string, string>> {
	const account = await resolveGitHubAccount(project);
	const token = await getAccountToken(account);
	return buildTokenEnv(account.host, token);
}

export async function runGitHub(
	project: ProjectGitHubSelection,
	cwd: string,
	args: string[],
	options?: { timeoutMs?: number },
): Promise<GitHubCommandResult> {
	const env = await getGitHubAuthEnv(project);
	return runGh(args, { cwd, env, timeoutMs: options?.timeoutMs });
}

export async function getGitHubShellExports(project: ProjectGitHubSelection): Promise<string[]> {
	const account = await resolveGitHubAccount(project);
	const tokenVar = "__DEV3_GH_TOKEN";
	// Env-backed account (Coder-style GH_TOKEN, no stored credential): resolve
	// from the ambient env var rather than `gh auth token --user`, which errors
	// on such accounts (decision 157). For a stored account, resolve via gh.
	const resolveExpr = isEnvTokenSource(account.tokenSource)
		? `"$${account.tokenSource}"`
		: `"$(gh auth token --hostname ${shellQuote(account.host)} --user ${shellQuote(account.login)} 2>/dev/null)"`;
	const lines = [
		`${tokenVar}=${resolveExpr}`,
		`if [ -z "$${tokenVar}" ]; then`,
		`  printf '\\033[1;31m✗ Failed to resolve GitHub auth token for ${account.login}@${account.host}\\033[0m\\n'`,
		"  exit 1",
		"fi",
	];

	if (isPublicGitHubHost(account.host)) {
		lines.push(
			`export GH_TOKEN="$${tokenVar}"`,
			`export GITHUB_TOKEN="$${tokenVar}"`,
		);
	} else {
		lines.push(
			`export GH_ENTERPRISE_TOKEN="$${tokenVar}"`,
			`export GITHUB_ENTERPRISE_TOKEN="$${tokenVar}"`,
		);
	}

	lines.push(`unset ${tokenVar}`);
	return lines;
}
