import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveUserHome } from "../shared/user-home";
import { agentAccountStoreRoot } from "./agent-store-roots";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEADER_LIMIT = 256 * 1024;

function code(error: unknown): string {
	return (error as NodeJS.ErrnoException)?.code ?? "unknown error";
}

async function optionalRoot(path: string): Promise<string | null> {
	try {
		return await realpath(path);
	} catch (error) {
		if (code(error) === "ENOENT") {
			try { await lstat(path); }
			catch (probeError) { if (code(probeError) === "ENOENT") return null; }
		}
		throw new Error(`Cannot read Codex session store ${path} (${code(error)}). Check its permissions before resuming.`);
	}
}

async function entries(path: string) {
	try {
		return await readdir(path, { withFileTypes: true });
	} catch (error) {
		throw new Error(`Cannot scan Codex session store ${path} (${code(error)}). Restore access before resuming.`);
	}
}

async function verifyHeader(file: string, sessionId: string): Promise<void> {
	let handle;
	try {
		if (!(await stat(file)).isFile()) throw new Error("header");
		handle = await open(file, "r");
		const buffer = Buffer.alloc(HEADER_LIMIT);
		const { bytesRead } = await handle.read(buffer, 0, HEADER_LIMIT, 0);
		const newline = buffer.subarray(0, bytesRead).indexOf(10);
		if (newline < 0) throw new Error("header");
		const header = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
		if (header?.type !== "session_meta" || header?.payload?.id !== sessionId) throw new Error("header");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code) {
			throw new Error(`Cannot read Codex conversation ${sessionId} (${code(error)}). Check session-file permissions before resuming.`);
		}
		throw new Error(`Codex conversation ${sessionId} has invalid, incomplete, or mismatched session metadata. Restore its saved header before resuming.`);
	} finally {
		await handle?.close();
	}
}

/** Every Codex home a conversation may live in: the system login, each managed account, and any configured CODEX_HOME. */
async function codexHomes(additionalHomes: string[], home: string): Promise<Set<string>> {
	const accountsRoot = await optionalRoot(agentAccountStoreRoot(home, "codex"));
	const managed = accountsRoot
		? (await entries(accountsRoot)).filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => join(accountsRoot, entry.name)).sort()
		: [];
	const homes = new Set<string>();
	for (const candidate of [join(home, ".codex"), ...managed, ...additionalHomes.filter((value) => value.trim())]) {
		const root = await optionalRoot(resolve(candidate));
		if (root) homes.add(root);
	}
	return homes;
}

async function rolloutFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	const pending = [root];
	while (pending.length) {
		const dir = pending.pop()!;
		for (const entry of await entries(dir)) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) files.push(path);
		}
	}
	return files;
}

const CWD_PROBE_BYTES = 8 * 1024;

/** The session header when it opens a user's own interactive conversation in `cwd`. */
async function interactiveHeaderIn(file: string, cwdNeedle: string, cwd: string): Promise<string | null> {
	let handle;
	try {
		handle = await open(file, "r");
		const probe = Buffer.alloc(CWD_PROBE_BYTES);
		const { bytesRead: probed } = await handle.read(probe, 0, CWD_PROBE_BYTES, 0);
		if (!probe.subarray(0, probed).includes(cwdNeedle)) return null;
		const buffer = Buffer.alloc(HEADER_LIMIT);
		const { bytesRead } = await handle.read(buffer, 0, HEADER_LIMIT, 0);
		const newline = buffer.subarray(0, bytesRead).indexOf(10);
		if (newline < 0) return null;
		const payload = JSON.parse(buffer.subarray(0, newline).toString("utf8"))?.payload;
		// `cli` is the TUI a person talks to; exec runs, IDE threads and subagents are not.
		if (payload?.cwd !== cwd || payload?.source !== "cli" || payload?.thread_source === "subagent") return null;
		return typeof payload.id === "string" && SESSION_ID.test(payload.id) ? payload.id : null;
	} catch {
		return null;
	} finally {
		await handle?.close();
	}
}

/**
 * The most recently used interactive Codex conversation started in `cwd`, across
 * every account store — for a task whose pane record was lost. Only a lookup:
 * the caller still resolves (and verifies) the store with resolveCodexResumeHome.
 */
export async function findLatestCodexConversation(cwd: string, additionalHomes: string[] = [], home = resolveUserHome()): Promise<string | null> {
	const candidates: Array<{ file: string; mtimeMs: number }> = [];
	for (const accountHome of await codexHomes(additionalHomes, home)) {
		const root = await optionalRoot(join(accountHome, "sessions"));
		if (!root) continue;
		for (const file of await rolloutFiles(root)) {
			try { candidates.push({ file, mtimeMs: (await stat(file)).mtimeMs }); }
			catch { /* vanished while scanning */ }
		}
	}
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const needle = `"cwd":${JSON.stringify(cwd)}`;
	for (const { file } of candidates) {
		const id = await interactiveHeaderIn(file, needle, cwd);
		if (id) return id;
	}
	return null;
}

/** Locate the exact saved conversation without choosing a different session. */
export async function resolveCodexResumeHome(sessionId: string, additionalHomes: string[] = [], home = resolveUserHome()): Promise<string> {
	if (!SESSION_ID.test(sessionId)) throw new Error("Invalid Codex conversation ID: expected a UUID. Check the saved session ID before resuming.");
	const homes = await codexHomes(additionalHomes, home);
	const verifiedFiles = new Set<string>();
	const matches: Array<{ home: string; archived: boolean }> = [];
	for (const accountHome of homes) {
		const seenFiles = new Set<string>();
		for (const store of ["sessions", "archived_sessions"]) {
			const root = await optionalRoot(join(accountHome, store));
			if (!root) continue;
			const pending = [root];
			while (pending.length) {
				const dir = pending.pop()!;
				for (const entry of await entries(dir)) {
					const path = join(dir, entry.name);
					if (entry.isDirectory()) {
						pending.push(path);
						continue;
					}
					// Nested directory links are not traversal roots; file links are
					// checked only when their names identify this exact conversation.
					if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(`-${sessionId}.jsonl`)) continue;
					if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error(`Codex conversation ${sessionId} is not a regular session file. Restore its saved file before resuming.`);
					let canonical: string;
					try { canonical = await realpath(path); }
					catch (error) { throw new Error(`Cannot read Codex conversation ${sessionId} (${code(error)}). Restore its session file before resuming.`); }
					if (seenFiles.has(canonical)) continue;
					if (!verifiedFiles.has(canonical)) await verifyHeader(canonical, sessionId);
					verifiedFiles.add(canonical);
					seenFiles.add(canonical);
					matches.push({ home: accountHome, archived: store === "archived_sessions" });
				}
			}
		}
	}
	if (new Set(matches.map((match) => match.home)).size > 1) {
		throw new Error(`Codex conversation ${sessionId} exists in multiple account stores. Resolve the duplicate session stores before resuming; no account was selected.`);
	}
	if (matches.filter((match) => !match.archived).length > 1) {
		throw new Error(`Codex conversation ${sessionId} has multiple active session files in one store. Resolve the duplicate files before resuming; no conversation was selected.`);
	}
	const active = matches.find((match) => !match.archived);
	if (active) return active.home;
	if (matches.length) throw new Error(`Codex conversation ${sessionId} is archived. Unarchive that exact conversation in Codex before resuming.`);
	throw new Error(`Codex conversation ${sessionId} was not found in the available account stores. Restore its saved session file or reconnect its original store before resuming.`);
}
