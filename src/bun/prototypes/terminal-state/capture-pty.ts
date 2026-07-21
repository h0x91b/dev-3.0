#!/usr/bin/env bun

import { spawn } from "../../spawn";
import type { GhosttyRendererProbe } from "./ghostty-renderer-probe";

export interface PtyFrameCaptureOptions {
	command: string[];
	cwd: string;
	cols: number;
	rows: number;
	settleMs: number;
	respondToTerminalQueries?: boolean;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function capturePtyFrame(options: PtyFrameCaptureOptions): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let emulator: GhosttyRendererProbe | undefined;
	if (options.respondToTerminalQueries) {
		const { GhosttyRendererProbe } = await import("./ghostty-renderer-probe");
		emulator = await GhosttyRendererProbe.create({
			cols: options.cols,
			rows: options.rows,
			scrollback: 1000,
		});
	}
	let child: ReturnType<typeof spawn> | undefined;
	child = spawn(options.command, {
		cwd: options.cwd,
		env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
		terminal: {
			cols: options.cols,
			rows: options.rows,
			data(_terminal: unknown, bytes: Uint8Array) {
				chunks.push(bytes.slice());
				if (emulator) {
					emulator.ingest(bytes);
					for (const response of emulator.readResponses()) child?.terminal?.write(response);
				}
			},
		},
	});
	const runningChild = child;

	await Promise.race([delay(options.settleMs), runningChild.exited]);
	const frame = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
	if (runningChild.exitCode === null) runningChild.kill("SIGTERM");
	await runningChild.exited;
	emulator?.dispose();
	return Uint8Array.from(frame);
}

async function main(): Promise<void> {
	const args = Bun.argv.slice(2);
	const respondToTerminalQueries = args[0] === "--terminal-responses";
	if (respondToTerminalQueries) args.shift();
	const [settleMsValue, colsValue, rowsValue, cwd, ...command] = args;
	const settleMs = Number(settleMsValue);
	const cols = Number(colsValue);
	const rows = Number(rowsValue);
	if (
		!Number.isInteger(settleMs) ||
		settleMs < 0 ||
		!Number.isInteger(cols) ||
		cols <= 0 ||
		!Number.isInteger(rows) ||
		rows <= 0 ||
		!cwd ||
		command.length === 0
	) {
		throw new Error(
			"Usage: capture-pty.ts [--terminal-responses] <settle-ms> <cols> <rows> <cwd> <command...>",
		);
	}
	const bytes = await capturePtyFrame({
		command,
		cwd,
		cols,
		rows,
		settleMs,
		respondToTerminalQueries,
	});
	console.log(Buffer.from(bytes).toString("base64"));
}

if (import.meta.main) await main();
