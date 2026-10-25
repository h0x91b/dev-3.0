import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repository = resolve(__dirname, "../../..");
const fixture = resolve(repository, "scripts/ghostty-core/fixtures/core-regression.mjs");
const cases = [
	["semantics", "preserves graphemes, erasure, cursor, alternate screen, scrollback and reset semantics"],
	["grapheme-reuse", "preserves content when terminal lifetimes reuse the same core"],
	["grapheme-reflow", "preserves combining characters through repeated narrowing and widening"],
	["original-width-reflow", "completes the original 40-column allocator regression without trapping"],
	["scroll-growth", "keeps blank and short rows clear after reset-heavy scroll growth"],
	["style-reflow", "preserves text while reflowing 120 distinct styles"],
] as const;

describe("the shipped Ghostty core", () => {
	it.each(cases)("%s: %s", (name) => {
		// A test timer cannot interrupt a synchronous WASM loop in its own process.
		const child = spawnSync("node", [fixture, "--case", name], {
			cwd: repository,
			encoding: "utf8",
			timeout: 8_000,
			killSignal: "SIGKILL",
			maxBuffer: 256 * 1024,
		});
		const detail = JSON.stringify({ error: child.error?.message, signal: child.signal, stdout: child.stdout, stderr: child.stderr });
		expect(child.error, detail).toBeUndefined();
		expect(child.signal, detail).toBeNull();
		expect(child.status, detail).toBe(0);
		const records = child.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
		const result = records.reverse().find((record) => record.type === "result");
		expect(result, detail).toMatchObject({ type: "result", case: name, status: "pass" });
	}, 10_000);
});
