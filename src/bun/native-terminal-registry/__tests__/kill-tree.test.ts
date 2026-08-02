/**
 * The signal contract of one host teardown (seq 1387), with no real processes.
 *
 * `graceful-teardown.bun-e2e.ts` proves the *behaviour* against a live PTY, but it
 * only runs on demand. This file runs in CI, and guards the one thing that caused
 * the 1.7 s close: sending the shell a signal an interactive PTY shell ignores.
 */

import { describe, expect, it } from "vitest";
import { GRACEFUL_STOP_SIGNALS, killTree, type KillTreeEffects } from "../host";

interface Sent {
	pid: number;
	sig: NodeJS.Signals;
}

function recorder(descendants: number[], failOn: number[] = []): { sent: Sent[]; effects: KillTreeEffects } {
	const sent: Sent[] = [];
	return {
		sent,
		effects: {
			descendants: () => descendants,
			signal: (pid, sig) => {
				if (failOn.includes(pid)) throw new Error("ESRCH");
				sent.push({ pid, sig });
			},
		},
	};
}

const noProc = { kill: (): void => {} };

describe("graceful stop signals", () => {
	it("hangs up the shell instead of terminating it", () => {
		// SIGTERM here is the regression: an interactive shell on a PTY ignores it.
		expect(GRACEFUL_STOP_SIGNALS.shell).toBe("SIGHUP");
	});

	it("still sends descendants SIGTERM, so a trapping child keeps its notification", () => {
		expect(GRACEFUL_STOP_SIGNALS.descendants).toBe("SIGTERM");
	});
});

describe("killTree", () => {
	it("hangs up the shell and its process group, and terminates the descendants", () => {
		const { sent, effects } = recorder([201, 202]);
		killTree(100, noProc, GRACEFUL_STOP_SIGNALS.shell, GRACEFUL_STOP_SIGNALS.descendants, effects);

		expect(sent).toEqual([
			{ pid: 201, sig: "SIGTERM" },
			{ pid: 202, sig: "SIGTERM" },
			{ pid: -100, sig: "SIGHUP" },
			{ pid: 100, sig: "SIGHUP" },
		]);
	});

	it("applies one signal everywhere when only one is given — the force pass", () => {
		const { sent, effects } = recorder([201]);
		killTree(100, noProc, "SIGKILL", undefined, effects);

		expect(sent.map((s) => s.sig)).toEqual(["SIGKILL", "SIGKILL", "SIGKILL"]);
		expect(sent.map((s) => s.pid)).toEqual([201, -100, 100]);
	});

	it("keeps signalling the shell after a descendant or its group is already gone", () => {
		const { sent, effects } = recorder([201], [201, -100]);
		killTree(100, noProc, "SIGHUP", "SIGTERM", effects);

		expect(sent).toEqual([{ pid: 100, sig: "SIGHUP" }]);
	});

	it("falls back to the process handle when the shell pid cannot be signalled", () => {
		const viaHandle: NodeJS.Signals[] = [];
		const { effects } = recorder([], [100, -100]);
		killTree(100, { kill: (sig) => viaHandle.push(sig as NodeJS.Signals) }, "SIGHUP", "SIGTERM", effects);

		expect(viaHandle).toEqual(["SIGHUP"]);
	});
});
