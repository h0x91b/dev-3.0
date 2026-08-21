import { describe, it, expect } from "vitest";
import { COORDINATOR_PROMPT, resolvePresetPrompt } from "../../shared/types";

const BUILTIN = "Review the code changes on this branch.";

describe("resolvePresetPrompt", () => {
	it("falls back to the built-in text when nothing is configured", () => {
		expect(resolvePresetPrompt(undefined, undefined, BUILTIN)).toBe(BUILTIN);
	});

	it("uses the global prompt when only that is set", () => {
		expect(resolvePresetPrompt(undefined, "Global.", BUILTIN)).toBe("Global.");
	});

	it("lets the project override the global prompt", () => {
		expect(resolvePresetPrompt("Project.", "Global.", BUILTIN)).toBe("Project.");
	});

	it("treats a blank value at either layer as unset", () => {
		expect(resolvePresetPrompt("   \n", "Global.", BUILTIN)).toBe("Global.");
		expect(resolvePresetPrompt("", "  ", BUILTIN)).toBe(BUILTIN);
	});

	it("keeps a configured prompt verbatim, trailing whitespace included", () => {
		expect(resolvePresetPrompt("Project.\n\n", undefined, BUILTIN)).toBe("Project.\n\n");
	});
});

describe("COORDINATOR_PROMPT", () => {
	// Each assertion pins a rule the running coordinator prototype (Seq 1141) paid
	// for with a real incident. Losing one silently is the failure this guards.
	it("states the no-code line with BOTH halves, so the role is neither blind nor a developer", () => {
		expect(COORDINATOR_PROMPT).toContain("NO CODE");
		expect(COORDINATOR_PROMPT).toMatch(/Allowed[\s\S]*SHA/);
		expect(COORDINATOR_PROMPT).toMatch(/Not allowed[\s\S]*engineering judgement/);
	});

	it("requires every reply to be a self-contained status", () => {
		expect(COORDINATOR_PROMPT).toContain("SELF-CONTAINED STATUS");
		expect(COORDINATOR_PROMPT).toContain("does not see or read your conversations");
	});

	it("requires a task to be named by number AND id", () => {
		expect(COORDINATOR_PROMPT).toContain("Seq NNNN (<id>)");
	});

	it("keeps the four rules that were learned from a specific failure", () => {
		expect(COORDINATOR_PROMPT).toContain("RELAY THE RULING, NOT YOUR READING OF IT");
		expect(COORDINATOR_PROMPT).toContain("NEVER ATTRIBUTE WORDS THE USER DID NOT SAY");
		expect(COORDINATOR_PROMPT).toContain("PERMISSION DOES NOT TRAVEL");
		expect(COORDINATOR_PROMPT).toContain("ANNOUNCE A REVERSAL AS A REVERSAL");
	});

	it("tells the coordinator its board picture is a snapshot, not a feed", () => {
		expect(COORDINATOR_PROMPT).toContain("SNAPSHOT");
		expect(COORDINATOR_PROMPT).toMatch(/before every status/);
	});

	it("is English-only, so a locale file can never half-translate a behavioural rule", () => {
		expect(COORDINATOR_PROMPT).not.toMatch(/[Ѐ-ӿ]/);
	});
});
