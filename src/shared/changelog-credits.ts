import type { ChangelogEntry } from "./types";

type CreditFields = Pick<
	ChangelogEntry,
	"suggestedBy" | "issueUrl" | "issueRef" | "contributedBy" | "prUrl" | "prRef"
>;

const DEFAULT_REPO = "h0x91b/dev-3.0";
const SUGGESTED = String.raw`Suggested by @\S+\s+\([^)]+\)`;
const CONTRIBUTED = String.raw`Contributed by @[\w-]+(?:[ \t]*\([^)]+\))?`;
const SUGGESTED_RE = /Suggested by @(\S+)\s+\(([^)]+)\)/;
const CONTRIBUTED_RE = /^[ \t]*Contributed by @([\w-]+)(?:[ \t]*\(([^)]+)\))?[ \t]*$/m;
// A credit line goes together with its line break; the old end-of-content strip also catches an inline or indented tail.
const CREDIT_LINE_RE = new RegExp(String.raw`^[ \t]*(?:${SUGGESTED}|${CONTRIBUTED})[ \t]*(?:\n\n?|$)`, "gm");
const TRAILING_SUGGESTED_RE = /\n*Suggested by @\S+\s+\([^)]+\)\s*$/;

function parseRef(ref: string | undefined, kind: "issues" | "pull", bareRepo?: string) {
	const m = ref?.match(bareRepo ? /^(.*?)#(\d+)$/ : /^(.+?)#(\d+)$/);
	return m ? { ref: `#${m[2]}`, url: `https://github.com/${m[1] || bareRepo}/${kind}/${m[2]}` } : undefined;
}

/** Extracts the "Suggested by" / "Contributed by" credits and returns the content without those lines. */
export function parseChangelogCredits(content: string): { credits: CreditFields; content: string } {
	const credits: CreditFields = {};
	const suggested = content.match(SUGGESTED_RE);
	if (suggested) {
		credits.suggestedBy = suggested[1];
		const issue = parseRef(suggested[2], "issues");
		if (issue) {
			credits.issueRef = issue.ref;
			credits.issueUrl = issue.url;
		}
	}
	const contributed = content.match(CONTRIBUTED_RE);
	if (contributed) {
		credits.contributedBy = contributed[1];
		const pr = parseRef(contributed[2], "pull", DEFAULT_REPO);
		if (pr) {
			credits.prRef = pr.ref;
			credits.prUrl = pr.url;
		}
	}
	return { credits, content: content.replace(CREDIT_LINE_RE, "").replace(TRAILING_SUGGESTED_RE, "") };
}
