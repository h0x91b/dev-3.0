import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, realpathSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureDev3CliSymlink, writeDev3SelfShim } from "../cli-self-install";

describe("ensureDev3CliSymlink", () => {
	let root: string;
	let home: string;
	let binExec: string; // a stand-in for the running dev3 binary

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-cli-self-install-"));
		home = join(root, "dev3home");
		mkdirSync(home, { recursive: true });
		binExec = join(root, "cellar", "dev3");
		mkdirSync(join(root, "cellar"), { recursive: true });
		writeFileSync(binExec, "#!/bin/sh\necho dev3\n", { mode: 0o755 });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const dest = () => join(home, "bin", "dev3");

	it("creates the symlink when nothing exists yet", () => {
		const result = ensureDev3CliSymlink(home, binExec);
		expect(result).toBe("linked");
		expect(lstatSync(dest()).isSymbolicLink()).toBe(true);
		expect(realpathSync(dest())).toBe(realpathSync(binExec));
	});

	it("resolves the running binary through an intermediate symlink (brew bin → cellar)", () => {
		// Simulate `which dev3` → /brew/bin/dev3 → …/cellar/dev3
		const brewBin = join(root, "brewbin", "dev3");
		mkdirSync(join(root, "brewbin"), { recursive: true });
		symlinkSync(binExec, brewBin);

		expect(ensureDev3CliSymlink(home, brewBin)).toBe("linked");
		// dest points at the concrete binary, not the intermediate symlink.
		expect(realpathSync(dest())).toBe(realpathSync(binExec));
	});

	it("is idempotent — a second call with the same binary changes nothing", () => {
		expect(ensureDev3CliSymlink(home, binExec)).toBe("linked");
		expect(ensureDev3CliSymlink(home, binExec)).toBe("unchanged");
	});

	it("heals a DANGLING symlink (the reported bug: ls shows it, exec says not found)", () => {
		mkdirSync(join(home, "bin"), { recursive: true });
		symlinkSync(join(root, "gone", "dev3"), dest()); // target does not exist
		expect(() => realpathSync(dest())).toThrow(); // confirm it's dangling

		expect(ensureDev3CliSymlink(home, binExec)).toBe("linked");
		expect(realpathSync(dest())).toBe(realpathSync(binExec)); // now valid
	});

	it("replaces a symlink that points at a different (stale) binary", () => {
		const stale = join(root, "old", "dev3");
		mkdirSync(join(root, "old"), { recursive: true });
		writeFileSync(stale, "old", { mode: 0o755 });
		mkdirSync(join(home, "bin"), { recursive: true });
		symlinkSync(stale, dest());

		expect(ensureDev3CliSymlink(home, binExec)).toBe("linked");
		expect(realpathSync(dest())).toBe(realpathSync(binExec));
	});

	it("skips when the running binary path can't be resolved", () => {
		expect(ensureDev3CliSymlink(home, join(root, "does-not-exist"))).toBe("skipped");
	});

	it("leaves a concrete binary dropped directly at dest untouched (no self-link)", () => {
		mkdirSync(join(home, "bin"), { recursive: true });
		writeFileSync(dest(), "real", { mode: 0o755 });
		// Passing dest itself as the running binary must not try to link it to itself.
		expect(ensureDev3CliSymlink(home, dest())).toBe("unchanged");
		expect(lstatSync(dest()).isSymbolicLink()).toBe(false);
	});

	// Windows: the destination is dev3.exe, and a symlink needs elevation or
	// Developer Mode — so the code must degrade instead of throwing.
	it("targets dev3.exe when the platform is Windows", () => {
		expect(ensureDev3CliSymlink(home, binExec, "win32")).toBe("linked");
		expect(realpathSync(join(home, "bin", "dev3.exe"))).toBe(realpathSync(binExec));
	});

	it("falls back to a .cmd shim when neither a link nor a copy is possible", () => {
		// A directory at the destination makes both symlink and copy fail, which
		// stands in for the elevation-less Windows box.
		mkdirSync(join(home, "bin", "dev3.exe"), { recursive: true });

		expect(ensureDev3CliSymlink(home, binExec, "win32")).toBe("shimmed");
		const shim = readFileSync(join(home, "bin", "dev3.cmd"), "utf-8");
		expect(shim).toContain(realpathSync(binExec));
		expect(shim.startsWith("@echo off")).toBe(true);
	});

	it("never throws when the dev3 home is not writable", () => {
		expect(() => ensureDev3CliSymlink(join(binExec, "not-a-dir"), binExec, "win32")).not.toThrow();
		expect(ensureDev3CliSymlink(join(binExec, "not-a-dir"), binExec, "win32")).toBe("skipped");
	});

	it("recreates the bin dir if it was removed", () => {
		expect(ensureDev3CliSymlink(home, binExec)).toBe("linked");
		unlinkSync(dest());
		rmSync(join(home, "bin"), { recursive: true, force: true });
		expect(ensureDev3CliSymlink(home, binExec)).toBe("linked");
		expect(realpathSync(dest())).toBe(realpathSync(binExec));
	});
});

