#!/usr/bin/env bun
/**
 * What dev3-launched Claude Code sessions cost, and which part of that dev3 itself
 * put there. Reads the local transcripts (~/.claude/projects, honouring
 * CLAUDE_CONFIG_DIR) of dev3 task worktrees only; nothing leaves the machine.
 *
 * Costs are API-equivalent, priced by `src/shared/agent-pricing.ts` per billing
 * type (uncached input, 5 m / 1 h cache writes, cache reads, output), so a change
 * is judged per task and per billing type rather than by raw token counts.
 *
 * Run: `bun run measure:agent-token-cost [--days 14] [--only <substring>]
 *       [--compact-at 400000] [--json <path>]`.
 * `--only` keeps transcript dirs whose name contains the substring (e.g.
 * `src-shared-dev-3-0-` for the dev-3.0 board).
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveModelRate, type ModelRate } from "../src/shared/agent-pricing";

/** Measured on dev3 transcripts by regressing first-request context tokens on the
 *  visible characters of the system prompt and first-turn attachments. */
export const CHARS_PER_TOKEN = 3.13;

/** A request re-wrote the conversation instead of reading it: it read less than
 *  half of what the previous request held and wrote more than half of it. */
const REWRITE_SHARE = 0.5;
const IDLE_TTL_MINUTES = 60;

export type SessionKind = "lead" | "teammate" | "subagent";

export type Trigger = "human" | "agent-message" | "teammate" | "tool-result" | "other";

export interface RequestUsage {
	ts: number;
	model: string;
	input: number;
	write5m: number;
	write1h: number;
	read: number;
	output: number;
	/** What the model was answering: the entry that came right before the request. */
	trigger: Trigger;
	/** Every tool call of this request is dev3 bookkeeping (overview, note, label …). */
	bookkeepingOnly: boolean;
}

export interface SessionTrace {
	kind: SessionKind;
	requests: RequestUsage[];
	/** Characters per static-prefix source, as sent with the session's first request. */
	staticChars: Record<string, number>;
}

export interface BillingUsd {
	input: number;
	write5m: number;
	write1h: number;
	read: number;
	output: number;
}

const DEV3_SHIPPED_SKILLS = /^- (dev3|ask-dev3|dev3-[a-z-]+|low-battery(:low-battery)?):/;
const BOOKKEEPING = /\bdev3 (overview|note|label|notify|attention|current|ui state|task update|task move)\b/;

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b) => (typeof b?.text === "string" ? b.text : typeof b?.content === "string" ? b.content : "")).join("");
}

function triggerOf(text: string): Trigger {
	if (text.includes("<dev3-ai-message")) return "agent-message";
	if (text.includes("<teammate-message")) return "teammate";
	return "human";
}

function classifyStatic(add: (source: string, chars: number) => void, attachment: any, rendered: string): void {
	switch (attachment?.type) {
		case "prompt_snapshot":
			for (const block of attachment.systemPrompt ?? []) {
				const text = String(block);
				add(text.startsWith("# dev3 — ") ? "dev3 protocol (system prompt)" : "Claude Code system prompt", text.length);
			}
			return;
		case "instructions":
			for (const part of rendered.split(/(?=Contents of \/)/)) {
				const path = part.match(/^Contents of (\S+)/)?.[1] ?? "";
				const source = /MEMORY\.md/.test(path)
					? "auto-memory MEMORY.md"
					: /\/worktree\/(CLAUDE|AGENTS)\.md/.test(path)
						? "repo CLAUDE.md / AGENTS.md"
						: path.startsWith(join(homedir(), ".claude"))
							? "user ~/.claude instructions"
							: "other instructions";
				add(source, part.length);
			}
			return;
		case "skill_listing": {
			let dev3 = 0;
			for (const line of rendered.split("\n")) if (DEV3_SHIPPED_SKILLS.test(line)) dev3 += line.length + 1;
			add("skill listing: dev3-shipped skills", dev3);
			add("skill listing: other skills", rendered.length - dev3);
			return;
		}
		case "output_style_instructions":
			add("output style", rendered.length);
			return;
		case "agent_listing_delta":
			add("agent-type listing", rendered.length);
			return;
		default:
			add("other first-turn context", rendered.length);
	}
}

