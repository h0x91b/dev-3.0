import { describe, expect, it } from "vitest";
import {
	type LaunchdServerDeps,
	buildLaunchdPlist,
	ensureLaunchdServer,
	launchdLabel,
	predatesLaunchdServer,
	staleServerBinary,
	usesLaunchdServer,
} from "../launchd-server";

const BUNDLED = "/Applications/dev-3.0.app/Contents/Resources/app/tmux/tmux";
const SHIM = "/Users/u/.dev3.0/bin/tmux";
const MIRRORS = "/Users/u/.dev3.0/tmux-host";
const MIRRORED = (key: number) => `${MIRRORS}/${key}/dev-3.0.app/Contents/Resources/app/tmux/tmux`;
const OPTS = { binary: BUNDLED, socket: "dev3", configFile: "/tmp/dev3-tmux.conf", cwd: "/Users/u/.dev3.0", env: { PATH: "/bin" } };

type Probe = "alive" | "absent" | "timeout" | "weird";

const LABEL = launchdLabel("/tmp/tmux-502/dev3");

function fakeDeps(over: {
	probes?: Probe[];
	bootstrapExit?: number;
	bootstrapTimesOut?: boolean;
	runningJobPid?: number;
	writeThrows?: boolean;
	platform?: NodeJS.Platform;
	fileLimits?: { soft: number; hard: number | null } | null;
	/** Inodes by path; a path not listed has none. */
	inodes?: Record<string, number>;
	linkThrows?: boolean;
	mirrors?: Record<string, { ageMs: number; inUse: boolean }>;
	/** Mirror keys whose build finished (their completion marker exists). */
	completeMirrors?: number[];
} = {}) {
	const probes = [...(over.probes ?? ["absent", "alive"])];
	const calls: string[][] = [];
	const timeouts: unknown[] = [];
	const files = new Map<string, string>();
	const removed: string[] = [];
	const signals: [number, string][] = [];
	const links: [string, string][] = [];
	const inodes = new Map(Object.entries(over.inodes ?? {}));
	let clock = 1_000_000_000;
	const deps: LaunchdServerDeps = {
		platform: over.platform ?? "darwin",
		uid: 502,
		spawnSync: (cmd, opts) => {
			calls.push(cmd);
			if (cmd[0] === "/usr/sbin/lsof") {
				const name = cmd[cmd.length - 1].slice(MIRRORS.length + 1).split("/")[0];
				return over.mirrors?.[name]?.inUse ? { exitCode: 0, stdout: new TextEncoder().encode("4242\n") } : { exitCode: 1 };
			}
			if (cmd[0] === "launchctl") {
				timeouts.push(opts?.timeout);
				if (cmd[1] === "print") {
					return over.runningJobPid
						? { exitCode: 0, stdout: new TextEncoder().encode(`state = running\n\tpid = ${over.runningJobPid}\n`) }
						: { exitCode: 113 };
				}
				if (cmd[1] === "bootstrap" && over.bootstrapTimesOut) return { exitCode: null, exitedDueToTimeout: true };
				return { exitCode: cmd[1] === "bootstrap" ? over.bootstrapExit ?? 0 : 0 };
			}
			const probe = probes.length > 1 ? probes.shift()! : probes[0];
			if (probe === "alive") return { exitCode: 0 };
			if (probe === "timeout") return { exitCode: null, exitedDueToTimeout: true };
			const msg = probe === "absent" ? "no server running on /private/tmp/tmux-502/dev3" : "something else";
			return { exitCode: 1, stderr: new TextEncoder().encode(msg) };
		},
		makePrivateDir: () => "/tmp/dev3-launchd-abc123",
		writeFile: (path, contents) => {
			if (over.writeThrows) throw new Error("EEXIST");
			files.set(path, contents);
		},
		removeDir: (path) => removed.push(path),
		sleep: (ms) => { clock += ms; },
		now: () => clock,
		signal: (pid, signal) => signals.push([pid, signal]),
		fileLimits: () => over.fileLimits === undefined ? { soft: 1050880, hard: null } : over.fileLimits,
		realpath: (path) => (path === SHIM ? BUNDLED : path.startsWith("/") ? path : null),
		pathExists: (path) =>
			path.endsWith("/complete")
				? files.has(path) || (over.completeMirrors ?? []).some((key) => path === `${MIRRORS}/${key}/complete`)
				: true,
		inode: (path) => inodes.get(path) ?? null,
		mirrorRoot: () => MIRRORS,
		linkTree: (src, dst) => {
			if (over.linkThrows) throw new Error("EXDEV: cross-device link not permitted");
			links.push([src, dst]);
			inodes.set(dst + "/Contents/Resources/app/tmux/tmux", inodes.get(BUNDLED)!);
		},
		listDir: (path) => (path === MIRRORS ? Object.keys(over.mirrors ?? {}) : path.startsWith(`${MIRRORS}/`) ? ["dev-3.0.app"] : []),
		mtimeMs: (path) => {
			const mirror = over.mirrors?.[path.slice(MIRRORS.length + 1)];
			return mirror ? clock - mirror.ageMs : null;
		},
	};
	const launchctl = () => calls.filter((c) => c[0] === "launchctl").map((c) => c.slice(0, 2).join(" "));
	return { deps, calls, timeouts, files, removed, signals, links, launchctl };
}

