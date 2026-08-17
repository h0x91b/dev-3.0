/**
 * Tool semantics: what a call *did*, independent of which agent made it.
 *
 * Without this layer a parsed conversation still speaks the source agent's
 * dialect — Claude says `Bash{command}` where Codex says `exec_command{cmd}` —
 * so nothing can be re-rendered for a different client. Every native name maps
 * to one canonical operation with normalized arguments, and anything unmapped
 * becomes `unknown` carrying its native name rather than being lost.
 *
 * The mapping is deliberately asymmetric where the agents are: Codex has no file
 * read tool (it shells out), Claude has no code-mode sandbox. Pretending
 * otherwise would invent calls that never happened.
 */

import type { ConversationSource } from "./conversation-model";

export type CanonicalToolOp =
	| "shell.run"
	| "shell.input"
	| "shell.wait"
	| "code.exec"
	| "file.read"
	| "file.write"
	| "file.edit"
	| "file.patch"
	| "search"
	| "web.fetch"
	| "web.search"
	| "agent.spawn"
	| "agent.message"
	| "plan.update"
	| "user.ask"
	| "image.view"
	| "image.generate"
	| "mcp.call"
	| "unknown";

/** A tool call reduced to "what happened", ready for any renderer. */
export interface CanonicalToolCall {
	op: CanonicalToolOp;
	/** The name the source agent used, always kept for traceability. */
	nativeName: string;
	/** Shell command, when the op is a shell one. */
	command?: string;
	/** Absolute or repo-relative path, when the op touches a file. */
	path?: string;
	/** Free-form payload (patch body, code, prompt, query) — never truncated here. */
	body?: string;
	/** Anything else worth keeping, normalized to plain values. */
	extra?: Record<string, unknown>;
}

/** Native tool arguments: an object for Claude, a JSON string for Codex. */
function argsObject(input: unknown): Record<string, unknown> {
	if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
	if (typeof input === "string") {
		try {
			const parsed = JSON.parse(input);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		} catch {
			// Not JSON — a code-mode body or a raw patch. The caller keeps it as `body`.
		}
	}
	return {};
}

