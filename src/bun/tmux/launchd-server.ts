/**
 * Start the macOS tmux server as a per-user launchd job instead of letting
 * tmux daemonize out of the app.
 *
 * macOS privacy checks (TCC) attribute every pane process to the tmux
 * server's *responsible process*. A daemonized server keeps pointing at the
 * dev3 instance that started it; once that instance quits (restart, update),
 * tccd fails with "Failed to create Attribution Chain" and every task loses
 * ~/Documents, ~/Desktop and Full Disk Access. A launchd job is its own
 * responsible process, and because the binary lives inside dev3.app tccd
 * resolves it to the app's bundle id, so the user's existing grants apply.
 * See decisions/2026/10/26/tmux-server-as-launchd-job.md.
 */
import { unlinkSync, writeFileSync } from "node:fs";
import { createLogger } from "../logger";
import { spawnSync as defaultSpawnSync } from "../spawn";
import { dev3TempPath } from "../temp-paths";

const log = createLogger("tmux");

/** A healthy server answers in milliseconds; a wedged one must not freeze the app. */
const PROBE_TIMEOUT_MS = 3_000;
const READY_TIMEOUT_MS = 2_000;
const READY_POLL_MS = 20;

type SpawnSyncFn = (cmd: string[], opts?: Record<string, unknown>) => {
	exitCode: number | null;
	stderr?: Uint8Array | Buffer;
	exitedDueToTimeout?: boolean;
};

export interface LaunchdServerDeps {
	platform: NodeJS.Platform;
	uid: number;
	spawnSync: SpawnSyncFn;
	writeFile: (path: string, contents: string) => void;
	removeFile: (path: string) => void;
	sleep: (ms: number) => void;
}

const defaultDeps: LaunchdServerDeps = {
	platform: process.platform,
	uid: process.getuid?.() ?? 0,
	spawnSync: (cmd, opts) => defaultSpawnSync(cmd, opts),
	writeFile: (path, contents) => writeFileSync(path, contents, { mode: 0o600 }),
	removeFile: (path) => {
		try {
			unlinkSync(path);
		} catch { /* already gone */ }
	},
	sleep: (ms) => Bun.sleepSync(ms),
};

/**
 * Only a tmux inside an app bundle gains anything: tccd maps it to that
 * bundle's grants. A Homebrew or PATH tmux would be judged as itself and lose
 * the access it inherits from a live app today.
 */
export function usesLaunchdServer(platform: NodeJS.Platform, binary: string): boolean {
	return platform === "darwin" && binary.includes(".app/Contents/");
}

export function launchdLabel(socket: string): string {
	return `dev3.tmux.${socket.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

function xmlEscape(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// XML 1.0 cannot carry these at all; a variable holding one is dropped, not mangled.
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

export function buildLaunchdPlist(opts: {
	label: string;
	binary: string;
	socket: string;
	configFile: string;
	cwd: string;
	env: Record<string, string | undefined>;
}): string {
	// `-D` keeps the server in the foreground: launchd must own the server
	// process itself, not a client that forks a daemon and exits.
	const args = [opts.binary, "-D", "-L", opts.socket, "-f", opts.configFile];
	const envEntries = Object.entries(opts.env)
		.filter((entry): entry is [string, string] => typeof entry[1] === "string")
		.filter(([key, value]) => !XML_INVALID.test(key) && !XML_INVALID.test(value))
		.map(([key, value]) => `\t\t<key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`);
	return [
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
		`<plist version="1.0">`,
		`<dict>`,
		`\t<key>Label</key><string>${xmlEscape(opts.label)}</string>`,
		`\t<key>ProgramArguments</key>`,
		`\t<array>`,
		...args.map((arg) => `\t\t<string>${xmlEscape(arg)}</string>`),
		`\t</array>`,
		`\t<key>WorkingDirectory</key><string>${xmlEscape(opts.cwd)}</string>`,
		`\t<key>EnvironmentVariables</key>`,
		`\t<dict>`,
		...envEntries,
		`\t</dict>`,
		`\t<key>RunAtLoad</key><true/>`,
		// The default (Standard) lets macOS throttle CPU and I/O like a background daemon.
		`\t<key>ProcessType</key><string>Interactive</string>`,
		`</dict>`,
		`</plist>`,
		``,
	].join("\n");
}

type ServerState = "alive" | "absent" | "unknown";

function probeServer(binary: string, socket: string, deps: LaunchdServerDeps): ServerState {
	const result = deps.spawnSync([binary, "-L", socket, "display-message", "-p", ""], {
		stdout: "ignore",
		stderr: "pipe",
		timeout: PROBE_TIMEOUT_MS,
	});
	if (result.exitedDueToTimeout) return "unknown";
	if (result.exitCode === 0) return "alive";
	const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : "";
	return /no server running|error connecting|No such file or directory/i.test(stderr) ? "absent" : "unknown";
}

/**
 * Make sure a launchd-owned server listens on `socket` before a
 * server-starting tmux command runs. Never throws and never touches a live
 * or unreadable server: on any doubt it returns and the caller's own command
 * starts the server exactly as before this module existed.
 */
export function ensureLaunchdServer(
	opts: { binary: string; socket: string; configFile: string; cwd: string; env: Record<string, string | undefined> },
	deps: LaunchdServerDeps = defaultDeps,
): "started" | "skipped" | "fallback" {
	if (!usesLaunchdServer(deps.platform, opts.binary)) return "skipped";
	if (probeServer(opts.binary, opts.socket, deps) !== "absent") return "skipped";

	const label = launchdLabel(opts.socket);
	const domain = `gui/${deps.uid}`;
	const plistPath = dev3TempPath(`${label}.plist`);
	try {
		// A job left loaded by a server that already exited blocks a new bootstrap (EIO).
		deps.spawnSync(["launchctl", "bootout", `${domain}/${label}`], { stdout: "ignore", stderr: "ignore" });
		deps.writeFile(plistPath, buildLaunchdPlist({ ...opts, label }));
		const boot = deps.spawnSync(["launchctl", "bootstrap", domain, plistPath], {
			stdout: "ignore",
			stderr: "pipe",
		});
		if (boot.exitCode !== 0) {
			const stderr = boot.stderr ? new TextDecoder().decode(boot.stderr).trim() : "";
			log.warn("launchctl bootstrap failed; tmux will start its own server", { label, exitCode: boot.exitCode, stderr });
			return "fallback";
		}
	} catch (err) {
		log.warn("launchd tmux start failed; tmux will start its own server", { label, error: String(err) });
		return "fallback";
	} finally {
		// launchd keeps its own copy; the file carries the app environment, so it must not linger.
		deps.removeFile(plistPath);
	}

	for (let waited = 0; waited < READY_TIMEOUT_MS; waited += READY_POLL_MS) {
		if (probeServer(opts.binary, opts.socket, deps) === "alive") {
			log.info("tmux server started as a launchd job", { label, waitedMs: waited });
			return "started";
		}
		deps.sleep(READY_POLL_MS);
	}
	// A server that never came up must not be left to race the caller's own start.
	deps.spawnSync(["launchctl", "bootout", `${domain}/${label}`], { stdout: "ignore", stderr: "ignore" });
	log.warn("launchd tmux server did not come up; tmux will start its own server", { label });
	return "fallback";
}