describe("usesLaunchdServer", () => {
	it("only applies to a tmux inside an app bundle on macOS", () => {
		expect(usesLaunchdServer("darwin", BUNDLED)).toBe(true);
		expect(usesLaunchdServer("darwin", "/opt/homebrew/bin/tmux")).toBe(false);
		expect(usesLaunchdServer("darwin", "tmux")).toBe(false);
		expect(usesLaunchdServer("linux", BUNDLED)).toBe(false);
	});
});

describe("buildLaunchdPlist", () => {
	it("runs the server in the foreground on the given socket and config", () => {
		const plist = buildLaunchdPlist({ ...OPTS, label: LABEL });
		expect(plist).toContain(`<key>Label</key><string>${LABEL}</string>`);
		expect(plist).toMatch(/<string>-D<\/string>\s*<string>-L<\/string>\s*<string>dev3<\/string>\s*<string>-f<\/string>\s*<string>\/tmp\/dev3-tmux.conf<\/string>/);
		expect(plist).toContain(`<key>WorkingDirectory</key><string>/Users/u/.dev3.0</string>`);
		expect(plist).toContain(`<key>ProcessType</key><string>Interactive</string>`);
		expect(plist).toContain(`<key>RunAtLoad</key><true/>`);
	});

	it("escapes XML and drops variables XML cannot carry", () => {
		const plist = buildLaunchdPlist({
			...OPTS,
			label: "x",
			env: { A: `a<b>&"c"`, BAD: "bell\u0007", UNSET: undefined },
		});
		expect(plist).toContain(`<key>A</key><string>a&lt;b&gt;&amp;&quot;c&quot;</string>`);
		expect(plist).not.toContain("BAD");
		expect(plist).not.toContain("UNSET");
	});

	it("carries the app's open-file limits, which panes would otherwise get from launchd (256)", () => {
		const plist = buildLaunchdPlist({ ...OPTS, label: "x", fileLimits: { soft: 1050880, hard: 2000000 } });
		expect(plist).toContain(`<key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>1050880</integer></dict>`);
		expect(plist).toContain(`<key>HardResourceLimits</key><dict><key>NumberOfFiles</key><integer>2000000</integer></dict>`);
		const unlimitedHard = buildLaunchdPlist({ ...OPTS, label: "x", fileLimits: { soft: 4096, hard: null } });
		expect(unlimitedHard).toContain("<integer>4096</integer>");
		expect(unlimitedHard).not.toContain("HardResourceLimits");
		expect(buildLaunchdPlist({ ...OPTS, label: "x", fileLimits: null })).not.toContain("ResourceLimits");
	});

	it("keys the label by the socket path, so same-named sockets in two TMUX_TMPDIRs never share a job", () => {
		expect(LABEL).toMatch(/^dev3\.tmux\.dev3\.[0-9a-f]{8}$/);
		expect(launchdLabel("/other/tmux-502/dev3")).not.toBe(LABEL);
		expect(launchdLabel("/tmp/tmux-502/dev3 x")).toMatch(/^dev3\.tmux\.dev3_x\.[0-9a-f]{8}$/);
	});
});

