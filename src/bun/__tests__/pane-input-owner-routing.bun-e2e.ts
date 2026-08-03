#!/usr/bin/env bun
/**
 * Pane input entering an app process that does NOT own a native pane's writer lease is
 * performed by the process that does — three REAL OS processes, public seam only.
 * Run: `bun run test:pane-input-owner-e2e`.
 *
 * Three roles share one isolated `$HOME`:
 *
 *   • **app A** (`--role=owner`) creates the task's native pane set through
 *     `pty.createNativeTaskSession`, therefore holds the writer lease, and runs the REAL
 *     `startSocketServer()` — so the production `_native.runPaneInputProgram` handler,
 *     its ledger and its guards are what answer the forwarded program.
 *   • **app B** (this process) is where the input enters. It has the pane open as an
 *     OBSERVER, exactly as a second app instance showing that task does, and then calls
 *     only `deliverPaneInput` — the public seam, never a lower-level delivery helper.
 *   • **app F** (`--role=forger`) replaces A as the writer and answers the same method
 *     with a FORGED `delivered` outcome, so the strict decoder is exercised at the
 *     public boundary against a real peer rather than a mock.
 *
 * Each `check` below names what it asserts; the run reads as the list.
 *
 * Isolation: `$HOME` is a tmpdir, set BEFORE the first `src/` import — `DEV3_HOME` and the
 * sockets dir are module-load constants, hence static imports of node builtins only.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { execFileSync } from "node:child_process";

const ENTRY = fileURLToPath(import.meta.url);
const ROLE = process.argv.find((arg) => arg.startsWith("--role="))?.slice("--role=".length) ?? "sender";

const TASK_ID = "00000000-0000-4000-8000-00000000e2e5";
const PROJECT_ID = "e2e-pane-input-routing";
const PANE_ID = "pane-1";
const PANE_SESSION_ID = `dev3-task-${TASK_ID}-${PANE_ID}`;
const READY_PREFIX = "__READY__";
const WRITE_PREFIX = "__WRITE__";
const WORK_ENV = "DEV3_PANE_INPUT_E2E_WORK";
/** The exact text the forging peer is asked to lie about. */
const FORGED_ID_MARK = "forged";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

/** What a pid is running right now, or "" when it is gone. Read-only. */
function commandOfPid(pid: number): string {
	if (pid <= 0) return "";
	try {
		return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf-8" }).trim();
	} catch {
		return "";
	}
}

/** A shell that never echoes, so one written line produces exactly one output line. */
function catShellLaunch(): { executable: string; argv: string[] } {
	return { executable: "/bin/bash", argv: ["--norc", "--noprofile", "-lc", "stty -echo; exec cat"] };
}

// ── app A: owns the pane and answers the real `_native.runPaneInputProgram` ──

