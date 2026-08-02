#!/usr/bin/env bun
/**
 * Disposable APP CONTROLLER for the cross-instance owner-routing proof (seq 1381).
 *
 * Each invocation models ONE dev3 app process against a shared `~/.dev3.0`
 * (decision 022 — a dev build runs beside the installed app). The point of using
 * separate processes rather than two clients in one is that the writer lease is
 * granted per CONNECTION but resolved by PID: `resolvePaneOwner` only means
 * anything when the owner's pid is genuinely another process with its own socket
 * in `${DEV3_HOME}/sockets`.
 *
 *   own      controller A — start the session, take the writer lease, and serve
 *            the CLI's NDJSON request protocol on `<pid>.sock` so a peer can hand
 *            it work. Stays alive (holding the lease) until stdin closes.
 *   route    controller B — bind the SAME pane through the production
 *            `bindNativeTaskPane`, land as an observer, resolve the owner from
 *            the HOST, and forward one delivery to A. Also proves its own direct
 *            write is refused, so the delivery cannot land twice.
 *   observe  controller C — a reopened second viewer: rediscover from disk alone,
 *            replay the journal, and count what actually reached the PTY.
 *
 * The JSON verdict goes to stdout behind a sentinel; human logs go to stderr.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEV3_HOME } from "../../paths";
import {
	cliEndpointFileName,
	CLI_ENDPOINT_VERSION,
	CLI_LOOPBACK_HOST,
	serializeCliEndpointRecord,
} from "../../../shared/cli-endpoint";
import { forwardToOwner, peerEndpointForPid, resolvePaneOwner } from "../../native-pane-owner";
import { bindNativeTaskPane } from "../../native-task-terminal";
import { NativeSessionClient } from "../client";
import { readRecord, readToken } from "../record";
import { start, stop } from "../registry";
import type { ErrorMessage } from "../protocol";
import {
	decodeShellLaunchSpec,
	defaultNativeShellLaunchSpec,
	NATIVE_SESSION_LAUNCH_ENV,
	type ShellLaunchSpec,
} from "../shell-launch";
import { sendUntilObserved, SHELL_WARMUP_PROBE } from "./command-roundtrip";

const JSON_SENTINEL = "__OWNER_ROUTING_JSON__";
/** The method A serves and B forwards — a stand-in for whatever delivery a
 * caller routes; the contract under test is the routing, not the payload. */
export const FORWARDED_METHOD = "pane.write";
const isWindows = process.platform === "win32";
const lineEnd = isWindows ? "\r" : "\n";
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function emit(verdict: Record<string, unknown>): void {
	process.stdout.write(`${JSON_SENTINEL}${JSON.stringify(verdict)}\n`);
}

function log(message: string): void {
	process.stderr.write(`[${process.pid}] ${message}\n`);
}

function launchSpec(): ShellLaunchSpec {
	const explicit = process.env[NATIVE_SESSION_LAUNCH_ENV];
	if (explicit) return decodeShellLaunchSpec(explicit);
	return defaultNativeShellLaunchSpec({ platform: process.platform, cwd: process.cwd(), env: process.env });
}

/**
 * Echo a marker from the shell. The marker is assembled from two halves inside
 * the command, so the whole string exists ONLY in the shell's output and never
 * in the echoed command line — that is what makes counting occurrences a sound
 * "delivered exactly once" proof.
 */
function echoCommand(marker: string): string {
	const cut = Math.ceil(marker.length / 2);
	const head = marker.slice(0, cut);
	const tail = marker.slice(cut);
	return isWindows ? `Write-Output ("${head}" + "${tail}")` : `printf '%s%s\\n' '${head}' '${tail}'`;
}

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

/** Everything this process saw on the PTY, plus a way to wait for a marker. */
function makeSink(client: NativeSessionClient): { text: () => string; waitFor: (needle: string, ms: number) => Promise<boolean> } {
	let output = "";
	const decoder = new TextDecoder();
	client.onOutput((bytes) => {
		output += decoder.decode(bytes, { stream: true });
	});
	return {
		text: () => output,
		async waitFor(needle, ms) {
			const deadline = Date.now() + ms;
			while (Date.now() <= deadline) {
				if (output.includes(needle)) return true;
				await delay(25);
			}
			return output.includes(needle);
		},
	};
}

