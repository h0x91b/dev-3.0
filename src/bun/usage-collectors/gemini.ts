import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeUsageRecord, type UsageState } from "../rpc-handlers/agent-usage-parse";

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function count(value: unknown, optional = false): number | null {
	if (value === undefined && optional) return 0;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function foldMessage(state: UsageState, sessionId: string, value: unknown): void {
	const message = object(value);
	if (!sessionId || message?.type !== "gemini" || typeof message.id !== "string" || !message.id) return;
	const tokens = object(message.tokens);
	const timestamp = typeof message.timestamp === "string" ? Date.parse(message.timestamp) : NaN;
	if (!tokens || !Number.isFinite(timestamp)) return;
	const input = count(tokens.input);
	const output = count(tokens.output);
	const cached = count(tokens.cached, true);
	const thoughts = count(tokens.thoughts, true);
	const tool = count(tokens.tool, true);
	if (input === null || output === null || cached === null || thoughts === null || tool === null) return;
	if (input + output + thoughts + tool === 0) return;
	const cacheRead = Math.min(input, cached);
	mergeUsageRecord(state, `gemini:${JSON.stringify([sessionId, message.id])}`, {
		model: typeof message.model === "string" && message.model.trim() ? message.model : "unknown",
		timestamp,
		counts: {
			inputTokens: input - cacheRead + tool,
			outputTokens: output + thoughts,
			cacheReadInputTokens: cacheRead,
			cacheCreationInputTokens: 0,
		},
	});
}

function foldSession(state: UsageState, text: string, jsonl: boolean): void {
	let sessionId = "";
	const fold = (value: unknown) => {
		const entry = object(value);
		if (!entry) return;
		if (typeof entry.sessionId === "string" && entry.sessionId) sessionId = entry.sessionId;
		if (Array.isArray(entry.messages)) {
			for (const message of entry.messages) foldMessage(state, sessionId, message);
		} else {
			foldMessage(state, sessionId, entry);
		}
		const metadata = object(entry.$set);
		if (Array.isArray(metadata?.messages)) {
			for (const message of metadata.messages) foldMessage(state, sessionId, message);
		}
	};
	try {
		fold(JSON.parse(text));
		return;
	} catch { /* Current append-only JSONL has more than one root object. */ }
	if (!jsonl) return;
	for (const line of text.split("\n")) {
		try { fold(JSON.parse(line)); }
		catch { /* A partially written final line must not hide earlier usage. */ }
	}
}

function collectChats(state: UsageState, dir: string): void {
	let entries: import("node:fs").Dirent[];
	try { entries = readdirSync(dir, { withFileTypes: true }); }
	catch { return; }
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) collectChats(state, path);
		else if (entry.isFile() && /\.jsonl?$/.test(entry.name)) {
			try { foldSession(state, readFileSync(path, "utf8"), entry.name.endsWith(".jsonl")); }
			catch { /* Missing or unreadable session files are a graceful absence. */ }
		}
	}
}

/** Read only chat stores, retaining per-message usage rather than conversation content. */
export function collectGeminiUsage(state: UsageState, home: string): void {
	const effectiveHome = process.env.GEMINI_CLI_HOME || home;
	// Seatbelt sandbox sessions use the cache runtime root; regular sessions use .gemini.
	for (const root of [join(effectiveHome, ".gemini", "tmp"), join(effectiveHome, ".cache", ".gemini", "tmp")]) {
		let projects: import("node:fs").Dirent[];
		try { projects = readdirSync(root, { withFileTypes: true }); }
		catch { continue; }
		for (const project of projects) {
			if (project.isDirectory()) collectChats(state, join(root, project.name, "chats"));
		}
	}
}
