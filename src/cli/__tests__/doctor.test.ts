import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { collectChecks, renderChecks, handleDoctor, type CheckResult, type DoctorDeps } from "../commands/doctor";
import { CLI_EXIT_CODE_DOCTOR_PROBLEMS, CLI_EXIT_CODE_SUCCESS } from "../../shared/cli-exit-codes";

const HOME = "/Users/tester";
const SHIM = `${HOME}/.dev3.0/bin/tmux`;
const SETTINGS = `${HOME}/.dev3.0/settings.json`;
const KEG = "/opt/homebrew/opt/tmux@3.6/bin/tmux";
const BUNDLE = "/Applications/dev-3.0.app";
const PLIST = `${BUNDLE}/Contents/Info.plist`;
const EXEC = `${HOME}/.dev3.0/bin/dev3`;
const BUNDLED_APP_TMUX = `${BUNDLE}/Contents/Resources/app/tmux/tmux`;
const BUNDLED_CLI_TMUX = `${HOME}/cli/tmux/tmux`;

function plistWithVersion(version: string): string {
	return `<dict><key>CFBundleVersion</key>\n<string>${version}</string></dict>`;
}

/** A fully healthy darwin install; individual tests break specific pieces. */
function healthyDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
	const existing = new Set([`${HOME}/.dev3.0`, BUNDLE, PLIST, SHIM, KEG, "/opt/homebrew/Caskroom/dev3"]);
	return {
		platform: "darwin",
		home: HOME,
		cliVersion: "1.30.0",
		execPath: EXEC,
		existsSync: (p) => existing.has(p),
		isWritable: () => true,
		isSymlink: (p) => p === SHIM,
		readlink: () => KEG,
		realpath: (p) => (p === EXEC ? EXEC : KEG),
		isExecutableFile: (p) => existing.has(p) && p !== HOME,
		readFile: (p) => {
			if (p === PLIST) return plistWithVersion("1.30.0");
			throw new Error(`ENOENT: ${p}`);
		},
		exec: (cmd, args) => {
			if (cmd === "brew" && args[0] === "--prefix") return { status: 0, stdout: "/opt/homebrew\n" };
			if (cmd === "brew" && args.includes("--cask")) return { status: 0, stdout: "dev3 1.30.0\n" };
			if (cmd === "brew" && args.includes("--formula")) return { status: 1, stdout: "" };
			if (args[0] === "-V") return { status: 0, stdout: "tmux 3.6a\n" };
			return { status: 1, stdout: "" };
		},
		socketPath: () => `${HOME}/.dev3.0/sockets/app.sock`,
		...overrides,
	};
}

function byLabel(results: CheckResult[], label: string): CheckResult {
	const found = results.find((r) => r.label === label);
	if (!found) throw new Error(`no check labelled "${label}"`);
	return found;
}

