/**
 * The one line printed when a static access code will be reachable over a
 * public tunnel.
 *
 * It is a WARNING, never a refusal. The static code is a permanent, multi-use
 * credential the owner chose deliberately; combining it with a tunnel is a
 * legitimate setup (that is how you sign in to a headless box from a phone).
 * dev3 used to exit here, which blocked the normal case and — because the gate
 * only read the `--no-tunnel` flag — waved the same combination through
 * whenever the code arrived via an exported `DEV3_REMOTE_STATIC_CODE`.
 *
 * Lives in its own module because both `remote.ts` and `remote-service.ts` need
 * it and `remote.ts` already imports `remote-service.ts`.
 */
export const STATIC_CODE_PUBLIC_TUNNEL_WARNING =
	"⚠ Static access code is enabled and the public tunnel is on: anyone who has the\n" +
	"  code can sign in from anywhere. That is what the code is for — just keep it long\n" +
	"  and private, or add --no-tunnel for local-only / SSH-forward use.";

/**
 * True when a static code is in effect and no `--no-tunnel` was requested.
 *
 * `envCode` is read as well as the flag, so an exported `DEV3_REMOTE_STATIC_CODE`
 * produces exactly the same notice as `--static-code=…`.
 */
export function shouldWarnAboutPublicTunnel(opts: {
	flagCode?: string | null;
	envCode?: string | null;
	tunnelDisabled: boolean;
}): boolean {
	const code = (opts.flagCode || opts.envCode || "").trim();
	return code.length > 0 && !opts.tunnelDisabled;
}
