import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENT_PROMPTS_DIR, ensureAgentSystemPromptFile } from "../agent-system-prompt-file";

// The file is read by ANOTHER process (the agent the launch spawns), so the two
// properties that matter are "the whole body is there" and "a reader never sees
// a half-written one". h0x91b/dev-3.0#1734 is why there is no inline fallback.

describe("ensureAgentSystemPromptFile", () => {
	it("writes the body and returns the path the launch will name", () => {
		const path = ensureAgentSystemPromptFile("probe-write", "first body");
		expect(path).toBe(join(AGENT_PROMPTS_DIR, "probe-write.md"));
		expect(readFileSync(path, "utf-8")).toBe("first body");
	});

	it("leaves the file alone when the body has not changed", () => {
		const path = ensureAgentSystemPromptFile("probe-stable", "same body");
		const first = statSync(path).mtimeMs;
		expect(ensureAgentSystemPromptFile("probe-stable", "same body")).toBe(path);
		expect(statSync(path).mtimeMs).toBe(first);
	});

	it("replaces a changed body and leaves no temp file behind", () => {
		const path = ensureAgentSystemPromptFile("probe-swap", "old body");
		ensureAgentSystemPromptFile("probe-swap", "new body");
		expect(readFileSync(path, "utf-8")).toBe("new body");
		expect(readdirSync(AGENT_PROMPTS_DIR).filter((f) => f.startsWith("probe-swap") && f.endsWith(".tmp"))).toEqual([]);
	});

	it("throws instead of falling back to the inline body, which is the bug being closed", () => {
		// A name whose parent directory does not exist is the cheapest real write
		// failure; what matters is that the caller gets an error, not a null.
		expect(() => ensureAgentSystemPromptFile("missing-dir/probe", "body")).toThrow(
			/Could not write the agent system-prompt file/,
		);
		expect(existsSync(join(AGENT_PROMPTS_DIR, "missing-dir"))).toBe(false);
	});
});
