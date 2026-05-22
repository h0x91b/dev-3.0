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
};

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

async function runGh(
	args: string[],
	options?: { cwd?: string; env?: Record<string, string> },
): Promise<GitHubCommandResult> {
	log.debug(`gh ${args.join(" ")}`, { cwd: options?.cwd });
	const proc = spawn(["gh", ...args], {
		cwd: options?.cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: options?.env,
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return {
		code,
		ok: code === 0,
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
	const loggedInPattern = /Logged in to (\S+) as ([^\s(]+)/g;
	let match: RegExpExecArray | null;
	let isFirst = true;
	while ((match = loggedInPattern.exec(output)) !== null) {
		const host = match[1];
		const login = match[2];
		const key = `${host}\0${login}`;
		if (seen.has(key)) continue;
		seen.add(key);
		accounts.push({ host, login, active: isFirst });
		isFirst = false;
	}
	return accounts;
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
			});
		}
	}

	return accounts.sort((a, b) => {
		if (a.active !== b.active) return a.active ? -1 : 1;
		if (a.host !== b.host) return a.host.localeCompare(b.host);
		return a.login.localeCompare(b.login);
	});
}

export async function getGitHubCliStatus(): Promise<GitHubCliStatus> {
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
	const result = await runGh(["auth", "token", "--hostname", account.host, "--user", account.login]);
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
): Promise<GitHubCommandResult> {
	const env = await getGitHubAuthEnv(project);
	return runGh(args, { cwd, env });
}

export async function getGitHubShellExports(project: ProjectGitHubSelection): Promise<string[]> {
	const account = await resolveGitHubAccount(project);
	const tokenVar = "__DEV3_GH_TOKEN";
	const lines = [
		`${tokenVar}="$(gh auth token --hostname ${shellQuote(account.host)} --user ${shellQuote(account.login)} 2>/dev/null)"`,
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
