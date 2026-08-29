import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
	loadSettingsSync: vi.fn(),
}));

vi.mock("../settings", () => ({
	loadSettingsSync: mocks.loadSettingsSync,
}));

import {
	GENERIC_TUNNEL_URL_REGEX,
	buildCustomTunnelArgv,
	compileUrlPattern,
	extractTunnelUrl,
	isCustomTunnelProviderActive,
	resolveRemoteTunnelProvider,
	tunnelCommandName,
	_resetCustomProviderCache,
} from "../tunnel-provider";

describe("tunnelCommandName", () => {
	it("names the tool the command runs", () => {
		expect(tunnelCommandName("ngrok http {port} --log stdout")).toBe("ngrok");
	});

	it("strips a path so the log label stays short", () => {
		expect(tunnelCommandName("/opt/tools/bin/expose --port {port}")).toBe("expose");
	});

	it("falls back to a generic label for a blank command", () => {
		expect(tunnelCommandName("   ")).toBe("custom-tunnel");
	});

	it("names the exec'd tool, not the wrapper that echoes the hostname", () => {
		expect(
			tunnelCommandName("echo https://host.example.com; exec cloudflared tunnel run --url http://localhost:{port} name"),
		).toBe("cloudflared");
	});

	it("keeps leading env assignments out of the label", () => {
		expect(tunnelCommandName("TUNNEL_TOKEN=abc exec /usr/local/bin/cloudflared tunnel run")).toBe("cloudflared");
	});

	// The tunnel is what FEEDS a pipeline, not what consumes it.
	it("names the producer of a pipeline, not the sink", () => {
		expect(tunnelCommandName("ngrok http {port} | tee log")).toBe("ngrok");
	});

	// Splitting the line on `;` and `&` to find "the last command" reads the `&`
	// inside `2>&1` as a separator and answers `1`. Redirection is not a command.
	it("is not fooled by a stderr redirection", () => {
		expect(tunnelCommandName("ngrok http {port} --log stdout 2>&1")).toBe("ngrok");
		expect(tunnelCommandName("ngrok http {port} > out.log 2>&1")).toBe("ngrok");
		expect(
			tunnelCommandName("cloudflared tunnel --url http://localhost:{port} 2>&1 | tee tunnel.log"),
		).toBe("cloudflared");
	});
});

describe("resolveRemoteTunnelProvider", () => {
	it("defaults to cloudflare when nothing is configured", () => {
		expect(resolveRemoteTunnelProvider({}).kind).toBe("cloudflare");
		expect(resolveRemoteTunnelProvider({ remoteTunnel: undefined }).kind).toBe("cloudflare");
	});

	it("fails closed on a blank custom command instead of falling back to cloudflare", () => {
		// The user this feature exists for is on a network that forbids
		// cloudflared — a fumbled command must never silently start one.
		const provider = resolveRemoteTunnelProvider({ remoteTunnel: { provider: "custom", command: "  " } });
		expect(provider.kind).toBe("misconfigured");
		expect(provider.command).toBeNull();
	});

	it("resolves a configured custom command with its URL pattern", () => {
		const provider = resolveRemoteTunnelProvider({
			remoteTunnel: { provider: "custom", command: " ngrok http {port} --log stdout ", urlPattern: "https://\\S+\\.example\\.com" },
		});
		expect(provider.kind).toBe("custom");
		expect(provider.command).toBe("ngrok http {port} --log stdout");
		expect("wss://x https://foo.example.com done".match(provider.urlRegex!)?.[0]).toBe("https://foo.example.com");
	});

	it("reads settings from disk when none are passed", () => {
		mocks.loadSettingsSync.mockReturnValue({ remoteTunnel: { provider: "custom", command: "tunnel {port}" } });
		expect(resolveRemoteTunnelProvider().kind).toBe("custom");
	});
});

describe("isCustomTunnelProviderActive", () => {
	beforeEach(() => {
		_resetCustomProviderCache();
		mocks.loadSettingsSync.mockReset();
	});

	it("reflects the configured provider and caches the answer briefly", () => {
		mocks.loadSettingsSync.mockReturnValue({ remoteTunnel: { provider: "custom", command: "tunnel {port}" } });
		expect(isCustomTunnelProviderActive()).toBe(true);
		expect(isCustomTunnelProviderActive()).toBe(true);
		// The origin check calls this per request; the settings file is read once.
		expect(mocks.loadSettingsSync).toHaveBeenCalledTimes(1);
	});

	it("treats a misconfigured (blank-command) provider as NOT active", () => {
		// Origin-check hardening must not widen while no working custom tunnel exists.
		mocks.loadSettingsSync.mockReturnValue({ remoteTunnel: { provider: "custom", command: " " } });
		expect(isCustomTunnelProviderActive()).toBe(false);
	});

	it("is false on the default cloudflare provider", () => {
		mocks.loadSettingsSync.mockReturnValue({});
		expect(isCustomTunnelProviderActive()).toBe(false);
	});
});

