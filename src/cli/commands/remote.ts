import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { ParsedArgs } from "../args";
import { exitError, exitUsage } from "../output";

const REMOTE_HELP = `dev3 remote — run dev-3.0 in headless mode with a browser UI.

Usage:
  dev3 remote [--tunnel] [--views-dir <path>]

What it does:
  Starts a Bun-only dev-3.0 server (no GUI window) and serves the full web UI
  to any browser over HTTP + WebSocket. Prints an ASCII QR code and an access
  URL signed with a short-lived (30s, single-use) JWT token — the QR is
  auto-refreshed every 25 seconds, matching the GUI modal's behavior.

Flags:
  --tunnel
      Start a Cloudflare quick tunnel (trycloudflare.com) and include its
      public URL in the QR. Requires \`cloudflared\` on PATH.
      Note: Cloudflare doesn't sanction trycloudflare.com for production
      use — treat this as a dev convenience only.

  --views-dir <path>
      Override the directory served as static assets (defaults to the
      dist/ next to the binary, or the current working directory's ./dist).

Connection options shown on startup:
  ① Public tunnel URL (if --tunnel)
  ② LAN — scan the QR from any device on the same network
  ③ SSH port-forward — \`ssh -L <port>:localhost:<port> user@<server>\`

  The SSH approach is the recommended default: no public exposure, uses your
  existing SSH credentials, and the browser just points at http://localhost.

Examples:
  dev3 remote                   # LAN + SSH forwarding
  dev3 remote --tunnel          # + public Cloudflare tunnel
`;

/**
 * Locate the `dev3-server` binary that sits alongside the CLI.
 *
 * Layout we expect (in priority order):
 *   <bin>/dev3           ← CLI  (this process)
 *   <bin>/dev3-server    ← headless server (spawned)
 *
 * Fallbacks for dev: the repo root's `dist/dev3-server`, or CWD/dist/dev3-server.
 */
function locateServerBinary(): string | null {
	const candidates: string[] = [];
	// process.execPath points at the current executable; for a compiled Bun
	// binary it's the binary itself, for `bun run` it's Bun.
	const cliDir = dirname(process.execPath);
	candidates.push(resolve(cliDir, "dev3-server"));
	candidates.push(resolve(process.cwd(), "dist", "dev3-server"));
	// Dev: if we're running from source, fall back to running headless-entry
	// through Bun itself (see runViaBun below).
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	return null;
}

/**
 * Run headless-entry.ts through the current Bun process (dev fallback when
 * there's no compiled `dev3-server` binary next to the CLI — e.g. when
 * invoking `bun run src/cli/main.ts remote` from the repo root).
 */
function runViaBun(env: NodeJS.ProcessEnv): void {
	// process.execPath is `bun` when launched via `bun run`; when compiled, it's
	// the dev3 binary — which can't run .ts files, so this branch is only
	// reachable in dev.
	const bunBin = process.execPath;
	// Use the bootstrap, not headless-entry directly — bootstrap sets
	// DEV3_HEADLESS=1 *before* ES imports evaluate, which is required for the
	// electrobun-platform shim to short-circuit to stubs instead of loading
	// the real electrobun module.
	const entry = resolve(import.meta.dir, "..", "..", "bun", "headless-bootstrap.ts");
	if (!existsSync(entry)) {
		exitError("Could not locate headless-bootstrap.ts", `Expected at ${entry}`);
	}
	const child = spawn(bunBin, ["run", entry], { stdio: "inherit", env });
	child.on("exit", (code) => process.exit(code ?? 0));
}

export async function handleRemote(subcommand: string | undefined, args: ParsedArgs): Promise<void> {
	if (args.flags.help === "true" || args.flags.h === "true") {
		process.stdout.write(REMOTE_HELP);
		return;
	}

	// `dev3 remote` takes no subcommand; reject accidental ones like "dev3 remote start".
	if (subcommand !== undefined) {
		exitUsage(`"dev3 remote" takes no subcommand (got "${subcommand}").\nRun "dev3 remote --help" for usage.`);
	}

	if (args.positional.length > 0) {
		exitUsage(`Unknown positional argument: "${args.positional[0]}"\nRun "dev3 remote --help" for usage.`);
	}

	for (const key of Object.keys(args.flags)) {
		if (key !== "tunnel" && key !== "views-dir" && key !== "help" && key !== "h") {
			exitUsage(`Unknown flag: --${key}\nRun "dev3 remote --help" for usage.`);
		}
	}

	// Translate flags → env for headless-entry. DEV3_HEADLESS is also set as a
	// safety net: the bootstrap sets it before imports, but belt-and-suspenders.
	const childEnv: NodeJS.ProcessEnv = { ...process.env, DEV3_HEADLESS: "1" };
	if (args.flags.tunnel === "true") {
		childEnv.DEV3_REMOTE_TUNNEL = "1";
	}
	if (args.flags["views-dir"] && args.flags["views-dir"] !== "true") {
		childEnv.DEV3_VIEWS_DIR = args.flags["views-dir"];
	}

	const serverBin = locateServerBinary();
	if (serverBin) {
		const child = spawn(serverBin, [], { stdio: "inherit", env: childEnv });
		child.on("exit", (code) => process.exit(code ?? 0));
		// Forward signals so Ctrl-C in the CLI reaches the server cleanly.
		process.on("SIGINT", () => child.kill("SIGINT"));
		process.on("SIGTERM", () => child.kill("SIGTERM"));
		return;
	}

	// Dev fallback: no compiled server next to us — try running source.
	runViaBun(childEnv);
}