/** Parse one Claude Code transcript (JSONL text). Pure: no fs. */
export function parseTranscript(text: string, isSubagent: boolean): SessionTrace {
	const requests: RequestUsage[] = [];
	const staticChars: Record<string, number> = {};
	const add = (source: string, chars: number) => {
		if (chars > 0) staticChars[source] = (staticChars[source] ?? 0) + chars;
	};
	const seen = new Map<string, RequestUsage>();
	let kind: SessionKind = isSubagent ? "subagent" : "lead";
	let firstUser = true;
	let trigger: Trigger = "human";
	for (const line of text.split("\n")) {
		if (!line) continue;
		let e: any;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e.type === "user") {
			const content = e.message?.content;
			if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) {
				trigger = "tool-result";
			} else if (!e.isMeta) {
				const t = contentText(content);
				trigger = triggerOf(t);
				if (firstUser && !isSubagent && t.startsWith("<teammate-message")) kind = "teammate";
				firstUser = false;
			}
			continue;
		}
		if (e.type === "attachment") {
			if (e.attachment?.type === "queued_command") {
				trigger = triggerOf(JSON.stringify(e.rendered ?? e.attachment));
			} else if (requests.length === 0) {
				classifyStatic(add, e.attachment, (e.rendered ?? []).map((r: any) => r?.content ?? "").join(""));
			}
			continue;
		}
		if (e.type !== "assistant") continue;
		const message = e.message;
		const usage = message?.usage;
		if (!usage || message.model === "<synthetic>") continue;
		const key = `${message.id}:${e.requestId ?? ""}`;
		const tools = (message.content ?? []).filter((b: any) => b?.type === "tool_use");
		const bookkeeping = tools.length > 0 && tools.every((b: any) => b.name === "Bash" && BOOKKEEPING.test(String(b.input?.command ?? "")));
		const known = seen.get(key);
		if (known) {
			// One API response is logged as one line per content block.
			known.bookkeepingOnly = known.bookkeepingOnly && (tools.length === 0 || bookkeeping);
			continue;
		}
		const split = usage.cache_creation ?? {};
		const write1h = split.ephemeral_1h_input_tokens ?? 0;
		const write5m = Math.max(split.ephemeral_5m_input_tokens ?? 0, (usage.cache_creation_input_tokens ?? 0) - write1h);
		const req: RequestUsage = {
			ts: Date.parse(e.timestamp),
			model: message.model,
			input: usage.input_tokens ?? 0,
			write5m,
			write1h,
			read: usage.cache_read_input_tokens ?? 0,
			output: usage.output_tokens ?? 0,
			trigger,
			bookkeepingOnly: bookkeeping,
		};
		seen.set(key, req);
		requests.push(req);
	}
	return { kind, requests, staticChars };
}

export function contextTokens(r: RequestUsage): number {
	return r.input + r.write5m + r.write1h + r.read;
}

export function billingUsd(r: RequestUsage, rate: ModelRate): BillingUsd {
	const m = 1e6;
	return {
		input: (r.input * rate.input) / m,
		write5m: (r.write5m * rate.cacheWrite5m) / m,
		write1h: (r.write1h * rate.cacheWrite1h) / m,
		read: (r.read * rate.cacheRead) / m,
		output: (r.output * rate.output) / m,
	};
}

function sumUsd(b: BillingUsd): number {
	return b.input + b.write5m + b.write1h + b.read + b.output;
}

/** The request threw the cached conversation away and wrote it again. */
export function isFullRewrite(r: RequestUsage, prev: RequestUsage | undefined): boolean {
	if (!prev) return false;
	const prevCtx = contextTokens(prev);
	return r.read < REWRITE_SHARE * prevCtx && r.write5m + r.write1h > REWRITE_SHARE * prevCtx;
}

