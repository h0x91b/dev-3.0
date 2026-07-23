/**
 * Reusable executable parity checks (MIG-001).
 *
 * Each `live` corpus scenario maps to a check that drives it through ANY
 * {@link ParityRunner} and asserts the backend-neutral observables; each `pure`
 * scenario maps to a check over the existing product-level pure helpers. The
 * checks are framework-agnostic (they throw plain Errors, not vitest matchers)
 * so the same set runs against the tmux runner today and a native runner later
 * — the point of MIG-001.
 *
 * `gap` scenarios have no check here by design; the corpus documents why.
 */
import { realpathSync } from "node:fs";
import { smallestClientSize } from "../pty-server";
import { encodeResizeSequence, parseResizeSequence } from "../../shared/resize-protocol";
import type { ParityRunner } from "./runner";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`parity check failed: ${message}`);
}

/** Poll `fn` until it returns a truthy value or the attempts run out. */
async function until<T>(fn: () => Promise<T>, message: string, tries = 50, intervalMs = 100): Promise<T> {
	let last: T | undefined;
	for (let i = 0; i < tries; i++) {
		last = await fn();
		if (last) return last;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`parity check timed out: ${message}`);
}

export interface CheckContext {
	/** A writable directory a check may use as a session/view cwd. */
	cwd: string;
	/** A fresh controller on the same backend endpoint (reconnect scenario). */
	reconnect: () => ParityRunner;
}

let sessionSeq = 0;
function uniqueSessionId(label: string): string {
	return `dev3-parity-${label}-${process.pid}-${sessionSeq++}`;
}

async function cleanup(runner: ParityRunner, id: string): Promise<void> {
	await runner.cleanupSession(id, { bestEffort: true }).catch(() => {});
}

