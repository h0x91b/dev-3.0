import { describe, expect, it } from "vitest";
import { checkTmuxServer, type TmuxServerDeps } from "../commands/doctor-tmux-server";

const HOME = "/Users/tester";
const TMUX = "/Applications/dev-3.0.app/Contents/Resources/app/tmux/tmux";
const MIRRORS = `${HOME}/.dev3.0/tmux-host`;
const MIRRORED = `${MIRRORS}/226804386/dev-3.0.app/Contents/Resources/app/tmux/tmux`;
const PROJECT = `${HOME}/Documents/code/app`;

const TREE: Record<number, { ppid: number; path: string }> = {
	500: { ppid: 400, path: `${HOME}/.dev3.0/bin/dev3` },
	400: { ppid: 7471, path: "/bin/zsh" },
	7471: { ppid: 1, path: TMUX },
};

const LSOF = (path: string, inode: number, links: number | null) =>
	`p7471\nftxt\ni${inode}\n${links === null ? "" : `k${links}\n`}n${path}\nftxt\ni9\nk1\nn/usr/lib/dyld\n`;

function deps(over: Partial<TmuxServerDeps> & { lsof?: string | null; probe?: string | null } = {}): TmuxServerDeps {
	return {
		platform: "darwin",
		home: HOME,
		pid: 500,
		processInfo: (pid) => TREE[pid] ?? null,
		probeDir: (path) => (path === PROJECT ? (over.probe ?? null) : "ENOENT"),
		lsofExecutable: (pid) => (pid === 7471 ? (over.lsof === undefined ? LSOF(TMUX, 100, 1) : over.lsof) : null),
		inode: (path) => (path === TMUX ? 100 : null),
		projectPaths: () => [`${HOME}/.dev3.0/ops/x`, `${HOME}/Documents/gone`, PROJECT],
		mirrorRoot: MIRRORS,
		...over,
	};
}

describe("tmux server check", () => {
	it("is skipped outside a pane of dev3's bundled tmux and off macOS", () => {
		expect(checkTmuxServer(deps({ processInfo: () => null }))).toBeNull();
		expect(checkTmuxServer(deps({ platform: "linux" }))).toBeNull();
		const homebrew: Record<number, { ppid: number; path: string }> = { ...TREE, 7471: { ppid: 1, path: "/opt/homebrew/bin/tmux" } };
		expect(checkTmuxServer(deps({ processInfo: (pid) => homebrew[pid] ?? null }))).toBeNull();
	});

	it("names the server pid, its executable and the probe of the first present protected project", () => {
		const result = checkTmuxServer(deps());
		expect(result).toEqual({
			label: "tmux server",
			status: "ok",
			detail: `pid 7471 runs ${TMUX}; ~/Documents readable (${PROJECT})`,
		});
	});

	// lsof may name the mirror, the /Applications link, or a bare /tmux once that link is gone.
	it.each([MIRRORED, TMUX, "/tmux"])("recognises the update-proof mirror by its inode when lsof names %s", (path) => {
		const mirrorDir = `${MIRRORS}/226804386`;
		const result = checkTmuxServer(deps({ lsof: LSOF(path, 226804386, 1), inode: (p) => (p === mirrorDir ? 5 : p === TMUX ? 226804386 : null) }));
		expect(result?.status).toBe("ok");
		expect(result?.detail).toContain(`runs its update-proof copy in ${mirrorDir}`);
	});

	it("warns, with restart hints, when the server's file has no links left but access still holds", () => {
		const result = checkTmuxServer(deps({ lsof: LSOF(TMUX, 216663566, 0) }));
		expect(result?.status).toBe("warn");
		expect(result?.detail).toBe(`pid 7471 runs ${TMUX} (inode 216663566), which is no longer on disk; ~/Documents readable (${PROJECT})`);
		expect(result?.hints?.join(" ")).toContain("Restart terminals");
	});

	it("compares inodes when lsof gives no link count", () => {
		expect(checkTmuxServer(deps({ lsof: LSOF(TMUX, 216663566, null) }))?.status).toBe("warn");
		expect(checkTmuxServer(deps({ lsof: LSOF(TMUX, 100, null) }))?.status).toBe("ok");
	});

	it("fails when the probe is denied, and offers the restart only for a deleted executable", () => {
		const denied = checkTmuxServer(deps({ probe: "EPERM" }));
		expect(denied?.status).toBe("fail");
		expect(denied?.detail).toContain(`~/Documents denied (EPERM reading ${PROJECT})`);
		expect(denied?.hints?.join(" ")).toContain("`repository access` line");
		expect(denied?.hints?.join(" ")).not.toContain("Restart terminals");
		const deletedAndDenied = checkTmuxServer(deps({ probe: "EPERM", lsof: LSOF(TMUX, 216663566, 0) }));
		expect(deletedAndDenied?.status).toBe("fail");
		expect(deletedAndDenied?.hints?.join(" ")).toContain("Restart terminals");
	});

	it("still reports the probe when lsof fails, and says when no project is protected", () => {
		expect(checkTmuxServer(deps({ lsof: null }))?.detail).toBe(
			`pid 7471, executable unreadable; ~/Documents readable (${PROJECT})`,
		);
		expect(checkTmuxServer(deps({ projectPaths: () => [`${HOME}/code/app`] }))?.detail).toContain("no project in a protected folder to probe");
	});
});
