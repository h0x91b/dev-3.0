import { describe, it, expect } from "vitest";
import { COORDINATOR_PROMPT, DEFAULT_PR_REVIEW_PROMPT, resolvePresetPrompt, reviewTaskTitle, reviewTitleTopic } from "../../shared/types";

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

describe("DEFAULT_PR_REVIEW_PROMPT", () => {
	// The half of a review task's board identity that only the agent can produce.
	// dev3 names the card at creation; the verdict and the counts cannot be known
	// before the review is done, so they have to be asked for here.
	it("asks for an overview that is a merge verdict plus numbers", () => {
		expect(DEFAULT_PR_REVIEW_PROMPT).toContain("dev3 overview set");
		expect(DEFAULT_PR_REVIEW_PROMPT).toContain("Safe to merge");
		expect(DEFAULT_PR_REVIEW_PROMPT).toContain("Merge after fixes");
		expect(DEFAULT_PR_REVIEW_PROMPT).toContain("Do not merge");
		expect(DEFAULT_PR_REVIEW_PROMPT).toMatch(/counts are numbers/);
		expect(DEFAULT_PR_REVIEW_PROMPT).toMatch(/Under 500 characters/);
	});

	// The agent owns the title too, not just the overview: dev3's creation-time
	// title is a draft built from the PR's own words, and only the agent has read
	// the diff. A prompt that said "fix it if it looks wrong" got that backwards.
	it("tells the agent to set the title itself, and spells out the shape", () => {
		expect(DEFAULT_PR_REVIEW_PROMPT).toContain("dev3 task update --title");
		expect(DEFAULT_PR_REVIEW_PROMPT).toContain(
			"Review of #<PR number> from <the author, a readable name> about <what it changes, five words>",
		);
		expect(DEFAULT_PR_REVIEW_PROMPT).toMatch(/Review of #493 from Arseny Pavlenko about pin tmux/);
	});

	it("calls dev3's creation-time title a draft to be replaced, not a result to keep", () => {
		expect(DEFAULT_PR_REVIEW_PROMPT).toMatch(/DRAFT title/);
		expect(DEFAULT_PR_REVIEW_PROMPT).toMatch(/Treat it as a draft and replace it/);
		expect(DEFAULT_PR_REVIEW_PROMPT).toMatch(/neither is optional/);
	});

	it("says what to do when there is no pull request to number", () => {
		expect(DEFAULT_PR_REVIEW_PROMPT).toMatch(/No pull request\?.*branch name/s);
	});

	it("is English-only, for the same reason the coordinator prompt is", () => {
		expect(DEFAULT_PR_REVIEW_PROMPT).not.toMatch(/[Ѐ-ӿ]/);
	});
});

describe("reviewTaskTitle", () => {
	it("reads as one sentence a human can scan on a card", () => {
		expect(reviewTaskTitle({ prNumber: 493, author: "Arseny Pavlenko", topic: "Pin tmux to a vendored keg" }))
			.toBe("Review of #493 from Arseny Pavlenko about Pin tmux to a vendored");
	});

	it("drops a clause it cannot fill instead of writing a placeholder", () => {
		expect(reviewTaskTitle({ prNumber: 12, author: null, topic: null })).toBe("Review of #12");
		expect(reviewTaskTitle({ branch: "feat/x", author: "Ann", topic: null })).toBe("Review of feat/x from Ann");
		expect(reviewTaskTitle({ prNumber: 12, author: null, topic: "Speed up boot" }))
			.toBe("Review of #12 about Speed up boot");
	});

	// "" is the signal that means "keep whatever title the task already has".
	it("returns nothing when it cannot even name what is under review", () => {
		expect(reviewTaskTitle({})).toBe("");
		expect(reviewTaskTitle({ branch: "  ", author: "Ann", topic: "x" })).toBe("");
	});

	it("prefers the pull request number over the branch", () => {
		expect(reviewTaskTitle({ prNumber: 7, branch: "feat/x" })).toBe("Review of #7");
	});
});

describe("reviewTitleTopic", () => {
	it("spends its five words on the change, not on ceremony", () => {
		expect(reviewTitleTopic("feat(remote): serve the board over a tunnel")).toBe("serve the board over a");
		expect(reviewTitleTopic("fix!: drop the shim")).toBe("drop the shim");
		expect(reviewTitleTopic("Pin tmux to a vendored keg (#493)")).toBe("Pin tmux to a vendored");
	});

	// A trailing "…" is this repo's marker for a title nobody has written yet, so a
	// condensed topic must never end in one.
	it("never ends in the unnamed-task ellipsis", () => {
		expect(reviewTitleTopic("one two three four five six seven")).not.toMatch(/…$/);
	});

	it("does not end on the punctuation that led into the words it dropped", () => {
		expect(reviewTitleTopic("fix: show branch-merged dialog only once, respect cancel"))
			.toBe("show branch-merged dialog only once");
		expect(reviewTitleTopic("Rework the parser and the — lexer")).toBe("Rework the parser and the");
	});

	it("survives blank and whitespace-only input", () => {
		expect(reviewTitleTopic(null)).toBe("");
		expect(reviewTitleTopic("   \n ")).toBe("");
		expect(reviewTitleTopic("feat:")).toBe("");
	});
});