/** Executable checks for every `live` corpus scenario, keyed by scenario id. */
export const LIVE_CHECKS: Record<string, (runner: ParityRunner, ctx: CheckContext) => Promise<void>> = {
	"create.session-cwd-env": async (runner, ctx) => {
		const id = uniqueSessionId("cwd-env");
		const cwdReal = realpathSync(ctx.cwd);
		try {
			const { firstViewId } = await runner.createSession({
				id,
				cwd: ctx.cwd,
				env: { DEV3_PARITY_ENV: "marker-77" },
				command: "sh",
			});
			assert(await runner.isSessionPresent(id), "created session should be present");
			// `pwd -P` prints the physical (symlink-resolved) cwd via getcwd, so it
			// reflects the pane's real directory rather than a stale inherited $PWD.
			await runner.sendInput(id, firstViewId, 'printf "PARITYENV=%s\\n" "$DEV3_PARITY_ENV"; pwd -P');
			const out = await until(
				async () => {
					const cap = await runner.capture(id, firstViewId, { includeHistory: true });
					return cap.includes("PARITYENV=marker-77") ? cap : "";
				},
				"env var should propagate to the session process",
			);
			assert(out.includes("PARITYENV=marker-77"), "environment variable must reach the process");
			// A long cwd wraps at the detached pane's 80-column width; flatten
			// whitespace (the path itself has none) before matching the contiguous path.
			const flat = out.replace(/\s+/g, "");
			assert(flat.includes(cwdReal) || flat.includes(ctx.cwd), "working directory must reach the process");
		} finally {
			await cleanup(runner, id);
		}
	},

	"create.stable-logical-id": async (runner, ctx) => {
		const id = uniqueSessionId("stable-id");
		try {
			const handle = await runner.createSession({ id, cwd: ctx.cwd, command: "sh" });
			const first = await runner.activeViewId(id);
			const second = await runner.activeViewId(id);
			assert(first !== null && first === second, "repeated lookups return the same view id");
			const views = await runner.listViews(id);
			assert(views.some((v) => v.id === handle.firstViewId), "the first view keeps its logical id");
		} finally {
			await cleanup(runner, id);
		}
	},

	"attach.read-current-and-subsequent-output": async (runner, ctx) => {
		const id = uniqueSessionId("attach");
		try {
			const { firstViewId } = await runner.createSession({ id, cwd: ctx.cwd, command: "sh" });
			await runner.sendInput(id, firstViewId, "echo PARITY-BEFORE");
			await until(
				async () => (await runner.capture(id, firstViewId, { includeHistory: true })).includes("PARITY-BEFORE"),
				"output produced before attach is readable",
			);
			await runner.sendInput(id, firstViewId, "echo PARITY-AFTER");
			await until(
				async () => (await runner.capture(id, firstViewId, { includeHistory: true })).includes("PARITY-AFTER"),
				"output produced after attach is readable",
			);
		} finally {
			await cleanup(runner, id);
		}
	},

	"attach.missing-session-is-clean": async (runner) => {
		const ghost = uniqueSessionId("ghost");
		assert((await runner.isSessionPresent(ghost)) === false, "unknown session is absent");
		// listViews of a missing session must be a typed error OR an empty list —
		// never an uncaught crash. Both outcomes satisfy the contract.
		const result = await runner.listViews(ghost).then(
			(views) => ({ ok: true as const, views }),
			(err) => ({ ok: false as const, err }),
		);
		if (result.ok) {
			assert(result.views.length === 0, "missing session lists no views");
		} else {
			assert(result.err instanceof Error, "missing session raises a catchable typed error");
		}
	},

	"input.keys-reach-process": async (runner, ctx) => {
		const id = uniqueSessionId("input");
		try {
			const { firstViewId } = await runner.createSession({ id, cwd: ctx.cwd, command: "sh" });
			await runner.sendInput(id, firstViewId, "echo PARITY-ROUNDTRIP");
			await until(
				async () => (await runner.capture(id, firstViewId, { includeHistory: true })).includes("PARITY-ROUNDTRIP"),
				"input reaches the process and is reflected in output",
			);
		} finally {
			await cleanup(runner, id);
		}
	},

	"split.adds-second-view": async (runner, ctx) => {
		const id = uniqueSessionId("split");
		const cwdReal = realpathSync(ctx.cwd);
		try {
			const { firstViewId } = await runner.createSession({ id, cwd: ctx.cwd, command: "sh" });
			const second = await runner.splitView(id, firstViewId, { cwd: ctx.cwd, command: "sh" });
			assert(second.id !== firstViewId, "the new view has a distinct logical id");
			const views = await runner.listViews(id);
			assert(views.length === 2, "the session now has two views");
			assert(views.some((v) => v.id === second.id), "the new view is listable");
			await runner.sendInput(id, second.id, "pwd -P");
			await until(
				async () => {
					// Flatten whitespace: a long cwd wraps at the 80-column pane width.
					const cap = (await runner.capture(id, second.id, { includeHistory: true })).replace(/\s+/g, "");
					return cap.includes(cwdReal) || cap.includes(ctx.cwd);
				},
				"the new view's process observes the requested working directory",
			);
		} finally {
			await cleanup(runner, id);
		}
	},

	"focus.exactly-one-active-view": async (runner, ctx) => {
		const id = uniqueSessionId("focus");
		try {
			const { firstViewId } = await runner.createSession({ id, cwd: ctx.cwd, command: "sh" });
			const second = await runner.splitView(id, firstViewId, { cwd: ctx.cwd, command: "sh" });
			await runner.focusView(id, firstViewId);
			await until(async () => (await runner.activeViewId(id)) === firstViewId, "focus lands on the first view");
			let views = await runner.listViews(id);
			assert(views.filter((v) => v.active).length === 1, "exactly one view is active after focus");
			await runner.focusView(id, second.id);
			await until(async () => (await runner.activeViewId(id)) === second.id, "focus moves to the second view");
			views = await runner.listViews(id);
			assert(views.filter((v) => v.active).length === 1, "still exactly one active view after refocus");
		} finally {
			await cleanup(runner, id);
		}
	},

	"capture.content-and-ordering": async (runner, ctx) => {
		const id = uniqueSessionId("capture");
		try {
			const { firstViewId } = await runner.createSession({ id, cwd: ctx.cwd, command: "sh" });
			for (const line of ["PARITY-L1", "PARITY-L2", "PARITY-L3"]) {
				await runner.sendInput(id, firstViewId, `echo ${line}`);
			}
			const cap = await until(
				async () => {
					const c = await runner.capture(id, firstViewId, { includeHistory: true });
					return c.includes("PARITY-L1") && c.includes("PARITY-L2") && c.includes("PARITY-L3") ? c : "";
				},
				"all printed lines are captured",
			);
			const i1 = cap.indexOf("PARITY-L1");
			const i2 = cap.indexOf("PARITY-L2");
			const i3 = cap.indexOf("PARITY-L3");
			assert(i1 < i2 && i2 < i3, "captured lines are in the order they were printed");
		} finally {
			await cleanup(runner, id);
		}
	},

	"capture.dead-view-is-clean": async (runner, ctx) => {
		const id = uniqueSessionId("dead-view");
		try {
			const { firstViewId } = await runner.createSession({ id, cwd: ctx.cwd, command: "sh" });
			// A second view whose process exits immediately — its view then goes away
			// on its own (process exit ends the view), leaving the session alive.
			const dead = await runner.splitView(id, firstViewId, { cwd: ctx.cwd, command: "true" });
			await until(
				async () => !(await runner.listViews(id)).some((v) => v.id === dead.id),
				"a view whose process exited is no longer listed",
			);
			// A best-effort operation on the gone view resolves quietly, no crash.
			await runner.killView(id, dead.id, { bestEffort: true });
			assert(await runner.isSessionPresent(id), "the surviving session is still present");
		} finally {
			await cleanup(runner, id);
		}
	},

	"reconnect.session-survives-detach": async (runner, ctx) => {
		const id = uniqueSessionId("reconnect");
		const fresh = ctx.reconnect();
		try {
			const { firstViewId } = await runner.createSession({ id, cwd: ctx.cwd, command: "sh" });
			await runner.sendInput(id, firstViewId, "echo PARITY-PERSIST");
			await until(
				async () => (await runner.capture(id, firstViewId, { includeHistory: true })).includes("PARITY-PERSIST"),
				"content is produced before detach",
			);
			// A fresh controller rediscovers the same session, view id, and content.
			assert(await fresh.isSessionPresent(id), "session survives with no attached controller");
			const freshViews = await fresh.listViews(id);
			assert(freshViews.some((v) => v.id === firstViewId), "the fresh controller sees the same view id");
			const cap = await fresh.capture(id, firstViewId, { includeHistory: true });
			assert(cap.includes("PARITY-PERSIST"), "content produced before detach survives rediscovery");
		} finally {
			await fresh.dispose().catch(() => {});
			await cleanup(runner, id);
		}
	},

	"high-output.lossless-ordered": async (runner, ctx) => {
		const id = uniqueSessionId("burst");
		const N = 200;
		try {
			const { firstViewId } = await runner.createSession({ id, cwd: ctx.cwd, command: "sh" });
			await runner.sendInput(id, firstViewId, `i=1; while [ $i -le ${N} ]; do echo BURST-$i; i=$((i+1)); done`);
			const cap = await until(
				async () => {
					const c = await runner.capture(id, firstViewId, { includeHistory: true });
					return c.includes(`BURST-${N}`) ? c : "";
				},
				"the full output burst is captured",
			);
			const seen: number[] = [];
			for (const m of cap.matchAll(/BURST-(\d+)/g)) seen.push(Number(m[1]));
			// Every line present exactly once, and in ascending (produced) order.
			for (let n = 1; n <= N; n++) assert(seen.includes(n), `line BURST-${n} must be present (no loss)`);
			const ascending = seen.filter((_, idx) => idx === 0 || seen[idx] > seen[idx - 1]);
			assert(ascending.length === seen.length, "burst lines are captured in produced order");
		} finally {
			await cleanup(runner, id);
		}
	},

	"exit.process-exit-ends-view": async (runner, ctx) => {
		const id = uniqueSessionId("exit");
		try {
			const { firstViewId } = await runner.createSession({ id, cwd: ctx.cwd, command: "sh" });
			// The only view's shell exits; the session then has no views and is gone.
			await runner.sendInput(id, firstViewId, "exit");
			await until(
				async () => (await runner.isSessionPresent(id)) === false,
				"a session with no remaining views is no longer present",
			);
		} finally {
			await cleanup(runner, id);
		}
	},

	"cleanup.removes-session": async (runner, ctx) => {
		const id = uniqueSessionId("cleanup");
		try {
			const { firstViewId } = await runner.createSession({ id, cwd: ctx.cwd, command: "sh" });
			await runner.splitView(id, firstViewId, { cwd: ctx.cwd, command: "sh" });
			await runner.cleanupSession(id);
			assert((await runner.isSessionPresent(id)) === false, "the session is gone after cleanup");
			const views = await runner.listViews(id).catch(() => []);
			assert(views.length === 0, "no views remain after cleanup");
		} finally {
			await cleanup(runner, id);
		}
	},

	"cleanup.retry-is-idempotent": async (runner, ctx) => {
		const id = uniqueSessionId("retry");
		try {
			await runner.createSession({ id, cwd: ctx.cwd, command: "sh" });
			await runner.cleanupSession(id);
			assert((await runner.isSessionPresent(id)) === false, "session removed by the first cleanup");
			// Best-effort retry on an already-gone session is quiet…
			await runner.cleanupSession(id, { bestEffort: true });
			// …and a strict retry reports absence as a catchable typed error.
			const strict = await runner.cleanupSession(id).then(
				() => ({ threw: false }),
				(err) => ({ threw: true, err }),
			);
			assert(strict.threw, "a strict cleanup of a missing session raises an error");
		} finally {
			await cleanup(runner, id);
		}
	},
};

