// dev3:// deep-link vocabulary — the one place the URL grammar lives.
//
// Both sides depend on this pure module: the bun `open-url` receiver parses
// inbound links, the renderer builds outbound "Copy deep link" strings. Keeping
// build+parse together guarantees they never drift.
//
// Grammar (host = intent, id in the path, params in the query):
//   dev3://task/<taskId>
//   dev3://project/<projectId>
//   dev3://new-task?project=<projectId>&text=<url-encoded>
//
// macOS-only in practice (Electrobun registers CFBundleURLTypes; Windows/Linux
// have no scheme registration yet) — see decisions/2026/08/04/dev3-url-scheme-deep-links.md.

export const DEEP_LINK_SCHEME = "dev3";

// GitHub (and most markdown renderers) strip links whose scheme is not http(s)/
// mailto, so a bare `dev3://…` in a PR body renders as un-clickable text. This
// https page on the landing-site domain redirects to the `dev3://` scheme, which
// is what makes a deep link clickable inside a pull request. See
// decisions/2026/08/13/pr-origin-task-deep-link.md.
export const DEEP_LINK_WEB_BASE = "https://dev3.h0x91b.com";

/** Parsed intent of an inbound deep link (before backend resolution). */
export type DeepLinkTarget =
	| { kind: "task"; taskId: string }
	| { kind: "project"; projectId: string }
	| { kind: "new-task"; projectId?: string; text?: string };

/**
 * Backend-resolved deep link handed to the renderer: the referenced ids are
 * verified to exist, and `new-task` always carries a concrete `projectId`
 * (resolved to a fallback project when the link omitted one).
 */
export type DeepLinkNav =
	| { kind: "task"; taskId: string; projectId: string }
	| { kind: "project"; projectId: string }
	| { kind: "new-task"; projectId: string; text: string };

const stripSlashes = (s: string) => s.replace(/^\/+/, "").replace(/\/+$/, "");

/**
 * Parse a `dev3://…` URL into a target, or `null` when it is malformed or of an
 * unknown kind. Tolerant of case in the host and of trailing slashes; ids and
 * text keep their original casing.
 */
export function parseDeepLink(raw: string): DeepLinkTarget | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null;

	const kind = url.hostname.toLowerCase();
	switch (kind) {
		case "task": {
			const taskId = stripSlashes(url.pathname);
			return taskId ? { kind: "task", taskId } : null;
		}
		case "project": {
			const projectId = stripSlashes(url.pathname);
			return projectId ? { kind: "project", projectId } : null;
		}
		case "new-task": {
			const projectId = url.searchParams.get("project") || undefined;
			const text = url.searchParams.get("text") || undefined;
			return { kind: "new-task", projectId, text };
		}
		default:
			return null;
	}
}

/** `dev3://task/<taskId>` */
export function buildTaskDeepLink(taskId: string): string {
	return `${DEEP_LINK_SCHEME}://task/${taskId}`;
}

/** `dev3://project/<projectId>` */
export function buildProjectDeepLink(projectId: string): string {
	return `${DEEP_LINK_SCHEME}://project/${projectId}`;
}

/** `dev3://new-task?project=…&text=…` — both params optional. */
export function buildNewTaskDeepLink(opts?: { projectId?: string; text?: string }): string {
	const params = new URLSearchParams();
	if (opts?.projectId) params.set("project", opts.projectId);
	if (opts?.text) params.set("text", opts.text);
	const qs = params.toString();
	return `${DEEP_LINK_SCHEME}://new-task${qs ? `?${qs}` : ""}`;
}

/**
 * `https://dev3.h0x91b.com/open.html?task=<taskId>` — the clickable, GitHub-safe
 * form of `buildTaskDeepLink`. The static `docs/open.html` page bounces it to the
 * `dev3://task/<taskId>` scheme so the app opens the task.
 *
 * Task and project ids are UUIDs — no URL-significant characters — so the id is
 * placed verbatim, exactly as `buildTaskDeepLink` does. Keeping both sides
 * un-encoded means the two links in one PR footer resolve to the identical
 * target (issue #1340, item 5).
 */
export function buildTaskWebLink(taskId: string): string {
	return `${DEEP_LINK_WEB_BASE}/open.html?task=${taskId}`;
}

/**
 * The single-line footer content dev3 asks agents to add to a PR description: a
 * clickable https link (redirects to the scheme), the raw `dev3://` link as a
 * copy-paste fallback, and a pointer to the opt-out setting. Deliberately free of
 * newlines so it can ride inside a single-line agent-handoff prompt — a multi-line
 * prompt risks submitting early on agents that treat `\n` as Enter (issue #1340,
 * item 3).
 */
export function buildTaskPrDeepLinkLine(taskId: string): string {
	return `🔗 **Origin task in dev3:** [open in dev3](${buildTaskWebLink(taskId)}) · \`${buildTaskDeepLink(taskId)}\` (this footer can be turned off in dev3 settings)`;
}

/**
 * The full markdown footer block: a thematic-break divider then the link line, for
 * the agent skill and the tests. The two leading newlines are load-bearing —
 * appended straight after the description, `text\n---` is setext syntax (turns the
 * previous line into a heading and draws no rule); a blank line before `---` makes
 * it a horizontal rule (issue #1340, item 2).
 */
export function buildTaskPrDeepLinkSection(taskId: string): string {
	return `\n\n---\n\n${buildTaskPrDeepLinkLine(taskId)}`;
}
