#!/usr/bin/env bun
/**
 * Detached-PTY prototype CLI (spike — see ./README.md). Manual driver + the
 * re-entry point the launcher spawns in host mode.
 *
 *   bun src/bun/prototypes/detached-pty/cli.ts start    # launch detached host
 *   bun src/bun/prototypes/detached-pty/cli.ts status   # discover + query
 *   bun src/bun/prototypes/detached-pty/cli.ts attach   # interactive attach (Ctrl-] detaches)
 *   bun src/bun/prototypes/detached-pty/cli.ts stop      # terminate host + shell tree
 *   bun src/bun/prototypes/detached-pty/cli.ts __host    # internal: the detached host process
 */

import { runHost } from "./host";
import { start, status, stop } from "./launcher";
import { PtyProtoClient } from "./client";
import { readState } from "./state";

async function attach(): Promise<void> {
	const state = readState();
	if (!state) {
		process.stderr.write("no detached-pty host running (run `start` first)\n");
		process.exit(1);
	}
	const client = new PtyProtoClient();
	await client.connect(state);
	client.onOutput((bytes) => process.stdout.write(bytes));

	const stdin = process.stdin;
	stdin.setRawMode?.(true);
	stdin.resume();
	process.stdout.write("[attached — press Ctrl-] to detach]\r\n");

	const detach = (): void => {
		client.close();
		stdin.setRawMode?.(false);
		process.stdout.write("\r\n[detached]\r\n");
		process.exit(0);
	};
	stdin.on("data", (d: Buffer) => {
		if (d.length === 1 && d[0] === 0x1d) {
			detach(); // Ctrl-]
			return;
		}
		client.input(new Uint8Array(d));
	});

	const pushSize = (): void => client.resize(process.stdout.columns || 80, process.stdout.rows || 24);
	pushSize();
	process.stdout.on("resize", pushSize);
}

async function main(): Promise<void> {
	const cmd = process.argv[2];
	switch (cmd) {
		case "__host":
			// Stays alive via the WebSocket server + PTY handles; never resolves out.
			await runHost();
			break;
		case "start": {
			const s = await start();
			process.stdout.write(
				`detached host started\n  hostPid=${s.hostPid} shellPid=${s.shellPid}\n  endpoint=ws://${s.host}:${s.port}\n  token=${s.token}\n`,
			);
			process.exit(0);
			break;
		}
		case "status": {
			const r = await status();
			if (!r.running) {
				process.stdout.write("not running\n");
				process.exit(0);
			}
			process.stdout.write(
				`running hostPid=${r.state?.hostPid} shellPid=${r.state?.shellPid} port=${r.state?.port} alive=${r.live?.alive ?? "unknown"}\n`,
			);
			process.exit(0);
			break;
		}
		case "attach":
			await attach();
			break;
		case "stop": {
			const ok = await stop();
			process.stdout.write(ok ? "stopped\n" : "nothing to stop (or failed)\n");
			process.exit(ok ? 0 : 1);
			break;
		}
		default:
			process.stdout.write("usage: cli.ts start|status|attach|stop|__host\n");
			process.exit(2);
	}
}

void main().catch((err) => {
	process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