export interface TaskSessions {
	task: string;
	sessions: SessionTrace[];
}

export interface CostReport {
	requests: number;
	tasks: number;
	sessionsByKind: Record<SessionKind, number>;
	usdByKind: Record<SessionKind, number>;
	tokens: Record<keyof BillingUsd, number>;
	usd: BillingUsd;
	total: number;
	perTaskUsd: number[];
	rewrites: Record<string, { count: number; usd: number }>;
	bookkeeping: { requests: number; usd: number };
	staticSources: Record<string, { medianTokens: number; usd: number }>;
	contextBuckets: Array<{ from: number; to: number; requests: number; usd: number }>;
}

const BUCKETS = [0, 100e3, 200e3, 300e3, 400e3, 600e3, 800e3, Number.POSITIVE_INFINITY];

function median(values: number[]): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[sorted.length >> 1];
}

export function summarize(tasks: TaskSessions[], rateOf: (model: string) => ModelRate | null = resolveModelRate): CostReport {
	const usd: BillingUsd = { input: 0, write5m: 0, write1h: 0, read: 0, output: 0 };
	const tokens = { input: 0, write5m: 0, write1h: 0, read: 0, output: 0 };
	const sessionsByKind = { lead: 0, teammate: 0, subagent: 0 };
	const usdByKind = { lead: 0, teammate: 0, subagent: 0 };
	const rewrites: CostReport["rewrites"] = {};
	const bookkeeping = { requests: 0, usd: 0 };
	const staticUsd: Record<string, number> = {};
	const staticTokens: Record<string, number[]> = {};
	const contextBuckets = BUCKETS.slice(1).map((to, i) => ({ from: BUCKETS[i], to, requests: 0, usd: 0 }));
	const perTaskUsd: number[] = [];
	let requests = 0;
	for (const task of tasks) {
		let taskUsd = 0;
		for (const session of task.sessions) {
			sessionsByKind[session.kind]++;
			for (const [source, chars] of Object.entries(session.staticChars)) {
				(staticTokens[source] ??= []).push(chars / CHARS_PER_TOKEN);
			}
			session.requests.forEach((r, i) => {
				const rate = rateOf(r.model);
				if (!rate) return;
				requests++;
				const b = billingUsd(r, rate);
				const cost = sumUsd(b);
				for (const k of Object.keys(usd) as (keyof BillingUsd)[]) usd[k] += b[k];
				tokens.input += r.input;
				tokens.write5m += r.write5m;
				tokens.write1h += r.write1h;
				tokens.read += r.read;
				tokens.output += r.output;
				taskUsd += cost;
				usdByKind[session.kind] += cost;
				const bucket = contextBuckets.find((x) => contextTokens(r) < x.to)!;
				bucket.requests++;
				bucket.usd += cost;
				if (r.bookkeepingOnly) {
					bookkeeping.requests++;
					bookkeeping.usd += cost;
				}
				const prev = session.requests[i - 1];
				if (isFullRewrite(r, prev)) {
					const idle = (r.ts - prev.ts) / 60000 > IDLE_TTL_MINUTES ? "idle > 60 min" : "idle < 60 min";
					const cause = r.model !== prev.model ? "model switch" : `${idle}, woken by ${r.trigger}`;
					const slot = (rewrites[cause] ??= { count: 0, usd: 0 });
					slot.count++;
					slot.usd += b.write5m + b.write1h + b.input;
				}
				// A static source is read with every request and re-written with the prefix.
				const prefixMiss = i === 0 || isFullRewrite(r, prev);
				const perToken = (prefixMiss ? rate.cacheWrite1h : rate.cacheRead) / 1e6;
				for (const [source, chars] of Object.entries(session.staticChars)) {
					staticUsd[source] = (staticUsd[source] ?? 0) + (chars / CHARS_PER_TOKEN) * perToken;
				}
			});
		}
		perTaskUsd.push(taskUsd);
	}
	const staticSources: CostReport["staticSources"] = {};
	for (const source of Object.keys(staticUsd)) {
		staticSources[source] = { medianTokens: Math.round(median(staticTokens[source] ?? [])), usd: staticUsd[source] };
	}
	return {
		requests,
		tasks: tasks.length,
		sessionsByKind,
		usdByKind,
		tokens,
		usd,
		total: sumUsd(usd),
		perTaskUsd,
		rewrites,
		bookkeeping,
		staticSources,
		contextBuckets,
	};
}

