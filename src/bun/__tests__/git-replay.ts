/**
 * Recorded-git fixtures: a test drives the real `getTaskDiff` against a transcript
 * of real git output instead of a real repository on disk.
 *
 * Why not a hand-written mock: git's own output is the input to every parser in
 * git.ts, so inventing it lets a parser bug pass. Every byte here came out of real
 * git and is replayed verbatim.
 *
 * Where the teeth are: a response is keyed on the EXACT argv (plus cwd and stdin)
 * the code under test sends. Drop `-M`, reorder the flags, or ask for a different
 * revision range and the lookup misses and the test fails loudly — it cannot
 * silently pass on a changed command the way `mockResolvedValue` would.
 *
 * Re-recording (needs real git, opt-in, never on CI) — see `recordGitTranscript`.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export const REPO_PLACEHOLDER = "<repo>";

export interface GitExchange {
	/** argv as the code under test sent it, recording paths replaced by the placeholder. */
	cmd: string[];
	cwd: string;
	/** base64 of the stdin fed to the process, or null. cat-file input is binary. */
	stdin: string | null;
	exitCode: number;
	/** base64 — git output is not always valid UTF-8 (cat-file --batch, -z lists). */
	stdout: string;
	stderr: string;
}

export type GitTranscript = GitExchange[];

function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

function fromBase64(text: string): Uint8Array {
	return new Uint8Array(Buffer.from(text, "base64"));
}

/** Replace the recording repo's path so the fixture is portable across machines. */
function scrub(text: string, repoDir: string): string {
	return repoDir ? text.split(repoDir).join(REPO_PLACEHOLDER) : text;
}

function exchangeKey(parts: Pick<GitExchange, "cmd" | "cwd" | "stdin">): string {
	return JSON.stringify([parts.cwd, parts.cmd, parts.stdin]);
}

function streamOf(load: () => Promise<Uint8Array>): ReadableStream<Uint8Array> {
	return new ReadableStream({
		async start(controller) {
			try {
				const bytes = await load();
				if (bytes.length) controller.enqueue(bytes);
				controller.close();
			} catch (err) {
				controller.error(err);
			}
		},
	});
}

export function loadTranscript(path: string): GitTranscript {
	return JSON.parse(readFileSync(path, "utf-8")) as GitTranscript;
}