/** Executable checks for every `pure` corpus scenario (no backend needed). */
export const PURE_CHECKS: Record<string, () => void> = {
	"resize.min-across-clients": () => {
		const negotiated = smallestClientSize([
			{ cols: 120, rows: 40 },
			{ cols: 80, rows: 50 },
			{ cols: 100, rows: 30 },
		]);
		assert(negotiated?.cols === 80 && negotiated.rows === 30, "size is the per-axis minimum across clients");
		const withUnsized = smallestClientSize([{ cols: 80, rows: 24 }, {}]);
		assert(withUnsized?.cols === 80 && withUnsized.rows === 24, "a client with no reported size does not shrink the result");
	},

	"resize.invalid-is-ignored": () => {
		const negotiated = smallestClientSize([
			{ cols: 0, rows: -5 },
			{ cols: 100, rows: 40 },
		]);
		assert(negotiated?.cols === 100 && negotiated.rows === 40, "non-positive dimensions do not contribute");
		assert(smallestClientSize([{ cols: 0, rows: 0 }]) === null, "no valid size yields no applied geometry");
		assert(parseResizeSequence("\x1b]resize;abc;def\x07") === null, "a malformed resize report parses to nothing");
		const parsed = parseResizeSequence(encodeResizeSequence(132, 43));
		assert(parsed?.cols === 132 && parsed.rows === 43, "a well-formed resize report round-trips");
	},
};