describe("dev3 doctor — collectChecks", () => {
	it("reports a fully healthy install with zero warnings and problems", () => {
		const results = collectChecks(healthyDeps());
		expect(results.every((r) => r.status === "ok")).toBe(true);
	});

	it("fails when the data dir is missing", () => {
		const deps = healthyDeps({ existsSync: (p) => p !== `${HOME}/.dev3.0` && healthyDeps().existsSync(p) });
		expect(byLabel(collectChecks(deps), "data dir").status).toBe("fail");
	});

	it("fails when the data dir is not writable", () => {
		const deps = healthyDeps({ isWritable: () => false });
		expect(byLabel(collectChecks(deps), "data dir").status).toBe("fail");
	});

	it("warns with a reinstall recipe when the app bundle is gone (macOS)", () => {
		const base = healthyDeps();
		const deps = healthyDeps({ existsSync: (p) => !p.endsWith("dev-3.0.app") && base.existsSync(p) });
		const check = byLabel(collectChecks(deps), "desktop app");
		expect(check.status).toBe("warn");
		expect(check.hints?.join("\n")).toContain("brew install --cask h0x91b/dev3/dev3");
	});

	it("skips the bundle check on Linux", () => {
		const deps = healthyDeps({ platform: "linux" });
		expect(byLabel(collectChecks(deps), "desktop app").status).toBe("ok");
	});

	it("warns when CLI and app bundle versions differ", () => {
		const deps = healthyDeps({ cliVersion: "1.29.2" });
		const check = byLabel(collectChecks(deps), "cli version");
		expect(check.status).toBe("warn");
		expect(check.detail).toContain("1.29.2");
		expect(check.detail).toContain("1.30.0");
	});

	it("treats a missing tmux shim as healthy (the app recreates it)", () => {
		const base = healthyDeps();
		const deps = healthyDeps({
			existsSync: (p) => p !== SHIM && base.existsSync(p),
			isSymlink: () => false,
		});
		expect(byLabel(collectChecks(deps), "tmux shim").status).toBe("ok");
	});

	it("warns about a regular file at the shim path without suggesting deletion of user data", () => {
		const deps = healthyDeps({ isSymlink: () => false });
		const check = byLabel(collectChecks(deps), "tmux shim");
		expect(check.status).toBe("warn");
		expect(check.detail).toContain("regular file");
	});

	it("fails on a broken (self-referential/dangling) shim symlink with the rm hint", () => {
		const deps = healthyDeps({
			realpath: () => {
				throw new Error("ELOOP");
			},
			readlink: () => SHIM,
		});
		const check = byLabel(collectChecks(deps), "tmux shim");
		expect(check.status).toBe("fail");
		expect(check.hints?.[0]).toBe(`rm ${SHIM}`);
	});

	it("fails when the tmux shim resolves to a directory", () => {
		const deps = healthyDeps({
			readlink: () => HOME,
			realpath: () => HOME,
		});

		const check = byLabel(collectChecks(deps), "tmux shim");

		expect(check.status).toBe("fail");
		expect(check.detail).toContain("not an executable file");
		expect(check.hints?.[0]).toBe(`rm ${SHIM}`);
	});

	it("finds a poisoned saved tmux path even when the manually repaired shim is healthy", () => {
		const base = healthyDeps();
		const deps = healthyDeps({
			existsSync: (path) => path === SETTINGS || base.existsSync(path),
			readFile: (path) => path === SETTINGS
				? JSON.stringify({ customBinaryPaths: { tmux: HOME } })
				: base.readFile(path),
		});

		expect(byLabel(collectChecks(deps), "tmux shim").status).toBe("ok");
		const setting = byLabel(collectChecks(deps), "tmux setting");
		expect(setting.status).toBe("fail");
		expect(setting.detail).toContain(HOME);
		expect(setting.hints?.join("\n")).toContain(`plutil -remove customBinaryPaths.tmux ${SETTINGS}`);
	});

	it("fails when the tmux shim resolves to an executable that is not tmux", () => {
		const base = healthyDeps();
		const deps = healthyDeps({
			exec: (cmd, args) => cmd === KEG && args[0] === "-V"
				? { status: 0, stdout: "not tmux\n" }
				: base.exec(cmd, args),
		});

		const check = byLabel(collectChecks(deps), "tmux shim");

		expect(check.status).toBe("fail");
		expect(check.detail).toContain("target is not tmux");
	});

	it("identifies the bundled tmux inside the app bundle", () => {
		const base = healthyDeps();
		const deps = healthyDeps({
			isExecutableFile: (p) => p === BUNDLED_APP_TMUX || base.isExecutableFile(p),
		});
		const check = byLabel(collectChecks(deps), "tmux binary");
		expect(check.status).toBe("ok");
		expect(check.detail).toContain(`bundled ${BUNDLED_APP_TMUX}`);
	});

	it("identifies the bundled tmux next to the CLI binary (tarball/libexec layout)", () => {
		const base = healthyDeps();
		const deps = healthyDeps({
			realpath: (p) => (p === EXEC ? `${HOME}/cli/dev3` : KEG),
			isExecutableFile: (p) => p === BUNDLED_CLI_TMUX || base.isExecutableFile(p),
		});
		const check = byLabel(collectChecks(deps), "tmux binary");
		expect(check.status).toBe("ok");
		expect(check.detail).toContain(`bundled ${BUNDLED_CLI_TMUX}`);
	});

	it("skips a bundled tmux that does not identify itself as tmux and reports the keg", () => {
		const base = healthyDeps();
		const deps = healthyDeps({
			isExecutableFile: (p) => p === BUNDLED_APP_TMUX || base.isExecutableFile(p),
			exec: (cmd, args) => (cmd === BUNDLED_APP_TMUX ? { status: 0, stdout: "not tmux\n" } : base.exec(cmd, args)),
		});
		const check = byLabel(collectChecks(deps), "tmux binary");
		expect(check.status).toBe("ok");
		expect(check.detail).toContain(`keg ${KEG}`);
	});

	it("fails when neither the bundled tmux, the keg, nor a PATH tmux exists", () => {
		const base = healthyDeps();
		const deps = healthyDeps({
			existsSync: (p) => p !== KEG && base.existsSync(p),
			exec: (cmd, args) => {
				if (cmd === "tmux") return { status: null, stdout: "" };
				return base.exec(cmd, args);
			},
		});
		const check = byLabel(collectChecks(deps), "tmux binary");
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("no bundled tmux");
		expect(check.hints?.join("\n")).toContain("brew install h0x91b/dev3/tmux@3.6");
	});

	it("rejects a keg path whose executable does not identify itself as tmux", () => {
		const base = healthyDeps();
		const deps = healthyDeps({
			exec: (cmd, args) => {
				if (cmd === KEG) return { status: 0, stdout: "not tmux\n" };
				if (cmd === "tmux") return { status: null, stdout: "" };
				return base.exec(cmd, args);
			},
		});

		const check = byLabel(collectChecks(deps), "tmux binary");

		expect(check.status).toBe("fail");
	});

	it("warns when the keg is absent and PATH tmux is the known-bad 3.7", () => {
		const base = healthyDeps();
		const deps = healthyDeps({
			existsSync: (p) => p !== KEG && base.existsSync(p),
			exec: (cmd, args) => {
				if (cmd === "tmux") return { status: 0, stdout: "tmux 3.7b\n" };
				return base.exec(cmd, args);
			},
		});
		expect(byLabel(collectChecks(deps), "tmux binary").status).toBe("warn");
	});

	it("accepts keg absence with a healthy PATH tmux", () => {
		const base = healthyDeps();
		const deps = healthyDeps({
			existsSync: (p) => p !== KEG && base.existsSync(p),
			exec: (cmd, args) => {
				if (cmd === "tmux") return { status: 0, stdout: "tmux 3.6a\n" };
				return base.exec(cmd, args);
			},
		});
		expect(byLabel(collectChecks(deps), "tmux binary").status).toBe("ok");
	});

	it("fails on a leftover Caskroom dir when the cask itself is not installed", () => {
		const base = healthyDeps();
		const deps = healthyDeps({
			exec: (cmd, args) => {
				if (cmd === "brew" && args.includes("--cask")) return { status: 1, stdout: "" };
				return base.exec(cmd, args);
			},
		});
		const check = byLabel(collectChecks(deps), "homebrew cask");
		expect(check.status).toBe("fail");
		expect(check.hints?.join("\n")).toContain("rm -rf");
	});

	it("treats a Caskroom version behind the app as normal in-app-update drift", () => {
		const base = healthyDeps();
		const deps = healthyDeps({
			exec: (cmd, args) => {
				if (cmd === "brew" && args.includes("--cask")) return { status: 0, stdout: "dev3 1.16.0\n" };
				return base.exec(cmd, args);
			},
		});
		const check = byLabel(collectChecks(deps), "homebrew cask");
		expect(check.status).toBe("ok");
		expect(check.detail).toContain("normal after in-app updates");
	});

	it("warns about the accidental headless formula next to the desktop app", () => {
		const base = healthyDeps();
		const deps = healthyDeps({
			exec: (cmd, args) => {
				if (cmd === "brew" && args.includes("--formula")) return { status: 0, stdout: "dev3 1.30.0\n" };
				return base.exec(cmd, args);
			},
		});
		const check = byLabel(collectChecks(deps), "homebrew formula");
		expect(check.status).toBe("warn");
		expect(check.hints?.[0]).toContain("brew uninstall --formula dev3");
	});

	it("accepts the formula as legitimate when there is no desktop app (headless box)", () => {
		const base = healthyDeps();
		const deps = healthyDeps({
			platform: "linux",
			exec: (cmd, args) => {
				if (cmd === "brew" && args.includes("--formula")) return { status: 0, stdout: "dev3 1.30.0\n" };
				return base.exec(cmd, args);
			},
		});
		expect(byLabel(collectChecks(deps), "homebrew formula").status).toBe("ok");
	});

	it("skips brew checks entirely when brew is not installed", () => {
		const base = healthyDeps();
		const deps = healthyDeps({
			exec: (cmd, args) => {
				if (cmd === "brew") return { status: null, stdout: "" };
				return base.exec(cmd, args);
			},
		});
		const results = collectChecks(deps);
		expect(byLabel(results, "homebrew").detail).toContain("skipping");
		expect(results.find((r) => r.label === "homebrew cask")).toBeUndefined();
	});
});