describe("writeDev3SelfShim", () => {
	let root: string;
	let home: string;
	let binExec: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-self-shim-"));
		home = join(root, "dev3home");
		mkdirSync(home, { recursive: true });
		binExec = join(root, "cellar", "dev3");
		mkdirSync(join(root, "cellar"), { recursive: true });
		writeFileSync(binExec, "#!/bin/sh\necho dev3\n", { mode: 0o755 });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("pins the task hosting this instance, by task id rather than pid", () => {
		const task = "6955b1dc-1111-2222-3333-444444444444";
		const { path, selector } = writeDev3SelfShim(home, binExec, task);

		expect(selector).toBe(`task:${task}`);
		expect(path).toBe(join(home, "bin", "dev3-self"));
		const body = readFileSync(path, "utf-8");
		expect(body).toContain(`--instance task:${task}`);
		expect(body).toContain(realpathSync(binExec));
		expect(body).toContain('"$@"');
	});

	it("arms `primary` when the installing app is not itself hosted by a task", () => {
		expect(writeDev3SelfShim(home, binExec, null).selector).toBe("primary");
		expect(readFileSync(join(home, "bin", "dev3-self"), "utf-8")).toContain("--instance primary");
	});

	it("execs the concrete binary, never the bin/dev3 entry that hooks invoke", () => {
		// The app hands us the bundled CLI reached through a symlink chain.
		const indirect = join(root, "brewbin", "dev3");
		mkdirSync(join(root, "brewbin"), { recursive: true });
		symlinkSync(binExec, indirect);

		const body = readFileSync(writeDev3SelfShim(home, indirect, null).path, "utf-8");
		expect(body).toContain(realpathSync(binExec));
		expect(body).not.toContain(join(home, "bin", "dev3\""));
	});

	it("dereferences bin/dev3 to the real binary instead of chaining through it", () => {
		// Handed the very entry agent hooks invoke: follow it, never exec it.
		ensureDev3CliSymlink(home, binExec);
		const body = readFileSync(writeDev3SelfShim(home, join(home, "bin", "dev3"), null).path, "utf-8");
		expect(body).toContain(realpathSync(binExec));
		expect(body).not.toContain(`"${join(home, "bin", "dev3")}"`);
	});

	it("refuses a target that really lives in <dev3Home>/bin — that dir is first on PATH (ELOOP, decision 105)", () => {
		// The Windows/copy layout: bin/dev3 is a concrete file, not a symlink out.
		mkdirSync(join(home, "bin"), { recursive: true });
		const copied = join(home, "bin", "dev3");
		writeFileSync(copied, "#!/bin/sh\necho dev3\n", { mode: 0o755 });
		expect(() => writeDev3SelfShim(home, copied, null)).toThrow(/would exec itself/);
	});

	it("is a .cmd on Windows, where a shell shim would not run", () => {
		const { path } = writeDev3SelfShim(home, binExec, null, "win32");
		expect(path).toBe(join(home, "bin", "dev3-self.cmd"));
		expect(readFileSync(path, "utf-8").startsWith("@echo off")).toBe(true);
	});

	it("leaves the CLI every agent hook invokes untouched", () => {
		expect(ensureDev3CliSymlink(home, binExec)).toBe("linked");
		writeDev3SelfShim(home, binExec, "6955b1dc-1111-2222-3333-444444444444");

		// bin/dev3 still resolves to the plain binary — no wrapper, no selector.
		expect(lstatSync(join(home, "bin", "dev3")).isSymbolicLink()).toBe(true);
		expect(realpathSync(join(home, "bin", "dev3"))).toBe(realpathSync(binExec));
	});
});
