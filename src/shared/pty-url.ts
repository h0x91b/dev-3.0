/** Query parameter carrying the PTY server's per-launch access token. */
export const PTY_TOKEN_PARAM = "token";

const TOKEN_VALUE = new RegExp(`([?&]${PTY_TOKEN_PARAM}=)[^&]+`, "g");

/** A PTY URL with its access token masked — the only form that may reach a log or the screen. */
export function redactPtyUrl(url: string): string {
	return url.replace(TOKEN_VALUE, "$1***");
}