function str(args: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function rawString(input: unknown): string | undefined {
	return typeof input === "string" && input.length > 0 ? input : undefined;
}

/** Files named by an apply_patch body (`*** Add|Update|Delete File: <path>`). */
function patchPaths(body: string | undefined): string[] {
	if (!body) return [];
	const paths = new Set<string>();
	for (const match of body.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
		const path = match[1].trim();
		if (path) paths.add(path);
	}
	return [...paths];
}

const CLAUDE_OPS: Record<string, CanonicalToolOp> = {
	Bash: "shell.run",
	BashOutput: "shell.wait",
	KillShell: "shell.input",
	Read: "file.read",
	NotebookEdit: "file.edit",
	Write: "file.write",
	Edit: "file.edit",
	Glob: "search",
	Grep: "search",
	WebFetch: "web.fetch",
	WebSearch: "web.search",
	Agent: "agent.spawn",
	Task: "agent.spawn",
	SendMessage: "agent.message",
	TodoWrite: "plan.update",
	AskUserQuestion: "user.ask",
};

const CODEX_OPS: Record<string, CanonicalToolOp> = {
	exec_command: "shell.run",
	shell: "shell.run",
	write_stdin: "shell.input",
	wait: "shell.wait",
	wait_agent: "shell.wait",
	exec: "code.exec",
	apply_patch: "file.patch",
	view_image: "image.view",
	imagegen: "image.generate",
	spawn_agent: "agent.spawn",
	send_message: "agent.message",
	followup_task: "agent.message",
	update_plan: "plan.update",
	request_user_input: "user.ask",
	request_permissions: "user.ask",
};

/** Reduce one native tool call to its canonical form. */
export function normalizeToolCall(
	source: ConversationSource,
	nativeName: string | undefined,
	input: unknown,
): CanonicalToolCall {
	const name = nativeName ?? "";
	const args = argsObject(input);

	// MCP tools are namespaced by the server, so they are recognizable without a table.
	if (name.startsWith("mcp__")) {
		const [, server, ...tool] = name.split("__");
		return { op: "mcp.call", nativeName: name, extra: { server, tool: tool.join("__"), args } };
	}

	const op = (source === "claude" ? CLAUDE_OPS[name] : CODEX_OPS[name]) ?? "unknown";
	const call: CanonicalToolCall = { op, nativeName: name };

	switch (op) {
		case "shell.run":
			call.command = str(args, "command", "cmd");
			call.path = str(args, "workdir", "cwd");
			break;
		case "shell.input":
			call.body = str(args, "chars");
			break;
		case "code.exec":
			// Codex code mode passes a JS program, not JSON arguments.
			call.body = rawString(input) ?? str(args, "code");
			break;
		case "file.read":
		case "file.write":
		case "file.edit":
			call.path = str(args, "file_path", "path", "notebook_path");
			if (op === "file.write") call.body = str(args, "content");
			if (op === "file.edit") call.body = str(args, "new_string", "new_source");
			break;
		case "file.patch": {
			// apply_patch ships the patch itself, sometimes unwrapped by JSON. The
			// paths live inside it, so without this Codex would look like it never
			// touched a file — it has no Write/Edit tool at all.
			call.body = str(args, "patch", "input") ?? rawString(input);
			const paths = patchPaths(call.body);
			if (paths.length > 0) call.extra = { paths };
			break;
		}
		case "search":
			call.body = str(args, "pattern", "query");
			call.path = str(args, "path", "glob");
			break;
		case "web.fetch":
			call.body = str(args, "url");
			break;
		case "web.search":
			call.body = str(args, "query");
			break;
		case "agent.spawn":
			call.body = str(args, "prompt", "message");
			call.extra = { name: str(args, "task_name", "name", "subagent_type", "description") };
			break;
		case "agent.message":
			call.body = str(args, "content", "message");
			call.extra = { to: str(args, "to", "recipient", "target") };
			break;
		case "plan.update":
			call.body = str(args, "explanation");
			call.extra = { plan: args.plan ?? args.todos };
			break;
		case "user.ask":
			call.extra = { questions: args.questions ?? args.permissions };
			break;
		case "image.view":
		case "image.generate":
			call.path = str(args, "path");
			call.body = str(args, "prompt");
			break;
		default:
			// `unknown` keeps everything so a renderer can still say something true.
			call.extra = Object.keys(args).length > 0 ? { args } : { input: rawString(input) };
	}

	return call;
}

/** One-line human summary of a canonical call, for prompts and logs. */
export function describeToolCall(call: CanonicalToolCall): string {
	switch (call.op) {
		case "shell.run":
			return `ran: ${call.command ?? "(unknown command)"}`;
		case "code.exec":
			return "ran code-mode program";
		case "file.read":
			return `read ${call.path ?? "(unknown file)"}`;
		case "file.write":
			return `wrote ${call.path ?? "(unknown file)"}`;
		case "file.edit":
			return `edited ${call.path ?? "(unknown file)"}`;
		case "file.patch": {
			const paths = call.extra?.paths;
			return Array.isArray(paths) && paths.length > 0 ? `patched ${paths.join(", ")}` : "applied a patch";
		}
		case "search":
			return `searched for ${call.body ?? "(unknown pattern)"}`;
		case "web.fetch":
			return `fetched ${call.body ?? "(unknown url)"}`;
		case "web.search":
			return `web-searched ${call.body ?? ""}`.trim();
		case "agent.spawn":
			return `spawned a subagent (${String(call.extra?.name ?? "unnamed")})`;
		case "agent.message":
			return `messaged ${String(call.extra?.to ?? "a peer")}`;
		case "plan.update":
			return "updated its plan";
		case "user.ask":
			return "asked the user a question";
		case "image.view":
			return `looked at ${call.path ?? "an image"}`;
		case "image.generate":
			return "generated an image";
		case "mcp.call":
			return `called ${String(call.extra?.server ?? "mcp")}/${String(call.extra?.tool ?? "?")}`;
		case "shell.input":
			return "sent input to a running command";
		case "shell.wait":
			return "waited on a running command";
		default:
			return `used ${call.nativeName || "an unknown tool"}`;
	}
}

/** Files the conversation changed, in first-touch order. Reads are not changes. */
export function filesTouched(calls: CanonicalToolCall[]): string[] {
	const seen = new Set<string>();
	for (const call of calls) {
		if (call.op === "file.write" || call.op === "file.edit") {
			if (call.path) seen.add(call.path);
			continue;
		}
		// Codex edits only through patches, so its paths come from the patch body.
		if (call.op !== "file.patch") continue;
		const paths = call.extra?.paths;
		if (Array.isArray(paths)) for (const path of paths) if (typeof path === "string") seen.add(path);
	}
	return [...seen];
}
