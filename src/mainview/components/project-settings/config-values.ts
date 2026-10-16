import type { Dev3RepoConfig, GitHubAccount } from "../../../shared/types";

export const CONFIG_BOOLEAN_DEFAULTS = {
	autoReviewEnabled: false,
	peerReviewEnabled: true,
	sparseCheckoutEnabled: false,
} as const;

export type ProjectConfigValues = Dev3RepoConfig & {
	githubAuthHost?: string | null;
	githubAuthLogin?: string | null;
};

export function getEffectiveCompareRef(config: Dev3RepoConfig, fallbackBaseBranch: string, fallbackCompareRef?: string): string | undefined {
	if (config.defaultCompareRef !== undefined) return config.defaultCompareRef;
	if (config.defaultCompareRefMode === "local") return config.defaultBaseBranch ?? fallbackBaseBranch;
	if (config.defaultCompareRefMode === "remote") return `origin/${config.defaultBaseBranch ?? fallbackBaseBranch}`;
	return fallbackCompareRef;
}

export function encodeGitHubAccountValue(account: Pick<GitHubAccount, "host" | "login">): string {
	return `${account.host}\t${account.login}`;
}

export function decodeGitHubAccountValue(value: string): Pick<ProjectConfigValues, "githubAuthHost" | "githubAuthLogin"> {
	const [host, login] = value.split("\t");
	return {
		githubAuthHost: host || null,
		githubAuthLogin: login || null,
	};
}

export function formatGitHubAccountLabel(account: GitHubAccount, accounts: GitHubAccount[]): string {
	const multipleHosts = new Set(accounts.map((item) => item.host)).size > 1;
	return multipleHosts ? `${account.login} @ ${account.host}` : account.login;
}
