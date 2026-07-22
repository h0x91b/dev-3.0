import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureDev3CliSymlink } from "../cli-self-install";

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

	it("recreates the bin dir if it was removed", () => {
		expect(ensureDev3CliSymlink(home, binExec)).toBe("linked");
		unlinkSync(dest());
		rmSync(join(home, "bin"), { recursive: true, force: true });
		expect(ensureDev3CliSymlink(home, binExec)).toBe("linked");
		expect(realpathSync(dest())).toBe(realpathSync(binExec));
	});
});
