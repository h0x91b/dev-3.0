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
// have no scheme registration yet) — see decisions/144.

export const DEEP_LINK_SCHEME = "dev3";

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
