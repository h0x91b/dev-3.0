import { describe, expect, it } from "vitest";
import {
	type LaunchdServerDeps,
	buildLaunchdPlist,
	ensureLaunchdServer,
	launchdLabel,
	usesLaunchdServer,
} from "../launchd-server";

const BUNDLED = "/Applications/dev-3.0.app/Contents/Resources/app/tmux/tmux";
const OPTS = { binary: BUNDLED, socket: "dev3", configFile: "/tmp/dev3-tmux.conf", cwd: "/Users/u/.dev3.0", env: { PATH: "/bin" } };

type Probe = "alive" | "absent" | "timeout" | "weird";

function fakeDeps(over: { probes?: Probe[]; bootstrapExit?: number; writeThrows?: boolean; platform?: NodeJS.Platform } = {}) {
	const probes = [...(over.probes ?? ["absent", "alive"])];
	const calls: string[][] = [];
	const files = new Map<string, string>();
	const removed: string[] = [];
	const deps: LaunchdServerDeps = {
		platform: over.platform ?? "darwin",
		uid: 502,
		spawnSync: (cmd) => {
			calls.push(cmd);
			if (cmd[0] === "launchctl") return { exitCode: cmd[1] === "bootstrap" ? over.bootstrapExit ?? 0 : 0 };
			const probe = probes.length > 1 ? probes.shift()! : probes[0];
			if (probe === "alive") return { exitCode: 0 };
			if (probe === "timeout") return { exitCode: null, exitedDueToTimeout: true };
			const msg = probe === "absent" ? "no server running on /private/tmp/tmux-502/dev3" : "something else";
			return { exitCode: 1, stderr: new TextEncoder().encode(msg) };
		},
		writeFile: (path, contents) => {
			if (over.writeThrows) throw new Error("EACCES");
			files.set(path, contents);
		},
		removeFile: (path) => removed.push(path),
		sleep: () => {},
	};
	const launchctl = () => calls.filter((c) => c[0] === "launchctl").map((c) => c.slice(0, 2).join(" "));
	return { deps, calls, files, removed, launchctl };
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
		const plist = buildLaunchdPlist({ ...OPTS, label: launchdLabel("dev3") });
		expect(plist).toContain(`<key>Label</key><string>dev3.tmux.dev3</string>`);
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

	it("sanitizes the socket into the label", () => {
		expect(launchdLabel("dev3 x/y")).toBe("dev3.tmux.dev3_x_y");
	});
});

describe("ensureLaunchdServer", () => {
	it("skips non-bundled binaries without running anything", () => {
		const f = fakeDeps();
		expect(ensureLaunchdServer({ ...OPTS, binary: "/opt/homebrew/bin/tmux" }, f.deps)).toBe("skipped");
		expect(ensureLaunchdServer(OPTS, fakeDeps({ platform: "linux" }).deps)).toBe("skipped");
		expect(f.calls).toEqual([]);
	});

	it("never touches launchd when a server is alive or the probe is inconclusive", () => {
		for (const probe of ["alive", "timeout", "weird"] as const) {
			const f = fakeDeps({ probes: [probe] });
			expect(ensureLaunchdServer(OPTS, f.deps)).toBe("skipped");
			expect(f.launchctl()).toEqual([]);
		}
	});

	it("clears a stale job, bootstraps, waits for the server and removes the plist", () => {
		const f = fakeDeps({ probes: ["absent", "absent", "alive"] });
		expect(ensureLaunchdServer(OPTS, f.deps)).toBe("started");
		expect(f.launchctl()).toEqual(["launchctl bootout", "launchctl bootstrap"]);
		const bootstrap = f.calls.find((c) => c[1] === "bootstrap")!;
		expect(bootstrap[2]).toBe("gui/502");
		expect(f.files.get(bootstrap[3])).toContain("<key>PATH</key><string>/bin</string>");
		expect(f.removed).toEqual([bootstrap[3]]);
	});

	it("falls back and still removes the plist when bootstrap fails", () => {
		const f = fakeDeps({ bootstrapExit: 5 });
		expect(ensureLaunchdServer(OPTS, f.deps)).toBe("fallback");
		expect(f.removed).toHaveLength(1);
	});

	it("falls back instead of throwing when the plist cannot be written", () => {
		const f = fakeDeps({ writeThrows: true });
		expect(ensureLaunchdServer(OPTS, f.deps)).toBe("fallback");
		expect(f.launchctl()).toEqual(["launchctl bootout"]);
	});

	it("unloads a job whose server never came up, so it cannot race the caller", () => {
		const f = fakeDeps({ probes: ["absent"] });
		expect(ensureLaunchdServer(OPTS, f.deps)).toBe("fallback");
		expect(f.launchctl()).toEqual(["launchctl bootout", "launchctl bootstrap", "launchctl bootout"]);
	});
});
