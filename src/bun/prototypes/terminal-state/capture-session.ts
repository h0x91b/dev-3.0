#!/usr/bin/env bun
/**
 * Scripted live PTY capture for the Windows shell/agent matrix.
 *
 * Extends the raw single-frame capture with a scripted timeline: waits, scripted
 * input, mid-session resizes, and a single detach boundary. Output chunks and
 * resize events are recorded in real order into a session journal. When query
 * responses are enabled, a static (non-Ghostty) responder answers DSR/DA/mode
 * probes inside the data callback and writes replies back to the PTY, keeping
 * Ghostty out of the Bun 1.3.14 Windows callback (decision 146).
 */

import { spawn } from "../../spawn";
import { TerminalQueryResponder } from "./terminal-query-responder";
import type { RawSessionJournal, SessionProvenance } from "./session-journal";
import type { TerminalCaptureEvent } from "./terminal-state";

export type SessionStep =
	| { type: "wait"; ms: number }
	| { type: "input"; data: string }
	| { type: "resize"; cols: number; rows: number }
	| { type: "detach" };

export interface CaptureSessionSpec {
	target: string;
	kind: "shell" | "agent";
	command: string[];
	/** Generic provenance label; avoids leaking absolute paths from `command`. */
	commandLabel?: string;
	cwd: string;
	cols: number;
	rows: number;
	respondToQueries?: boolean;
	script: SessionStep[];
	/** Hard cap; the child is killed if it outlives the script by this long. */
	exitGraceMs?: number;
	platform: string;
	capturedAt: string;
}

interface PtyTerminal {
	write(data: string | Uint8Array): void;
	resize(cols: number, rows: number): void;
	close?(): void;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function captureSession(spec: CaptureSessionSpec): Promise<RawSessionJournal> {
	const events: TerminalCaptureEvent[] = [];
	const responder = spec.respondToQueries
		? new TerminalQueryResponder(spec.cols, spec.rows)
		: undefined;
	let responderReplies = 0;
	let detachIndex = -1;
	let finalDimensions = { cols: spec.cols, rows: spec.rows };

	let child: ReturnType<typeof spawn> | undefined;
	child = spawn(spec.command, {
		cwd: spec.cwd,
		env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
		terminal: {
			cols: spec.cols,
			rows: spec.rows,
			data(_terminal: unknown, bytes: Uint8Array) {
				events.push({
					type: "output",
					encoding: "base64",
					data: Buffer.from(bytes).toString("base64"),
				});
				if (!responder) return;
				responder.ingest(bytes);
				const replies = responder.takeResponses();
				const terminal = child?.terminal as PtyTerminal | undefined;
				for (const reply of replies) {
					terminal?.write(reply);
					responderReplies += 1;
				}
			},
		},
	});
	const runningChild = child;
	const terminal = runningChild.terminal as PtyTerminal | undefined;

	for (const step of spec.script) {
		if (runningChild.exitCode !== null) break;
		switch (step.type) {
			case "wait":
				await Promise.race([delay(step.ms), runningChild.exited]);
				break;
			case "input":
				terminal?.write(step.data);
				break;
			case "resize":
				terminal?.resize(step.cols, step.rows);
				responder?.resize(step.cols, step.rows);
				finalDimensions = { cols: step.cols, rows: step.rows };
				events.push({ type: "resize", cols: step.cols, rows: step.rows });
				break;
			case "detach":
				detachIndex = events.length;
				break;
		}
	}

	if (runningChild.exitCode === null) {
		await Promise.race([delay(spec.exitGraceMs ?? 2000), runningChild.exited]);
		if (runningChild.exitCode === null) runningChild.kill("SIGTERM");
	}
	await runningChild.exited;

	const provenance: SessionProvenance = {
		command: spec.commandLabel ?? spec.command.join(" "),
		platform: spec.platform,
		capturedAt: spec.capturedAt,
		exitCode: runningChild.exitCode,
	};

	return {
		schema: "dev3-windows-session-journal",
		version: 1,
		target: spec.target,
		kind: spec.kind,
		initial: { cols: spec.cols, rows: spec.rows, scrollback: 1000 },
		finalDimensions,
		detachIndex: detachIndex >= 0 ? detachIndex : events.length,
		events,
		responderReplies,
		queryCounts: responder ? { ...responder.counts } : {},
		provenance,
	};
}

function parseSpec(raw: string): CaptureSessionSpec {
	const spec = JSON.parse(raw) as CaptureSessionSpec;
	if (!Array.isArray(spec.command) || spec.command.length === 0) {
		throw new Error("capture-session spec requires a non-empty command array");
	}
	return spec;
}

async function main(): Promise<void> {
	const specPath = Bun.argv[2];
	const outputPath = Bun.argv[3];
	if (!specPath) throw new Error("Usage: capture-session.ts <spec.json> [output.json]");
	const spec = parseSpec(await Bun.file(specPath).text());
	const journal = await captureSession(spec);
	const serialized = JSON.stringify(journal);
	if (outputPath) {
		await Bun.write(outputPath, serialized);
		console.error(
			`captured ${journal.events.length} events (${journal.responderReplies} query replies) → ${outputPath}`,
		);
	} else {
		console.log(serialized);
	}
}

if (import.meta.main) await main();