describe("ensureLaunchdServer", () => {
	it("skips non-bundled binaries without running anything", () => {
		const f = fakeDeps();
		expect(ensureLaunchdServer({ ...OPTS, binary: "/opt/homebrew/bin/tmux" }, f.deps)).toBe("skipped");
		expect(ensureLaunchdServer(OPTS, fakeDeps({ platform: "linux" }).deps)).toBe("skipped");
		expect(f.calls).toEqual([]);
	});

	it("follows the ~/.dev3.0/bin shim into the bundle and launches the real binary", () => {
		const f = fakeDeps({ probes: ["absent", "alive"] });
		expect(ensureLaunchdServer({ ...OPTS, binary: SHIM }, f.deps)).toBe("started");
		const plist = [...f.files.values()][0];
		expect(plist).toContain(`<string>${BUNDLED}</string>`);
		expect(plist).not.toContain(SHIM);
	});

	it("never touches launchd when a server is alive or the probe is inconclusive", () => {
		for (const probe of ["alive", "timeout", "weird"] as const) {
			const f = fakeDeps({ probes: [probe] });
			expect(ensureLaunchdServer(OPTS, f.deps)).toBe("skipped");
			expect(f.launchctl()).toEqual([]);
		}
	});

	it("clears a stale job, bootstraps from a private dir, waits for the server and removes the dir", () => {
		const f = fakeDeps({ probes: ["absent", "absent", "alive"] });
		expect(ensureLaunchdServer(OPTS, f.deps)).toBe("started");
		expect(f.launchctl()).toEqual(["launchctl print", "launchctl bootout", "launchctl bootstrap"]);
		const bootstrap = f.calls.find((c) => c[1] === "bootstrap")!;
		expect(bootstrap[2]).toBe("gui/502");
		expect(bootstrap[3]).toBe(`/tmp/dev3-launchd-abc123/${LABEL}.plist`);
		expect(f.files.get(bootstrap[3])).toContain("<key>PATH</key><string>/bin</string>");
		expect(f.files.get(bootstrap[3])).toContain("<integer>1050880</integer>");
		expect(f.removed).toEqual(["/tmp/dev3-launchd-abc123"]);
		// Every launchctl call is bounded by a timeout.
		expect(f.timeouts.length).toBeGreaterThan(0);
		expect(f.timeouts.every((t) => typeof t === "number" && t > 0)).toBe(true);

		// The label follows TMUX_TMPDIR from the server env.
		const other = fakeDeps();
		ensureLaunchdServer({ ...OPTS, env: { PATH: "/bin", TMUX_TMPDIR: "/other" } }, other.deps);
		const bootout = other.calls.find((c) => c[1] === "bootout")!;
		expect(bootout[2]).toBe(`gui/502/${launchdLabel("/other/tmux-502/dev3")}`);
	});

	it("falls back, unloads the job and removes the plist when bootstrap times out or fails", () => {
		const f = fakeDeps({ bootstrapTimesOut: true });
		expect(ensureLaunchdServer(OPTS, f.deps)).toBe("fallback");
		expect(f.launchctl()).toEqual(["launchctl print", "launchctl bootout", "launchctl bootstrap", "launchctl bootout"]);
		expect(f.removed).toHaveLength(1);

		const failed = fakeDeps({ bootstrapExit: 5 });
		expect(ensureLaunchdServer(OPTS, failed.deps)).toBe("fallback");
		expect(failed.removed).toHaveLength(1);
	});

	it("never boots out a running job whose socket file went missing; asks it to recreate the socket", () => {
		const f = fakeDeps({ probes: ["absent", "alive"], runningJobPid: 4242 });
		expect(ensureLaunchdServer(OPTS, f.deps)).toBe("skipped");
		expect(f.signals).toEqual([[4242, "SIGUSR1"]]);
		expect(f.launchctl()).toEqual(["launchctl print"]);

		// ...and leaves it alone even when it does not answer after SIGUSR1.
		const silent = fakeDeps({ probes: ["absent"], runningJobPid: 4242 });
		expect(ensureLaunchdServer(OPTS, silent.deps)).toBe("fallback");
		expect(silent.launchctl()).toEqual(["launchctl print"]);
	});

	it("falls back instead of throwing when the plist cannot be written", () => {
		const f = fakeDeps({ writeThrows: true });
		expect(ensureLaunchdServer(OPTS, f.deps)).toBe("fallback");
		expect(f.launchctl()).toEqual(["launchctl print", "launchctl bootout"]);
	});

	it("unloads a job whose server never came up, so it cannot race the caller", () => {
		const f = fakeDeps({ probes: ["absent"] });
		expect(ensureLaunchdServer(OPTS, f.deps)).toBe("fallback");
		expect(f.launchctl()).toEqual(["launchctl print", "launchctl bootout", "launchctl bootstrap", "launchctl bootout"]);
	});
});

