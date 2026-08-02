#!/usr/bin/env bun
/**
 * PRODUCT end-to-end proof that a message entering a dev3 app process that does
 * NOT own a native pane's writer lease is still delivered — exactly once, by the
 * process that does own it (seq 1377). Run: `bun run test:native-message-e2e`.
 *
 * Two REAL processes share one isolated `$HOME`:
 *
 *   • **app A** — a child process (`--role=owner`). It creates the task's native
 *     pane set through `pty.createNativeTaskSession`, therefore holds the pane's
 *     writer lease, and runs the REAL `startSocketServer()`, so the production
 *     `_native.deliverPrompt` handler is what answers the forwarded delivery.
 *   • **app B** — this parent process. The message enters here. It binds the same
 *     pane (an OBSERVER, because A holds the lease) and calls the production seam
 *     `deliverAgentPrompt(task, text)`.
 *
 * The delivery is then driven a SECOND time through the full outside-in path
 * (seq 1381): app B runs its own real `startSocketServer()`, a real project and
 * task are persisted to the isolated `$HOME`, and the request arrives over B's
 * CLI socket as the production `message.send` handler — the exact transport
 * `dev3 message` uses. Calling `deliverAgentPrompt` directly proves the seam;
 * only this proves the seam is actually REACHED from the CLI in a non-owning
 * process, with task resolution, envelope handling and the handler's reply in
 * the loop. The task's `tmuxSocket` points at the throwaway sentinel socket, so
 * a silent tmux fallback anywhere in that chain would show up as a session on a
 * socket whose list is asserted byte-identical.
 *
 * What it asserts: the lease really lives in A; `deliverAgentPrompt` reports true
 * in B; `message.send` entering B over its own socket answers delivered; each
 * token lands in native pane-1 with its submit CR; each occurs EXACTLY once and
 * is still exactly once well past the submit delay; the bytes were written by A
 * and never by B; host/shell pids are unchanged; no second native session or
 * host was spawned; and no tmux session was created or mutated.
 *
 * Isolation: `$HOME` is a tmpdir — set BEFORE the first `src/` import, because
 * `DEV3_HOME` (and `native-pane-owner`'s sockets dir) are module-load constants.
 * Hence static imports of node builtins only, everything else via `await import`.
 * Registry/host-image/multipane/log dirs are redirected the same way the sibling
 * `native-task-terminal.bun-e2e.ts` does. Test-only: no production file changes.
 *
 * The pane's shell is `stty -echo; exec cat`, so every delivered line comes back
 * on the stream exactly once and an occurrence count is meaningful evidence.
 *
 * Both halves own listeners and timers, so each ends in an explicit process.exit.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(import.meta.url);
const IS_OWNER = process.argv.includes("--role=owner");

// Fixed ids keep the pane session id deterministic in both processes.
const TASK_ID = "00000000-0000-4000-8000-0000000e2e91";
const PROJECT_ID = "e2e-owner-routing";
const PANE_ID = "pane-1";
const PANE_SESSION_ID = `dev3-task-${TASK_ID}-${PANE_ID}`;

const READY_PREFIX = "__OWNER_READY__";
const WRITE_PREFIX = "__OWNER_WRITE__";
const WORK_ENV = "DEV3_MESSAGE_E2E_WORK";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

/** A shell that never echoes, so one written line produces exactly one output line. */
function catShellLaunch(): { executable: string; argv: string[] } {
	return { executable: "/bin/bash", argv: ["--norc", "--noprofile", "-lc", "stty -echo; exec cat"] };
}

/**
 * Persist a real project + task into the isolated `$HOME`, so the production
 * `message.send` handler can resolve them the way it does for a live board.
 * Only the fields the resolution path actually reads are set; `rawLoadTasks`
 * backfills the rest on load.
 *
 * `tmuxSocket` deliberately points at the throwaway sentinel socket rather than
 * the developer's real one: if any part of this chain ever fell back to tmux,
 * the session would land there and the sentinel's byte-identical session-list
 * assertion below would catch it instead of it passing unnoticed.
 */
function writeAppData(home: string, opts: { projectPath: string; slug: string; worktreePath: string; tmuxSocket: string }): void {
	const now = new Date(0).toISOString();
	writeFileSync(
		join(home, ".dev3.0", "projects.json"),
		JSON.stringify([
			{
				id: PROJECT_ID,
				name: "native owner routing e2e",
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
				title: "native owner routing e2e",
				description: "native owner routing e2e",
				status: "in-progress",
				baseBranch: "main",
				worktreePath: opts.worktreePath,
				branchName: "e2e/native-owner-routing",
				createdAt: now,
				updatedAt: now,
				tmuxSocket: opts.tmuxSocket,
				terminalBackend: "native",
			},
		]),
	);
}

