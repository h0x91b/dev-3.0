/**
 * The mandatory one-line subject of a `dev3 message`, and the error that teaches
 * a caller how to write one.
 *
 * Why it exists: the agent-traffic surfaces render one line per message, and
 * until now that line was the head of the body. Agents open their messages by
 * naming themselves and their task — the two things the row already shows — so
 * every row read as "…" and the reader learned nothing. The subject is the line
 * those surfaces show, so it is stored with the message rather than derived at
 * render time.
 *
 * The cap is on CHARACTERS, not words. "About six words" is real guidance but a
 * useless rule: six words of Russian and six words of English do not carry the
 * same meaning, and a word counter would reject honest subjects in one language
 * while waving through bloated ones in another. So the limit is a generous
 * character count, enforced hard, and the word count is advice in the help text.
 *
 * Over the limit is REJECTED, never truncated. A clipped subject is a sentence
 * the author did not write, and the whole point of the field is that a human
 * reads it later and trusts it. Rejection costs one retry; a silent clip costs
 * the meaning, invisibly.
 *
 * Pure and shared: the CLI validates locally (instant, no round trip) and the
 * app validates every socket send, so an older CLI that never learned the flag
 * gets the same explanation instead of quietly writing a subject-less row.
 */

/** Hard ceiling on a subject, in characters, after whitespace is collapsed. */
export const MAX_MESSAGE_SUBJECT_LENGTH = 80;

/** The advisory length quoted in help text and in the error. Not enforced. */
export const MESSAGE_SUBJECT_WORD_GUIDANCE = 6;

/** What is wrong with a rejected subject. */
export type MessageSubjectProblem = "missing" | "too-long";

export type MessageSubjectCheck =
	| { ok: true; subject: string }
	| { ok: false; problem: MessageSubjectProblem; subject: string };

/**
 * Collapse a subject to the single line it is. Newlines and runs of spaces are
 * normalised away — that is formatting, not meaning, and a stored subject with a
 * newline in it would break every row that renders it.
 */
export function normalizeMessageSubject(raw: unknown): string {
	return String(raw ?? "").replace(/\s+/g, " ").trim();
}

/** Validate a subject. Empty and whitespace-only are both `missing`. */
export function checkMessageSubject(raw: unknown): MessageSubjectCheck {
	const subject = normalizeMessageSubject(raw);
	if (!subject) return { ok: false, problem: "missing", subject: "" };
	if (subject.length > MAX_MESSAGE_SUBJECT_LENGTH) return { ok: false, problem: "too-long", subject };
	return { ok: true, subject };
}

/**
 * A leading address the sender wrote in front of its own message: `Seq 1722 ->`,
 * `#1141`, `Coordinator Seq 1141 (47205843) -`. This is exactly what made the
 * old body-derived rows useless, so a suggestion strips it before quoting the
 * caller's own words back at them.
 */
