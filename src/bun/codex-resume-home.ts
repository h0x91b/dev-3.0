import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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

interface InteractiveHeader { id: string; startMs: number }

/** The session header when it opens a user's own interactive conversation in `cwd`. */
async function interactiveHeaderIn(file: string, cwdNeedle: string, cwd: string): Promise<InteractiveHeader | null> {
	let handle;
	try {
		handle = await open(file, "r");
		const probe = Buffer.alloc(CWD_PROBE_BYTES);
		const { bytesRead: probed } = await handle.read(probe, 0, CWD_PROBE_BYTES, 0);
		if (!probe.subarray(0, probed).includes(cwdNeedle)) return null;
		const payload = await sessionPayload(handle);
		// `cli` is the TUI a person talks to; exec runs, IDE threads and subagents are not.
		if (payload?.cwd !== cwd || !isInteractive(payload)) return null;
		if (typeof payload.id !== "string" || !SESSION_ID.test(payload.id)) return null;
		return { id: payload.id, startMs: Date.parse(String(payload.timestamp)) };
	} catch {
		return null;
	} finally {
		await handle?.close();
	}
}

type SessionPayload = { id?: unknown; cwd?: unknown; source?: unknown; thread_source?: unknown; timestamp?: unknown };

async function sessionPayload(handle: Awaited<ReturnType<typeof open>>): Promise<SessionPayload | null> {
	const buffer = Buffer.alloc(HEADER_LIMIT);
	const { bytesRead } = await handle.read(buffer, 0, HEADER_LIMIT, 0);
	const newline = buffer.subarray(0, bytesRead).indexOf(10);
	if (newline < 0) return null;
	const header = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
	return header?.type === "session_meta" ? header.payload ?? null : null;
}

function isInteractive(payload: SessionPayload): boolean {
	return payload.source === "cli" && payload.thread_source !== "subagent";
}

interface LocatedConversation { home: string; file: string }

/** Locate the exact saved conversation without choosing a different session. */
async function locateCodexConversation(sessionId: string, homes: Set<string>): Promise<LocatedConversation> {
	if (!SESSION_ID.test(sessionId)) throw new Error("Invalid Codex conversation ID: expected a UUID. Check the saved session ID before resuming.");
	const verifiedFiles = new Set<string>();
	const matches: Array<{ home: string; file: string; archived: boolean }> = [];
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
					matches.push({ home: accountHome, file: canonical, archived: store === "archived_sessions" });
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
	if (active) return { home: active.home, file: active.file };
	if (matches.length) throw new Error(`Codex conversation ${sessionId} is archived. Unarchive that exact conversation in Codex before resuming.`);
	throw new Error(`Codex conversation ${sessionId} was not found in the available account stores. Restore its saved session file or reconnect its original store before resuming.`);
}

/** Locate the exact saved conversation without choosing a different session. */
export async function resolveCodexResumeHome(sessionId: string, additionalHomes: string[] = [], home = resolveUserHome()): Promise<string> {
	if (!SESSION_ID.test(sessionId)) throw new Error("Invalid Codex conversation ID: expected a UUID. Check the saved session ID before resuming.");
	return (await locateCodexConversation(sessionId, await codexHomes(additionalHomes, home))).home;
}

/**
 * Whether a hook-reported id is a user's own interactive conversation that is
 * already on disk. Codex creates the rollout lazily, so "not yet" is false and a
 * later hook of the same session binds it.
 */
export async function isInteractiveCodexConversation(sessionId: string, additionalHomes: string[] = [], home = resolveUserHome()): Promise<boolean> {
	// Checked before any store is touched: a malformed id can match nothing.
	if (!SESSION_ID.test(sessionId)) return false;
	let located: LocatedConversation;
	try { located = await locateCodexConversation(sessionId, await codexHomes(additionalHomes, home)); }
	catch { return false; }
	let handle;
	try {
		handle = await open(located.file, "r");
		const payload = await sessionPayload(handle);
		return !!payload && payload.id === sessionId && isInteractive(payload);
	} catch {
		return false;
	} finally {
		await handle?.close();
	}
}