describe("dev3 doctor — renderChecks", () => {
	it("prints hints indented under their finding and a summary line", () => {
		const out = renderChecks([
			{ label: "tmux shim", status: "fail", detail: "broken symlink", hints: ["rm ~/.dev3.0/bin/tmux"] },
			{ label: "data dir", status: "ok", detail: "fine" },
		]);
		expect(out).toContain("✗ tmux shim");
		expect(out).toContain("    ↳ rm ~/.dev3.0/bin/tmux");
		expect(out).toContain("1 problem, 0 warnings.");
	});

	it("prints the healthy summary when nothing is wrong", () => {
		const out = renderChecks([{ label: "data dir", status: "ok", detail: "fine" }]);
		expect(out).toContain("Everything looks healthy.");
	});
});

describe("dev3 doctor — handleDoctor", () => {
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let writeSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit");
		}) as never);
		writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		exitSpy.mockRestore();
		writeSpy.mockRestore();
	});

	it("exits 0 on a healthy install", async () => {
		await expect(handleDoctor({ flags: {}, positional: [] }, healthyDeps())).rejects.toThrow("exit");
		expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODE_SUCCESS);
	});

	it("exits with the doctor-problems code when a check fails", async () => {
		const deps = healthyDeps({
			realpath: () => {
				throw new Error("ELOOP");
			},
		});
		await expect(handleDoctor({ flags: {}, positional: [] }, deps)).rejects.toThrow("exit");
		expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODE_DOCTOR_PROBLEMS);
	});

	it("emits parseable JSON with --json", async () => {
		await expect(handleDoctor({ flags: { json: "true" }, positional: [] }, healthyDeps())).rejects.toThrow("exit");
		const payload = writeSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		const parsed = JSON.parse(payload) as { checks: CheckResult[] };
		expect(parsed.checks.length).toBeGreaterThan(0);
		expect(parsed.checks[0]).toHaveProperty("status");
	});
});