describe("ensureLaunchdServer bundle mirror", () => {
	const plistOf = (f: ReturnType<typeof fakeDeps>) => [...f.files.entries()].find(([path]) => path.endsWith(".plist"))![1];

	it("runs the server from a hardlink tree of the whole bundle, keyed by the tmux inode", () => {
		const f = fakeDeps({ inodes: { [BUNDLED]: 42 } });
		expect(ensureLaunchdServer({ ...OPTS, binary: SHIM }, f.deps)).toBe("started");
		expect(f.links).toEqual([["/Applications/dev-3.0.app", `${MIRRORS}/42/dev-3.0.app`]]);
		expect(f.files.has(`${MIRRORS}/42/complete`)).toBe(true);
		expect(plistOf(f)).toContain(`<string>${MIRRORED(42)}</string>`);
		expect(plistOf(f)).not.toContain(`<string>${BUNDLED}</string>`);
	});

	it("reuses a finished mirror of the same tmux instead of relinking it", () => {
		const f = fakeDeps({ inodes: { [BUNDLED]: 42, [MIRRORED(42)]: 42 }, completeMirrors: [42] });
		expect(ensureLaunchdServer(OPTS, f.deps)).toBe("started");
		expect(f.links).toEqual([]);
		expect(plistOf(f)).toContain(`<string>${MIRRORED(42)}</string>`);
	});

	// readdir order links tmux long before Info.plist, so tmux alone does not prove a finished build.
	it.each([
		["a wrong tmux", { [BUNDLED]: 42, [MIRRORED(42)]: 7 }],
		["the right tmux but no completion marker", { [BUNDLED]: 42, [MIRRORED(42)]: 42 }],
	])("rebuilds an interrupted mirror holding %s", (_name, inodes) => {
		const f = fakeDeps({ inodes });
		expect(ensureLaunchdServer(OPTS, f.deps)).toBe("started");
		expect(f.removed[0]).toBe(`${MIRRORS}/42`);
		expect(f.links).toHaveLength(1);
		expect(plistOf(f)).toContain(`<string>${MIRRORED(42)}</string>`);
	});

	it("runs from the bundle itself when no mirror can be built (another volume)", () => {
		const f = fakeDeps({ inodes: { [BUNDLED]: 42 }, linkThrows: true });
		expect(ensureLaunchdServer(OPTS, f.deps)).toBe("started");
		expect(plistOf(f)).toContain(`<string>${BUNDLED}</string>`);
		expect(f.removed).toContain(`${MIRRORS}/42`);
	});

	it("deletes old mirrors nothing runs from, and keeps in-use, young and its own", () => {
		const f = fakeDeps({
			inodes: { [BUNDLED]: 42 },
			mirrors: {
				"42": { ageMs: 0, inUse: false },
				"7": { ageMs: 86_400_000, inUse: false },
				"8": { ageMs: 86_400_000, inUse: true },
				"9": { ageMs: 60_000, inUse: false },
			},
		});
		expect(ensureLaunchdServer(OPTS, f.deps)).toBe("started");
		expect(f.removed.filter((p) => p.startsWith(MIRRORS))).toEqual([`${MIRRORS}/42`, `${MIRRORS}/7`]);
		expect(f.calls.filter((c) => c[0] === "/usr/sbin/lsof").map((c) => c[c.length - 1])).toEqual([MIRRORED(7), MIRRORED(8)]);
	});

	it("leaves every mirror alone when the server runs from the bundle", () => {
		const f = fakeDeps({ inodes: { [BUNDLED]: 42 }, linkThrows: true, mirrors: { "7": { ageMs: 86_400_000, inUse: false } } });
		ensureLaunchdServer(OPTS, f.deps);
		expect(f.removed).not.toContain(`${MIRRORS}/7`);
	});
});

