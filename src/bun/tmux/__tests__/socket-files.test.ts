import { describe, expect, it } from "vitest";
import {
	SWEEP_MIN_AGE_MS,
	type SocketLiveness,
	isSweepCandidate,
	selectSweepableSockets,
	tmuxSocketDir,
	tmuxSocketPath,
} from "../socket-files";

const NOW = 1_800_000_000_000;
const OLD = NOW - SWEEP_MIN_AGE_MS - 1;
const US = 501;

function facts(
	name: string,
	over: { uid?: number; mtimeMs?: number; isSocket?: boolean; liveness?: SocketLiveness } = {},
) {
	return {
		name,
		uid: over.uid ?? US,
		mtimeMs: over.mtimeMs ?? OLD,
		isSocket: over.isSocket ?? true,
		liveness: over.liveness ?? ("dead" as SocketLiveness),
	};
}

function sweep(files: ReturnType<typeof facts>[]) {
	return selectSweepableSockets({ files, ourUid: US, nowMs: NOW });
}

describe("tmuxSocketDir", () => {
	it("mirrors tmux: /tmp plus tmux-<uid>, and TMPDIR is deliberately ignored", () => {
		expect(tmuxSocketDir({ TMPDIR: "/var/folders/zz/" }, 501)).toBe("/tmp/tmux-501");
	});

	it("follows TMUX_TMPDIR when tmux would, so a scoped instance sweeps its own dir", () => {
		expect(tmuxSocketDir({ TMUX_TMPDIR: "/scratch" }, 501)).toBe("/scratch/tmux-501");
	});

	it("treats an empty TMUX_TMPDIR as unset", () => {
		expect(tmuxSocketDir({ TMUX_TMPDIR: "" }, 7)).toBe("/tmp/tmux-7");
	});

	it("composes a full socket path", () => {
		expect(tmuxSocketPath("dev3-live-test-42", {}, 501)).toBe("/tmp/tmux-501/dev3-live-test-42");
	});
});

describe("isSweepCandidate", () => {
	it("is what decides whether a file is worth a connect at all", () => {
		expect(isSweepCandidate(facts("dev3-seam-1"), US, NOW)).toBe(true);
		expect(isSweepCandidate(facts("default"), US, NOW)).toBe(false);
		expect(isSweepCandidate(facts("dev3-seam-1", { uid: 502 }), US, NOW)).toBe(false);
		expect(isSweepCandidate(facts("dev3-seam-1", { isSocket: false }), US, NOW)).toBe(false);
		expect(isSweepCandidate(facts("dev3-seam-1", { mtimeMs: NOW - 1_000 }), US, NOW)).toBe(false);
	});
});

describe("selectSweepableSockets", () => {
	it("removes a dev3 socket of ours with nothing listening on it", () => {
		expect(sweep([facts("dev3-live-test-99")]).remove).toEqual(["dev3-live-test-99"]);
	});

	// The guard this whole module exists to keep. Break the liveness check in
	// selectSweepableSockets and this is the test that goes red.
	it("KEEPS a socket that something is still listening on", () => {
		const decision = sweep([facts("dev3-live-test-99"), facts("dev3-seam-100", { liveness: "listening" })]);
		expect(decision.remove).toEqual(["dev3-live-test-99"]);
		expect(decision.kept).toBe(1);
	});

	it("KEEPS a socket whose liveness could not be established — unknown is not dead", () => {
		expect(sweep([facts("dev3-seam-100", { liveness: "unknown" })]).remove).toEqual([]);
	});

	it("keeps the app's own default socket while its server is live", () => {
		expect(sweep([facts("dev3", { liveness: "listening" })]).remove).toEqual([]);
	});

	it("never touches a socket that is not dev3-prefixed", () => {
		expect(sweep([facts("default"), facts("claude-swarm"), facts("mysocket")]).remove).toEqual([]);
	});

	it("never touches a socket belonging to another user", () => {
		expect(sweep([facts("dev3-seam-1", { uid: 502 })]).remove).toEqual([]);
	});

	it("never touches something in that directory that is not a socket", () => {
		expect(sweep([facts("dev3-seam-1", { isSocket: false })]).remove).toEqual([]);
	});

	it("leaves a freshly created socket alone — its server may still be binding", () => {
		expect(sweep([facts("dev3-seam-1", { mtimeMs: NOW - 1_000 })]).remove).toEqual([]);
	});

	it("counts kept as everything it did not remove", () => {
		const decision = sweep([facts("dev3-seam-1"), facts("default"), facts("dev3-seam-2")]);
		expect(decision.remove).toEqual(["dev3-seam-1", "dev3-seam-2"]);
		expect(decision.kept).toBe(1);
	});
});
