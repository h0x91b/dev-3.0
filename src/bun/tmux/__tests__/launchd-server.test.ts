import { describe, expect, it } from "vitest";
import {
	type LaunchdServerDeps,
	buildLaunchdPlist,
	ensureLaunchdServer,
	launchdLabel,
	predatesLaunchdServer,
	usesLaunchdServer,
} from "../launchd-server";

const BUNDLED = "/Applications/dev-3.0.app/Contents/Resources/app/tmux/tmux";
const SHIM = "/Users/u/.dev3.0/bin/tmux";
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
} = {}) {
	const probes = [...(over.probes ?? ["absent", "alive"])];
	const calls: string[][] = [];
	const timeouts: unknown[] = [];
	const files = new Map<string, string>();
	const removed: string[] = [];
	const signals: [number, string][] = [];
	let clock = 0;
	const deps: LaunchdServerDeps = {
		platform: over.platform ?? "darwin",
		uid: 502,
		spawnSync: (cmd, opts) => {
			calls.push(cmd);
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
	};
	const launchctl = () => calls.filter((c) => c[0] === "launchctl").map((c) => c.slice(0, 2).join(" "));
	return { deps, calls, timeouts, files, removed, signals, launchctl };
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
	});

	it("bounds every launchctl call with a timeout", () => {
		const f = fakeDeps({ probes: ["absent"] });
		ensureLaunchdServer(OPTS, f.deps);
		expect(f.timeouts.length).toBeGreaterThan(0);
		expect(f.timeouts.every((t) => typeof t === "number" && t > 0)).toBe(true);
	});

	it("falls back and unloads the job when bootstrap times out", () => {
		const f = fakeDeps({ bootstrapTimesOut: true });
		expect(ensureLaunchdServer(OPTS, f.deps)).toBe("fallback");
		expect(f.launchctl()).toEqual(["launchctl print", "launchctl bootout", "launchctl bootstrap", "launchctl bootout"]);
		expect(f.removed).toHaveLength(1);
	});

	it("never boots out a running job whose socket file went missing; asks it to recreate the socket", () => {
		const f = fakeDeps({ probes: ["absent", "alive"], runningJobPid: 4242 });
		expect(ensureLaunchdServer(OPTS, f.deps)).toBe("skipped");
		expect(f.signals).toEqual([[4242, "SIGUSR1"]]);
		expect(f.launchctl()).toEqual(["launchctl print"]);
	});

	it("leaves a running job alone even when it does not answer after SIGUSR1", () => {
		const f = fakeDeps({ probes: ["absent"], runningJobPid: 4242 });
		expect(ensureLaunchdServer(OPTS, f.deps)).toBe("fallback");
		expect(f.launchctl()).toEqual(["launchctl print"]);
	});

	it("uses TMUX_TMPDIR from the server env for the label", () => {
		const f = fakeDeps();
		ensureLaunchdServer({ ...OPTS, env: { PATH: "/bin", TMUX_TMPDIR: "/other" } }, f.deps);
		const bootout = f.calls.find((c) => c[1] === "bootout")!;
		expect(bootout[2]).toBe(`gui/502/${launchdLabel("/other/tmux-502/dev3")}`);
	});

	it("falls back and still removes the plist when bootstrap fails", () => {
		const f = fakeDeps({ bootstrapExit: 5 });
		expect(ensureLaunchdServer(OPTS, f.deps)).toBe("fallback");
		expect(f.removed).toHaveLength(1);
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