/**
 * Why each caller asks. `explicit-resume` honours a saved id exactly;
 * `automatic-recovery` takes the newest eligible conversation (the user's
 * ruling); `reopen` never guesses. See decisions/2026/09/28/codex-conversation-selection.md.
 */
export type CodexSelectionIntent = "explicit-resume" | "automatic-recovery" | "reopen";

export interface CodexPaneSnapshot {
	sessionId: string | null;
	/** Managed account id; `null` = a non-managed home; `undefined` = never recorded. */
	accountId?: string | null;
	/**
	 * Whether the pane may still be running Codex. The CALLER decides: true when the
	 * pane exists or its state is unknown; false only for a pane proven gone or one
	 * this call is relaunching. A live other pane disables scanned candidates.
	 */
	live: boolean;
	/** Whether this call chooses for the pane. Others still shape the choice. */
	resumeNow: boolean;
}

export interface CodexSelectionInput {
	intent: CodexSelectionIntent;
	/** The task's managed git worktree, or null when conversations may not be scanned at all. */
	scanWorktree: string | null;
	/** Every Codex pane recorded for the task, from one snapshot. */
	panes: CodexPaneSnapshot[];
	runBoundary: { lifecycleStartedAt: string | null | undefined; worktreeBirthMs: number | null; floorAt: string | null | undefined };
	additionalHomes: string[];
	home?: string;
}

export type CodexPaneSelection =
	| { kind: "selected"; sessionId: string; codexHome: string; via: "stored" | "latest-owned" }
	| { kind: "none" | "ambiguous" | "account-mismatch"; reason: string }
	| { kind: "not-requested" };

/**
 * The earliest start a scanned conversation may have to belong to this run.
 * The earlier of the status clock and the folder's birth, because either can
 * come after a legitimate start; a restart floor can only raise it. Null means
 * no usable bound, so nothing may be scanned.
 */
export function codexScanBound(boundary: CodexSelectionInput["runBoundary"]): number | null {
	const present = [Date.parse(boundary.lifecycleStartedAt ?? ""), boundary.worktreeBirthMs ?? Number.NaN]
		.filter((value) => Number.isFinite(value) && value > 0);
	if (!present.length) return null;
	const floor = Date.parse(boundary.floorAt ?? "");
	return Math.max(Math.min(...present), Number.isFinite(floor) ? floor : Number.NEGATIVE_INFINITY);
}

interface Candidate { sessionId: string; home: string; mtimeMs: number; scanned: boolean }

async function scannedCandidates(worktree: string, bound: number, homes: Set<string>, boundIds: Set<string>): Promise<Candidate[]> {
	const found: Candidate[] = [];
	const needle = `"cwd":${JSON.stringify(worktree)}`;
	for (const accountHome of homes) {
		const root = await optionalRoot(join(accountHome, "sessions"));
		if (!root) continue;
		for (const file of await rolloutFiles(root)) {
			const header = await interactiveHeaderIn(file, needle, worktree);
			if (!header || boundIds.has(header.id) || !(header.startMs >= bound)) continue;
			try { found.push({ sessionId: header.id, home: accountHome, mtimeMs: (await stat(file)).mtimeMs, scanned: true }); }
			catch { /* vanished while scanning */ }
		}
	}
	return found;
}

/**
 * Pick the Codex conversation for each pane of one task, never another task's:
 * a scanned conversation must start in this task's managed worktree, inside the
 * current run, and belong to no pane. Refuses instead of guessing when two panes
 * could claim it or another Codex pane is live. Saved-id errors throw unchanged.
 */
