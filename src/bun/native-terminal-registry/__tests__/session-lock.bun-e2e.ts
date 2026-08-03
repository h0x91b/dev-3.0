#!/usr/bin/env bun

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawn } from "../../spawn";

const DEADLINE_MS = 10_000;

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
	console.log(`✓ ${message}`);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class LineReader {
	private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
	private pending = "";

	constructor(stream: ReadableStream<Uint8Array>) {
		this.reader = stream.getReader();
	}

	async next(label: string): Promise<string> {
		const read = async (): Promise<string> => {
			for (;;) {
				const newline = this.pending.indexOf("\n");
				if (newline >= 0) {
					const line = this.pending.slice(0, newline).trim();
					this.pending = this.pending.slice(newline + 1);
					return line;
				}
				const chunk = await this.reader.read();
				if (chunk.done) throw new Error(`${label} closed stdout before its barrier`);
				this.pending += new TextDecoder().decode(chunk.value, { stream: true });
			}
		};
		return Promise.race([
			read(),
			delay(DEADLINE_MS).then(() => {
				throw new Error(`${label} barrier timed out after ${DEADLINE_MS}ms`);
			}),
		]);
	}
}

type Worker = ReturnType<typeof spawn>;

function startWorker(role: "D" | "B" | "C", root: string, deadPid?: number): { proc: Worker; lines: LineReader } {
	const worker = fileURLToPath(new URL("./session-lock-worker.ts", import.meta.url));
	const proc = spawn([process.execPath, worker, role, root, ...(deadPid ? [String(deadPid)] : [])], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	return { proc, lines: new LineReader(proc.stdout as ReadableStream<Uint8Array>) };
}

async function release(worker: Worker): Promise<void> {
	const stdin = worker.stdin as unknown as import("bun").FileSink;
	stdin.write("continue\n");
	await stdin.flush();
	stdin.end();
}

async function stop(worker: Worker | undefined): Promise<void> {
	if (!worker || worker.exitCode !== null) return;
	try {
		worker.kill("SIGKILL");
	} catch {
		// already exited
	}
	await Promise.race([worker.exited, delay(1_000)]);
}

async function main(): Promise<void> {
	if (process.platform === "win32") {
		console.log("SKIP session lock ABA E2E: SIGKILL/start-signature proof is POSIX-only");
		return;
	}
	const root = mkdtempSync(join(tmpdir(), "dev3-session-lock-e2e-"));
	let d: Worker | undefined;
	let b: Worker | undefined;
	let c: Worker | undefined;
	try {
		const dWorker = startWorker("D", root);
		d = dWorker.proc;
		check((await dWorker.lines.next("D")) === "entered", "D acquired the real cross-process lock");
		const deadPid = d.pid;
		d.kill("SIGKILL");
		await d.exited;
		check(!existsSync(join(root, "critical.guard")), "D died without entering another owner's guard");

		const bWorker = startWorker("B", root, deadPid);
		b = bWorker.proc;
		check((await bWorker.lines.next("B stale observation")) === "stale-observed", "B observed D as definitively stale and paused");

		const cWorker = startWorker("C", root);
		c = cWorker.proc;
		check((await cWorker.lines.next("C")) === "entered", "C claimed D's stale generation and entered");
		check(existsSync(join(root, "critical.guard")), "C exclusively owns the critical guard");

		const bEntered = bWorker.lines.next("B entry");
		await release(b);
		const premature = await Promise.race([bEntered.then(() => true), delay(250).then(() => false)]);
		check(!premature, "resumed B neither entered nor deleted C's live state");
		check(existsSync(join(root, "critical.guard")), "C's guard survived B's stale-break ABA attempt");

		await release(c);
		check((await cWorker.lines.next("C release")) === "released", "C released its generation after B moved it to a claim");
		await c.exited;
		check((await bEntered) === "entered", "B entered only after C released");
		check((await bWorker.lines.next("B release")) === "released", "B released its own generation");
		await b.exited;

		check(!existsSync(join(root, "critical.guard")), "the exclusive guard was removed");
		check(readdirSync(join(root, "locks")).length === 0, "canonical, candidate, and claim artifacts were all retired");
	} finally {
		await Promise.all([stop(b), stop(c), stop(d)]);
		rmSync(root, { recursive: true, force: true });
	}
}

await main();
