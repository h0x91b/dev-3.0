import { existsSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
	clearRemoteState,
	isProcessAlive,
	readRemoteState,
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

/**
 * True when the CLI runs via `bun run ...` (dev mode) rather than as a compiled
 * `dev3` binary. In dev mode we must NEVER spawn `dist/dev3-server`:
 *   (a) on macOS the unsigned compiled binary is killed by Gatekeeper with
 *       SIGKILL and no output (observed: signal=SIGKILL, exit code=null),
 *   (b) `dist/dev3-server` may be a stale artifact from a previous build that
 *       no longer matches the current source — running it would silently
 *       execute old code while the developer thinks they're testing HEAD.
 * Always re-run source through Bun instead (see resolveServerCommand).
 */
function isRunningViaBun(): boolean {
	const exec = process.execPath;
	return exec.endsWith("/bun") || exec.endsWith("\\bun.exe");
}

/**
 * Locate the `dev3-server` binary that sits alongside the CLI.
 *
 * Layout we expect:
 *   <bin>/dev3           ← CLI  (this process)
 *   <bin>/dev3-server    ← headless server (spawned)
 *
 * Resolved via `realpathSync(process.execPath)` so brew-style installs
 * (`bin/dev3` is a symlink to `libexec/dev3`, server lives at `libexec/dev3-server`)
 * find the sibling next to the actual binary, not next to the symlink.
 *
 * Only meaningful in prod — from the compiled `dev3`. Dev mode bypasses this
 * entirely via the bun branch of resolveServerCommand; see isRunningViaBun.
 */
function locateServerBinary(): string | null {
	let cliDir = dirname(process.execPath);
	try {
		cliDir = dirname(realpathSync(process.execPath));
	} catch { /* unreadable execPath — fall back to dirname(execPath) */ }
	const sibling = resolve(cliDir, "dev3-server");
	return existsSync(sibling) ? sibling : null;
}

/**
 * Resolve which binary + args boot the headless server. In dev mode that's
 * `bun run headless-bootstrap.ts` (the bootstrap sets DEV3_HEADLESS=1 before ES
 * imports evaluate); in prod it's the sibling `dev3-server` binary. Exits with a
 * helpful message when neither can be found.
 */
function resolveServerCommand(): { bin: string; args: string[] } {
	if (isRunningViaBun()) {
		const bunBin = process.execPath;
		const entry = resolve(import.meta.dir, "..", "..", "bun", "headless-bootstrap.ts");
		if (!existsSync(entry)) {
			exitError("Could not locate headless-bootstrap.ts", `Expected at ${entry}`);
		}
		return { bin: bunBin, args: ["run", entry] };
	}
	const serverBin = locateServerBinary();
	if (!serverBin) {
		const expected = resolve(dirname(process.execPath), "dev3-server");
		exitError(
			"dev3-server binary not found",
			`Expected alongside the CLI at: ${expected}\n` +
				`\n` +
				`This usually means the installed dev-3.0 app predates the \`dev3 remote\`\n` +
				`feature. Launch the dev-3.0 GUI app once — it refreshes both dev3 and\n` +
				`dev3-server into ~/.dev3.0/bin/ on every start — then retry \`dev3 remote\`.`,
		);
	}
	return { bin: serverBin, args: [] };
}

/** Translate `dev3 remote start` flags into the DEV3_REMOTE_* env the server reads. */
function buildServerEnv(args: ParsedArgs): NodeJS.ProcessEnv {
	// DEV3_HEADLESS is also set as a safety net: the bootstrap sets it before
	// imports, but belt-and-suspenders. Tunnel is opt-out: the server starts one
	// unless DEV3_REMOTE_NO_TUNNEL=1.
	const childEnv: NodeJS.ProcessEnv = { ...process.env, DEV3_HEADLESS: "1" };
	if (args.flags["no-tunnel"] === "true") {
		childEnv.DEV3_REMOTE_NO_TUNNEL = "1";
	}
	if (args.flags["views-dir"] && args.flags["views-dir"] !== "true") {
		childEnv.DEV3_VIEWS_DIR = args.flags["views-dir"];
	}
	if (args.flags.port !== undefined) {
		if (args.flags.port === "true") {
			exitUsage(`--port requires a value: --port <1-65535>`);
		}
		const n = Number.parseInt(args.flags.port, 10);
		if (!Number.isFinite(n) || n < 1 || n > 65535 || String(n) !== args.flags.port.trim()) {
			exitUsage(`--port must be an integer in 1-65535 (got "${args.flags.port}")`);
		}
		childEnv.DEV3_REMOTE_PORT = String(n);
	}
	if (args.flags["static-code"] && args.flags["static-code"] !== "true") {
		const code = args.flags["static-code"];
		if (code.length < 4) {
			exitUsage(`--static-code must be at least 4 characters (got "${code}")`);
		}
		childEnv.DEV3_REMOTE_STATIC_CODE = code;
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
		childEnv.DEV3_REMOTE_EXPOSE_PORTS = ports.join(",");
	}
	return childEnv;
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

	const detach = args.flags.detach === "true";
	const childEnv = buildServerEnv(args);

	if (detach) {
		await startDetached(childEnv);
		return;
	}

	// Foreground: forward stdio and signals so Ctrl-C cleanly stops the server.
	const { bin, args: serverArgs } = resolveServerCommand();
	const child = spawn(bin, serverArgs, { stdio: "inherit", env: childEnv });
	child.on("exit", (code) => process.exit(code ?? 0));
	process.on("SIGINT", () => child.kill("SIGINT"));
	process.on("SIGTERM", () => child.kill("SIGTERM"));
}

async function startDetached(childEnv: NodeJS.ProcessEnv): Promise<void> {
	// Refuse to launch a second managed server — the lifecycle state file is a
	// singleton, so a second detached server would orphan the first.
	const existing = readRemoteState();
	if (existing && isProcessAlive(existing.pid)) {
		exitError(
			`A dev3 remote server is already running (pid ${existing.pid}, port ${existing.port}).`,
			"Use `dev3 remote url` to get its link, or `dev3 remote stop` to shut it down first.",
		);
	}
	if (existing) clearRemoteState(); // stale record from a dead server

	mkdirSync(REMOTE_DIR, { recursive: true });
	childEnv.DEV3_REMOTE_LOG_FILE = REMOTE_LOG_FILE;
	const logFd = openSync(REMOTE_LOG_FILE, "a");

	const { bin, args: serverArgs } = resolveServerCommand();
	const child = spawn(bin, serverArgs, {
		stdio: ["ignore", logFd, logFd],
		env: childEnv,
		detached: true,
	});
	child.unref();

	const pid = child.pid;
	process.stdout.write(`Starting dev3 remote in the background (pid ${pid ?? "?"})…\n`);

	// Bail early if the child dies during startup (e.g. port in use, crash).
	let childExited = false;
	child.on("exit", (code) => { childExited = true; void code; });

	// Wait for the server to write its lifecycle state, then print the access URL.
	const deadlineMs = Date.now() + 20_000;
	while (Date.now() < deadlineMs) {
		if (childExited) {
			exitError(
				"The background server exited during startup.",
				`Check the log for details:\n  ${REMOTE_LOG_FILE}`,
			);
		}
		const state = readRemoteState();
		if (state && state.pid === pid && state.port > 0) {
			await printAccessForState(state.socketPath, {
				header: `dev3 remote is running in the background (pid ${pid}, port ${state.port}).`,
				withQr: true,
			});
			process.stdout.write(
				`\nManage it with:  dev3 remote url   (fresh link)\n` +
				`                 dev3 remote status\n` +
				`                 dev3 remote stop\n` +
				`Logs:  ${REMOTE_LOG_FILE}\n`,
			);
			process.exit(0);
		}
		await delay(250);
	}

	// Started but never reported in — likely slow startup. Don't fail; point the
	// user at status/log so they can check without us hanging forever.
	process.stdout.write(
		`Server started (pid ${pid ?? "?"}) but did not report readiness within 20s.\n` +
		`Check \`dev3 remote status\` or the log at ${REMOTE_LOG_FILE}.\n`,
	);
	process.exit(0);
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

/** Ask a running server (over its CLI socket) for a fresh access URL and print it. */
async function printAccessForState(
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
			clearRemoteState();
			exitError(
				"The dev3 remote server is no longer reachable (cleared a stale record).",
				"Start one with `dev3 remote`.",
				CLI_EXIT_CODE_APP_NOT_RUNNING,
			);
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
