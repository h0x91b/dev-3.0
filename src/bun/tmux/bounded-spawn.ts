/**
 * Bounding a spawned tmux process — the ONE implementation of "wait for this
 * process, but give up if it never answers".
 *
 * A tmux client whose server is wedged never exits on its own: it sits on the
 * socket waiting for a reply that never comes. A bare `await proc.exited` on
 * such a client hangs for the life of the app, and every caller behind it hangs
 * with it (it froze startup on "Checking system…" — see
 * decisions/2026/08/16/bound-every-tmux-spawn.md).
 *
 * Internal to the tmux module: TmuxClient and ./binary are the only consumers.
 */
import type { spawn } from "../spawn";

type SpawnedProcess = ReturnType<typeof spawn>;

/** How long a stopped child gets to die politely, then to be reaped after KILL. */
const TERM_GRACE_MS = 500;
const KILL_GRACE_MS = 500;

export interface BoundedRunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * `done` — the process answered. `stopped` — we gave up on it and killed it;
 * `confirmed` says whether the child was actually seen to exit.
 */
export type BoundedOutcome =
	| { kind: "done"; value: BoundedRunResult }
	| { kind: "stopped"; confirmed: boolean };

export interface SpawnBounds {
	timeoutMs?: number;
	signal?: AbortSignal;
}

/** Whether `work` settled within `ms`. Never rejects; used only to bound a wait. */
async function settled(work: Promise<unknown>, ms: number): Promise<boolean> {
	return await Promise.race([
		work.then(
			() => true,
			() => true,
		),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
	]);
}

/** `work`, or `fallback` as soon as `giveUp` settles — so no wait outlives the stop. */
function until<T>(work: Promise<T>, giveUp: Promise<unknown>, fallback: T): Promise<T> {
	return Promise.race([work.catch(() => fallback), giveUp.then(() => fallback)]);
}

/**
 * Read a stream with an OWN reader so the stop can cancel it: handing the stream to
 * `Response` locks it, and an abandoned `Response` read stays pending for the life of the
 * process with the stream locked behind it.
 */
async function readUntil(stream: unknown, giveUp: Promise<unknown>): Promise<string> {
	const readable = stream as ReadableStream<Uint8Array> | undefined;
	// Anything that is not a live stream (a string, a Response, a test double) has no
	// reader to cancel and cannot half-open, so read it the simple way.
	if (!readable || typeof readable.getReader !== "function") {
		return await until(new Response(readable as unknown as BodyInit).text(), giveUp, "");
	}
	const reader = readable.getReader();
	void giveUp.then(() => reader.cancel().catch(() => undefined));
	const decoder = new TextDecoder();
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
	} catch {
		// cancelled, or the pipe broke — whatever arrived is what we report
	} finally {
		reader.releaseLock();
	}
	return text;
}

/**
 * Collect a spawned process's output under a timeout / abort signal. Without
 * `bounds.timeoutMs` the wait is unbounded — pass one for anything that talks
 * to a tmux server, which may never reply.
 */
export async function runBounded(proc: SpawnedProcess, bounds?: SpawnBounds): Promise<BoundedOutcome> {
	let resolveStopped: (confirmed: boolean) => void = () => undefined;
	// Settles when a stop has finished, with whether the child was confirmed gone.
	const stopped = new Promise<boolean>((resolve) => {
		resolveStopped = resolve;
	});
	let stopping = false;
	const stop = async (): Promise<void> => {
		if (stopping) return;
		stopping = true;
		// TERM, a bounded wait, then KILL, then a bounded reap.
		try {
			proc.kill("SIGTERM");
		} catch {
			// already gone
		}
		if (await settled(proc.exited, TERM_GRACE_MS)) return resolveStopped(true);
		try {
			proc.kill("SIGKILL");
		} catch {
			// already gone
		}
		resolveStopped(await settled(proc.exited, KILL_GRACE_MS));
	};

	const timer = bounds?.timeoutMs === undefined ? undefined : setTimeout(() => void stop(), Math.max(0, bounds.timeoutMs));
	const onAbort = (): void => void stop();
	bounds?.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		// Every wait here ends when the stop does, so a half-open pipe or an `exited`
		// that never settles cannot outlive the decision to give up.
		const collected = Promise.all([
			readUntil(proc.stdout, stopped),
			readUntil(proc.stderr, stopped),
			until(proc.exited, stopped, -1),
		]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }));

		const result = await Promise.race([
			collected.then((value) => ({ kind: "done" as const, value })),
			stopped.then((confirmed) => ({ kind: "stopped" as const, confirmed })),
		]);
		if (result.kind === "done" && !stopping) return result;
		return { kind: "stopped", confirmed: result.kind === "stopped" ? result.confirmed : await stopped };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		bounds?.signal?.removeEventListener("abort", onAbort);
	}
}
