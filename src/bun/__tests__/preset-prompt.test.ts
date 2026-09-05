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

	// The seq alone is the name, because the board block now supplies it on every
	// turn. Only a task whose seq a live variant sibling still shares needs the id
	// — that is the one case where `--task seq:N` does not resolve.
	it("requires a task to be named by its number, and a shared seq by its id too", () => {
		expect(COORDINATOR_PROMPT).toContain("NAME EVERY TASK BY ITS NUMBER");
		expect(COORDINATOR_PROMPT).toContain("Seq NNNN");
		expect(COORDINATOR_PROMPT).toContain("seq:NNNN:index (id)");
	});

	// Anthropic's safeguards refuse this prompt outright (`[reasoning_extraction]`)
	// when it pairs "reason in full in your thinking" with "send only the conclusion" —
	// see decisions/2026/08/30/coordinator-prompt-reasoning-extraction-refusal.md.
	it("never pairs the thinking channel with a send-only-the-conclusion instruction", () => {
		expect(COORDINATOR_PROMPT).toContain("belongs in your thinking");
		expect(COORDINATOR_PROMPT).not.toMatch(/(?:send|carries)[^.]*conclusion alone/i);
	});

	it("keeps the four rules that were learned from a specific failure", () => {
		expect(COORDINATOR_PROMPT).toContain("RELAY THE RULING, NOT YOUR READING OF IT");
		expect(COORDINATOR_PROMPT).toContain("NEVER ATTRIBUTE WORDS THE USER DID NOT SAY");
		expect(COORDINATOR_PROMPT).toContain("PERMISSION DOES NOT TRAVEL");
		expect(COORDINATOR_PROMPT).toContain("ANNOUNCE A REVERSAL AS A REVERSAL");
	});

	// The board used to be a snapshot the coordinator had to refresh by hand; it
	// now rides in on the messages dev3 delivers. The rule that replaced it must
	// point at the block AND name every gap, or it trades one stale answer for
	// a confidently stale one.
	it("points the coordinator at the delivered board instead of a manual re-read", () => {
		expect(COORDINATOR_PROMPT).toContain("<dev3-board>");
		// Spending a turn on what the block already said is the waste this exists to stop.
		expect(COORDINATOR_PROMPT).toMatch(/do not spend a turn on `dev3 task list`/);
	});

	// The gap that matters most: the user types straight into the pane, which no
	// delivery seam sees, so his turn carries no block at all.
	it("warns that the user's own message brings no board", () => {
		expect(COORDINATOR_PROMPT).toMatch(/user typing to you directly brings NO block/);
		expect(COORDINATOR_PROMPT).toMatch(/re-read the board before you answer/);
	});

	it("keeps the long-turn and no-harness fallbacks", () => {
		expect(COORDINATOR_PROMPT).toMatch(/turn has run long/);
		expect(COORDINATOR_PROMPT).toMatch(/no block at all/);
	});

	// A quiet time is not a screen: peek stays the only way to see what a child
	// is actually doing, and conflating the two would retire it by accident.
	it("keeps peek as the way to see what a child is doing", () => {
		expect(COORDINATOR_PROMPT).toMatch(/`dev3 peek` is still the only way/);
	});

	// `dev3 events` (Seq 1738) is a POSITION, not a feed: a coordinator that reads
	// it as "the last couple of hours" loses exactly the stretch it was away for.
	// Each assertion below pins one half of that contract.
	it("makes the events read part of composing a status, with no timer behind it", () => {
		expect(COORDINATOR_PROMPT).toContain("dev3 events");
		expect(COORDINATOR_PROMPT).toMatch(/Read events BEFORE composing any substantive status/);
		expect(COORDINATOR_PROMPT).toMatch(/never a timer, hook, wake-up or poll/);
	});

	it("starts from the saved cursor and advances only the one the run returned", () => {
		expect(COORDINATOR_PROMPT).toContain("START AT YOUR SAVED CURSOR");
		expect(COORDINATOR_PROMPT).toContain("dev3 events --from <cursor>");
		expect(COORDINATOR_PROMPT).toContain("ADVANCE THE CURSOR ONLY AFTER CONSUMING WHAT CAME BACK");
		expect(COORDINATOR_PROMPT).toMatch(/store the one the run returned, not one you composed/);
	});

	// The two ways a coordinator silently under-reads: bootstrapping without saying
	// what was cut off, and papering over a lost cursor with a short window.
	it("bootstraps a bounded window openly and refuses a relative window as a substitute", () => {
		expect(COORDINATOR_PROMPT).toMatch(/NO CURSOR YET\?/);
		expect(COORDINATOR_PROMPT).toMatch(/bounded WINDOW, not a position/);
		expect(COORDINATOR_PROMPT).toMatch(/rather than implying you read everything/);
		expect(COORDINATOR_PROMPT).toContain("A LOST CURSOR IS NEVER REPLACED BY `--from 2h`");
	});

	// `dev3 note show` defaults to the CALLER's task, so an event's note needs the
	// owning task named — without it a coordinator searches its own notes and gets
	// "Note not found" for a note that exists.
	it("drains every capped page and opens the notes that matter in full", () => {
		expect(COORDINATOR_PROMPT).toContain("DRAIN THE PAGES");
		expect(COORDINATOR_PROMPT).toMatch(/Capped at --limit[\s\S]*until nothing is capped/);
		expect(COORDINATOR_PROMPT).toContain("dev3 note show <id> --task seq:");
		// Scoped to NOTE rows: another kind's event id is not a note id at all.
		expect(COORDINATOR_PROMPT).toMatch(/open a NOTE row in full/);
		expect(COORDINATOR_PROMPT).toMatch(/another kind's id is not a note/);
	});

	it("never reports a failed read as a quiet board", () => {
		expect(COORDINATOR_PROMPT).toContain("A FAILED READ IS NOT A QUIET BOARD");
		expect(COORDINATOR_PROMPT).toMatch(/keep the old cursor/);
	});

	// Events and the board answer different questions. The prompt must not name the
	// kinds itself: v1 records notes only, Seq 1675 is adding board movements, and a
	// hardcoded list here would be false the day it lands — so it points at the CLI's
	// own help, which is generated from the build the coordinator is actually running.
	it("keeps events complementary to the board and sources the kinds from the CLI", () => {
		expect(COORDINATOR_PROMPT).toContain("EVENTS AND THE BOARD ARE COMPLEMENTARY");
		expect(COORDINATOR_PROMPT).toMatch(/`dev3 events --help` names the kinds this build records/);
		expect(COORDINATOR_PROMPT).not.toMatch(/--kind (all|note|move)\b/);
	});

	it("bans repeating a status the user already has, acknowledgements included", () => {
		expect(COORDINATOR_PROMPT).toContain("NEVER REPEAT A STATUS THE USER ALREADY HAS");
		expect(COORDINATOR_PROMPT).toMatch(/a short acknowledgement included/);
		expect(COORDINATOR_PROMPT).toMatch(/Cursors, page counts and opened notes stay in your reasoning/);
	});

	// This preamble is prepended to a coordinator task's DESCRIPTION, which travels
	// on the command line for every agent that does not get a prompt file, so its
	// length is launch capacity spent (`agent-command-line-budget.ts`) — and it is
	// already over the 5 000-character reserve, which nothing enforces on input.
	//
	// 6 210 is not a round number: it is what this prompt measured BEFORE the events
	// block was added. Adding the block cost 1 700 characters and the rest of the
	// prompt was condensed to pay for all of them, so no coordinator task that
	// launched before stops launching. The cap keeps that property: a new section
	// is paid for out of existing prose, never out of the user's task description.
	it("costs no more launch capacity than it did before the events block", () => {
		expect(COORDINATOR_PROMPT.length).toBeLessThanOrEqual(6210);
	});

	it("never assumes the user's gender — it ships to every install as the default", () => {
		expect(COORDINATOR_PROMPT).not.toMatch(/\b(he|him|his|she|her|hers)\b/i);
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

	it("ranks findings in the same three buckets the overview counts", () => {
		expect(DEFAULT_PR_REVIEW_PROMPT).toContain("blocker, worth fixing,");
		expect(DEFAULT_PR_REVIEW_PROMPT).toContain("nitpick");
		expect(DEFAULT_PR_REVIEW_PROMPT).toContain("`file:line`");
	});

	it("keeps the review off GitHub and puts it in a note that outlives the worktree", () => {
		expect(DEFAULT_PR_REVIEW_PROMPT).toContain("never on GitHub");
		expect(DEFAULT_PR_REVIEW_PROMPT).toContain("dev3 note add");
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