export function saveTranscript(path: string, transcript: GitTranscript): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(transcript, null, "\t")}\n`);
}

interface ReplayMock {
	spawn: (cmd: string[], opts?: Record<string, unknown>) => unknown;
	/** Every argv the code under test asked for, in order. */
	asked: string[][];
	/** Recorded exchanges nothing asked for — a fixture that drifted ahead of the code. */
	unused: () => string[];
}

/**
 * The replay spawn mock. Shape-compatible with `src/bun/spawn.ts`'s `spawn`, so a
 * suite wires it through the same `vi.mock("../spawn", …)` the real-git suites use.
 *
 * `repoDir` is the worktree path the test passes to `getTaskDiff`; it never has to
 * exist on disk.
 */
export function createGitReplayMock(transcript: GitTranscript, repoDir: string): ReplayMock {
	// The same command asked twice gets the next recorded answer and then keeps the
	// last one. Safe because every recorded command is a read: re-asking cannot
	// change the answer. A recorded WRITE would need strict single-use.
	const queues = new Map<string, GitExchange[]>();
	for (const exchange of transcript) {
		const key = exchangeKey(exchange);
		const queue = queues.get(key);
		if (queue) queue.push(exchange);
		else queues.set(key, [exchange]);
	}
	const consumed = new Map<string, number>();
	const asked: string[][] = [];

	async function resolveExchange(
		cmd: string[],
		opts: Record<string, unknown> | undefined,
	): Promise<GitExchange> {
		const cwd = scrub(String(opts?.cwd ?? ""), repoDir);
		const scrubbedCmd = cmd.map((part) => scrub(part, repoDir));
		let stdin: string | null = null;
		if (opts?.stdin instanceof Blob) {
			const bytes = new Uint8Array(await (opts.stdin as Blob).arrayBuffer());
			stdin = toBase64(new TextEncoder().encode(scrub(new TextDecoder().decode(bytes), repoDir)));
		}
		const key = exchangeKey({ cmd: scrubbedCmd, cwd, stdin });
		const queue = queues.get(key);
		if (!queue) {
			const message =
				`[git-replay] no recorded git response for:\n  ${cmd.join(" ")}\n  cwd: ${cwd}\n  key: ${key}\n` +
				"The code under test now asks git something this fixture never recorded: either the command " +
				"changed (RENAME_DETECTION_ARGS, the revision range, the flag order) or a new call site appeared. " +
				"If the new command is intended, re-record the fixture and review the diff.";
			// Logged as well as thrown: git.ts turns a failed process into `{ ok: false }`,
			// so a swallowed rejection would surface as a confusing empty-diff assertion.
			console.error(message);
			throw new Error(message);
		}
		const seen = consumed.get(key) ?? 0;
		consumed.set(key, seen + 1);
		return queue[Math.min(seen, queue.length - 1)];
	}

	function spawn(cmd: string[], opts?: Record<string, unknown>) {
		asked.push([...cmd]);
		const exchange = resolveExchange(cmd, opts);
		return {
			exited: exchange.then((e) => e.exitCode),
			stdout: streamOf(async () => fromBase64((await exchange).stdout)),
			stderr: streamOf(async () => fromBase64((await exchange).stderr)),
			// `stdin: "pipe"` callers (runGitPipe) get a sink that discards: a piped
			// pair is keyed by the two argvs, not by the bytes flowing between them.
			stdin: { write: (chunk: Uint8Array) => chunk.byteLength, flush: () => Promise.resolve(0), end: () => {} },
			kill: () => {},
		};
	}

	return {
		spawn,
		asked,
		unused: () => [...queues.keys()].filter((key) => !consumed.has(key)),
	};
}

/**
 * Wraps a real spawn implementation and writes everything it ran to a transcript.
 * Used only by the opt-in re-record path, never in a normal run.
 */
export function createGitRecorder(
	realSpawn: (cmd: string[], opts?: Record<string, unknown>) => {
		exited: Promise<number>;
		stdout: ReadableStream<Uint8Array>;
		stderr: ReadableStream<Uint8Array>;
	},
	repoDir: string,
	transcript: GitTranscript,
) {
	return function spawn(cmd: string[], opts?: Record<string, unknown>) {
		const proc = realSpawn(cmd, opts);
		// Buffer both sides fully so the exchange can be written down, then re-serve
		// them. Streaming is lost, which only matters for progress parsing — and the
		// recorder is never the path a normal run takes.
		const captured = (async () => {
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).arrayBuffer().then((b) => new Uint8Array(b)),
				new Response(proc.stderr).arrayBuffer().then((b) => new Uint8Array(b)),
				proc.exited,
			]);
			let stdin: string | null = null;
			if (opts?.stdin instanceof Blob) {
				const bytes = new Uint8Array(await (opts.stdin as Blob).arrayBuffer());
				stdin = toBase64(new TextEncoder().encode(scrub(new TextDecoder().decode(bytes), repoDir)));
			}
			transcript.push({
				cmd: cmd.map((part) => scrub(part, repoDir)),
				cwd: scrub(String(opts?.cwd ?? ""), repoDir),
				stdin,
				exitCode,
				stdout: toBase64(stdout),
				stderr: toBase64(stderr),
			});
			return { stdout, stderr, exitCode };
		})();

		return {
			exited: captured.then((c) => c.exitCode),
			stdout: streamOf(async () => (await captured).stdout),
			stderr: streamOf(async () => (await captured).stderr),
			stdin: { write: (chunk: Uint8Array) => chunk.byteLength, flush: () => Promise.resolve(0), end: () => {} },
			kill: () => {},
		};
	};
}

// ─── Active scenario ────────────────────────────────────────────────────────
//
// `vi.mock("../spawn", …)` is hoisted once per file, but a suite needs a different
// transcript per test. The mock therefore forwards to whichever scenario is
// currently installed, and a test with none installed fails saying so rather than
// quietly reaching real git.

let current: { spawn: (cmd: string[], opts?: Record<string, unknown>) => unknown } | null = null;

/** True when the suite was started to regenerate its fixtures. */
export const RECORDING = Boolean(process.env.DEV3_GIT_RECORD);

export function useReplay(transcript: GitTranscript, repoDir: string): ReplayMock {
	const mock = createGitReplayMock(transcript, repoDir);
	current = mock;
	return mock;
}

export function useRecorder(
	realSpawn: Parameters<typeof createGitRecorder>[0],
	repoDir: string,
	transcript: GitTranscript,
): void {
	current = { spawn: createGitRecorder(realSpawn, repoDir, transcript) };
}

export function endScenario(): void {
	current = null;
}

/** The function a suite hands to `vi.mock("../spawn")`. */
export function sessionSpawn(cmd: string[], opts?: Record<string, unknown>) {
	if (!current) {
		throw new Error(
			"[git-replay] no scenario is installed, so this git call has nowhere to go: " +
			`${cmd.join(" ")}. Install one with useReplay() (or useRecorder()) in beforeEach.`,
		);
	}
	return current.spawn(cmd, opts);
}

export { scrub as scrubRepoPath, exchangeKey, toBase64 };