describe("compileUrlPattern", () => {
	it("falls back to the generic https match on an invalid regex", () => {
		expect(compileUrlPattern("([")).toBe(GENERIC_TUNNEL_URL_REGEX);
		expect(compileUrlPattern("")).toBe(GENERIC_TUNNEL_URL_REGEX);
		expect(compileUrlPattern(undefined)).toBe(GENERIC_TUNNEL_URL_REGEX);
	});

	it("falls back on an absurdly long pattern instead of running it per output line", () => {
		expect(compileUrlPattern(`https://${"(a+)+".repeat(100)}`)).toBe(GENERIC_TUNNEL_URL_REGEX);
	});
});

describe("GENERIC_TUNNEL_URL_REGEX / extractTunnelUrl", () => {
	it("scrapes the first https URL from typical tunnel CLI output", () => {
		const cases: Array<[string, string]> = [
			// ngrok --log stdout
			[
				't=2026-08-23 lvl=info msg="started tunnel" obj=tunnels name=command_line addr=http://localhost:3000 url=https://a1b2.ngrok-free.app',
				"https://a1b2.ngrok-free.app",
			],
			// cloudflared banner style
			["INF |  https://random-words.trycloudflare.com  |", "https://random-words.trycloudflare.com"],
			// plain "Public: <url>" style
			["   Public: https://me-app.tunnel.example.com", "https://me-app.tunnel.example.com"],
			// URL with a port
			["forwarding https://host.example.net:8443 -> localhost", "https://host.example.net:8443"],
			// Tailscale Funnel prints a trailing slash — the shape that used to scrape to null
			["https://machine.tailnet.ts.net/", "https://machine.tailnet.ts.net/"],
			// URL with a path
			["Public: https://x.corp.example.com/app", "https://x.corp.example.com/app"],
		];
		for (const [line, expected] of cases) {
			expect(extractTunnelUrl(line, GENERIC_TUNNEL_URL_REGEX)).toBe(expected);
		}
	});

	it("does not swallow prose punctuation into the hostname", () => {
		expect(extractTunnelUrl("Visit https://x.example.com.", GENERIC_TUNNEL_URL_REGEX)).toBe("https://x.example.com");
		expect(extractTunnelUrl("try https://x.example.com, then reload", GENERIC_TUNNEL_URL_REGEX)).toBe("https://x.example.com");
	});

	it("prefers a capture group in a user pattern over the whole match", () => {
		// The natural ngrok pattern — without group preference this would
		// publish "url=https://…" as the public URL.
		const pattern = compileUrlPattern("url=(https:\\/\\/\\S+)");
		expect(extractTunnelUrl("… url=https://a1b2.ngrok-free.app", pattern)).toBe("https://a1b2.ngrok-free.app");
	});

	it("does not match non-https output lines", () => {
		expect(extractTunnelUrl("listening on http://localhost:3000", GENERIC_TUNNEL_URL_REGEX)).toBeNull();
	});
});

describe("buildCustomTunnelArgv", () => {
	it("substitutes {port}, runs under the shell, and execs a plain command", () => {
		const argv = buildCustomTunnelArgv("ngrok http {port} --log stdout", 18590);
		if (process.platform === "win32") {
			expect(argv).toEqual(["cmd", "/c", "ngrok http 18590 --log stdout"]);
		} else {
			// exec replaces the wrapper sh, so kill() reaches the tunnel itself and
			// the pid recorded for the self-update handoff is the real tunnel.
			expect(argv).toEqual(["sh", "-c", "exec ngrok http 18590 --log stdout"]);
		}
	});

	it("substitutes every occurrence of {port}", () => {
		const argv = buildCustomTunnelArgv("tunnel {port} --name app-{port}", 4242);
		expect(argv[2]).toContain("tunnel 4242 --name app-4242");
	});

	it("keeps leading VAR=value assignments in front of exec", () => {
		if (process.platform === "win32") return;
		const argv = buildCustomTunnelArgv("NGROK_AUTHTOKEN=abc ngrok http {port}", 3000);
		expect(argv[2]).toBe("NGROK_AUTHTOKEN=abc exec ngrok http 3000");
	});

	it("leaves a pipeline to the shell — exec cannot represent it", () => {
		if (process.platform === "win32") return;
		const argv = buildCustomTunnelArgv("tunnel {port} | tee /tmp/log", 3000);
		expect(argv[2]).toBe("tunnel 3000 | tee /tmp/log");
	});

	it("leaves a quoted line untouched — regex word-splitting would splice exec into the quotes", () => {
		if (process.platform === "win32") return;
		// FOO="a b" used to become FOO="a exec b" — the value silently corrupted.
		expect(buildCustomTunnelArgv('FOO="a b" tunnel {port}', 3000)[2]).toBe('FOO="a b" tunnel 3000');
		// A quoted path already works without exec: sh execs a lone simple command itself.
		expect(buildCustomTunnelArgv('"/opt/my tools/tunnel.sh" {port}', 3000)[2]).toBe('"/opt/my tools/tunnel.sh" 3000');
	});
});
