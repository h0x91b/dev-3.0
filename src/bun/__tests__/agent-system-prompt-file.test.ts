import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	AGENT_PROMPTS_DIR,
	ensureAgentSystemPromptFile,
	systemPromptFileDigest,
} from "../agent-system-prompt-file";

// ---------------------------------------------------------------------------
// The protocol body reaches Claude as a file on every platform, because an argv
// copy of it is what `pkill -f` pattern-matches against — one agent's cleanup
// SIGTERMed every sibling agent on the machine (h0x91b/dev-3.0#1734).
//
// The file name is content-addressed so two app versions running side by side
// cannot overwrite each other's body between the write and the child's read.
// The suite runs against the real filesystem under the isolated test HOME.
// ---------------------------------------------------------------------------

const BODY_A = "dev3 protocol body A\nwith 'apostrophes' and «non-ASCII».";
const BODY_B = "dev3 protocol body B — a different version of the same protocol.";

describe("ensureAgentSystemPromptFile", () => {
	it("writes the body verbatim and returns its path", () => {
		const path = ensureAgentSystemPromptFile("claude", BODY_A);
		expect(readFileSync(path, "utf-8")).toBe(BODY_A);
		expect(dirname(path)).toBe(AGENT_PROMPTS_DIR);
	});

	it("names the file after the body's content, not after the agent alone", () => {
		const path = ensureAgentSystemPromptFile("claude", BODY_A);
		expect(basename(path)).toBe(`claude-${systemPromptFileDigest(BODY_A)}.md`);
	});

	it("gives two different bodies two different files — a parallel app version cannot clobber ours", () => {
		const a = ensureAgentSystemPromptFile("claude", BODY_A);
		const b = ensureAgentSystemPromptFile("claude", BODY_B);
		expect(a).not.toBe(b);
		expect(readFileSync(a, "utf-8")).toBe(BODY_A);
		expect(readFileSync(b, "utf-8")).toBe(BODY_B);
	});

	it("reuses the existing file when the body is unchanged — repeated launches do not rewrite it", () => {
		const first = ensureAgentSystemPromptFile("claude", BODY_A);
		const stamp = statSync(first).mtimeMs;
		const second = ensureAgentSystemPromptFile("claude", BODY_A);
		expect(second).toBe(first);
		expect(statSync(second).mtimeMs).toBe(stamp);
	});

	it("repairs a truncated file instead of launching against half a protocol", () => {
		const path = ensureAgentSystemPromptFile("claude", BODY_A);
		writeFileSync(path, BODY_A.slice(0, 5), "utf-8");
		expect(ensureAgentSystemPromptFile("claude", BODY_A)).toBe(path);
		expect(readFileSync(path, "utf-8")).toBe(BODY_A);
	});

	it("leaves no temp file behind", () => {
		ensureAgentSystemPromptFile("claude", BODY_A);
		ensureAgentSystemPromptFile("claude", BODY_B);
		expect(readdirSync(AGENT_PROMPTS_DIR).filter((f) => f.includes(".tmp"))).toEqual([]);
	});

	// No inline fallback: on Windows the inline body cannot be launched at all,
	// and on POSIX it would put the protocol straight back into argv.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"throws when the file cannot be written",
		() => {
			const dir = join(AGENT_PROMPTS_DIR, "..", "unwritable-probe");
			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dir, { recursive: true });
			chmodSync(dir, 0o500);
			try {
				expect(() => writeFileSync(join(dir, "probe"), "x")).toThrow();
			} finally {
				chmodSync(dir, 0o700);
				rmSync(dir, { recursive: true, force: true });
			}
			// Same failure through the real helper: an unwritable prompts dir.
			const saved = statSync(AGENT_PROMPTS_DIR).mode;
			chmodSync(AGENT_PROMPTS_DIR, 0o500);
			try {
				expect(() => ensureAgentSystemPromptFile("claude", `${BODY_A}-unwritable`)).toThrow(
					/Could not write the agent system-prompt file/,
				);
			} finally {
				chmodSync(AGENT_PROMPTS_DIR, saved);
			}
		},
	);
});