describe("predatesLaunchdServer", () => {
	function deps(server: { exitCode: number; pid?: string }, job: { exitCode: number; out?: string }): LaunchdServerDeps {
		const enc = (text: string) => new TextEncoder().encode(text);
		return {
			...fakeDeps().deps,
			spawnSync: (cmd) => cmd[0] === "launchctl"
				? { exitCode: job.exitCode, stdout: enc(job.out ?? "") }
				: { exitCode: server.exitCode, stdout: enc(server.pid ?? "") },
		};
	}
	const JOB = (pid: number) => `gui/502/${LABEL} = {\n\tstate = running\n\tpid = ${pid}\n\t\tstate = active\n}`;

	it("flags a live server that launchd does not own", () => {
		expect(predatesLaunchdServer(OPTS, deps({ exitCode: 0, pid: "16123" }, { exitCode: 113 }))).toBe(true);
		expect(predatesLaunchdServer(OPTS, deps({ exitCode: 0, pid: "16123" }, { exitCode: 0, out: JOB(999) }))).toBe(true);
	});

	it("stays quiet for a launchd-owned, missing or unreadable server", () => {
		expect(predatesLaunchdServer(OPTS, deps({ exitCode: 0, pid: "16123" }, { exitCode: 0, out: JOB(16123) }))).toBe(false);
		expect(predatesLaunchdServer(OPTS, deps({ exitCode: 1 }, { exitCode: 113 }))).toBe(false);
		expect(predatesLaunchdServer(OPTS, deps({ exitCode: 0, pid: "16123" }, { exitCode: 1 }))).toBe(false);
		expect(predatesLaunchdServer(OPTS, deps({ exitCode: 0, pid: "garbage" }, { exitCode: 113 }))).toBe(false);
		expect(predatesLaunchdServer({ ...OPTS, binary: "/opt/homebrew/bin/tmux" }, deps({ exitCode: 0, pid: "1" }, { exitCode: 113 }))).toBe(false);
	});
});

