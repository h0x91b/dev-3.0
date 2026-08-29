import type { RemoteTunnelSettings } from "../shared/types";
import { loadSettingsSync } from "./settings";
import { createLogger } from "./logger";

const log = createLogger("tunnel-provider");

/**
 * The resolved tunnel provider for every tunnel dev3 starts.
 *
 * `cloudflare` is the built-in default (cloudflared quick tunnel, see
 * cloudflare-tunnel.ts). `custom` is bring-your-own-tunnel: any ngrok-like CLI
 * that takes a local port and prints a public https URL, configured in
 * Settings → System → Tunnel provider. `misconfigured` is "custom" with a
 * blank command — it fails closed (no tunnel starts) rather than silently
 * falling back to cloudflared, which is exactly what a user on a
 * cloudflared-forbidding network must never get.
 */
export interface ResolvedTunnelProvider {
	kind: "cloudflare" | "custom" | "misconfigured";
	/** Shell command with `{port}` NOT yet substituted — see buildCustomTunnelArgv. */
	command: string | null;
	urlRegex: RegExp | null;
}

/**
 * Default URL scrape for custom providers: the first https URL the CLI prints,
 * with an optional path — Tailscale Funnel prints `https://host.ts.net/`, and a
 * lookahead-only pattern never matched a URL followed by `/`.
 */
export const GENERIC_TUNNEL_URL_REGEX = /https:\/\/[a-zA-Z0-9][a-zA-Z0-9._-]*(?::\d+)?(?:\/[^\s"',;)\]]*)?/;

/**
 * Pull the public URL out of an output line. A capture group in a user-supplied
 * pattern names the URL more precisely than the whole match (`url=(https://\S+)`),
 * so group 1 wins when it participated. A single trailing `.` or `,` is prose
 * punctuation ("Visit https://x.example.com."), not part of the hostname.
 */
export function extractTunnelUrl(line: string, urlRegex: RegExp): string | null {
	const match = line.match(urlRegex);
	if (!match) return null;
	const url = (match[1] ?? match[0]).replace(/[.,]$/, "");
	return url || null;
}

export function resolveRemoteTunnelProvider(settings?: { remoteTunnel?: RemoteTunnelSettings }): ResolvedTunnelProvider {
	const conf = (settings ?? loadSettingsSync()).remoteTunnel;
	if (conf?.provider !== "custom") {
		return { kind: "cloudflare", command: null, urlRegex: null };
	}
	if (!conf.command?.trim()) {
		return { kind: "misconfigured", command: null, urlRegex: null };
	}
	return {
		kind: "custom",
		command: conf.command.trim(),
		urlRegex: compileUrlPattern(conf.urlPattern),
	};
}

/**
 * Whether a custom provider is currently configured, cached briefly: the
 * remote-access origin check consults this per request, and `loadSettingsSync`
 * reads a file.
 */
const CUSTOM_ACTIVE_TTL_MS = 5_000;
let customActiveCache: { value: boolean; at: number } | null = null;

export function isCustomTunnelProviderActive(): boolean {
	const now = Date.now();
	if (customActiveCache && now - customActiveCache.at < CUSTOM_ACTIVE_TTL_MS) {
		return customActiveCache.value;
	}
	const value = resolveRemoteTunnelProvider().kind === "custom";
	customActiveCache = { value, at: now };
	return value;
}

/** Reset the custom-provider cache — for tests; production relies on the TTL. */
export function _resetCustomProviderCache(): void {
	customActiveCache = null;
}

/**
 * A pathological user regex can pin a core (it runs against every output
 * line), so the field is capped rather than trusted.
 */
const URL_PATTERN_MAX_LENGTH = 300;

/** A user-supplied pattern that does not compile falls back to the generic scrape. */
export function compileUrlPattern(pattern: string | undefined): RegExp {
	const trimmed = pattern?.trim();
	if (trimmed) {
		if (trimmed.length > URL_PATTERN_MAX_LENGTH) {
			log.warn("Custom tunnel urlPattern too long — falling back to generic https URL match", {
				length: trimmed.length,
				max: URL_PATTERN_MAX_LENGTH,
			});
			return GENERIC_TUNNEL_URL_REGEX;
		}
		try {
			return new RegExp(trimmed);
		} catch (err) {
			log.warn("Invalid custom tunnel urlPattern — falling back to generic https URL match", {
				pattern: trimmed,
				error: String(err),
			});
		}
	}
	return GENERIC_TUNNEL_URL_REGEX;
}

/**
 * A custom command is a free-form shell line (templates like
 * `ngrok http {port} --log stdout` need shell word splitting anyway), so it
 * runs under the platform shell — the same trust model as project scripts.
 *
 * On POSIX the line is `exec`-prefixed when it contains no shell control
 * operators AND no quotes, so `kill()` signals the tunnel itself instead of a
 * wrapper `sh` that would orphan it — and the pid recorded for the
 * self-update handoff is the real tunnel, not the wrapper. Leading VAR=value
 * assignments stay in front of `exec`, where POSIX sh applies them to the
 * exec'd command. Quoted lines are left alone: word-splitting a quoted value
 * with a regex would splice `exec` inside the quotes, and a lone simple
 * command is exec'd by sh itself anyway. A genuine pipeline keeps its shell;
 * stopEntry sweeps its children instead.
 */
export function buildCustomTunnelArgv(command: string, targetPort: number): string[] {
	const line = command.replaceAll("{port}", String(targetPort));
	if (process.platform === "win32") return ["cmd", "/c", line];
	if (/[|;&<>()]/.test(line) || /["']/.test(line)) return ["sh", "-c", line];
	const m = line.match(/^((?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)(.*)$/);
	const execLine = m && m[2] ? `${m[1]}exec ${m[2]}` : line;
	return ["sh", "-c", execLine];
}

/**
 * The tool a custom command runs, used to attribute its output lines in logs.
 *
 * A wrapper is the normal shape here, not an exotic one: `cloudflared tunnel run`
 * never prints its own hostname, so a named-tunnel command must echo the URL
 * itself (`echo https://host; exec cloudflared tunnel run …`). Taking the first
 * word attributed cloudflared's output to `echo`.
 *
 * `exec` is matched as a whole word and nothing else is split. Deciding the tool
 * by carving the line on `;` and `&` reads `2>&1` as a command and answers `1`.
 */
export function tunnelCommandName(command: string): string {
	const line = command.trim();
	const execs = [...line.matchAll(/(?:^|[\s;&|])exec\s+(\S+)/g)];
	const segment = execs.length > 0 ? execs[execs.length - 1]![1]! : line;
	// Leading VAR=value assignments belong to the command, not to its name.
	const binary = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, "").split(/\s+/)[0] ?? "";
	return binary.split(/[\\/]/).pop() || "custom-tunnel";
}
