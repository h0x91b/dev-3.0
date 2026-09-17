import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { withResolvedCodexBinary } from "../rpc-handlers/shared-pure";

// ---------------------------------------------------------------------------
// Codex's filesystem-sandbox helper re-execs Codex's own binary and allows the
// canonicalized path as the helper's read root, while `sandbox-exec` is handed
// the path Codex was started with. A Homebrew install starts through a symlink,
// so the helper exec is denied (exit 71) under any profile without full-disk
// read — dev3's own profile included. Launching the resolved path is what makes
// the two agree; these cases pin who gets rewritten and who does not.
// ---------------------------------------------------------------------------

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function asPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

let dir: string;
let target: string;
let link: string;
let plain: string;

beforeAll(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "codex-bin-")));
	target = join(dir, "codex-real");
	link = join(dir, "codex");
	plain = join(dir, "codex-plain");
	writeFileSync(target, "");
	writeFileSync(plain, "");
	symlinkSync(target, link);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

afterEach(() => {
	if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
});

describe("withResolvedCodexBinary", () => {
	it("starts a symlinked Codex by the path the sandbox helper will allow", () => {
		asPlatform("darwin");
		expect(withResolvedCodexBinary("codex --model x", "codex", link)).toBe(`${target} --model x`);
	});

	it("rewrites a command that is only the binary", () => {
		asPlatform("darwin");
		expect(withResolvedCodexBinary("codex", "codex", link)).toBe(target);
	});

	it("leaves a binary that is not a symlink alone", () => {
		asPlatform("darwin");
		expect(withResolvedCodexBinary("codex --model x", "codex", plain)).toBe("codex --model x");
	});

	it("leaves an absolute path or wrapper the user chose alone", () => {
		asPlatform("darwin");
		const command = "/opt/homebrew/bin/codex --model x";
		expect(withResolvedCodexBinary(command, "codex", link)).toBe(command);
		expect(withResolvedCodexBinary("my-codex-wrapper --model x", "codex", link)).toBe("my-codex-wrapper --model x");
	});

	it("never rewrites a token that merely starts with the binary name", () => {
		asPlatform("darwin");
		expect(withResolvedCodexBinary("codexy --model x", "codex", link)).toBe("codexy --model x");
	});

	it("quotes a resolved path containing a space", () => {
		asPlatform("darwin");
		const spaced = join(dir, "with space");
		const spacedLink = join(dir, "codex-spaced-link");
		writeFileSync(spaced, "");
		symlinkSync(spaced, spacedLink);
		expect(withResolvedCodexBinary("codex -x", "codex", spacedLink)).toBe(`'${spaced}' -x`);
	});

	it("does nothing off macOS — Seatbelt is what mismatches", () => {
		asPlatform("linux");
		expect(withResolvedCodexBinary("codex --model x", "codex", link)).toBe("codex --model x");
		asPlatform("win32");
		expect(withResolvedCodexBinary("codex --model x", "codex", link)).toBe("codex --model x");
	});

	it("returns the command untouched when the path cannot be resolved", () => {
		asPlatform("darwin");
		expect(withResolvedCodexBinary("codex --model x", "codex", join(dir, "gone"))).toBe("codex --model x");
	});
});
