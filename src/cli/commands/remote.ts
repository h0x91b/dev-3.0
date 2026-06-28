import type { ParsedArgs } from "../args";
import { exitUsage } from "../output";

const REMOTE_HELP = `dev3 remote — run dev-3.0 in headless mode with a browser UI.

Usage:
  dev3 remote [--no-tunnel] [--expose-ports=<ports>] [--port <n>] [--views-dir <path>]

What it does:
  Starts a Bun-only dev-3.0 server (no GUI window) and serves the full web UI
  to any browser over HTTP + WebSocket. Prints an ASCII QR code and an access
  URL signed with a short-lived (30s, single-use) JWT token — the QR is
  auto-refreshed every 25 seconds, matching the GUI modal's behavior.

  By default a Cloudflare quick tunnel (trycloudflare.com) is started and its
  public URL is included in the QR, so you can connect from any device without
  setting up SSH port-forwarding. \`cloudflared\` is installed as a brew
  dependency. Pass --no-tunnel for local-only mode (LAN + SSH forward only).

Flags:
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
  dev3 remote --no-tunnel                  # LAN + SSH only (no public URL)
  dev3 remote --port 3000                  # fixed port (ideal for Docker -p 3000:3000)
  dev3 remote --expose-ports=3000,5173     # also expose dev-server ports publicly
`;

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
		if (key !== "no-tunnel" && key !== "views-dir" && key !== "static-code" && key !== "port" && key !== "expose-ports" && key !== "help" && key !== "h") {
			exitUsage(`Unknown flag: --${key}\nRun "dev3 remote --help" for usage.`);
		}
	}

	// Validate flags and collect the env vars headless-entry reads at boot. We
	// apply them to process.env only after every check passes, so a validation
	// failure never pollutes the environment. Tunnel is opt-out: headless-entry
	// starts one unless DEV3_REMOTE_NO_TUNNEL=1.
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

	// Boot the headless server IN-PROCESS. `dev3` and the old standalone
	// `dev3-server` are now a single binary: the server lives behind this dynamic
	// import so it stays out of the CLI's startup graph — every other
	// `dev3 <cmd>` pays nothing for it (a guard test enforces this; see
	// __tests__/cli-startup-graph.test.ts). DEV3_HEADLESS must be set BEFORE the
	// import so the electrobun-platform shim short-circuits to no-op stubs
	// instead of loading the real native module; `await import()` is a statement,
	// so unlike a static `import` it never hoists above these assignments. The
	// same path serves dev (`bun run src/cli/main.ts remote` imports the TS
	// source) and prod (Bun bundles the dynamic-import target into the compiled
	// binary). headless-entry boots on import and keeps the process alive via its
	// own open handles + SIGINT/SIGTERM shutdown, so this import never resolves
	// until the server stops.
	Object.assign(process.env, remoteEnv);
	process.env.DEV3_HEADLESS = "1";
	await import("../../bun/headless-entry");
}