// ── Phase: own ───────────────────────────────────────────────────────────────

/**
 * The CLI's request/response protocol, only enough of it to be a real peer: one
 * NDJSON request per line in, one reply line out. A only ever performs the work
 * it is handed — it never echoes it back to the caller to perform as well.
 *
 * Publishes itself where `peerEndpointForPid` looks: a `<pid>.sock` on POSIX,
 * and on Windows — which has no unix-domain sockets — a loopback listener plus
 * the `<pid>.endpoint.json` record the CLI transport already uses (decision 172).
 */
function serveAsOwner(perform: (params: Record<string, unknown>) => Promise<unknown>): string {
	const handlers = {
		data(socket: { write(data: string): unknown }, chunk: Uint8Array) {
			const line = new TextDecoder().decode(chunk).trim();
			if (!line) return;
			let request: { id?: string; method?: string; params?: Record<string, unknown>; token?: string };
			try {
				request = JSON.parse(line);
			} catch {
				socket.write(`${JSON.stringify({ ok: false, error: "unparseable request" })}\n`);
				return;
			}
			const id = request.id ?? "";
			if (request.method !== FORWARDED_METHOD) {
				socket.write(`${JSON.stringify({ id, ok: false, error: `unknown method ${request.method}` })}\n`);
				return;
			}
			void perform(request.params ?? {})
				.then((data) => socket.write(`${JSON.stringify({ id, ok: true, data })}\n`))
				.catch((err) => socket.write(`${JSON.stringify({ id, ok: false, error: String(err) })}\n`));
		},
		error() { /* a peer hanging up mid-request is the caller's problem */ },
	};

	const socketsDir = join(DEV3_HOME, "sockets");
	mkdirSync(socketsDir, { recursive: true });

	if (!isWindows) {
		const socketPath = join(socketsDir, `${process.pid}.sock`);
		Bun.listen({ unix: socketPath, socket: handlers } as never);
		return socketPath;
	}

	const server = Bun.listen({ hostname: CLI_LOOPBACK_HOST, port: 0, socket: handlers } as never) as { port: number };
	const endpointPath = join(socketsDir, cliEndpointFileName(process.pid));
	writeFileSync(
		endpointPath,
		serializeCliEndpointRecord({
			v: CLI_ENDPOINT_VERSION,
			pid: process.pid,
			host: CLI_LOOPBACK_HOST,
			port: server.port,
			token: `owner-routing-${process.pid}`,
			hostTaskId: null,
			startedAt: new Date().toISOString(),
		}),
	);
	return endpointPath;
}

async function phaseOwn(sessionId: string): Promise<void> {
	const started = await start(sessionId, { launch: launchSpec(), timeoutMs: 20_000 });
	const token = readToken(sessionId);
	if (!token) throw new Error("no session token after start");

	const client = new NativeSessionClient();
	const sink = makeSink(client);
	await client.connect(started.record, token);

	// Wait for a live prompt before anyone measures what lands on the PTY.
	const warmup = `OWNER-READY-${process.pid}`;
	const observed = await sendUntilObserved({
		send: () => client.input(`${echoCommand(warmup)}${lineEnd}`),
		observe: () => (occurrences(sink.text(), warmup) >= 1 ? warmup : null),
		...SHELL_WARMUP_PROBE,
	});
	if (!observed) throw new Error("owner shell never produced its warm-up marker");

	// Deliver EXACTLY what we were handed, one time, through our own lease.
	let performed = 0;
	const socketPath = serveAsOwner(async (params) => {
		const text = typeof params.text === "string" ? params.text : "";
		performed++;
		client.input(`${echoCommand(text)}${lineEnd}`);
		return { delivered: true, performedBy: process.pid, performed };
	});

	emit({
		phase: "own",
		pid: process.pid,
		role: client.getRole(),
		hostPid: started.record.host.pid,
		shellPid: started.record.shell.pid,
		sessionId: started.record.sessionId,
		paneId: started.record.paneId,
		socketPath,
		// Proof the peer lookup would find US — the same call B makes about A.
		selfEndpoint: peerEndpointForPid(process.pid),
	});

	// Hold the lease until the driver signals; exiting would free it, and the whole
	// point is that B never gets to write while A is alive. The ceiling is a
	// stranded-process guard, never reached on a passing run.
	log("owner ready, holding the writer lease");
	await new Promise<void>((resolve) => {
		process.on("SIGTERM", () => resolve());
		process.on("SIGINT", () => resolve());
		setTimeout(resolve, 120_000).unref?.();
	});
	log("owner released");
	client.close();
}

