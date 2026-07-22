#!/usr/bin/env bun
/**
 * Manual driver + host re-entry for the native-session registry (seq 1214).
 * NOT wired into the production `dev3` CLI (src/cli/main.ts) — a dev-only driver.
 *
 *   bun src/bun/native-terminal-registry/cli.ts start <id> [--live-parser] [--state-tap]
 *   bun src/bun/native-terminal-registry/cli.ts list                # discover all sessions
 *   bun src/bun/native-terminal-registry/cli.ts status <id>         # discover + query one
 *   bun src/bun/native-terminal-registry/cli.ts attach <id>         # interactive attach (Ctrl-] detaches)
 *   bun src/bun/native-terminal-registry/cli.ts parser-state <id>   # reconstructed semantic screen (seq 1228)
 *   bun src/bun/native-terminal-registry/cli.ts stop <id>           # stop one session's tree
 *   bun src/bun/native-terminal-registry/cli.ts __host <id>         # internal: the detached host
 */

import { NativeSessionClient } from "./client";
import { resolveHostConfig, runHost } from "./host";
import { readParserState } from "./parser-state";
import { readRecord, readToken } from "./record";
import { list, start, status, stop } from "./registry";

function requireId(): string {
	const id = positionalArgs()[1];
	if (!id) {
		process.stderr.write("usage: cli.ts <command> <sessionId>\n");
		process.exit(2);
	}
	return id;
}

/** argv after the runtime/script entries, with `--flags` filtered out. */
function positionalArgs(): string[] {
	return process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
}

function hasFlag(flag: string): boolean {
	return process.argv.includes(flag);
}

async function attach(sessionId: string): Promise<void> {
	const record = readRecord(sessionId);
	const token = readToken(sessionId);
	if (!record || !token) {
		process.stderr.write(`no live native session ${sessionId} (run \`start ${sessionId}\` first)\n`);
		process.exit(1);
	}
	const client = new NativeSessionClient();
	client.onOutput((bytes) => process.stdout.write(bytes));
	await client.connect(record, token);

	const stdin = process.stdin;
	stdin.setRawMode?.(true);
	stdin.resume();
	client.onError((error) => {
		process.stdout.write(`\r\n[${error.code}${error.message ? `: ${error.message}` : ""}]\r\n`);
	});
	process.stdout.write(`[attached as ${client.getRole() ?? "observer"} — Ctrl-\\ claims/releases writer; Ctrl-] detaches]\r\n`);

	const pushSize = (): void => {
		if (client.getRole() === "writer") client.resize(process.stdout.columns || 80, process.stdout.rows || 24);
	};

	const detach = (): void => {
		process.stdout.off("resize", pushSize);
		client.close();
		stdin.setRawMode?.(false);
		process.stdout.write("\r\n[detached]\r\n");
		process.exit(0);
	};
	let ownershipChangePending = false;
	const toggleOwnership = async (): Promise<void> => {
		if (ownershipChangePending) return;
		ownershipChangePending = true;
		try {
			if (client.getRole() === "writer") {
				await client.releaseWriter();
				process.stdout.write("\r\n[writer ownership released]\r\n");
			} else {
				await client.claimWriter();
				process.stdout.write("\r\n[writer ownership claimed]\r\n");
				pushSize();
			}
		} catch {
			// The host's compact conflict error is printed by onError.
		} finally {
			ownershipChangePending = false;
		}
	};
	stdin.on("data", (d: Buffer) => {
		if (d.length === 1 && d[0] === 0x1d) {
			detach(); // Ctrl-]
			return;
		}
		if (d.length === 1 && d[0] === 0x1c) {
			void toggleOwnership(); // Ctrl-\
			return;
		}
		client.input(new Uint8Array(d));
	});

	pushSize();
	process.stdout.on("resize", pushSize);
}

async function main(): Promise<void> {
	const cmd = positionalArgs()[0];
	switch (cmd) {
		case "__host": {
			process.env.DEV3_NATIVE_SESSION_ID = positionalArgs()[1] ?? process.env.DEV3_NATIVE_SESSION_ID;
			await runHost(resolveHostConfig()); // stays alive via WebSocket + PTY handles
			break;
		}
		case "start": {
			const id = requireId();
			const result = await start(id, {
				liveParser: hasFlag("--live-parser"),
				stateTap: hasFlag("--state-tap"),
			});
			const r = result.record;
			process.stdout.write(
				`${result.status} sessionId=${r.sessionId} paneId=${r.paneId}\n` +
					`  hostPid=${r.host.pid} shellPid=${r.shell.pid}\n` +
					`  endpoint=${r.endpoint.transport}://${r.endpoint.address}:${r.endpoint.port}\n`,
			);
			process.exit(0);
			break;
		}
		case "list": {
			const sessions = await list();
			if (sessions.length === 0) process.stdout.write("no native sessions\n");
			for (const s of sessions) {
				process.stdout.write(
					`${s.sessionId}\tstate=${s.state}\thostPid=${s.record.host.pid}\tshellPid=${s.record.shell.pid}\tport=${s.record.endpoint.port}\n`,
				);
			}
			process.exit(0);
			break;
		}
		case "status": {
			const id = requireId();
			const r = await status(id);
			if (!r.running) {
				process.stdout.write(`not running${r.verdict ? ` (${r.verdict})` : ""}\n`);
				process.exit(0);
			}
			process.stdout.write(
				`running sessionId=${id} hostPid=${r.record?.host.pid} shellPid=${r.record?.shell.pid} alive=${r.live?.alive ?? "unknown"}\n`,
			);
			process.exit(0);
			break;
		}
		case "attach":
			await attach(requireId());
			break;
		case "parser-state": {
			// Fresh-client reconstruction path: read the bounded semantic snapshot.
			const state = readParserState(requireId());
			if (!state) {
				process.stderr.write("no parser state (was the session started with --live-parser?)\n");
				process.exit(1);
			}
			process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
			process.exit(0);
			break;
		}
		case "stop": {
			const ok = await stop(requireId());
			process.stdout.write(ok ? "stopped\n" : "nothing to stop (or failed)\n");
			process.exit(ok ? 0 : 1);
			break;
		}
		default:
			process.stdout.write(
				"usage: cli.ts start [--live-parser] [--state-tap]|list|status|attach|parser-state|stop <sessionId>\n",
			);
			process.exit(2);
	}
}

void main().catch((err) => {
	process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