/**
 * Upper-bound estimate of an earlier auto-compaction: whenever a session's context
 * would exceed `threshold`, pay one read of it plus a `summaryTokens` summary and
 * restart from the session's first-request prefix plus that summary. It cannot see
 * the files an agent re-reads after a compaction, so real savings are lower.
 */
export function simulateCompaction(
	tasks: TaskSessions[],
	threshold: number,
	summaryTokens = 3000,
	rateOf: (model: string) => ModelRate | null = resolveModelRate,
): { actual: number; simulated: number; compactions: number } {
	let actual = 0;
	let simulated = 0;
	let compactions = 0;
	for (const task of tasks) {
		for (const session of task.sessions) {
			if (session.kind === "subagent" || !session.requests.length) continue;
			const prefix = contextTokens(session.requests[0]);
			// After a compaction the first-turn context is sent again; only the part the
			// session's first request already found in the cache stays a read.
			const rewrittenPrefix = prefix - session.requests[0].read;
			let removed = 0;
			session.requests.forEach((r, i) => {
				const rate = rateOf(r.model);
				if (!rate) return;
				const m = 1e6;
				actual += sumUsd(billingUsd(r, rate));
				const ctx = contextTokens(r);
				removed = Math.min(removed, Math.max(0, ctx - prefix));
				let extra = 0;
				if (ctx - removed > threshold) {
					const restart = prefix + summaryTokens;
					extra = ((ctx - removed) * rate.cacheRead + summaryTokens * rate.output + (rewrittenPrefix + summaryTokens) * rate.cacheWrite1h) / m;
					removed = ctx - restart;
					compactions++;
				}
				const rewrite = i === 0 || isFullRewrite(r, session.requests[i - 1]);
				const read = rewrite ? r.read : Math.max(0, r.read - removed);
				const w1 = rewrite ? Math.max(0, r.write1h - removed) : r.write1h;
				const w5 = rewrite ? Math.max(0, r.write5m - Math.max(0, removed - r.write1h)) : r.write5m;
				simulated += sumUsd(billingUsd({ ...r, read, write1h: w1, write5m: w5 }, rate)) + extra;
			});
		}
	}
	return { actual, simulated, compactions };
}

function pct(part: number, whole: number): string {
	return whole ? `${((100 * part) / whole).toFixed(1)}%` : "-";
}

function usdText(v: number): string {
	return `$${v.toFixed(v < 10 ? 2 : 0)}`;
}

function table(rows: string[][]): string {
	const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
	return rows.map((r) => r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join("  ")).join("\n");
}