// ── Phase: route ─────────────────────────────────────────────────────────────

async function phaseRoute(sessionId: string, ownerPid: number, marker: string, directMarker: string): Promise<void> {
	const refusals: ErrorMessage[] = [];
	const terminal = await bindNativeTaskPane(sessionId, {
		onOutput: () => { /* B is a viewer; the driver reads the PTY through phase observe */ },
		onClosed: () => log("binding closed"),
	});
	if (!terminal) throw new Error("second process could not bind the pane");

	// A direct write from a non-owning process is what used to vanish silently
	// while the UI reported success. It must still not reach the PTY.
	terminal.write(`${echoCommand(directMarker)}${lineEnd}`);
	await delay(300);

	const owner = await resolvePaneOwner(terminal);
	let forwarded: unknown = null;
	let forwardError: string | null = null;
	if (owner.kind === "peer") {
		try {
			forwarded = await forwardToOwner(owner, FORWARDED_METHOD, { text: marker });
		} catch (err) {
			forwardError = String(err);
		}
	}

	emit({
		phase: "route",
		pid: process.pid,
		ownerKind: owner.kind,
		ownerPid: owner.kind === "peer" ? owner.pid : null,
		ownerEndpoint: owner.kind === "peer" ? owner.endpoint : null,
		expectedOwnerPid: ownerPid,
		role: terminal.hostRole(),
		writerAttached: terminal.hostWriterAttached(),
		hostPid: terminal.hostPid,
		shellPid: terminal.shellPid,
		paneId: terminal.paneId,
		forwarded,
		forwardError,
		refusals: refusals.length,
	});
	terminal.detach();
}

// ── Phase: observe ───────────────────────────────────────────────────────────

async function phaseObserve(sessionId: string, marker: string, directMarker: string): Promise<void> {
	const record = readRecord(sessionId);
	const client = await NativeSessionClient.discover(sessionId);
	const sink = makeSink(client);
	// The journal replays on attach; give the forwarded delivery a moment to land
	// if it is still in flight, then count what the PTY actually produced.
	await sink.waitFor(marker, 5000);
	await delay(300);

	emit({
		phase: "observe",
		pid: process.pid,
		role: client.getRole(),
		hostPid: record?.host.pid ?? -1,
		shellPid: record?.shell.pid ?? -1,
		paneId: record?.paneId ?? "",
		// Each marker is echoed by the shell, so a correct delivery shows up as the
		// command line plus its output: two occurrences, once.
		markerCount: occurrences(sink.text(), marker),
		directMarkerCount: occurrences(sink.text(), directMarker),
		replayedBytes: sink.text().length,
	});
	client.close();
}

// ── Entry ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const [phase, sessionId, arg] = process.argv.slice(2);
	const marker = process.env.DEV3_OWNER_ROUTING_MARKER ?? "ROUTED";
	const directMarker = process.env.DEV3_OWNER_ROUTING_DIRECT_MARKER ?? "DIRECT";
	if (phase === "own") return phaseOwn(sessionId);
	if (phase === "route") return phaseRoute(sessionId, Number(arg), marker, directMarker);
	if (phase === "observe") return phaseObserve(sessionId, marker, directMarker);
	if (phase === "stop") {
		// Teardown from a clean process, the way a later app instance would.
		emit({ phase: "stop", stopped: await stop(sessionId, { timeoutMs: 8000 }) });
		return;
	}
	throw new Error(`unknown phase ${phase}`);
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		log(`ERROR: ${String(error)}`);
		emit({ phase: "error", error: String(error) });
		process.exit(1);
	});
