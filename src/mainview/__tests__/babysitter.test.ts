/**
 * PR Babysitter pure helpers: autonomy presets, capability overrides, and the
 * prompt composed from the knobs. The hard ceilings must survive every knob
 * combination — they are policy, not configuration.
 */
import { describe, expect, it } from "vitest";
import {
	BABYSITTER_AUTONOMY_PRESETS,
	babysitterEnabled,
	composeBabysitPrompt,
	DEFAULT_BABYSIT_PROMPT,
	effectiveBabysitterCapabilities,
} from "../../shared/types";

describe("babysitterEnabled", () => {
	it("defaults to enabled (read-only Triage) when config or autonomy is absent", () => {
		expect(babysitterEnabled(undefined)).toBe(true);
		expect(babysitterEnabled({})).toBe(true);
	});

	it("is disabled only by the explicit off opt-out", () => {
		expect(babysitterEnabled({ autonomy: "off" })).toBe(false);
	});

	it("is enabled for triage, fix, and land", () => {
		expect(babysitterEnabled({ autonomy: "triage" })).toBe(true);
		expect(babysitterEnabled({ autonomy: "fix" })).toBe(true);
		expect(babysitterEnabled({ autonomy: "land" })).toBe(true);
	});
});

describe("effectiveBabysitterCapabilities", () => {
	it("triage grants nothing", () => {
		expect(Object.values(BABYSITTER_AUTONOMY_PRESETS.triage).every((v) => v === false)).toBe(true);
	});

	it("fix grants push, reply, and rebase but not resolve/rerun/auto-merge", () => {
		expect(BABYSITTER_AUTONOMY_PRESETS.fix).toEqual({
			push: true,
			reply: true,
			resolve: false,
			rebase: true,
			rerunChecks: false,
			armAutoMerge: false,
		});
	});

	it("land grants everything", () => {
		expect(Object.values(BABYSITTER_AUTONOMY_PRESETS.land).every((v) => v === true)).toBe(true);
	});

	it("applies sparse overrides on top of the preset", () => {
		const caps = effectiveBabysitterCapabilities({ autonomy: "fix", overrides: { push: false, armAutoMerge: true } });
		expect(caps.push).toBe(false);
		expect(caps.armAutoMerge).toBe(true);
		expect(caps.reply).toBe(true);
	});

	it("defaults to the read-only triage preset when config is absent", () => {
		expect(effectiveBabysitterCapabilities(undefined)).toEqual(BABYSITTER_AUTONOMY_PRESETS.triage);
	});
});

describe("composeBabysitPrompt", () => {
	const HARD_LIMITS = [
		"Never merge the PR yourself",
		"--admin",
		"Never approve the PR",
		"Never edit CI configuration, tests, or timeouts",
		"Never touch a draft PR",
		"--force-with-lease is allowed only immediately after a legitimate rebase",
		"Reply to a review thread before resolving it",
	];

	it("keeps the hard ceilings in every knob combination", () => {
		const variants = [
			undefined,
			{ autonomy: "triage" as const },
			{ autonomy: "fix" as const, handleComments: false },
			{ autonomy: "land" as const, overrides: { push: false } },
		];
		for (const config of variants) {
			const prompt = composeBabysitPrompt(config);
			for (const limit of HARD_LIMITS) expect(prompt).toContain(limit);
		}
	});

	it("triage is read-only: forbids all GitHub writes and reports via task note", () => {
		const prompt = composeBabysitPrompt({ autonomy: "triage" });
		expect(prompt).toContain("read-only triage run");
		expect(prompt).toContain("Do NOT push commits");
		expect(prompt).toContain("Do NOT post comments");
		expect(prompt).toContain("Do NOT resolve review threads");
		expect(prompt).toContain("Do NOT rebase");
		expect(prompt).toContain("Do NOT enable auto-merge");
	});

	it("triage with comments on drafts replies into a task note instead of posting", () => {
		const prompt = composeBabysitPrompt({ autonomy: "triage", handleComments: true });
		expect(prompt).toContain("draft them all into a single task note");
	});

	it("without the reply capability, comments are always monitored — handleComments=false is ignored", () => {
		for (const config of [
			{ autonomy: "triage" as const, handleComments: false },
			{ autonomy: "fix" as const, overrides: { reply: false }, handleComments: false },
		]) {
			const prompt = composeBabysitPrompt(config);
			expect(prompt).toContain("Classify each one");
			expect(prompt).toContain("draft them all into a single task note");
		}
	});

	it("fix grants push/reply/rebase and keeps auto-merge forbidden", () => {
		const prompt = composeBabysitPrompt({ autonomy: "fix" });
		expect(prompt).toContain("You MAY fix problems in this worktree");
		expect(prompt).toContain("You MAY post replies");
		expect(prompt).toContain("rebase this worktree onto {baseBranch}");
		expect(prompt).toContain("Do NOT enable auto-merge");
		expect(prompt).not.toContain("read-only triage run");
	});

	it("land grants rerun and auto-merge arming", () => {
		const prompt = composeBabysitPrompt({ autonomy: "land" });
		expect(prompt).toContain("You MAY re-run a failed check");
		expect(prompt).toContain("gh pr merge --auto --squash --match-head-commit");
		expect(prompt).toContain("You MAY resolve review threads");
	});

	it("handleComments=false skips comment triage entirely", () => {
		const prompt = composeBabysitPrompt({ autonomy: "fix", handleComments: false });
		expect(prompt).toContain("Ignore review comments and conversation comments");
		expect(prompt).not.toContain("Classify each one");
	});

	it("handleComments defaults to on with the four-way triage taxonomy", () => {
		const prompt = composeBabysitPrompt({ autonomy: "fix" });
		for (const label of ["Agree", "Disagree", "Already fixed", "Defer"]) {
			expect(prompt).toContain(label);
		}
	});

	it("always instructs parking via user-questions when stuck", () => {
		for (const config of [undefined, { autonomy: "triage" as const }, { autonomy: "land" as const }]) {
			expect(composeBabysitPrompt(config)).toContain("dev3 task move --status user-questions");
		}
	});

	it("DEFAULT_BABYSIT_PROMPT equals the composition of the default knobs (triage)", () => {
		expect(DEFAULT_BABYSIT_PROMPT).toBe(composeBabysitPrompt());
		expect(DEFAULT_BABYSIT_PROMPT).toContain("read-only triage run");
	});
});
