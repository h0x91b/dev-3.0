import { mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import QRCode from "qrcode";
import type { ParsedArgs } from "../args";
import type { RemoteAccessInfo } from "../../shared/types";
import { exitError, exitUsage, printDetail } from "../output";
import { rejectUnknownFlags } from "../flag-validation";
import { sendRequest } from "../socket-client";
import { installRemoteService, uninstallRemoteService } from "./remote-service";
import { CLI_EXIT_CODE_APP_NOT_RUNNING } from "../../shared/cli-exit-codes";
import {
	REMOTE_DIR,
	REMOTE_LOG_FILE,
	acquireStartLock,
	clearRemoteState,
	isProcessAlive,
	readRemoteState,
	releaseStartLock,
} from "../../bun/remote-state";

const REMOTE_HELP = `dev3 remote — run dev-3.0 in headless mode with a browser UI.

Usage:
  dev3 remote [start] [--detach] [--no-tunnel] [--expose-ports=<ports>] [--port <n>] [--views-dir <path>]
  dev3 remote status
  dev3 remote url
  dev3 remote stop
  dev3 remote install-service [--port <n>] [--no-tunnel] [--no-start]
  dev3 remote uninstall-service

  (default subcommand is "start"; bare "dev3 remote" runs the server in the foreground)

What it does:
  Starts a Bun-only dev-3.0 server (no GUI window) and serves the full web UI
  to any browser over HTTP + WebSocket. Prints an ASCII QR code and an access
  URL signed with a short-lived (30s, single-use) JWT token — the QR is
  auto-refreshed every 25 seconds, matching the GUI modal's behavior.

  By default a Cloudflare quick tunnel (trycloudflare.com) is started and its
  public URL is included in the QR, so you can connect from any device without
  setting up SSH port-forwarding. \`cloudflared\` is installed as a brew
  dependency. Pass --no-tunnel for local-only mode (LAN + SSH forward only).

Subcommands:
  start (default)     Start the headless server. Add --detach to run it in the
                      background (survives the current shell), then exit.
  status              Show whether a server is running, its PID, port, and uptime.
  url                 Print a fresh access URL + QR for the running server. Handy
                      from a new SSH session to re-scan without rerunning start.
  stop                Stop the background server (SIGTERM, then SIGKILL fallback).
  install-service     (Linux) Install + enable a systemd --user unit so the
                      server survives logout and starts on boot. Accepts the
                      same start flags (e.g. --port, --no-tunnel). The unit runs
                      in the foreground under systemd — do NOT pass --detach.
  uninstall-service   (Linux) Stop, disable, and remove the systemd --user unit.

Flags (start):
  --detach
      Run the server in the background and return to the shell immediately.
      stdout/stderr are redirected to ${REMOTE_LOG_FILE}.
      Use \`dev3 remote url\` to get the access link and \`dev3 remote stop\`
      to shut it down. Ideal for remote Linux boxes reached over SSH.

  --no-tunnel
      Skip the Cloudflare quick tunnel — only LAN + SSH-forward URLs are
      shown. Use this when the machine is already on a trusted network and
      you don't want to expose anything to the public internet, or when
      \`cloudflared\` is unavailable.

  --expose-ports=<csv>
      Comma-separated list of dev-server ports to expose via Cloudflare quick
      tunnels at startup (one tunnel per port, each with its own random
      \`*.trycloudflare.com\` URL). Retries every 2 s for 60 s until the port
      is actually listening. Useful for headless boxes where you can't click
      the GUI \`Expose\` button.
      Example: --expose-ports=3000,5173

  --port <n>
      Bind to a fixed TCP port instead of a random one. Useful when running
      inside Docker (so you can publish \`-p <n>:<n>\`) or when you want to
      preconfigure an SSH \`-L\` forward without scraping the banner line.
      Valid range: 1-65535. Defaults to a random free port.

  --views-dir <path>
      Override the directory served as static assets (defaults to the
      dist/ next to the binary, or the current working directory's ./dist).

  --static-code=<value>
      Use a fixed access code instead of a rotating short-lived JWT.
      The QR/URL token will be exactly <value>; auto-refresh is disabled.
      For local dev only — do NOT expose a static code on the public
      internet. Minimum length: 4 characters.

Connection options shown on startup:
  ① Public tunnel URL (Cloudflare quick tunnel, unless --no-tunnel)
  ② LAN — scan the QR from any device on the same network
  ③ SSH port-forward — \`ssh -L <port>:localhost:<port> user@<server>\`

  Tunnel is the easiest to use from anywhere. SSH is the most private — no
  public exposure, uses your existing SSH credentials, browser points at
  http://localhost.

Examples:
  dev3 remote                              # Cloudflare tunnel + LAN + SSH forwarding
  dev3 remote --detach                     # run in background, return to shell
  dev3 remote url                          # print a fresh QR/URL for the running server
  dev3 remote stop                         # shut the background server down
  dev3 remote install-service --port 3017  # (Linux) run as a systemd --user service
  dev3 remote uninstall-service            # (Linux) remove the systemd --user service
  dev3 remote --no-tunnel                  # LAN + SSH only (no public URL)
  dev3 remote --port 3000                  # fixed port (ideal for Docker -p 3000:3000)
  dev3 remote --expose-ports=3000,5173     # also expose dev-server ports publicly
`;

export async function handleRemote(subcommand: string | undefined, args: ParsedArgs): Promise<void> {
	if (args.flags.help === "true" || args.flags.h === "true") {
		process.stdout.write(REMOTE_HELP);
		return;
	}

	switch (subcommand) {
		case undefined:
		case "start":
			return startRemote(args);
		case "status":
			return statusRemote(args);
		case "url":
			return urlRemote(args);
		case "stop":
			return stopRemote(args);
		case "install-service":
			return installRemoteService(args);
		case "uninstall-service":
			return uninstallRemoteService(args);
		default:
			exitUsage(
				`Unknown subcommand: remote ${subcommand}\n` +
				"Available: dev3 remote [start], dev3 remote status, dev3 remote url, dev3 remote stop,\n" +
				"           dev3 remote install-service, dev3 remote uninstall-service\n" +
				'Run "dev3 remote --help" for usage.',
			);
	}
}

/**
 * Validate `dev3 remote` start flags and collect the DEV3_REMOTE_* env the
 * headless server reads at boot. Exits (exitUsage) on the first invalid flag
 * BEFORE returning, so a bad flag never pollutes process.env (foreground path)
 * nor detaches a child that would immediately die (--detach path).
 */
function collectRemoteEnv(args: ParsedArgs): Record<string, string> {
	const remoteEnv: Record<string, string> = {};
	if (args.flags["no-tunnel"] === "true") {
		remoteEnv.DEV3_REMOTE_NO_TUNNEL = "1";
	}
	if (args.flags["views-dir"] && args.flags["views-dir"] !== "true") {
		remoteEnv.DEV3_VIEWS_DIR = args.flags["views-dir"];
	}
	if (args.flags.port !== undefined) {
		if (args.flags.port === "true") {
			exitUsage(`--port requires a value: --port <1-65535>`);
		}
		const n = Number.parseInt(args.flags.port, 10);
		if (!Number.isFinite(n) || n < 1 || n > 65535 || String(n) !== args.flags.port.trim()) {
			exitUsage(`--port must be an integer in 1-65535 (got "${args.flags.port}")`);
		}
		remoteEnv.DEV3_REMOTE_PORT = String(n);
	}
	if (args.flags["static-code"] && args.flags["static-code"] !== "true") {
		const code = args.flags["static-code"];
		if (code.length < 4) {
			exitUsage(`--static-code must be at least 4 characters (got "${code}")`);
		}
		remoteEnv.DEV3_REMOTE_STATIC_CODE = code;
	} else if (args.flags["static-code"] === "true") {
		exitUsage(`--static-code requires a value: --static-code=<your-code>`);
	}
	if (args.flags["expose-ports"] !== undefined) {
		if (args.flags["expose-ports"] === "true") {
			exitUsage(`--expose-ports requires a value: --expose-ports=3000,5173`);
		}
		const raw = args.flags["expose-ports"];
		const ports: number[] = [];
		for (const part of raw.split(",")) {
			const trimmed = part.trim();
			const n = Number.parseInt(trimmed, 10);
			if (!Number.isFinite(n) || n < 1 || n > 65535 || String(n) !== trimmed) {
				exitUsage(`--expose-ports: invalid port "${trimmed}" (must be integer in 1-65535)`);
			}
			ports.push(n);
		}
		if (ports.length === 0) {
			exitUsage(`--expose-ports: at least one port required`);
		}
		remoteEnv.DEV3_REMOTE_EXPOSE_PORTS = ports.join(",");
	}
	return remoteEnv;
}

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// ── start ────────────────────────────────────────────────────────────────────

async function startRemote(args: ParsedArgs): Promise<void> {
	if (args.positional.length > 0) {
		exitUsage(`Unknown positional argument: "${args.positional[0]}"\nRun "dev3 remote --help" for usage.`);
	}
	rejectUnknownFlags(args, [
		"no-tunnel", "views-dir", "static-code", "port", "expose-ports", "detach", "help", "h",
	]);

	const remoteEnv = collectRemoteEnv(args); // validates; exits on a bad flag

	if (args.flags.detach === "true") {
		await startDetached();
		return;
	}

	// Foreground: boot the headless server IN-PROCESS (single-binary model, #744).
	// `dev3` and the old standalone `dev3-server` are one binary now; the server
	// lives behind this dynamic import so it stays out of the CLI's static startup
	// graph (a guard test enforces this — see __tests__/cli-startup-graph.test.ts).
	// DEV3_HEADLESS must be set BEFORE the import so the electrobun-platform shim
	// short-circuits to no-op stubs; `await import()` is a statement, so it never
	// hoists above these assignments. headless-entry boots on import and keeps the
	// process alive via its own handles, so this import never resolves until the
	// server stops.
	Object.assign(process.env, remoteEnv);
	process.env.DEV3_HEADLESS = "1";
	await import("../../bun/headless-entry");
}

async function startDetached(): Promise<void> {
	// Hold an exclusive start lock across the whole check → spawn → readiness-wait
	// window. The lifecycle state file is a singleton, so without this two
	// simultaneous `--detach` launches could both pass the "already running?"
	// check and orphan each other's server (F4). The lock is held until the child
	// has recorded its state — at which point the state file itself enforces
	// uniqueness — then released.
	const lockFd = acquireStartLock();
	if (lockFd === null) {
		exitError(
			"Another `dev3 remote --detach` is already starting up.",
			"Wait a moment and retry, or check `dev3 remote status`.",
		);
		return;
	}
	let lockReleased = false;
	const releaseLock = (): void => {
		if (lockReleased) return;
		lockReleased = true;
		releaseStartLock(lockFd);
	};

	try {
		// Refuse to launch a second managed server — see the lock comment above.
		const existing = readRemoteState();
		if (existing && isProcessAlive(existing.pid)) {
			releaseLock();
			exitError(
				`A dev3 remote server is already running (pid ${existing.pid}, port ${existing.port}).`,
				"Use `dev3 remote url` to get its link, or `dev3 remote stop` to shut it down first.",
			);
		}
		if (existing) clearRemoteState(); // stale record from a dead server

		mkdirSync(REMOTE_DIR, { recursive: true });
		const logFd = openSync(REMOTE_LOG_FILE, "a");

		// Single-binary model: re-run THIS invocation's `remote` command WITHOUT
		// --detach, detached, so the child boots the server in-process (dev:
		// `bun <main.ts> remote …`; prod: the `dev3` binary) and survives the
		// shell. process.execPath is the runtime (bun or the compiled binary);
		// process.argv[1:] is our own command line, which already contains
		// "remote" + the user's flags — we only strip --detach.
		const childArgs = process.argv.slice(1).filter((a) => a !== "--detach");
		const childEnv: NodeJS.ProcessEnv = { ...process.env, DEV3_REMOTE_LOG_FILE: REMOTE_LOG_FILE };
		const child = spawn(process.execPath, childArgs, {
			stdio: ["ignore", logFd, logFd],
			env: childEnv,
			detached: true,
		});

		// A ChildProcess emits "error" (not "exit") when the binary can't be
		// executed at all — ENOENT, EACCES, wrong arch (EBADARCH), AV quarantine.
		// Without a listener Node re-throws it as an uncaught exception, crashing
		// the CLI with a raw stack trace instead of our friendly message (F2).
		let childExited = false;
		let startupErrorMessage: string | null = null;
		child.on("error", (err) => { childExited = true; startupErrorMessage = err.message; });
		child.on("exit", (code) => { childExited = true; void code; });
		child.unref();

		const pid = child.pid;
		process.stdout.write(`Starting dev3 remote in the background (pid ${pid ?? "?"})…\n`);

		// Wait for the server to write its lifecycle state.
		const deadlineMs = Date.now() + 20_000;
		let recorded: ReturnType<typeof readRemoteState> = null;
		while (Date.now() < deadlineMs) {
			if (childExited) {
				releaseLock();
				exitError(
					"The background server exited during startup.",
					startupErrorMessage
						? `Could not start it: ${startupErrorMessage}`
						: `Check the log for details:\n  ${REMOTE_LOG_FILE}`,
				);
			}
			const state = readRemoteState();
			if (state && state.pid === pid && state.port > 0) {
				recorded = state;
				break;
			}
			await delay(250);
		}

		// State is recorded (or we timed out) — the state file now guards
		// uniqueness, so we can drop the lock before the slower URL fetch.
		releaseLock();

		if (!recorded) {
			// Started but never reported in — likely slow startup. Don't fail;
			// point the user at status/log so we don't hang forever.
			process.stdout.write(
				`Server started (pid ${pid ?? "?"}) but did not report readiness within 20s.\n` +
				`Check \`dev3 remote status\` or the log at ${REMOTE_LOG_FILE}.\n`,
			);
			process.exit(0);
		}

		try {
			await printAccessForState(recorded.socketPath, {
				header: `dev3 remote is running in the background (pid ${pid}, port ${recorded.port}).`,
				withQr: true,
				notRunningIsFatal: false, // server IS alive (state recorded) — a lagging socket is "booting", not "dead"
			});
		} catch (err) {
			if (err instanceof Error && err.message === "APP_NOT_RUNNING") {
				// The server recorded its state but its CLI socket isn't accepting
				// yet. It's booting, not dead — don't clear state or fail hard.
				process.stdout.write(
					`Server is running (pid ${pid}, port ${recorded.port}) but the link isn't ready yet.\n` +
					`Run \`dev3 remote url\` in a moment for the QR + URL.\n`,
				);
				process.exit(0);
			}
			throw err;
		}
		process.stdout.write(
			`\nManage it with:  dev3 remote url   (fresh link)\n` +
			`                 dev3 remote status\n` +
			`                 dev3 remote stop\n` +
			`Logs:  ${REMOTE_LOG_FILE}\n`,
		);
		process.exit(0);
	} finally {
		// Backstop: process.exit() above skips finally in production, but exitError
		// throws under test — make sure the lock never leaks there.
		releaseLock();
	}
}

// ── status ─────────────────────────────────────────────────────────────────

async function statusRemote(args: ParsedArgs): Promise<void> {
	rejectUnknownFlags(args, ["help", "h"]);

	const state = readRemoteState();
	if (!state) {
		process.stdout.write("No dev3 remote server is running.\n");
		process.exit(0);
	}
	if (!isProcessAlive(state.pid)) {
		clearRemoteState();
		process.stdout.write("No dev3 remote server is running (cleared a stale record).\n");
		process.exit(0);
	}

	const uptime = state.startedAt ? formatUptime(state.startedAt) : "unknown";
	const fields: Array<[string, string]> = [
		["State:", "running"],
		["PID:", String(state.pid)],
		["Port:", String(state.port)],
		["Uptime:", uptime],
		["Tunnel:", state.tunnelRequested ? "requested" : "disabled (--no-tunnel)"],
		["Static code:", state.staticCode ? "yes (rotation disabled)" : "no (rotating JWT)"],
		["Version:", state.version || "unknown"],
	];
	if (state.logFile) fields.push(["Log:", state.logFile]);
	printDetail(fields);

	// Best-effort: append a fresh access URL if the server's socket answers.
	try {
		const resp = await sendRequest(state.socketPath, "remote.accessUrl", {});
		if (resp.ok) {
			const info = resp.data as RemoteAccessInfo;
			process.stdout.write(`\nAccess URL (fresh token):\n  ${info.url}\n`);
			if (info.tunnelUrl) process.stdout.write(`Public tunnel:\n  ${info.tunnelUrl}\n`);
		}
	} catch {
		// Socket unreachable but PID alive — server may still be booting. The
		// PID/port above are enough; `dev3 remote url` retries the link.
	}
	process.exit(0);
}

// ── url ──────────────────────────────────────────────────────────────────────

async function urlRemote(args: ParsedArgs): Promise<void> {
	rejectUnknownFlags(args, ["help", "h"]);

	const state = readRemoteState();
	if (!state || !isProcessAlive(state.pid)) {
		if (state) clearRemoteState();
		exitError(
			"No dev3 remote server is running.",
			"Start one with `dev3 remote` (add --detach to run it in the background).",
			CLI_EXIT_CODE_APP_NOT_RUNNING,
		);
	}

	await printAccessForState(state.socketPath, {
		header: `dev3 remote (pid ${state.pid}, port ${state.port}):`,
		withQr: true,
		notRunningIsFatal: true,
	});
	process.exit(0);
}

// ── stop ─────────────────────────────────────────────────────────────────────

async function stopRemote(args: ParsedArgs): Promise<void> {
	rejectUnknownFlags(args, ["help", "h"]);

	const state = readRemoteState();
	if (!state) {
		process.stdout.write("No dev3 remote server is running.\n");
		process.exit(0);
	}
	if (!isProcessAlive(state.pid)) {
		clearRemoteState();
		process.stdout.write("No dev3 remote server is running (cleared a stale record).\n");
		process.exit(0);
	}

	try {
		process.kill(state.pid, "SIGTERM");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EPERM") {
			exitError(`Cannot stop server (pid ${state.pid}) — it is owned by another user.`);
		}
		// ESRCH: it died between our liveness check and the signal — treat as stopped.
		clearRemoteState();
		process.stdout.write(`dev3 remote server (pid ${state.pid}) was already stopped.\n`);
		process.exit(0);
	}

	// Wait for graceful exit, then escalate to SIGKILL.
	const graceMs = Date.now() + 8_000;
	while (Date.now() < graceMs) {
		if (!isProcessAlive(state.pid)) {
			clearRemoteState();
			process.stdout.write(`Stopped dev3 remote server (pid ${state.pid}).\n`);
			process.exit(0);
		}
		await delay(200);
	}

	try {
		process.kill(state.pid, "SIGKILL");
	} catch { /* already gone */ }
	clearRemoteState();
	process.stdout.write(`Force-stopped dev3 remote server (pid ${state.pid}) after it ignored SIGTERM.\n`);
	process.exit(0);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Ask a running server (over its CLI socket) for a fresh access URL and print it.
 * Exported for unit tests (F6: notRunningIsFatal contract).
 */
export async function printAccessForState(
	socketPath: string,
	opts: { header: string; withQr: boolean; notRunningIsFatal?: boolean },
): Promise<void> {
	let info: RemoteAccessInfo;
	try {
		const resp = await sendRequest(socketPath, "remote.accessUrl", {});
		if (!resp.ok) {
			exitError(resp.error || "Failed to get the access URL from the running server.");
		}
		info = resp.data as RemoteAccessInfo;
	} catch (err) {
		if (err instanceof Error && err.message === "APP_NOT_RUNNING") {
			// Honor notRunningIsFatal (F6): only the fatal callers (e.g. `url`) want
			// us to clear the state and exit. A non-fatal caller (e.g. the --detach
			// readiness path, where the server is provably alive) gets the error
			// rethrown so it can decide — clearing state there would orphan a live
			// server whose socket simply hasn't come up yet.
			if (opts.notRunningIsFatal) {
				clearRemoteState();
				exitError(
					"The dev3 remote server is no longer reachable (cleared a stale record).",
					"Start one with `dev3 remote`.",
					CLI_EXIT_CODE_APP_NOT_RUNNING,
				);
			}
			throw err;
		}
		throw err;
	}

	process.stdout.write(`${opts.header}\n\n`);
	if (opts.withQr) {
		try {
			const qr = await QRCode.toString(info.url, { type: "terminal", small: true });
			process.stdout.write(qr + "\n");
		} catch {
			// QR render failed — the URL alone is still usable.
		}
	}
	process.stdout.write(`  ${info.url}\n`);
	if (info.tunnelUrl) {
		process.stdout.write(`\n  Public tunnel: ${info.tunnelUrl}\n`);
	}
	if (info.staticCode) {
		process.stdout.write(`  Static access code: ${info.staticCode} (rotation disabled — local use only)\n`);
	} else {
		process.stdout.write(`  (the token is single-use — rerun \`dev3 remote url\` for a fresh one)\n`);
	}
}

function formatUptime(startedAtIso: string): string {
	const start = Date.parse(startedAtIso);
	if (Number.isNaN(start)) return "unknown";
	let secs = Math.max(0, Math.floor((Date.now() - start) / 1000));
	const days = Math.floor(secs / 86400); secs -= days * 86400;
	const hours = Math.floor(secs / 3600); secs -= hours * 3600;
	const mins = Math.floor(secs / 60); secs -= mins * 60;
	const parts: string[] = [];
	if (days) parts.push(`${days}d`);
	if (hours) parts.push(`${hours}h`);
	if (mins) parts.push(`${mins}m`);
	parts.push(`${secs}s`);
	return parts.join(" ");
}