// ── app A: the process that owns the pane and answers `_native.deliverPrompt` ──

async function runOwner(): Promise<never> {
	const work = process.env[WORK_ENV] ?? process.cwd();
	const pty = await import("../pty-server");
	const { NativeSessionClient } = await import("../native-terminal-registry/client");
	const { readRecord } = await import("../native-terminal-registry/record");
	const { startSocketServer } = await import("../cli-socket-server");

	await pty.createNativeTaskSession(TASK_ID, PROJECT_ID, work, catShellLaunch(), {}, { cols: 120, rows: 40 });
	const terminal = pty.nativePaneTerminal(TASK_ID, PANE_ID);
	if (!terminal) {
		console.log(`${READY_PREFIX}${JSON.stringify({ error: "the created pane produced no terminal" })}`);
		process.exit(1);
	}

	// Wait until `stty -echo` has taken effect and `cat` is reading: only then is
	// an occurrence count honest evidence rather than a race with shell warm-up.
	const probe = await NativeSessionClient.discover(PANE_SESSION_ID);
	const decoder = new TextDecoder();
	let seen = "";
	probe.onOutput((bytes) => {
		seen += decoder.decode(bytes, { stream: true });
	});
	let echoOff = false;
	for (let attempt = 0; attempt < 30 && !echoOff; attempt++) {
		const warmup = `ECHOPROBE-${attempt}-${process.pid}`;
		seen = "";
		terminal.write(`${warmup}\r`);
		const deadline = Date.now() + 500;
		while (Date.now() < deadline && occurrences(seen, warmup) === 0) await delay(25);
		await delay(150); // let a second (echoed) copy arrive before believing there is one
		echoOff = occurrences(seen, warmup) === 1;
	}
	probe.close();

	// From here every byte this process puts into the pane is reported on stdout —
	// the owner-side evidence that the forwarded delivery ran HERE, exactly once.
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
				echoOff,
				endpoint,
			}),
	);

	await new Promise(() => {}); // stay alive until the parent kills us
	process.exit(0);
}

// ── app B: the process the message enters ──

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) console.log(`  ok   - ${message}`);
	else {
		failures++;
		console.error(`  FAIL - ${message}`);
	}
}

interface OwnerReady {
	pid: number;
	hostPid: number;
	shellPid: number;
	role: string;
	echoOff: boolean;
	endpoint: string;
	error?: string;
}

/** The child's stdout, split into lines as they arrive. */
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