const ADDRESS_PREFIX_RE =
	/^[\s*_#>]*(?:coordinator|agent|task|seq)?[\s:]*(?:#|seq[:\s]*)?\d+(?:-\d+)?[\s]*(?:\([0-9a-f]{6,}\))?[\s]*(?:->|→|:|-|—|»|\|)\s*/i;

/** A bare label with no number: `Coordinator:`, `ACT:`. Stripped once, after the address. */
const LABEL_PREFIX_RE = /^(?:coordinator|agent|update|status|report)\s*(?:->|→|:|-|—)\s*/i;

/**
 * A starting point for a subject, taken from the message body itself.
 *
 * Deliberately modest: it strips the sender's self-address, then quotes the first
 * few words. It is offered as a suggestion and labelled as one — no summariser
 * runs in a CLI error path, and pretending otherwise would put a confident wrong
 * sentence in front of the caller. Returns "" when nothing usable survives.
 */
export function suggestMessageSubject(body: string): string {
	let rest = normalizeMessageSubject(body);
	for (let i = 0; i < 3; i += 1) {
		const stripped = rest.replace(ADDRESS_PREFIX_RE, "");
		if (stripped === rest || !stripped) break;
		rest = stripped;
	}
	rest = rest.replace(LABEL_PREFIX_RE, "") || rest;
	// Drop pseudo-XML and markdown scaffolding: an envelope tag is not a subject.
	rest = rest.replace(/^<[^>]*>\s*/, "").replace(/^[#*_`>\-\s]+/, "");
	if (!rest) return "";
	// Drop whole words until it fits. Never cut inside a word: a half-word
	// suggestion is a typo the caller would paste, and if even the first word is
	// over the cap there is nothing honest to suggest at all.
	const words = rest.split(" ").slice(0, MESSAGE_SUBJECT_WORD_GUIDANCE);
	while (words.length > 0 && words.join(" ").length > MAX_MESSAGE_SUBJECT_LENGTH) words.pop();
	// A cut at a fixed word count often lands on a dangling short function word
	// ("… PR 1577 is"), which reads as a broken sentence rather than a suggestion.
	if (words.length > 2 && words[words.length - 1]!.length <= 3) words.pop();
	return words.join(" ").replace(/[\s,;:.!\-–—]+$/, "").trim();
}

/** Longest body still safe to paste back into the corrected command, verbatim. */
const QUOTABLE_BODY_LENGTH = 60;

/**
 * The runnable command the caller should have typed.
 *
 * The body is quoted verbatim only while it is short enough to be the whole
 * message. A truncated body inside a copy-pasteable command is a trap — running
 * it would send half the message — so a long one becomes an obvious placeholder.
 */
export function correctedMessageCommand(opts: { flags: string; subject: string; body: string }): string {
	const body = normalizeMessageSubject(opts.body);
	const quoted = body.length > 0 && body.length <= QUOTABLE_BODY_LENGTH ? body : "<your text>";
	const flags = opts.flags ? `${opts.flags} ` : "";
	const subject = opts.subject || "what this is about";
	return `dev3 message ${flags}--subject "${escapeQuotes(subject)}" "${escapeQuotes(quoted)}"`;
}

function escapeQuotes(text: string): string {
	return text.replace(/"/g, '\\"');
}

/**
 * The error a caller sees. Two parts, matching the CLI's `error: <headline>` plus
 * indented detail shape, so the app and the CLI can print the identical text.
 *
 * `flags` is the target part of the command the caller already got right
 * (`--task seq:1141`, `--in 30m`) so the corrected command is theirs, not a
 * generic one. `note` carries a caller-specific line, e.g. the app telling an
 * older CLI to update.
 */
export function messageSubjectError(opts: {
	problem: MessageSubjectProblem;
	body: string;
	flags?: string;
	subject?: string;
	note?: string;
}): { message: string; detail: string } {
	const suggestion = suggestMessageSubject(opts.body);
	const command = correctedMessageCommand({
		flags: opts.flags ?? "",
		subject: opts.problem === "missing" ? suggestion : "",
		body: opts.body,
	});
	const lines: string[] = [];

	if (opts.problem === "too-long") {
		lines.push(
			`A subject is one line — about ${MESSAGE_SUBJECT_WORD_GUIDANCE} words. Nothing is shortened for you:`,
			"a clipped subject is a sentence you did not write, so send a shorter one instead.",
			"",
			`Yours (${(opts.subject ?? "").length} chars): "${opts.subject ?? ""}"`,
		);
	} else {
		lines.push(
			"Every message now carries a subject: one line saying what it is about.",
			"It is stored with the message and it is the line the agent-traffic view shows,",
			"so a message without one cannot be told apart from any other.",
		);
	}

	lines.push(
		"",
		`Write about ${MESSAGE_SUBJECT_WORD_GUIDANCE} words, ${MAX_MESSAGE_SUBJECT_LENGTH} characters at most.`,
		"Do NOT repeat who is talking — the row already shows the pair, e.g. #1722 → #1141.",
		'  good:  --subject "PR 1577 merged, main green"',
		'  bad:   --subject "Seq 1722 -> Coordinator: PR 1577 merged"',
	);

	if (opts.problem === "missing" && suggestion) {
		lines.push("", `Suggested from your own text (check it, it is only a starting point): "${suggestion}"`);
	}
	if (opts.note) lines.push("", opts.note);
	lines.push("", "Run this instead:", `  ${command}`);

	const message =
		opts.problem === "too-long"
			? `--subject is too long: ${(opts.subject ?? "").length} characters, and the limit is ${MAX_MESSAGE_SUBJECT_LENGTH}`
			: "dev3 message needs --subject: one line saying what this message is about";
	return { message, detail: lines.join("\n") };
}

/**
 * Validate a subject arriving over the CLI socket and return it, or throw the
 * readable error. The app's half of the gate: an older `dev3` binary that never
 * learned the flag must be told what to do, not silently obeyed.
 */
export function requireMessageSubject(raw: unknown, body: string): string {
	const check = checkMessageSubject(raw);
	if (check.ok) return check.subject;
	const { message, detail } = messageSubjectError({
		problem: check.problem,
		body,
		flags: "--task seq:<N>",
		subject: check.subject,
		note:
			check.problem === "missing"
				? "If your `dev3` CLI has no --subject flag at all, it is older than the app: run `dev3 update`."
				: undefined,
	});
	throw new Error(`${message}\n${detail}`);
}