describe("staleServerBinary", () => {
	const enc = (text: string) => new TextEncoder().encode(text);
	const LSOF = (path: string, inode = 100, links: number | null = 1) =>
		`p16123\nftxt\ni${inode}\n${links === null ? "" : `k${links}\n`}n${path}\nftxt\ni9\nk1\nn/usr/lib/dyld\n`;
	function deps(
		server: { exitCode: number; pid?: string },
		lsof: { exitCode: number; out?: string },
		existing: string[] = [],
		inodes: Record<string, number> = {},
	) {
		const calls: string[][] = [];
		const d: LaunchdServerDeps = {
			...fakeDeps({ inodes }).deps,
			spawnSync: (cmd) => {
				calls.push(cmd);
				return cmd[0] === "/usr/sbin/lsof"
					? { exitCode: lsof.exitCode, stdout: enc(lsof.out ?? "") }
					: { exitCode: server.exitCode, stdout: enc(server.pid ?? "") };
			},
			pathExists: (path) => existing.includes(path),
		};
		return { d, calls };
	}
	const OLD = "/Users/u/dev3-app-backup.app/Contents/Resources/app/tmux/tmux";
	const SERVER = { exitCode: 0, pid: "16123" };

	// The updater, brew and a DMG reinstall put a new bundle at the old path; what matters is whether
	// the server's own file still has a link, which lsof reports as its link count.
	it("reads the executable, inode and link count from lsof and stays quiet for this app's own tmux, via the shim too", () => {
		const { d, calls } = deps(SERVER, { exitCode: 0, out: LSOF(BUNDLED) }, [BUNDLED], { [BUNDLED]: 100 });
		expect(staleServerBinary(OPTS, d)).toBeNull();
		expect(calls[1]).toEqual(["/usr/sbin/lsof", "-a", "-p", "16123", "-d", "txt", "-Fikn"]);
		expect(staleServerBinary({ ...OPTS, binary: SHIM }, deps(SERVER, { exitCode: 0, out: LSOF(BUNDLED) }, [BUNDLED]).d)).toBeNull();
	});

	// macOS 27: tccd denies a server whose file is gone even when an update put a new tmux at the same path.
	it("reports this app's own tmux once it has no links (k0), or without a link count, once its path holds another inode", () => {
		const stale = (links: number | null, onDisk: number) =>
			staleServerBinary(OPTS, deps(SERVER, { exitCode: 0, out: LSOF(BUNDLED, 100, links) }, [BUNDLED], { [BUNDLED]: onDisk }).d);
		expect(stale(0, 200)).toBe("deleted");
		expect(stale(null, 200)).toBe("deleted");
		expect(stale(null, 100)).toBeNull();
		// A file that keeps a link elsewhere is not gone, even if its reported path was replaced.
		expect(stale(1, 200)).toBeNull();
	});

	// lsof names a hardlinked file by the link last looked up; once the bundle is gone it prints the bare basename.
	it("recognises a mirror-hosted server by its inode dir whatever path lsof names, and reports a deleted mirror", () => {
		expect(staleServerBinary(OPTS, deps(SERVER, { exitCode: 0, out: LSOF(MIRRORED(7), 7) }, [MIRRORED(7), `${MIRRORS}/7`]).d)).toBeNull();
		expect(staleServerBinary(OPTS, deps(SERVER, { exitCode: 0, out: LSOF("/tmux", 7) }, [`${MIRRORS}/7`]).d)).toBeNull();
		expect(staleServerBinary(OPTS, deps(SERVER, { exitCode: 0, out: LSOF("/tmux", 7) }).d)).toBeNull();
		expect(staleServerBinary(OPTS, deps(SERVER, { exitCode: 0, out: LSOF(MIRRORED(7), 7, 0) }).d)).toBe("deleted");
	});

	it("reports an executable with nothing left at its path, or in another still present dev3 bundle", () => {
		expect(staleServerBinary(OPTS, deps(SERVER, { exitCode: 0, out: LSOF(OLD, 100, null) }).d)).toBe("deleted");
		expect(staleServerBinary(OPTS, deps(SERVER, { exitCode: 0, out: LSOF(OLD) }, [OLD]).d)).toBe("elsewhere");
	});

	const QUIET = [
		["a present non-bundle tmux", SERVER, { exitCode: 0, out: LSOF("/opt/homebrew/bin/tmux") }, ["/opt/homebrew/bin/tmux"], OPTS, "darwin"],
		["a missing server", { exitCode: 1 }, { exitCode: 0, out: LSOF(OLD) }, [], OPTS, "darwin"],
		["a failed lsof", SERVER, { exitCode: 1 }, [], OPTS, "darwin"],
		["an lsof with no txt path", SERVER, { exitCode: 0, out: "p16123\n" }, [], OPTS, "darwin"],
		["a non-bundled client", { exitCode: 0, pid: "1" }, { exitCode: 0, out: LSOF(OLD) }, [], { ...OPTS, binary: "/opt/homebrew/bin/tmux" }, "darwin"],
		["Linux", SERVER, { exitCode: 0, out: LSOF(OLD) }, [], OPTS, "linux"],
	] as const;

	it("stays quiet for a non-bundle tmux, a missing server, a failed or empty lsof, a non-bundled client, and Linux", () => {
		for (const [name, server, lsof, existing, opts, platform] of QUIET) {
			const { d } = deps(server, lsof, [...existing]);
			expect(staleServerBinary(opts, { ...d, platform }), name).toBeNull();
		}
	});
});
