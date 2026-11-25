import { afterAll, afterEach, describe, expect, it } from "vitest";
import { load } from "js-toml";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { codexInstallReadRoots, ensureCodexConfig, resolveCodexInstallRoots } from "../codex-config";

const WORKTREES = "/Users/testuser/.dev3.0/worktrees";
const SOCKETS = "/Users/testuser/.dev3.0/sockets";
const MARKER = "# dev3: codex install";

const dirs: string[] = [];
function tmp(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "codex-install-")));
	dirs.push(dir);
	return dir;
}
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function touch(path: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "");
}

/** ~/.local/bin/codex -> ~/.codex/packages/standalone/current/bin/codex, current -> releases/<v>. */
function standalone(home: string, release: string): string {
	const standaloneDir = join(home, ".codex", "packages", "standalone");
	touch(join(standaloneDir, "releases", release, "bin", "codex"));
	symlinkSync(join("releases", release), join(standaloneDir, "current"));
	mkdirSync(join(home, ".local", "bin"), { recursive: true });
	const launcher = join(home, ".local", "bin", "codex");
	symlinkSync(join(standaloneDir, "current", "bin", "codex"), launcher);
	return launcher;
}

function filesystem(config: string): Record<string, unknown> {
	const parsed = load(config) as { permissions: { dev3: { filesystem: Record<string, unknown> } } };
	return parsed.permissions.dev3.filesystem;
}

describe.skipIf(process.platform === "win32")("codexInstallReadRoots", () => {
	it("returns the launcher dir and the standalone install root", () => {
		const home = tmp();
		const launcher = standalone(home, "0.163.0-aarch64-apple-darwin");
		expect(codexInstallReadRoots(launcher)).toEqual([
			join(home, ".local", "bin"),
			join(home, ".codex", "packages", "standalone"),
		]);
	});

	it("follows a relative Homebrew cask link", () => {
		const prefix = tmp();
		const cask = join(prefix, "Caskroom", "codex", "0.1.0");
		touch(join(cask, "codex-aarch64-apple-darwin"));
		mkdirSync(join(prefix, "bin"));
		symlinkSync("../Caskroom/codex/0.1.0/codex-aarch64-apple-darwin", join(prefix, "bin", "codex"));
		expect(codexInstallReadRoots(join(prefix, "bin", "codex"))).toEqual([join(prefix, "bin"), cask]);
	});

	it("follows an npm global link and steps out of the package bin dir", () => {
		const prefix = tmp();
		const pkg = join(prefix, "lib", "node_modules", "@openai", "codex");
		touch(join(pkg, "bin", "codex.js"));
		mkdirSync(join(prefix, "bin"));
		symlinkSync("../lib/node_modules/@openai/codex/bin/codex.js", join(prefix, "bin", "codex"));
		expect(codexInstallReadRoots(join(prefix, "bin", "codex"))).toEqual([join(prefix, "bin"), pkg]);
	});

	it("returns only the launcher dir for a plain file, and nothing for a missing launcher", () => {
		const dir = tmp();
		touch(join(dir, "codex"));
		expect(codexInstallReadRoots(join(dir, "codex"))).toEqual([dir]);
		expect(codexInstallReadRoots(join(tmp(), "nope"))).toEqual([]);
	});

	it("does not widen the root to the Homebrew prefix when a link points at Homebrew's bin", () => {
		const root = tmp();
		const cask = join(root, "homebrew", "Caskroom", "codex", "0.1.0");
		touch(join(cask, "codex"));
		mkdirSync(join(root, "homebrew", "bin"));
		symlinkSync("../Caskroom/codex/0.1.0/codex", join(root, "homebrew", "bin", "codex"));
		mkdirSync(join(root, "local", "bin"), { recursive: true });
		symlinkSync(join(root, "homebrew", "bin", "codex"), join(root, "local", "bin", "codex"));
		expect(codexInstallReadRoots(join(root, "local", "bin", "codex"))).toEqual([
			join(root, "local", "bin"),
			join(root, "homebrew", "bin"),
			cask,
		]);
	});

	it("grants each link's dir instead of the common ancestor of unrelated trees", () => {
		const root = tmp();
		touch(join(root, "b", "y", "codex"));
		mkdirSync(join(root, "a", "x"), { recursive: true });
		mkdirSync(join(root, "c", "bin"), { recursive: true });
		symlinkSync(join(root, "b", "y", "codex"), join(root, "a", "x", "codex"));
		symlinkSync(join(root, "a", "x", "codex"), join(root, "c", "bin", "codex"));
		const roots = codexInstallReadRoots(join(root, "c", "bin", "codex"));
		expect(roots).toEqual([join(root, "c", "bin"), join(root, "a", "x"), join(root, "b", "y")]);
		expect(roots).not.toContain(root);
	});

	it("adds the canonical dir of a plain launcher reached through a symlinked dir", () => {
		const root = tmp();
		touch(join(root, "real", "codex"));
		symlinkSync(join(root, "real"), join(root, "alias"));
		expect(codexInstallReadRoots(join(root, "alias", "codex"))).toEqual([join(root, "alias"), join(root, "real")]);
	});

	describe("with HOME pointing at a fixture", () => {
		const savedHome = process.env.HOME;
		afterEach(() => {
			process.env.HOME = savedHome;
		});

		it("keeps the standalone root when an extra link sits elsewhere in home", () => {
			const home = tmp();
			process.env.HOME = home;
			const launcher = standalone(home, "0.163.0");
			mkdirSync(join(home, "bin"));
			symlinkSync(launcher, join(home, "bin", "codex"));
			expect(codexInstallReadRoots(join(home, "bin", "codex"))).toEqual([
				join(home, "bin"),
				join(home, ".local", "bin"),
				join(home, ".codex", "packages", "standalone"),
			]);
		});

		it("never grants home, its ancestors or ~/.codex itself", () => {
			const home = tmp();
			process.env.HOME = home;
			touch(join(home, ".codex", "codex"));
			touch(join(home, "codex"));
			expect(codexInstallReadRoots(join(home, ".codex", "codex"))).toEqual([]);
			expect(codexInstallReadRoots(join(home, "codex"))).toEqual([]);
			expect(codexInstallReadRoots(join(dirname(home), "nope"))).toEqual([]);
		});
	});
});

