/**
 * Sanitizer for Windows capture journals.
 *
 * Fail-closed evidence policy for the spike:
 *  - Shell captures (cmd, pwsh) are deterministic probe output. They are emitted
 *    as a fixture ONLY when a secret/path/PII scan is clean; any hit downgrades
 *    the result to metrics-only so raw bytes never leave the machine.
 *  - Agent captures (Claude, Codex) never store raw transcript bytes. They are
 *    always reduced to a hash plus structural metrics, which is enough to prove
 *    startup, query handling, resize, detach, and clean exit without exposing
 *    credentials, prompts, repository data, or user paths.
 */

import { createHash } from "node:crypto";
import type { TerminalCaptureEvent } from "./terminal-state";
import {
	journalOutputByteLength,
	type RawSessionJournal,
} from "./session-journal";

interface SensitiveRule {
	category: string;
	pattern: RegExp;
}

// Detection only; values are never emitted, just their category names.
const SENSITIVE_RULES: SensitiveRule[] = [
	{ category: "windows-user-path", pattern: /[A-Za-z]:\\Users\\[^\\/\s"']+/i },
	{ category: "unc-path", pattern: /\\\\[A-Za-z0-9._-]+\\[^\s"']+/ },
	{ category: "unix-home-path", pattern: /\/(?:home|Users)\/[^/\s"']+/ },
	{ category: "openai-key", pattern: /sk-[A-Za-z0-9]{16,}/ },
	{ category: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/ },
	{ category: "aws-key", pattern: /AKIA[0-9A-Z]{16}/ },
	{ category: "slack-token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
	{ category: "bearer-token", pattern: /Bearer\s+[A-Za-z0-9._-]{12,}/ },
	{ category: "jwt", pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
	{ category: "long-hex-secret", pattern: /\b[0-9a-fA-F]{40,}\b/ },
	{ category: "private-key", pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
	{ category: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
];

export function scanSensitive(text: string): string[] {
	const found = new Set<string>();
	for (const rule of SENSITIVE_RULES) if (rule.pattern.test(text)) found.add(rule.category);
	return [...found].sort();
}

/** Replace sensitive substrings with `<category>` placeholders (for metadata). */
export function redactText(text: string): string {
	let result = text;
	for (const rule of SENSITIVE_RULES) {
		result = result.replace(new RegExp(rule.pattern.source, `g${rule.pattern.flags.replace("g", "")}`), `<${rule.category}>`);
	}
	return result;
}

function redactProvenance(journal: RawSessionJournal): RawSessionJournal {
	return {
		...journal,
		provenance: {
			...journal.provenance,
			command: redactText(journal.provenance.command),
			platform: redactText(journal.provenance.platform),
		},
	};
}

function decodeEventText(event: TerminalCaptureEvent): string {
	if (event.type !== "output") return "";
	return event.encoding === "base64"
		? new TextDecoder().decode(Uint8Array.from(Buffer.from(event.data, "base64")))
		: event.data;
}

function decodeEventBytes(event: TerminalCaptureEvent): Uint8Array {
	if (event.type !== "output") return new Uint8Array();
	return event.encoding === "base64"
		? Uint8Array.from(Buffer.from(event.data, "base64"))
		: new TextEncoder().encode(event.data);
}

function hashOutput(journal: RawSessionJournal): string {
	const hash = createHash("sha256");
	for (const event of journal.events) if (event.type === "output") hash.update(decodeEventBytes(event));
	return hash.digest("hex");
}

function decodedOutputText(journal: RawSessionJournal): string {
	return journal.events.map(decodeEventText).join("");
}

export interface SessionMetrics {
	schema: "dev3-windows-session-metrics";
	version: 1;
	target: string;
	kind: "shell" | "agent";
	sha256: string;
	outputByteLength: number;
	eventCount: number;
	outputEvents: number;
	resizeEvents: number;
	detachIndex: number;
	initial: RawSessionJournal["initial"];
	finalDimensions: RawSessionJournal["finalDimensions"];
	responderReplies: number;
	queryCounts: RawSessionJournal["queryCounts"];
	sensitiveCategories: string[];
	provenance: RawSessionJournal["provenance"];
}

export type SanitizeResult =
	| { mode: "fixture"; journal: RawSessionJournal; metrics: SessionMetrics; warnings: string[] }
	| { mode: "metrics"; metrics: SessionMetrics; warnings: string[] };

export function buildMetrics(journal: RawSessionJournal, sensitiveCategories: string[]): SessionMetrics {
	const outputEvents = journal.events.filter((event) => event.type === "output").length;
	return {
		schema: "dev3-windows-session-metrics",
		version: 1,
		target: journal.target,
		kind: journal.kind,
		sha256: hashOutput(journal),
		outputByteLength: journalOutputByteLength(journal),
		eventCount: journal.events.length,
		outputEvents,
		resizeEvents: journal.events.length - outputEvents,
		detachIndex: journal.detachIndex,
		initial: journal.initial,
		finalDimensions: journal.finalDimensions,
		responderReplies: journal.responderReplies,
		queryCounts: journal.queryCounts,
		sensitiveCategories,
		provenance: journal.provenance,
	};
}

/**
 * Decide how a journal may leave the machine. Agents are always metrics-only;
 * shells become fixtures only when the sensitive scan is clean.
 */
export function sanitizeJournal(journal: RawSessionJournal): SanitizeResult {
	const sensitiveCategories = scanSensitive(decodedOutputText(journal));
	const safe = redactProvenance(journal);
	const metrics = buildMetrics(safe, sensitiveCategories);
	const warnings: string[] = [];
	if (journal.kind === "agent") {
		return { mode: "metrics", metrics, warnings };
	}
	if (sensitiveCategories.length > 0) {
		warnings.push(
			`Shell capture "${journal.target}" contained ${sensitiveCategories.join(", ")}; ` +
				"downgraded to metrics-only. Fix the probe to emit deterministic, non-sensitive output.",
		);
		return { mode: "metrics", metrics, warnings };
	}
	return { mode: "fixture", journal: safe, metrics, warnings };
}
