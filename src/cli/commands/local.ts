/**
 * `dev3 local` - an alias for `dev3 remote --no-tunnel --host 127.0.0.1`.
 * main() rewrites the argv before any routing, so every `remote` subcommand,
 * flag and help path applies unchanged.
 */

export const LOCAL_ALIAS_FLAGS = ["--no-tunnel", "--host", "127.0.0.1"];

/** Subcommands that start a server and so take the alias flags. */
const STARTING_SUBCOMMANDS = new Set(["start", "restart", "install-service"]);

export const LOCAL_HELP = `dev3 local - run dev-3.0 headless for this machine only.

Usage:
  dev3 local [start|status|url|restart|logs|stop|install-service|uninstall-service] [<flags>]

What it does:
  Same as \`dev3 remote --no-tunnel --host 127.0.0.1\`: the server listens on
  loopback only and opens no public tunnel. Open the printed URL in a browser
  on this machine. start, restart and install-service get the two flags added;
  the other subcommands pass through unchanged.

  Flags you pass go after the alias flags and win, so \`dev3 local --host localhost\`
  binds localhost instead. Every other \`dev3 remote\` flag works the same way.

Examples:
  dev3 local                                 # start in the background
  dev3 local --port 8090 --no-detach         # foreground, fixed port
  dev3 local install-service --port 8090     # systemd --user unit, loopback only
  dev3 local stop

Run "dev3 remote --help" for every flag and subcommand.
`;

/** Rewrite `local [<sub>] [<args>]` (argv minus "dev3") into the matching `remote` argv. */
export function expandLocalAlias(rawArgs: string[]): string[] {
	const rest = rawArgs.slice(1);
	const subcommand = rest[0] && !rest[0].startsWith("-") ? rest[0] : undefined;
	const userArgs = subcommand ? rest.slice(1) : rest;
	const head = subcommand ? ["remote", subcommand] : ["remote"];
	if (subcommand && !STARTING_SUBCOMMANDS.has(subcommand)) return [...head, ...userArgs];
	return [...head, ...LOCAL_ALIAS_FLAGS, ...userArgs];
}
