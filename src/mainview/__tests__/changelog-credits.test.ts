import { describe, it, expect } from "vitest";
import { parseChangelogCredits } from "../../shared/changelog-credits";

describe("parseChangelogCredits", () => {
	it("parses Suggested by with an issue ref", () => {
		const { credits, content } = parseChangelogCredits("Fix a thing.\n\nSuggested by @roiros (h0x91b/dev-3.0#191)\n");
		expect(credits).toEqual({
			suggestedBy: "roiros",
			issueRef: "#191",
			issueUrl: "https://github.com/h0x91b/dev-3.0/issues/191",
		});
		expect(content.trim()).toBe("Fix a thing.");
	});

	it("parses Contributed by with a PR ref", () => {
		const { credits, content } = parseChangelogCredits("Add x.\n\nContributed by @alice (h0x91b/dev-3.0#42)");
		expect(credits).toEqual({
			contributedBy: "alice",
			prRef: "#42",
			prUrl: "https://github.com/h0x91b/dev-3.0/pull/42",
		});
		expect(content.trim()).toBe("Add x.");
	});

	it("parses Contributed by without a ref", () => {
		const { credits, content } = parseChangelogCredits("Add x.\n\nContributed by @alice\n");
		expect(credits).toEqual({ contributedBy: "alice" });
		expect(content.trim()).toBe("Add x.");
	});

	it("handles both lines in any order and strips them from the middle too", () => {
		const text = "Add x.\n\nContributed by @alice (h0x91b/dev-3.0#42)\nSuggested by @bob (h0x91b/dev-3.0#7)\n";
		const { credits, content } = parseChangelogCredits(text);
		expect(credits).toMatchObject({ contributedBy: "alice", suggestedBy: "bob", prRef: "#42", issueRef: "#7" });
		expect(content.trim()).toBe("Add x.");

		const swapped = parseChangelogCredits("Suggested by @bob (h0x91b/dev-3.0#7)\nAdd x.\nContributed by @alice\n");
		expect(swapped.content.trim()).toBe("Add x.");
	});

	it("strips an inline or indented trailing Suggested by like the old code did", () => {
		expect(parseChangelogCredits("Fix a thing. Suggested by @x (h0x91b/dev-3.0#1)").content.trim()).toBe("Fix a thing.");
		expect(parseChangelogCredits("Fix a thing.\n\n   Suggested by @x (h0x91b/dev-3.0#1)  \n").content.trim()).toBe("Fix a thing.");
	});

	it("removes a middle credit line with its line break, leaving no extra blank line", () => {
		expect(parseChangelogCredits("A.\n\nSuggested by @x (h0x91b/dev-3.0#1)\n\nMore.").content).toBe("A.\n\nMore.");
		expect(parseChangelogCredits("A.\n\nContributed by @x\n\nMore.").content).toBe("A.\n\nMore.");
		expect(parseChangelogCredits("A.\nSuggested by @x (h0x91b/dev-3.0#1)\nMore.").content).toBe("A.\nMore.");
	});

	it("takes only the login chars after @ and accepts a ref glued to it", () => {
		expect(parseChangelogCredits("A.\nContributed by @alice(h0x91b/dev-3.0#42)").credits).toEqual({
			contributedBy: "alice",
			prRef: "#42",
			prUrl: "https://github.com/h0x91b/dev-3.0/pull/42",
		});
	});

	it("resolves a bare #N PR ref against the default repo", () => {
		expect(parseChangelogCredits("A.\n\nContributed by @alice (#42)\n").credits).toEqual({
			contributedBy: "alice",
			prRef: "#42",
			prUrl: "https://github.com/h0x91b/dev-3.0/pull/42",
		});
	});

	it("returns no credits and unchanged content when there are none", () => {
		const text = "Plain entry. Mentions Contributed by in prose.";
		expect(parseChangelogCredits(text)).toEqual({ credits: {}, content: text });
	});
});
