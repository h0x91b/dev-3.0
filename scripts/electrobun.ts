/**
 * The one way to run the electrobun CLI: `bun scripts/electrobun.ts <args>`.
 *
 * Identical to `electrobun <args>` except that:
 *  - on Windows the CLI never sees PowerShell 7's module directories, which break its
 *    `Expand-Archive` (see windows-powershell-env.ts);
 *  - a run that fails on the network (GitHub download 5xx, Apple stapler losing the connection)
 *    is retried after 30s, up to 5 attempts (see network-retry.ts). Any other failure is final.
 * Every package script and workflow goes through here; a guard test refuses a bare call.
 */

import { resolve } from "node:path";
import { type AttemptResult, ciWarning, retryOnNetworkFailure } from "./network-retry";
import { stripPowerShell7ModulePathsInPlace } from "./windows-powershell-env";

const ELECTROBUN_CLI = resolve(import.meta.dir, "..", "node_modules", "electrobun", "bin", "electrobun.cjs");
/** Enough for the CLI's final error and its stack; the network line is always near the end. */
const TAIL_BYTES = 64 * 1024;

async function tee(stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream, tail: { text: string }): Promise<void> {
	const decoder = new TextDecoder();
	for await (const chunk of stream) {
		sink.write(chunk);
		tail.text = (tail.text + decoder.decode(chunk, { stream: true })).slice(-TAIL_BYTES);
	}
}

async function runOnce(): Promise<AttemptResult> {
	const child = Bun.spawn([process.execPath, ELECTROBUN_CLI, ...process.argv.slice(2)], {
		stdin: "inherit",
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	const tail = { text: "" };
	await Promise.all([tee(child.stdout, process.stdout, tail), tee(child.stderr, process.stderr, tail)]);
	return { exitCode: (await child.exited) ?? 1, output: tail.text };
}

stripPowerShell7ModulePathsInPlace("electrobun");
const exitCode = await retryOnNetworkFailure("electrobun", runOnce, {
	sleep: (ms) => Bun.sleep(ms),
	warn: (message) => console.log(ciWarning(message)),
});
process.exit(exitCode);
