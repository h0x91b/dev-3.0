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

/**
 * Whether the OS has a handler for `dev3://` at all. Only the macOS bundle
 * registers the scheme (CFBundleURLTypes); nothing in this codebase writes a
 * Windows registry key or a Linux `.desktop` MimeType entry, so a deep link is
 * inert everywhere else — including the `https` redirect page, which only bounces
 * back to the same scheme.
 */
export function deepLinkSchemeRegistered(platform: NodeJS.Platform = process.platform): boolean {
	return platform === "darwin";
}

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

/** Ids travel percent-encoded in both the path and the query, so both sides decode. */
const decodeId = (s: string) => {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
};

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
			const taskId = decodeId(stripSlashes(url.pathname));
			return taskId ? { kind: "task", taskId } : null;
		}
		case "project": {
			const projectId = decodeId(stripSlashes(url.pathname));
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
	return `${DEEP_LINK_SCHEME}://task/${encodeURIComponent(taskId)}`;
}

/** `dev3://project/<projectId>` */
export function buildProjectDeepLink(projectId: string): string {
	return `${DEEP_LINK_SCHEME}://project/${encodeURIComponent(projectId)}`;
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
 */
export function buildTaskWebLink(taskId: string): string {
	return `${DEEP_LINK_WEB_BASE}/open.html?task=${encodeURIComponent(taskId)}`;
}

/**
 * The footer content, on ONE line: a clickable https link (redirects to the scheme),
 * the raw `dev3://` link as a copy-paste fallback, and where to switch the footer
 * off. Newline-free on purpose — it rides inside the agent-handoff prompt, which
 * reaches the pane as raw bytes, and a newline can submit the prompt early on an
 * agent that reads `\n` as Enter.
 */
export function buildTaskPrDeepLinkLine(taskId: string): string {
	return `🔗 **Origin task in dev3:** [open in dev3](${buildTaskWebLink(taskId)}) · \`${buildTaskDeepLink(taskId)}\` _(dev3 added this footer — turn it off in Settings → Tasks.)_`;
}

/**
 * The rendered footer: the divider plus {@link buildTaskPrDeepLinkLine}. Used by the
 * agent skill and the tests; the handoff prompt itself passes the LINE, never this,
 * because a prompt with newlines is typed into the pane byte for byte.
 *
 * The leading blank line is load-bearing: `---` directly under a line of text is
 * setext syntax, which turns that line into an <h2> and draws no rule at all.
 */
export function buildTaskPrDeepLinkSection(taskId: string): string {
	return `\n\n---\n\n${buildTaskPrDeepLinkLine(taskId)}`;
}