export function formatReport(report: CostReport, days: number): string {
	const t = report.total;
	const sorted = [...report.perTaskUsd].sort((a, b) => a - b);
	const out: string[] = [];
	out.push(`dev3 task sessions, last ${days} days: ${report.tasks} tasks, ${report.requests} requests, ${usdText(t)} API-equivalent`);
	out.push(
		`per task: median ${usdText(median(sorted))}, p90 ${usdText(sorted[Math.floor(sorted.length * 0.9)] ?? 0)}, mean ${usdText(t / Math.max(1, report.tasks))}`,
	);
	out.push("", "By billing type");
	const names: Record<keyof BillingUsd, string> = { input: "uncached input", write5m: "cache write 5m", write1h: "cache write 1h", read: "cache read", output: "output" };
	out.push(
		table([
			["type", "tokens", "usd", "share"],
			...(Object.keys(names) as (keyof BillingUsd)[]).map((k) => [names[k], String(report.tokens[k]), usdText(report.usd[k]), pct(report.usd[k], t)]),
		]),
	);
	out.push("", "By session kind");
	out.push(
		table([
			["kind", "sessions", "usd", "share"],
			...(["lead", "teammate", "subagent"] as SessionKind[]).map((k) => [k, String(report.sessionsByKind[k]), usdText(report.usdByKind[k]), pct(report.usdByKind[k], t)]),
		]),
	);
	out.push("", "Static prefix, by source (re-read on every request)");
	out.push(
		table([
			["source", "median tokens", "usd", "share"],
			...Object.entries(report.staticSources)
				.sort((a, b) => b[1].usd - a[1].usd)
				.map(([k, v]) => [k, String(v.medianTokens), usdText(v.usd), pct(v.usd, t)]),
		]),
	);
	out.push("", "Full-context cache re-writes, by cause");
	out.push(
		table([
			["cause", "count", "usd", "share"],
			...Object.entries(report.rewrites)
				.sort((a, b) => b[1].usd - a[1].usd)
				.map(([k, v]) => [k, String(v.count), usdText(v.usd), pct(v.usd, t)]),
		]),
	);
	out.push("", `Requests that only did dev3 bookkeeping: ${report.bookkeeping.requests}, ${usdText(report.bookkeeping.usd)} (${pct(report.bookkeeping.usd, t)})`);
	out.push("", "Spend by context size of the request");
	out.push(
		table([
			["context", "requests", "usd", "share"],
			...report.contextBuckets.map((b) => [`${b.from / 1e3}k–${Number.isFinite(b.to) ? `${b.to / 1e3}k` : "∞"}`, String(b.requests), usdText(b.usd), pct(b.usd, t)]),
		]),
	);
	return out.join("\n");
}

function claudeProjectsDir(): string {
	return join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "projects");
}

/** dev3 task worktree transcript dirs: `…-dev3-0-worktrees-…-<task8>-worktree`. */
export function taskIdOfProjectDir(name: string): string | null {
	if (!name.includes("-dev3-0-worktrees-")) return null;
	return name.match(/-([0-9a-f]{8})-worktree$/)?.[1] ?? null;
}

function loadTasks(days: number, only: string | undefined): TaskSessions[] {
	const root = claudeProjectsDir();
	const cutoff = Date.now() - days * 864e5;
	const byTask = new Map<string, SessionTrace[]>();
	const take = (path: string, task: string, sub: boolean) => {
		if (statSync(path).mtimeMs < cutoff) return;
		const trace = parseTranscript(readFileSync(path, "utf8"), sub);
		if (trace.requests.length) (byTask.get(task) ?? byTask.set(task, []).get(task)!).push(trace);
	};
	for (const dir of existsSync(root) ? readdirSync(root) : []) {
		const task = taskIdOfProjectDir(dir);
		if (!task || (only && !dir.includes(only))) continue;
		for (const entry of readdirSync(join(root, dir))) {
			const path = join(root, dir, entry);
			if (entry.endsWith(".jsonl")) take(path, task, false);
			const subagents = join(path, "subagents");
			if (existsSync(subagents)) for (const f of readdirSync(subagents)) if (f.endsWith(".jsonl")) take(join(subagents, f), task, true);
		}
	}
	return [...byTask].map(([task, sessions]) => ({ task, sessions }));
}

function argValue(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const days = Number(argValue(args, "--days") ?? 14);
	const tasks = loadTasks(days, argValue(args, "--only"));
	const report = summarize(tasks);
	console.log(formatReport(report, days));
	const compactAt = argValue(args, "--compact-at");
	if (compactAt) {
		const sim = simulateCompaction(tasks, Number(compactAt));
		console.log(
			`\nAuto-compaction at ${Number(compactAt) / 1e3}k (upper bound): ${usdText(sim.simulated)} instead of ${usdText(sim.actual)}, ` +
				`${pct(sim.simulated - sim.actual, sim.actual)}, ${sim.compactions} extra compactions`,
		);
	}
	const json = argValue(args, "--json");
	if (json) writeFileSync(json, JSON.stringify(report, null, 2));
}
