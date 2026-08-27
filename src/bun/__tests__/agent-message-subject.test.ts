/**
 * The subject rules, and the error that teaches them.
 *
 * The error text is the deliverable here, not an implementation detail: every
 * agent that exists sends without a subject out of habit, so this message is what
 * they meet. Its parts are asserted individually so a rewrite that quietly drops
 * the example or the corrected command fails.
 */

import { describe, expect, it } from "vitest";
import {
	MAX_MESSAGE_SUBJECT_LENGTH,
	checkMessageSubject,
	correctedMessageCommand,
	messageSubjectError,
	normalizeMessageSubject,
	requireMessageSubject,
	suggestMessageSubject,
} from "../../shared/agent-message-subject";

describe("checkMessageSubject", () => {
	it("accepts an ordinary one-liner", () => {
		expect(checkMessageSubject("PR 1577 merged, main green")).toEqual({
			ok: true,
			subject: "PR 1577 merged, main green",
		});
	});

	it("collapses whitespace, newlines included", () => {
		expect(normalizeMessageSubject("  CI green\n\ton   main  ")).toBe("CI green on main");
		expect(checkMessageSubject(" one \n two ")).toEqual({ ok: true, subject: "one two" });
	});

	it("treats absent, empty and whitespace-only alike", () => {
		for (const raw of [undefined, null, "", "   ", "\n\t"]) {
			expect(checkMessageSubject(raw)).toEqual({ problem: "missing", ok: false, subject: "" });
		}
	});

	it("accepts exactly the limit and rejects one character more", () => {
		expect(checkMessageSubject("a".repeat(MAX_MESSAGE_SUBJECT_LENGTH)).ok).toBe(true);
		const over = checkMessageSubject("a".repeat(MAX_MESSAGE_SUBJECT_LENGTH + 1));
		expect(over.ok).toBe(false);
		expect(over).toMatchObject({ problem: "too-long" });
	});

	it("counts characters, not words — six words of Russian pass", () => {
		expect(checkMessageSubject("ребейз готов, шард три позеленел снова").ok).toBe(true);
	});

	it("does not reject a subject for having more than six words", () => {
		// The word count is guidance in the help text; only the character cap is a rule.
		expect(checkMessageSubject("one two three four five six seven eight nine ten").ok).toBe(true);
	});
});

describe("suggestMessageSubject", () => {
	it("strips the sender's own address, which is what made body rows useless", () => {
		expect(suggestMessageSubject("Seq 1722 -> Coordinator: PR 1577 merged, main green")).toBe(
			"PR 1577 merged, main green",
		);
		expect(suggestMessageSubject("#1141 → shard 3 finished with no failures")).toBe("shard 3 finished with no failures");
		expect(suggestMessageSubject("Coordinator Seq 1141 (47205843) - ACT on the review")).toBe("ACT on the review");
	});

	it("never cuts inside a word, and gives up when the first word is over the cap", () => {
		expect(suggestMessageSubject("x".repeat(MAX_MESSAGE_SUBJECT_LENGTH + 20))).toBe("");
	});

	it("drops a dangling short function word rather than ending mid-clause", () => {
		expect(suggestMessageSubject("CI VERDICT - PR 1577 is green")).toBe("CI VERDICT - PR 1577");
	});

	it("answers empty for a body with nothing in it", () => {
		expect(suggestMessageSubject("   ")).toBe("");
	});
});

describe("correctedMessageCommand", () => {
	it("quotes a short body verbatim, so the command actually runs", () => {
		expect(correctedMessageCommand({ flags: "--task seq:7", subject: "ci green", body: "ping" })).toBe(
			'dev3 message --task seq:7 --subject "ci green" "ping"',
		);
	});

	it("replaces a long body with a placeholder instead of a truncated one", () => {
		const command = correctedMessageCommand({ flags: "", subject: "s", body: "z".repeat(200) });
		expect(command).toContain('"<your text>"');
		expect(command).not.toContain("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz");
	});

	it("escapes quotes so the printed command stays one command", () => {
		expect(correctedMessageCommand({ flags: "", subject: 'say "hi"', body: "x" })).toContain('\\"hi\\"');
	});
});

describe("messageSubjectError", () => {
	it("says what is required, shows the limit, and shows a good and a bad example", () => {
		const { message, detail } = messageSubjectError({ problem: "missing", body: "ping", flags: "--task seq:7" });
		expect(message).toContain("needs --subject");
		expect(detail).toContain("Write about 6 words, 80 characters at most.");
		expect(detail).toContain('good:  --subject "PR 1577 merged, main green"');
		expect(detail).toContain('bad:   --subject "Seq 1722 -> Coordinator: PR 1577 merged"');
		expect(detail).toContain("Do NOT repeat who is talking");
		expect(detail).toContain("dev3 message --task seq:7 --subject");
	});

	it("labels the suggestion as a starting point, never as the answer", () => {
		const { detail } = messageSubjectError({ problem: "missing", body: "Seq 9 -> shard 3 went red again" });
		expect(detail).toContain("only a starting point");
		expect(detail).toContain('"shard 3 went red again"');
	});

	it("says an over-limit subject is not shortened, and gives its length back", () => {
		const subject = "a".repeat(95);
		const { message, detail } = messageSubjectError({ problem: "too-long", body: "x", subject });
		expect(message).toBe("--subject is too long: 95 characters, and the limit is 80");
		expect(detail).toContain("Nothing is shortened for you");
		expect(detail).toContain("Yours (95 chars)");
	});
});

describe("requireMessageSubject", () => {
	it("returns the normalised subject when it is fine", () => {
		expect(requireMessageSubject("  ci  green ", "body")).toBe("ci green");
	});

	it("throws the readable error, and tells an older CLI to update", () => {
		expect(() => requireMessageSubject(undefined, "ping")).toThrow(/needs --subject/);
		expect(() => requireMessageSubject(undefined, "ping")).toThrow(/dev3 update/);
	});

	it("throws on an over-limit subject too", () => {
		expect(() => requireMessageSubject("a".repeat(200), "ping")).toThrow(/too long/);
	});
});