export async function selectCodexConversations(input: CodexSelectionInput): Promise<CodexPaneSelection[]> {
	const home = input.home ?? resolveUserHome();
	const homes = await codexHomes(input.additionalHomes, home);
	const accountsRoot = await optionalRoot(agentAccountStoreRoot(home, "codex"));
	const isManaged = (store: string) => !!accountsRoot && dirname(store) === accountsRoot;
	const allowed = (accountId: string | null | undefined) => (store: string) =>
		accountId === undefined ? true : accountId === null ? !isManaged(store) : isManaged(store) && basename(store) === accountId;

	const boundIds = new Set(input.panes.flatMap((pane) => (pane.sessionId ? [pane.sessionId] : [])));
	const bound = input.scanWorktree ? codexScanBound(input.runBoundary) : null;
	const scanned = input.scanWorktree && bound !== null ? await scannedCandidates(input.scanWorktree, bound, homes, boundIds) : [];

	const stored = await Promise.all(input.panes.map(async (pane) => {
		if (!pane.sessionId) return null;
		// Only the panes being chosen for may fail loudly; another pane's broken id
		// just means it cannot outrank a scanned candidate.
		const located = pane.resumeNow
			? await locateCodexConversation(pane.sessionId, homes)
			: await locateCodexConversation(pane.sessionId, homes).catch(() => null);
		if (!located) return null;
		return { sessionId: pane.sessionId, home: located.home, mtimeMs: (await stat(located.file)).mtimeMs, scanned: false } satisfies Candidate;
	}));

	const newest = (list: Candidate[]) => list.reduce<Candidate | null>((best, next) => (!best || next.mtimeMs > best.mtimeMs ? next : best), null);
	// What each pane would take under the newest-wins rule; the claim count keeps
	// two panes from both resuming one unbound conversation.
	const claims = input.panes.map((pane, index) => newest([
		...(stored[index] ? [stored[index]!] : []),
		...scanned.filter((candidate) => allowed(pane.accountId)(candidate.home)),
	]));
	const claimCount = (sessionId: string) => claims.filter((claim) => claim?.sessionId === sessionId).length;

	return input.panes.map((pane, index): CodexPaneSelection => {
		if (!pane.resumeNow) return { kind: "not-requested" };
		const own = stored[index];
		if (own) {
			if (!allowed(pane.accountId)(own.home)) {
				return { kind: "account-mismatch", reason: `Codex conversation ${own.sessionId} is stored under a different account than this pane records. Resume it from that account, or select this pane's conversation in Codex.` };
			}
			if (input.intent !== "automatic-recovery") return { kind: "selected", sessionId: own.sessionId, codexHome: own.home, via: "stored" };
		} else if (input.intent === "reopen") {
			return { kind: "none", reason: "The previous Codex conversation of this task is not recorded, so it was not reopened. Run `codex resume <id>` in the task's terminal to continue it." };
		}

		const eligible = scanned.filter((candidate) => allowed(pane.accountId)(candidate.home));
		const winner = newest([...(own ? [own] : []), ...eligible]);
		if (!winner) {
			return { kind: "none", reason: "No Codex conversation of this task's worktree was found for this pane. Run `codex resume <id>` in the task's terminal to continue a specific one." };
		}
		if (!winner.scanned) return { kind: "selected", sessionId: winner.sessionId, codexHome: winner.home, via: "stored" };

		const otherLive = input.panes.some((other, i) => i !== index && other.live);
		const stores = new Set(eligible.map((candidate) => candidate.home));
		const contested = claimCount(winner.sessionId) > 1;
		if (otherLive || contested || stores.size > 1) {
			const why = otherLive ? "another Codex pane of this task is still open"
				: contested ? "more than one pane of this task could own it"
				: "matching conversations exist under more than one account";
			return { kind: "ambiguous", reason: `Codex conversation ${winner.sessionId} is the newest in this worktree${own ? ` (newer than this pane's ${own.sessionId})` : ""}, but ${why}. Nothing was resumed; run \`codex resume <id>\` in the pane to choose.` };
		}
		return { kind: "selected", sessionId: winner.sessionId, codexHome: winner.home, via: "latest-owned" };
	});
}