async function runSender(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "dev3-native-message-e2e-"));
	const work = join(root, "work");
	mkdirSync(work, { recursive: true });
	mkdirSync(join(root, "native-sessions"), { recursive: true });
	mkdirSync(join(root, "native-multipane"), { recursive: true });

	// $HOME first: DEV3_HOME and the sockets dir both freeze at module load.
	process.env.HOME = root;
	process.env[WORK_ENV] = work;
	process.env.DEV3_NATIVE_SESSIONS_DIR = join(root, "native-sessions");
	process.env.DEV3_NATIVE_HOST_IMAGES_DIR = join(root, "host-images");
	process.env.DEV3_LOG_DIR = join(root, "logs");

	const { NATIVE_MULTIPANE_DIR_ENV } = await import("../native-terminal-multipane/paths");
	process.env[NATIVE_MULTIPANE_DIR_ENV] = join(root, "native-multipane");

	const { spawn } = await import("../spawn");
	const { deliverAgentPrompt } = await import("../agent-prompt-delivery");
	const { projectStorageKey } = await import("../../shared/project-storage-key");
	const { startSocketServer } = await import("../cli-socket-server");
	const { sendRequest } = await import("../../cli/socket-client");
	const { AGENT_PROMPT_ENTER_DELAY_MS } = await import("../agent-prompt");
	const { resolvePaneOwner } = await import("../native-pane-owner");
	const { NativeSessionClient } = await import("../native-terminal-registry/client");
	const { readRecord } = await import("../native-terminal-registry/record");
	const { sessionsRootDir } = await import("../native-terminal-registry/paths");
	const { isProcessAlive } = await import("../native-terminal-registry/process-identity");
	const { tmux, taskSessionName } = await import("../tmux");
	const { SESSION_OVERVIEW_FORMAT } = await import("../tmux/formats");
	const pty = await import("../pty-server");
	type Task = import("../../shared/types").Task;

	const listSessions = async (socket?: string): Promise<string> => {
		try {
			const rows = await tmux.listSessions(SESSION_OVERVIEW_FORMAT, socket ? { socket } : undefined);
			return rows.map((row) => row.name).sort().join(",");
		} catch {
			return ""; // no tmux server on that socket — an empty list is the honest answer
		}
	};

	/**
	 * Does this tmux session exist — with "tmux is not installed at all" reported as
	 * a plain no rather than an exception. On a machine with no tmux binary
	 * `hasSession` throws ENOENT, which used to abort the whole run on its very last
	 * line AFTER every check had passed (seq 1381, first CI run on a tmux-less
	 * runner). A missing binary is the strongest possible evidence that no tmux
	 * session was created, so it belongs on the passing side, exactly as the
	 * `listSessions` helper above already treats an unreachable server.
	 */
	const hasSessionOrAbsent = async (name: string, socket?: string): Promise<boolean> => {
		try {
			return await tmux.hasSession(name, socket ? { socket } : undefined);
		} catch {
			return false;
		}
	};

	const token = `NMORT-${process.pid}-${Date.now()}`;
	/** Second delivery, driven outside-in through B's real CLI socket. */
	const cliToken = `NMORT-CLI-${process.pid}-${Date.now()}`;
	console.log(`  info - platform=${process.platform} bun=${Bun.version} pane=${PANE_SESSION_ID}`);

	const sentinelSocket = `dev3-native-message-e2e-${process.pid}`;
	const sentinelSession = "dev3-native-message-e2e-sentinel";
	let sentinelAlive = false;
	let sentinelSocketSessionsBefore = "";
	let child: ReturnType<typeof spawn> | null = null;
	let observer: Awaited<ReturnType<typeof NativeSessionClient.discover>> | null = null;

	// A real board on disk, so `message.send` resolves this task the way it does
	// in the app instead of being handed a synthesized object.
	const projectPath = join(root, "repo");
	mkdirSync(projectPath, { recursive: true });
	mkdirSync(join(root, ".dev3.0"), { recursive: true });
	writeAppData(root, {
		projectPath,
		slug: projectStorageKey(projectPath),
		worktreePath: work,
		tmuxSocket: sentinelSocket,
	});

	try {
		try {
			await tmux.newSessionDetached({
				sessionName: sentinelSession,
				cwd: work,
				socket: sentinelSocket,
				command: "sleep 600",
			});
			sentinelAlive = await tmux.hasSession(sentinelSession, { socket: sentinelSocket });
			sentinelSocketSessionsBefore = await listSessions(sentinelSocket);
		} catch (err) {
			console.log(`  SKIP - tmux sentinel unavailable (${err instanceof Error ? err.message : String(err)})`);
		}

		// ── app A comes up: it owns the pane and serves `_native.deliverPrompt` ──
		child = spawn([process.execPath, ENTRY, "--role=owner"], { stdout: "pipe", stderr: "pipe" });
		const childLines: string[] = [];
		const childErrors: string[] = [];
		collectLines(child.stdout as unknown as ReadableStream<Uint8Array>, childLines);
		collectLines(child.stderr as unknown as ReadableStream<Uint8Array>, childErrors);
		const readyLine = await waitForLine(childLines, READY_PREFIX, 90_000);
		if (!readyLine) {
			console.error(childErrors.slice(-10).join("\n"));
			throw new Error("app A never reported readiness");
		}
		const ready = JSON.parse(readyLine.slice(READY_PREFIX.length)) as OwnerReady;
		if (ready.error) throw new Error(`app A failed to start its pane: ${ready.error}`);
		console.log(`  info - app A pid=${ready.pid} host=${ready.hostPid} shell=${ready.shellPid}`);
		check(ready.role === "writer" && ready.echoOff, "app A holds the writer lease and its pane shell stopped echoing");

		// ── app B binds the same pane ──
		const reattached = await pty.reattachNativeTaskSession(TASK_ID, PROJECT_ID, work);
		const terminal = reattached ? pty.nativePaneTerminal(TASK_ID, PANE_ID) : null;
		if (!terminal) throw new Error("app B could not bind the pane app A created");
		let localWrites = 0;
		const passthrough = terminal.write.bind(terminal);
		(terminal as { write: (data: string) => void }).write = (data) => {
			localWrites++;
			passthrough(data);
		};

		// An independent raw client is the pane's byte witness: it observes what the
		// SHELL emitted, with no dependency on either app's own bookkeeping.
		observer = await NativeSessionClient.discover(PANE_SESSION_ID);
		const decoder = new TextDecoder();
		let paneOutput = "";
		observer.onOutput((bytes) => {
			paneOutput += decoder.decode(bytes, { stream: true });
		});

		// ── 1. the lease lives in app A, not here ──
		const owner = await resolvePaneOwner(terminal);
		check(terminal.hostRole() === "observer", "app B is an OBSERVER on the pane — its own writes would be dropped");
		check(
			owner.kind === "peer" && owner.pid === ready.pid,
			`app B resolves the pane owner as peer pid ${ready.pid} (got ${owner.kind === "peer" ? owner.pid : owner.kind})`,
		);

		const before = readRecord(PANE_SESSION_ID);

		// ── 2. the production seam, called in the process that owns nothing ──
		const task = {
			id: TASK_ID,
			projectId: PROJECT_ID,
			worktreePath: work,
			terminalBackend: "native",
		} as unknown as Task;
		const delivered = await deliverAgentPrompt(task, token);
		check(delivered === true, "deliverAgentPrompt resolved TRUE in the non-owning process");

		// ── 3. the token reached the pane's shell, submit CR and all ──
		const lineDeadline = Date.now() + 15_000;
		while (Date.now() < lineDeadline && !paneOutput.includes(token)) await delay(50);
		check(
			new RegExp(`(^|[\\r\\n])${token}[\\r\\n]`).test(paneOutput),
			"the token came back from native pane-1 on a line of its own — the submit CR arrived",
		);

		// ── 4. exactly once, and still exactly once after the submit delay ──
		const firstCount = occurrences(paneOutput, token);
		check(firstCount === 1, `the token occurs exactly once in the pane output (got ${firstCount})`);
		await delay(AGENT_PROMPT_ENTER_DELAY_MS + 4000);
		const settledCount = occurrences(paneOutput, token);
		check(settledCount === 1, `no late duplicate after the submit delay + margin (got ${settledCount})`);

		// ── 5. app A wrote it; app B never wrote locally ──
		const ownerWrites = childLines
			.filter((line) => line.startsWith(WRITE_PREFIX))
			.map((line) => JSON.parse(line.slice(WRITE_PREFIX.length)) as string);
		check(
			ownerWrites.filter((data) => data.includes(token)).length === 1,
			`the owning process performed the delivery exactly once (${ownerWrites.length} owner write(s) total)`,
		);
		check(ownerWrites.filter((data) => data === "\r").length === 1, "the owning process sent exactly one submit CR");
		check(localWrites === 0, "the forwarding process never wrote a byte into the pane itself");

		// ── 6. the delivery changed no process identity ──
		const after = readRecord(PANE_SESSION_ID);
		check(
			before?.host.pid === ready.hostPid && after?.host.pid === ready.hostPid,
			"the pane's host pid is unchanged before vs after the delivery",
		);
		check(
			before?.shell.pid === ready.shellPid && after?.shell.pid === ready.shellPid,
			"the pane's shell pid is unchanged before vs after the delivery",
		);

		// ── 6b. the SAME journey, entered from outside through B's own CLI socket ──
		// Everything above proves the seam. This proves the seam is reached: the
		// request arrives over the transport `dev3 message` uses, hits the real
		// `message.send` handler in the process that owns NOTHING, resolves the task
		// off disk, and comes out the other end as one delivery performed by A.
		const bEndpoint = startSocketServer();
		check(typeof bEndpoint === "string" && bEndpoint.length > 0, "app B is listening on its own CLI socket");
		check(bEndpoint !== ready.endpoint, "app A and app B listen on two DIFFERENT CLI endpoints");

		const ownerWritesBeforeCli = childLines.filter((line) => line.startsWith(WRITE_PREFIX)).length;
		const localWritesBeforeCli = localWrites;

		const response = await sendRequest(bEndpoint, "message.send", {
			taskId: TASK_ID,
			projectId: PROJECT_ID,
			text: cliToken,
		});
		check(response.ok === true, `message.send through app B's socket succeeded${response.ok ? "" : `: ${response.error}`}`);
		check(
			(response.data as { delivered?: boolean } | undefined)?.delivered === true,
			"the CLI handler reported the message delivered",
		);

		const cliDeadline = Date.now() + 15_000;
		while (Date.now() < cliDeadline && !paneOutput.includes(cliToken)) await delay(50);
		check(
			new RegExp(`(^|[\\r\\n])${cliToken}[\\r\\n]`).test(paneOutput),
			"the CLI-entered token came back from native pane-1 on its own line — the submit CR arrived",
		);
		const cliFirstCount = occurrences(paneOutput, cliToken);
		check(cliFirstCount === 1, `the CLI-entered token occurs exactly once in the pane output (got ${cliFirstCount})`);
		await delay(AGENT_PROMPT_ENTER_DELAY_MS + 4000);
		const cliSettledCount = occurrences(paneOutput, cliToken);
		check(cliSettledCount === 1, `no late duplicate of the CLI-entered token (got ${cliSettledCount})`);

		const cliOwnerWrites = childLines
			.filter((line) => line.startsWith(WRITE_PREFIX))
			.slice(ownerWritesBeforeCli)
			.map((line) => JSON.parse(line.slice(WRITE_PREFIX.length)) as string);
		check(
			cliOwnerWrites.filter((data) => data.includes(cliToken)).length === 1,
			`app A performed the CLI-entered delivery exactly once (${cliOwnerWrites.length} owner write(s) in this round)`,
		);
		check(
			cliOwnerWrites.filter((data) => data === "\r").length === 1,
			"app A sent exactly one submit CR for the CLI-entered delivery",
		);
		check(
			localWrites === localWritesBeforeCli,
			"app B still never wrote a byte into the pane, even entering through its own CLI socket",
		);
		// The first token must not have been replayed by the second journey.
		check(occurrences(paneOutput, token) === 1, "the earlier token is still present exactly once after the CLI delivery");

		const afterCli = readRecord(PANE_SESSION_ID);
		check(
			afterCli?.host.pid === ready.hostPid && afterCli?.shell.pid === ready.shellPid,
			"host and shell identity survive the CLI-entered delivery too",
		);

		// ── 7. nothing was respawned ──
		const sessionDirs = readdirSync(sessionsRootDir(), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
		const taskDirs = sessionDirs.filter((name) => name.startsWith(`dev3-task-${TASK_ID}`));
		const liveHostPids = new Set(
			sessionDirs
				.map((name) => readRecord(name)?.host.pid ?? -1)
				.filter((pid) => pid > 0 && isProcessAlive(pid)),
		);
		check(taskDirs.length === 1, `exactly ONE registry session directory exists for this task (got ${taskDirs.length})`);
		check(
			liveHostPids.size === 1 && liveHostPids.has(ready.hostPid),
			"exactly one live native host exists, and it is app A's original one",
		);

		// ── 8. tmux was never touched ──
		// The DEFAULT socket is the developer's live one, so its full session list is
		// not ours to compare — only the absence of this task's session name is
		// attributable to us. The throwaway socket IS ours, so there the whole list
		// must be byte-identical before and after.
		if (sentinelAlive) {
			check(
				await tmux.hasSession(sentinelSession, { socket: sentinelSocket }),
				"the pre-existing tmux sentinel session is still alive after the delivery",
			);
			check(
				(await listSessions(sentinelSocket)) === sentinelSocketSessionsBefore,
				"the throwaway socket's session list is unchanged — nothing was created or mutated there",
			);
			check(
				!(await tmux.hasSession(taskSessionName(TASK_ID), { socket: sentinelSocket })),
				"no tmux session named for this task exists on that socket",
			);
		} else {
			console.log("  SKIP - tmux sentinel checks (tmux unavailable on this machine)");
		}
		check(
			!(await hasSessionOrAbsent(taskSessionName(TASK_ID))),
			"no tmux session named for this task exists on the default socket either",
		);
	} finally {
		try {
			observer?.close();
		} catch {
			// best-effort
		}
		try {
			child?.kill("SIGKILL");
		} catch {
			// best-effort
		}
		try {
			await pty.destroyNativeTaskSession(TASK_ID);
		} catch {
			// best-effort
		}
		if (sentinelAlive) {
			try {
				await tmux.killSession(sentinelSession, { socket: sentinelSocket });
			} catch {
				// best-effort
			}
		}
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
}

const run = IS_OWNER ? runOwner : runSender;

run()
	.then(() => {
		if (failures > 0) {
			console.error(`\n${failures} check(s) FAILED`);
			process.exit(1);
		}
		console.log("\nALL CHECKS PASSED");
		process.exit(0);
	})
	.catch((err) => {
		console.error("\nERROR:", err);
		process.exit(1);
	});