async function runOwner(): Promise<never> {
	const work = process.env[WORK_ENV] ?? process.cwd();
	const pty = await import("../pty-server");
	const { readRecord } = await import("../native-terminal-registry/record");
	const { startSocketServer } = await import("../cli-socket-server");

	await pty.createNativeTaskSession(TASK_ID, PROJECT_ID, work, catShellLaunch(), {}, { cols: 120, rows: 40 });
	const terminal = pty.nativePaneTerminal(TASK_ID, PANE_ID);
	if (!terminal) {
		console.log(`${READY_PREFIX}${JSON.stringify({ error: "the created pane produced no terminal" })}`);
		process.exit(1);
	}
	// Bounded readiness instead of a sleep: the launch is `stty -echo; exec cat`, so the
	// shell pid running plain `cat` PROVES stty already ran and the reader is up.
	const shellPid = readRecord(PANE_SESSION_ID)?.shell.pid ?? -1;
	let shellReady = false;
	for (let attempt = 0; attempt < 60 && !shellReady; attempt += 1) {
		shellReady = /(^|\/)cat\b/.test(commandOfPid(shellPid)) && !commandOfPid(shellPid).includes("exec cat");
		if (!shellReady) await delay(100);
	}
	if (!shellReady) {
		console.log(`${READY_PREFIX}${JSON.stringify({ error: `the pane's shell never became cat (${commandOfPid(shellPid)})` })}`);
		process.exit(1);
	}

	// Every byte THIS process puts into the pane is reported, which is the owner-side
	// evidence that the forwarded program ran here rather than in the sender.
	const passthrough = terminal.write.bind(terminal);
	(terminal as { write: (data: string) => void }).write = (data) => {
		console.log(`${WRITE_PREFIX}${JSON.stringify(data)}`);
		passthrough(data);
	};

	const endpoint = startSocketServer();
	const record = readRecord(PANE_SESSION_ID);
	console.log(
		READY_PREFIX +
			JSON.stringify({
				pid: process.pid,
				hostPid: record?.host.pid ?? -1,
				shellPid: record?.shell.pid ?? -1,
				role: terminal.hostRole(),
				endpoint,
			}),
	);
	// The parent asks for teardown on stdin, so the host+shell tree dies with the test
	// instead of outliving it.
	process.stdin.on("data", () => {
		void pty.destroyNativeTaskSession(TASK_ID).finally(() => process.exit(0));
	});
	await new Promise(() => {});
	process.exit(0);
}

// ── app F: takes the lease, then answers the same method with a forged verdict ──

async function runForger(): Promise<never> {
	const { bindNativeTaskPane } = await import("../native-task-terminal");
	const { DEV3_HOME } = await import("../paths");

	const terminal = await bindNativeTaskPane(PANE_SESSION_ID, {
		onOutput: () => undefined,
		onClosed: () => undefined,
	});
	if (!terminal) {
		console.log(`${READY_PREFIX}${JSON.stringify({ error: "the forger could not bind the pane" })}`);
		process.exit(1);
	}
	if (terminal.hostRole() !== "writer") await terminal.claimHostWriter();

	// The same NDJSON request/response the CLI socket server speaks, so the sender's
	// production forwarder reaches it exactly as it would reach a real app process.
	const socketsDir = join(DEV3_HOME, "sockets");
	mkdirSync(socketsDir, { recursive: true });
	const socketPath = join(socketsDir, `${process.pid}.sock`);
	net
		.createServer((socket) => {
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf-8");
				for (;;) {
					const newline = buffer.indexOf("\n");
					if (newline === -1) break;
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (!line) continue;
					const request = JSON.parse(line) as { id: string; params?: { deliveryId?: string; incarnation?: { paneId?: string } } };
					// A peer claiming a delivered native program: impossible without a host
					// acknowledgement, so the sender must refuse it.
					socket.write(
						`${JSON.stringify({
							id: request.id,
							ok: true,
							data: {
								deliveryId: request.params?.deliveryId,
								backend: "native",
								paneId: request.params?.incarnation?.paneId,
								executor: `forger:${process.pid}`,
								status: "delivered",
								acceptedThrough: 1,
							},
						})}\n`,
					);
				}
			});
			socket.on("error", () => undefined);
		})
		.listen(socketPath, () => {
			console.log(`${READY_PREFIX}${JSON.stringify({ pid: process.pid, role: terminal.hostRole(), socketPath })}`);
		});

	await new Promise(() => {});
	process.exit(0);
}

// ── app B: the process the input enters ──

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) console.log(`  ok   - ${message}`);
	else {
		failures += 1;
		console.error(`  FAIL - ${message}`);
	}
}

function collectLines(stream: ReadableStream<Uint8Array>, lines: string[]): void {
	void (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of stream) {
			buffer += decoder.decode(chunk, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				lines.push(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
		}
	})();
}

async function waitForLine(lines: string[], prefix: string, timeoutMs: number): Promise<string | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = lines.find((line) => line.startsWith(prefix));
		if (found) return found;
		await delay(50);
	}
	return null;
}

function writeAppData(home: string, opts: { projectPath: string; slug: string; worktreePath: string }): void {
	const now = new Date(0).toISOString();
	writeFileSync(
		join(home, ".dev3.0", "projects.json"),
		JSON.stringify([
			{
				id: PROJECT_ID,
				name: "pane input owner routing e2e",
				path: opts.projectPath,
				setupScript: "",
				devScript: "",
				cleanupScript: "",
				defaultBaseBranch: "main",
				createdAt: now,
			},
		]),
	);
	const dataDir = join(home, ".dev3.0", "data", opts.slug);
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(
		join(dataDir, "tasks.json"),
		JSON.stringify([
			{
				id: TASK_ID,
				seq: 1,
				projectId: PROJECT_ID,
				title: "pane input owner routing e2e",
				description: "pane input owner routing e2e",
				status: "in-progress",
				baseBranch: "main",
				worktreePath: opts.worktreePath,
				branchName: "e2e/pane-input-owner-routing",
				createdAt: now,
				updatedAt: now,
				terminalBackend: "native",
			},
		]),
	);
}

/**
 * The registry's own proof of what this test owns: the record plus its session token. A
 * pid, and equally a matching `ps` command line, is not identity — the OS hands both to an
 * unrelated successor. Only the recorded start signatures decide.
 */
async function readOwnedEvidence(): Promise<OwnedEvidence | null> {
	const { readRecord, readToken } = await import("../native-terminal-registry/record");
	const record = readRecord(PANE_SESSION_ID);
	if (!record) return null;
	return { record, token: readToken(PANE_SESSION_ID) };
}

