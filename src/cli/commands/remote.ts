import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { ParsedArgs } from "../args";
import { exitError, exitUsage } from "../output";

const REMOTE_HELP = `dev3 remote — run dev-3.0 in headless mode with a browser UI.

Usage:
  dev3 remote [--tunnel] [--port <n>] [--views-dir <path>]

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
  ① Public tunnel URL (if --tunnel)
  ② LAN — scan the QR from any device on the same network
  ③ SSH port-forward — \`ssh -L <port>:localhost:<port> user@<server>\`

  The SSH approach is the recommended default: no public exposure, uses your
  existing SSH credentials, and the browser just points at http://localhost.

Examples:
  dev3 remote                   # LAN + SSH forwarding
  dev3 remote --tunnel          # + public Cloudflare tunnel
  dev3 remote --port 3000       # fixed port (ideal for Docker -p 3000:3000)
`;

/**
 * True when the CLI runs via `bun run ...` (dev mode) rather than as a compiled
 * `dev3` binary. In dev mode we must NEVER spawn `dist/dev3-server`:
 *   (a) on macOS the unsigned compiled binary is killed by Gatekeeper with
 *       SIGKILL and no output (observed: signal=SIGKILL, exit code=null),
 *   (b) `dist/dev3-server` may be a stale artifact from a previous build that
 *       no longer matches the current source — running it would silently
 *       execute old code while the developer thinks they're testing HEAD.
 * Always re-run source through Bun instead (see runViaBun).
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
 * Only meaningful in prod — from the compiled `dev3`. Dev mode bypasses this
 * entirely via `runViaBun`; see isRunningViaBun.
 */
function locateServerBinary(): string | null {
	const cliDir = dirname(process.execPath);
	const sibling = resolve(cliDir, "dev3-server");
	return existsSync(sibling) ? sibling : null;
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
	// Forward signals so Ctrl-C in the CLI reaches the server cleanly.
	process.on("SIGINT", () => child.kill("SIGINT"));
	process.on("SIGTERM", () => child.kill("SIGTERM"));
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
		if (key !== "tunnel" && key !== "views-dir" && key !== "static-code" && key !== "port" && key !== "help" && key !== "h") {
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

	// Dev mode (bun run src/cli/main.ts) — always re-run source through Bun.
	// See isRunningViaBun for why we never touch dist/dev3-server here.
	if (isRunningViaBun()) {
		runViaBun(childEnv);
		return;
	}

	// Prod mode — compiled `dev3` spawns its sibling `dev3-server`.
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
	const child = spawn(serverBin, [], { stdio: "inherit", env: childEnv });
	child.on("exit", (code) => process.exit(code ?? 0));
	// Forward signals so Ctrl-C in the CLI reaches the server cleanly.
	process.on("SIGINT", () => child.kill("SIGINT"));
	process.on("SIGTERM", () => child.kill("SIGTERM"));
}
