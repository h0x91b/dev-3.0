import type { Project } from "../shared/types";
import { TASK_REF_UNRESOLVED_PREFIX } from "../shared/types";
import * as github from "./github";
import * as git from "./git";
import * as data from "./data";
import { createLogger } from "./logger";

const log = createLogger("task-start-ref");

export interface ResolvePrUrlResult {
	ok: boolean;
	branch: string | null;
	number: number | null;
	title: string | null;
	isFork: boolean;
	error: string | null;
}

// Resolve a GitHub pull-request URL to a locally-fetched branch ref, ready to be
// used as a task's `existingBranch`. Same-repo PRs resolve to `origin/<head>`;
// cross-repo (fork) PRs are fetched via the fork-remote machinery and resolve to
// `<forkOwner>/<head>` — the exact ref shapes the branch selector already accepts.
export async function resolvePrUrl(params: { projectId: string; url: string }): Promise<ResolvePrUrlResult> {
	const url = params.url.trim();
	log.info("→ resolvePrUrl", { projectId: params.projectId, url });
	const project = await data.getProject(params.projectId);

	try {
		const result = await github.runGitHub(
			project,
			project.path,
			["pr", "view", url, "--json", "number,title,headRefName,headRepositoryOwner,isCrossRepository"],
			{ timeoutMs: 20_000 },
		);
		if (!result.ok || !result.stdout) {
			const error = result.stderr.trim() || "Failed to resolve pull request";
			log.warn("resolvePrUrl: gh pr view failed", { url, error });
			return { ok: false, branch: null, number: null, title: null, isFork: false, error };
		}

		const pr = JSON.parse(result.stdout) as {
			number?: number;
			title?: string;
			headRefName?: string;
			headRepositoryOwner?: { login?: string } | null;
			isCrossRepository?: boolean;
		};
		const headRefName = typeof pr.headRefName === "string" ? pr.headRefName : "";
		const number = typeof pr.number === "number" ? pr.number : null;
		const title = typeof pr.title === "string" ? pr.title : null;
		if (!headRefName) {
			return { ok: false, branch: null, number, title, isFork: false, error: "Pull request has no head branch" };
		}

		const forkOwner = pr.isCrossRepository ? pr.headRepositoryOwner?.login : undefined;
		if (forkOwner) {
			const fetched = await git.fetchFork(project.path, forkOwner, headRefName);
			if (!fetched) {
				log.warn("resolvePrUrl: fork fetch failed", { url, forkOwner, headRefName });
				return { ok: false, branch: null, number, title, isFork: true, error: `Could not fetch ${headRefName} from fork ${forkOwner}` };
			}
			log.info("← resolvePrUrl (fork)", { number, branch: `${forkOwner}/${headRefName}` });
			return { ok: true, branch: `${forkOwner}/${headRefName}`, number, title, isFork: true, error: null };
		}

		await git.fetchOrigin(project.path, headRefName);
		log.info("← resolvePrUrl (origin)", { number, branch: `origin/${headRefName}` });
		return { ok: true, branch: `origin/${headRefName}`, number, title, isFork: false, error: null };
	} catch (err) {
		log.warn("resolvePrUrl failed", { url, error: String(err) });
		return { ok: false, branch: null, number: null, title: null, isFork: false, error: String(err) };
	}
}


/** Rejection the CLI translates into its own exit code. */
function unresolved(message: string): Error {
	return new Error(`${TASK_REF_UNRESOLVED_PREFIX}${message}`);
}

/**
 * Turn whatever `gh` said into one line a caller can act on. The four causes are
 * indistinguishable in an exit code but not in a message, and "Failed to resolve
 * pull request" tells nobody whether to fix the number or run `gh auth login`.
 */
export function describePrFailure(prRef: string, error: string): string {
	const text = error.toLowerCase();
	if (text.includes("enoent") || text.includes("failed to spawn") || text.includes("no such file or directory")) {
		return "the GitHub CLI (`gh`) is not installed, so a pull request cannot be looked up. Install it, or pass --branch <ref> instead.";
	}
	if (text.includes("gh auth login") || text.includes("not logged in") || text.includes("authentication")) {
		return "the GitHub CLI (`gh`) is not authenticated. Run `gh auth login`, or pass --branch <ref> instead.";
	}
	if (github.isNotAGitHubRepoError({ stderr: error })) {
		return "this project has no GitHub remote, so it has no pull requests. Pass --branch <ref> instead.";
	}
	if (text.includes("could not fetch")) return `${error} — the fork may have been deleted.`;
	return `no pull request ${prRef} in this project (${error.trim()}).`;
}

interface StartRefRequest {
	project: Project;
	/** `--pr`: a number, or the pull request's URL. */
	pr?: string;
	/** `--branch`: a local name, `origin/x`, or a fork remote's `owner/x`. */
	branch?: string;
}

/**
 * What a task is about, resolved BEFORE the task exists — the ref that becomes
 * its `existingBranch`, from which creation derives `foreignCode`. A ref decided
 * afterwards is a different guarantee: the trust decision would already be made.
 *
 * Returns undefined when neither flag was passed (an ordinary task on the base
 * branch); throws {@link unresolved} when a flag was passed and did not resolve,
 * so a review task never lands quietly on `main`.
 */
export async function resolveTaskStartRef(request: StartRefRequest): Promise<string | undefined> {
	const { project, pr, branch } = request;
	if (pr && branch) throw unresolved("--pr and --branch name the same thing two ways — pass one of them.");
	if (pr) {
		if (project.kind === "virtual") {
			throw unresolved("an Operations board has no git repository, so it has no pull requests.");
		}
		const trimmed = pr.trim();
		if (!/^\d+$/.test(trimmed) && !/^https?:\/\//.test(trimmed)) {
			throw unresolved(`--pr takes a pull-request number or URL (got "${pr}").`);
		}
		const resolved = await resolvePrUrl({ projectId: project.id, url: trimmed });
		if (!resolved.ok || !resolved.branch) {
			throw unresolved(describePrFailure(trimmed, resolved.error ?? ""));
		}
		log.info("resolved --pr to a ref", { pr: trimmed, ref: resolved.branch, isFork: resolved.isFork });
		return resolved.branch;
	}
	if (branch) {
		const ref = branch.trim();
		if (!ref) throw unresolved("--branch needs a ref.");
		if (project.kind === "virtual") {
			throw unresolved("an Operations board has no git repository, so it has no branches.");
		}
		// Remote-tracking refs are checked under refs/remotes so `origin/main`
		// cannot be satisfied by a local branch literally named `origin/main`.
		const exists = (await git.refExists(project.path, `refs/remotes/${ref}`))
			|| (await git.refExists(project.path, `refs/heads/${ref}`));
		if (!exists) {
			throw unresolved(`no ref "${ref}" in ${project.path} — fetch it first, or pass --pr <number> to have dev3 fetch it.`);
		}
		return ref;
	}
	return undefined;
}