interface OwnedEvidence {
	readonly record: import("../native-terminal-registry/record").NativeSessionRecord;
	readonly token: string | null;
}

/**
 * Whether our exact processes are still running, judged by start signature (or the Windows
 * Job). `reused` and `dead` both mean nothing of ours survives.
 */
async function stillOurs(evidence: OwnedEvidence | null): Promise<boolean> {
	if (!evidence) return false;
	const { classifyOwnership } = await import("../native-terminal-registry/ownership");
	return (await classifyOwnership(evidence.record, evidence.token)) === "owned";
}

async function runSender(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "dev3-pane-input-owner-e2e-"));
	const work = join(root, "work");
	mkdirSync(join(root, ".dev3.0", "sockets"), { recursive: true });
	mkdirSync(work, { recursive: true });
	process.env.HOME = root;
	process.env[WORK_ENV] = work;
	process.env.DEV3_NATIVE_SESSIONS_DIR = join(root, ".dev3.0", "native-sessions");
	process.env.DEV3_NATIVE_HOST_IMAGES_DIR = join(root, "host-images");
	process.env.DEV3_LOG_DIR = join(root, "logs");

	const { spawn } = await import("../spawn");
	const { NATIVE_MULTIPANE_DIR_ENV } = await import("../native-terminal-multipane/paths");
	process.env[NATIVE_MULTIPANE_DIR_ENV] = join(root, ".dev3.0", "multipane");
	mkdirSync(process.env[NATIVE_MULTIPANE_DIR_ENV], { recursive: true });

	const projectPath = join(root, "repo");
	mkdirSync(projectPath, { recursive: true });
	const { projectStorageKey } = await import("../../shared/project-storage-key");
	writeAppData(root, { projectPath, slug: projectStorageKey(projectPath), worktreePath: work });

	const { deliverPaneInput, pinTaskPane, newPaneInputDeliveryId } = await import("../pane-input");
	const { NativeSessionClient } = await import("../native-terminal-registry/client");
	const data = await import("../data");

	let owner: ReturnType<typeof spawn> | null = null;
	let forger: ReturnType<typeof spawn> | null = null;
	let observer: Awaited<ReturnType<typeof NativeSessionClient.discover>> | null = null;

	try {
		owner = spawn([process.execPath, ENTRY, "--role=owner"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		const ownerLines: string[] = [];
		const ownerErrors: string[] = [];
		collectLines(owner.stdout as unknown as ReadableStream<Uint8Array>, ownerLines);
		collectLines(owner.stderr as unknown as ReadableStream<Uint8Array>, ownerErrors);
		const readyLine = await waitForLine(ownerLines, READY_PREFIX, 90_000);
		if (!readyLine) {
			console.error(ownerErrors.slice(-10).join("\n"));
			throw new Error("app A never reported readiness");
		}
		const ready = JSON.parse(readyLine.slice(READY_PREFIX.length)) as { pid: number; role: string; error?: string };
		if (ready.error) throw new Error(`app A failed: ${ready.error}`);
		check(ready.role === "writer", "the lease lives in app A");
		console.log(`  info - app A pid=${ready.pid}`);

		// B watches the shell's own output, which is the only place a byte that actually
		// landed can be observed.
		const decoder = new TextDecoder();
		let seen = "";
		observer = await NativeSessionClient.discover(PANE_SESSION_ID);
		observer.onOutput((bytes) => {
			seen += decoder.decode(bytes, { stream: true });
		});

		// A real second app instance has the pane OPEN as an observer; that binding is what
		// pane input requires, since it never attaches one itself.
		const pty = await import("../pty-server");
		await pty.reattachNativeTaskSession(TASK_ID, PROJECT_ID, work);
		const bBinding = pty.nativePaneTerminal(TASK_ID, PANE_ID);
		check(Boolean(bBinding), "app B has the pane open as a viewer");
		check(bBinding?.hostRole() === "observer", `app B is an observer, not the writer (role ${bBinding?.hostRole()})`);

		const projects = await data.loadProjects();
		const task = (await data.loadTasks(projects[0])).find((t) => t.id === TASK_ID);
		if (!task) throw new Error("the e2e task did not load from the isolated home");

		const pin = await pinTaskPane(task, PANE_ID);
		check(pin.ok, "app B pins the live pane through the public seam");
		if (!pin.ok) throw new Error(pin.detail);

		// ── the forwarded program: entered in B, performed in A ──
		const token = `PANEINPUT-${Date.now()}`;
		const deliveryId = newPaneInputDeliveryId("e2e");
		const program = {
			deliveryId,
			attempt: 1,
			incarnation: pin.incarnation,
			stages: [{ steps: [{ kind: "text" as const, text: `${token}\r` }] }],
		};
		const first = await deliverPaneInput(task, program);

		check(first.status === "indeterminate", `B reports the honest verdict (got ${first.status})`);
		check(
			first.status === "indeterminate" && first.reason === "unacknowledged",
			`the reason is unacknowledged, never delivered (got ${"reason" in first ? first.reason : "-"})`,
		);
		check(
			typeof first.executor === "string" && first.executor.startsWith(`${ready.pid}:`),
			`the verdict is stamped with A's executor identity (got ${String(first.executor)})`,
		);

		await delay(600);
		check(occurrences(seen, token) === 1, `the bytes reached the real shell exactly once (saw ${occurrences(seen, token)})`);
		const ownerWrote = ownerLines.filter((line) => line.startsWith(WRITE_PREFIX) && line.includes(token));
		check(ownerWrote.length === 1, `app A performed the write (${ownerWrote.length} owner write(s))`);

		// ── ledger dedup across the process boundary ──
		const probe = await deliverPaneInput(task, { ...program, attempt: 2 });
		await delay(600);
		check(
			probe.status === first.status && probe.executor === first.executor,
			"a probe with the same delivery id returns A's recorded outcome",
		);
		check(occurrences(seen, token) === 1, `the probe wrote nothing more (still ${occurrences(seen, token)})`);
		check(
			ownerLines.filter((line) => line.startsWith(WRITE_PREFIX) && line.includes(token)).length === 1,
			"app A did not write a second time",
		);

		// ── the strict decoder, against a real peer that lies ──
		owner.kill();
		await delay(1_000);
		forger = spawn([process.execPath, ENTRY, "--role=forger"], { stdout: "pipe", stderr: "pipe" });
		const forgerLines: string[] = [];
		const forgerErrors: string[] = [];
		collectLines(forger.stdout as unknown as ReadableStream<Uint8Array>, forgerLines);
		collectLines(forger.stderr as unknown as ReadableStream<Uint8Array>, forgerErrors);
		const forgerReady = await waitForLine(forgerLines, READY_PREFIX, 60_000);
		if (!forgerReady) {
			console.error(forgerErrors.slice(-10).join("\n"));
			throw new Error("app F never reported readiness");
		}
		const forgerInfo = JSON.parse(forgerReady.slice(READY_PREFIX.length)) as { pid: number; role: string; error?: string };
		if (forgerInfo.error) throw new Error(`app F failed: ${forgerInfo.error}`);
		check(forgerInfo.role === "writer", "the lease moved to app F");

		const forged = await deliverPaneInput(task, {
			deliveryId: newPaneInputDeliveryId(FORGED_ID_MARK),
			attempt: 1,
			incarnation: pin.incarnation,
			stages: [{ steps: [{ kind: "text" as const, text: `FORGED-${Date.now()}\r` }] }],
		});
		check(
			forged.status === "indeterminate" && forged.reason === "owner-unreachable",
			`a peer claiming delivered is refused (got ${forged.status}/${"reason" in forged ? forged.reason : "-"})`,
		);
		check(
			forged.status === "indeterminate" && String(forged.detail).includes("no host can acknowledge"),
			"the refusal names the reason it cannot be believed",
		);
	} finally {
		observer?.close();
		// Stop the native tree FIRST: deleting the state root under a live host leaves an
		// orphan that no later run can even name.
		const evidence = await readOwnedEvidence();
		if (owner) {
			try {
				(owner as unknown as { stdin?: { write(data: string): void; flush?: () => void } }).stdin?.write("stop\n");
			} catch {
				// the child may already be gone
			}
			await Promise.race([owner.exited, delay(5_000)]);
		}
		forger?.kill();
		owner?.kill();
		await delay(500);
		// Terminate through the registry's own boundary: it classifies by start signature,
		// signals ONLY while the verdict is still `owned`, and re-verifies immediately
		// before the signal. This test signals nothing itself, so it cannot hit a stranger
		// that inherited a pid.
		if (evidence) {
			const registry = await import("../native-terminal-registry/registry");
			await registry.stop(PANE_SESSION_ID, { timeoutMs: 5_000 }).catch(() => undefined);
		}
		await delay(300);
		const leaked = await stillOurs(evidence);
		check(!leaked, `no owned host or shell survives (${leaked ? "still owned" : "none"})`);
		rmSync(root, { recursive: true, force: true });
	}
}

const run = ROLE === "owner" ? runOwner : ROLE === "forger" ? runForger : runSender;
run()
	.then(() => {
		if (ROLE !== "sender") return;
		console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
		process.exit(failures === 0 ? 0 : 1);
	})
	.catch((err) => {
		console.error("\nE2E CRASHED", err);
		process.exit(1);
	});
