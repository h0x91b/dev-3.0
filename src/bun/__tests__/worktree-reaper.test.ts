import { describe, expect, it } from "vitest";
import {
	parsePidCwds,
	selectCwdHolders,
	selectOrphanGroups,
	selectProtectedPids,
	taskShortIdFromWorktreePath,
} from "../worktree-reaper";

const WORKTREE = "/Users/x/.dev3.0/worktrees/proj/abcd1234/worktree";

describe("parsePidCwds", () => {
	it("pairs each pid line with the cwd line that follows it", () => {
		const output = ["p101", "fcwd", "n/tmp", "p202", "fcwd", `n${WORKTREE}`, ""].join("\n");

		expect(parsePidCwds(output)).toEqual(new Map([
			[101, "/tmp"],
			[202, WORKTREE],
		]));
	});

	it("skips a pid whose cwd lsof could not read", () => {
		const output = ["p101", "p202", "fcwd", "n/tmp", ""].join("\n");

		expect(parsePidCwds(output)).toEqual(new Map([[202, "/tmp"]]));
	});

	it("returns an empty map for empty or garbage output", () => {
		expect(parsePidCwds("")).toEqual(new Map());
		expect(parsePidCwds("lsof: WARNING: something\n")).toEqual(new Map());
	});
});

describe("selectCwdHolders", () => {
	const cwds = new Map<number, string>([
		[1, "/"],
		[10, WORKTREE],
		[11, `${WORKTREE}/dev3-artifact-report`],
		[12, "/Users/x/.dev3.0/worktrees/proj/ffff9999/worktree"],
		[13, "/Users/x/.dev3.0"],
		[14, `${WORKTREE}-backup`],
	]);

	it("picks the worktree itself and anything below it", () => {
		expect(selectCwdHolders(cwds, [WORKTREE], new Set()).sort()).toEqual([10, 11]);
	});

	it("leaves a sibling task's worktree and a path that merely shares the prefix alone", () => {
		const holders = selectCwdHolders(cwds, [WORKTREE], new Set());

		expect(holders).not.toContain(12);
		expect(holders).not.toContain(13);
		// `<worktree>-backup` is a different directory, not a child.
		expect(holders).not.toContain(14);
	});

	it("honours the protected set", () => {
		expect(selectCwdHolders(cwds, [WORKTREE], new Set([10]))).toEqual([11]);
	});

	it("never reaps a protected pid even when its cwd is inside the worktree", () => {
		// tree: 100 (app) → 200 (self) → 300 (child spawn); 400 is a tmux server.
		const tree = new Map<number, number[]>([[100, [200]], [200, [300]]]);
		const cmdlines = new Map<number, string>([
			[400, "/Applications/dev-3.0.app/Contents/Resources/app/tmux/tmux -L dev3 new-session"],
			[500, "node dist/daemon.js"],
		]);
		const inside = new Map<number, string>([
			[100, WORKTREE],
			[200, WORKTREE],
			[300, WORKTREE],
			// tmux inherits the server's cwd from whoever started it — killing it
			// takes down every task's terminal, not just this one's.
			[400, WORKTREE],
			[500, WORKTREE],
		]);

		const holders = selectCwdHolders(inside, [WORKTREE], selectProtectedPids(tree, cmdlines, 200));

		expect(holders).toEqual([500]);
	});

	it("matches either spelling of the root, since lsof resolves symlinks", () => {
		const symlinked = new Map<number, string>([[20, "/private/tmp/wt/sub"]]);

		expect(selectCwdHolders(symlinked, ["/tmp/wt", "/private/tmp/wt"], new Set())).toEqual([20]);
	});
});

describe("taskShortIdFromWorktreePath", () => {
	const ROOT = "/home/u/.dev3.0/worktrees";

	it("reads the task id out of the frozen worktree layout", () => {
		expect(taskShortIdFromWorktreePath(`${ROOT}/proj/abcd1234/worktree/src`, ROOT)).toBe("abcd1234");
	});

	it("ignores the non-task siblings that live at the same depth", () => {
		expect(taskShortIdFromWorktreePath(`${ROOT}/proj/uploads/x.png`, ROOT)).toBeNull();
		expect(taskShortIdFromWorktreePath(`${ROOT}/proj/shared-artifacts`, ROOT)).toBeNull();
		expect(taskShortIdFromWorktreePath(`${ROOT}/proj`, ROOT)).toBeNull();
		expect(taskShortIdFromWorktreePath("/home/u/Desktop/src/abcd1234/worktree", ROOT)).toBeNull();
	});
});

describe("selectOrphanGroups", () => {
	const ROOT = "/home/u/.dev3.0/worktrees";
	const dead = `${ROOT}/proj/dead1111/worktree`;
	const live = `${ROOT}/proj/live2222/worktree`;

	function info(tree: Array<[number, number[]]>, rss: Record<number, number>, cmd: Record<number, string> = {}) {
		return {
			tree: new Map(tree),
			resources: new Map(Object.entries(rss).map(([pid, bytes]) => [Number(pid), { rss: bytes, cpu: 0 }])),
			cmdlines: new Map(Object.entries(cmd).map(([pid, line]) => [Number(pid), line])),
		};
	}

	it("groups init-owned processes per task and sums their subtree memory", () => {
		// 300 is a child of the detached 200, so its memory belongs to the group.
		const cwds = new Map([[200, dead], [300, dead]]);
		const groups = selectOrphanGroups(
			cwds,
			info([[1, [200]], [200, [300]]], { 200: 1000, 300: 500 }, { 200: "node daemon.js" }),
			new Set(),
			ROOT,
		);

		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({ shortId: "dead1111", processCount: 2, rss: 1500, pids: [200, 300] });
	});

	it("skips a process that still has a supervisor", () => {
		// 400's parent is a live shell, so somebody owns it — not a leftover.
		const groups = selectOrphanGroups(new Map([[400, dead]]), info([[99, [400]]], { 400: 10 }), new Set(), ROOT);

		expect(groups).toEqual([]);
	});

	it("skips a task that is still busy, because its browser may be in use", () => {
		const groups = selectOrphanGroups(new Map([[200, live]]), info([[1, [200]]], { 200: 10 }), new Set(["live2222"]), ROOT);

		expect(groups).toEqual([]);
	});

	it("ranks the heaviest task first", () => {
		const other = `${ROOT}/proj/cccc3333/worktree`;
		const groups = selectOrphanGroups(
			new Map([[200, dead], [201, other]]),
			info([[1, [200, 201]]], { 200: 100, 201: 900 }),
			new Set(),
			ROOT,
		);

		expect(groups.map((g) => g.shortId)).toEqual(["cccc3333", "dead1111"]);
	});
});