describe("resolveCodexInstallRoots", () => {
	it("leaves the grants alone off macOS", async () => {
		expect(await resolveCodexInstallRoots("linux")).toBeUndefined();
		expect(await resolveCodexInstallRoots("win32")).toBeUndefined();
	});
});

describe.skipIf(process.platform === "win32")("ensureCodexConfig codexInstallRoots", () => {
	it("writes the roots as managed read grants into a new or existing dev3 profile", () => {
		const home = tmp();
		const roots = codexInstallReadRoots(standalone(home, "0.163.0"));
		const result = ensureCodexConfig(null, WORKTREES, SOCKETS, [], { codexInstallRoots: roots });
		const fs = filesystem(result);
		for (const root of roots) {
			expect(fs[root]).toBe("read");
			expect(result).toContain(`"${root}" = "read" ${MARKER}`);
		}
		// An existing dev3 profile gets them too.
		const existing = ensureCodexConfig(ensureCodexConfig(null, WORKTREES, SOCKETS), WORKTREES, SOCKETS, [], { codexInstallRoots: ["/opt/a/bin", "/opt/a/pkg"] });
		expect(filesystem(existing)["/opt/a/bin"]).toBe("read");
		expect(filesystem(existing)["/opt/a/pkg"]).toBe("read");
	});

	it("swaps stale managed lines when the install moves", () => {
		const first = ensureCodexConfig(null, WORKTREES, SOCKETS, [], { codexInstallRoots: ["/opt/a/bin", "/opt/a/old"] });
		const second = ensureCodexConfig(first, WORKTREES, SOCKETS, [], { codexInstallRoots: ["/opt/a/bin", "/opt/b/new"] });
		const fs = filesystem(second);
		expect(fs["/opt/a/old"]).toBeUndefined();
		expect(fs["/opt/b/new"]).toBe("read");
		expect(fs["/opt/a/bin"]).toBe("read");
		expect(second.match(/"\/opt\/a\/bin"/g)).toHaveLength(1);
	});

	it("is a no-op on a second run and ignores roots when the option is unset", () => {
		const first = ensureCodexConfig(null, WORKTREES, SOCKETS, [], { codexInstallRoots: ["/opt/a/bin"] });
		expect(ensureCodexConfig(first, WORKTREES, SOCKETS, [], { codexInstallRoots: ["/opt/a/bin"] })).toBe(first);
		expect(ensureCodexConfig(first, WORKTREES, SOCKETS)).toBe(first);
	});

	it("keeps the user's own entries and does not duplicate a path they already granted", () => {
		const base = ensureCodexConfig(null, WORKTREES, SOCKETS).replace(
			'":minimal" = "read"',
			'":minimal" = "read"\n"/opt/a/bin" = "read"\n"/opt/custom" = "write"',
		);
		const result = ensureCodexConfig(base, WORKTREES, SOCKETS, [], { codexInstallRoots: ["/opt/a/bin", "/opt/a/pkg"] });
		const fs = filesystem(result);
		expect(result.match(/"\/opt\/a\/bin"/g)).toHaveLength(1);
		expect(result).not.toContain(`"/opt/a/bin" = "read" ${MARKER}`);
		expect(fs["/opt/custom"]).toBe("write");
		expect(fs["/opt/a/pkg"]).toBe("read");

		const dropped = ensureCodexConfig(result, WORKTREES, SOCKETS, [], { codexInstallRoots: [] });
		expect(filesystem(dropped)["/opt/a/bin"]).toBe("read");
		expect(filesystem(dropped)["/opt/a/pkg"]).toBeUndefined();
	});

	it("never grants write to a root", () => {
		const before = filesystem(ensureCodexConfig(null, WORKTREES, SOCKETS));
		const after = filesystem(ensureCodexConfig(null, WORKTREES, SOCKETS, [], { codexInstallRoots: ["/opt/a/bin", "/opt/a/pkg"] }));
		const added = Object.keys(after).filter((key) => !(key in before));
		expect(added.sort()).toEqual(["/opt/a/bin", "/opt/a/pkg"]);
		for (const key of added) expect(after[key]).toBe("read");
		expect(Object.values(after).filter((mode) => mode === "write")).toHaveLength(
			Object.values(before).filter((mode) => mode === "write").length,
		);
	});
});
