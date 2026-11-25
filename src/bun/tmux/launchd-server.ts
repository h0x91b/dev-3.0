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
 * The job runs a hardlink mirror of the bundle, so an update never deletes its executable.
 * See decisions/2026/10/26/tmux-server-as-launchd-job.md and
 * decisions/2026/11/24/tmux-server-runs-from-a-hardlink-mirror.md.
 */
import { createHash } from "node:crypto";
import {
	existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveDev3Home } from "../../shared/dev3-home";
import { TMUX_MIRROR_DIR, executableDeleted, parseLsofExecutable } from "../../shared/tmux-server-executable";
import { createLogger } from "../logger";
import { spawnSync as defaultSpawnSync } from "../spawn";
import { dev3TempPath } from "../temp-paths";
import { tmuxSocketPath } from "./socket-files";

const log = createLogger("tmux");

/** A healthy server answers in milliseconds; a wedged one must not freeze the app. */
const PROBE_TIMEOUT_MS = 3_000;
const READY_TIMEOUT_MS = 2_000;
const READY_POLL_MS = 20;
/** `launchctl print` exits with this when the job is not loaded. */
const LAUNCHCTL_NO_SUCH_SERVICE = 113;
/** A younger mirror may be another instance's, built a moment before it starts its server. */
const MIRROR_PRUNE_MIN_AGE_MS = 10 * 60_000;
/** Written once every file of a mirror is linked. */
const MIRROR_COMPLETE = "complete";
/** Pruning is housekeeping: it waits until the first pane has opened. */
const MIRROR_PRUNE_DELAY_MS = 30_000;

type SpawnSyncFn = (cmd: string[], opts?: Record<string, unknown>) => {
	exitCode: number | null;
	stdout?: Uint8Array | Buffer;
	stderr?: Uint8Array | Buffer;
	exitedDueToTimeout?: boolean;
};

export interface LaunchdServerDeps {
	platform: NodeJS.Platform;
	uid: number;
	spawnSync: SpawnSyncFn;
	/** A fresh directory only this user can enter, so the job file cannot be planted or read. */
	makePrivateDir: () => string;
	writeFile: (path: string, contents: string) => void;
	removeDir: (path: string) => void;
	sleep: (ms: number) => void;
	now: () => number;
	signal: (pid: number, signal: NodeJS.Signals) => void;
	/** The app's open-file limits; launchd's own default soft limit is 256. */
	fileLimits: () => { soft: number; hard: number | null } | null;
	/** Resolves the ~/.dev3.0/bin shim to the bundle it points at; null when unresolvable. */
	realpath: (path: string) => string | null;
	pathExists: (path: string) => boolean;
	/** The inode now at `path`; null when it cannot be read. */
	inode: (path: string) => number | null;
	/** Where the bundle mirrors live (see `mirrorBundle`). */
	mirrorRoot: () => string;
	/** Hardlinks every file of the `src` tree into a new tree at `dst`; throws on any failure. */
	linkTree: (src: string, dst: string) => void;
	/** Entry names of a directory; empty when it cannot be read. */
	listDir: (path: string) => string[];
	/** Last modification time in ms; null when it cannot be read. */
	mtimeMs: (path: string) => number | null;
	/** Runs `task` later, off the server start path. */
	defer: (task: () => void) => void;
}

const defaultDeps: LaunchdServerDeps = {
	platform: process.platform,
	uid: process.getuid?.() ?? 0,
	spawnSync: (cmd, opts) => defaultSpawnSync(cmd, opts),
	makePrivateDir: () => mkdtempSync(dev3TempPath("dev3-launchd-")),
	writeFile: (path, contents) => writeFileSync(path, contents, { mode: 0o600, flag: "wx" }),
	removeDir: (path) => rmSync(path, { recursive: true, force: true }),
	sleep: (ms) => Bun.sleepSync(ms),
	now: () => Date.now(),
	signal: (pid, signal) => process.kill(pid, signal),
	fileLimits: () => readFileLimits(defaultSpawnSync),
	realpath: (path) => {
		try {
			return realpathSync(path);
		} catch {
			return null;
		}
	},
	pathExists: (path) => existsSync(path),
	inode: (path) => {
		try {
			return statSync(path).ino;
		} catch {
			return null;
		}
	},
	mirrorRoot: () => join(resolveDev3Home(), TMUX_MIRROR_DIR),
	linkTree: (src, dst) => {
		mkdirSync(dirname(dst), { recursive: true });
		linkTreeSync(src, dst);
	},
	listDir: (path) => {
		try {
			return readdirSync(path);
		} catch {
			return [];
		}
	},
	mtimeMs: (path) => {
		try {
			return statSync(path).mtimeMs;
		} catch {
			return null;
		}
	},
	defer: (task) => {
		setTimeout(task, MIRROR_PRUNE_DELAY_MS).unref?.();
	},
};

function linkTreeSync(src: string, dst: string): void {
	mkdirSync(dst);
	for (const entry of readdirSync(src, { withFileTypes: true })) {
		const [from, to] = [join(src, entry.name), join(dst, entry.name)];
		if (entry.isDirectory()) linkTreeSync(from, to);
		else if (entry.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
		else linkSync(from, to);
	}
}

/**
 * Only a tmux inside an app bundle gains anything: tccd maps it to that
 * bundle's grants. A Homebrew or PATH tmux would be judged as itself and lose
 * the access it inherits from a live app today.
 */
export function usesLaunchdServer(platform: NodeJS.Platform, binary: string): boolean {
	return platform === "darwin" && binary.includes(".app/Contents/");
}

function readFileLimits(spawnSync: SpawnSyncFn): { soft: number; hard: number | null } | null {
	const result = spawnSync(["/bin/sh", "-c", "ulimit -n; ulimit -Hn"], { stdout: "pipe", stderr: "ignore", timeout: PROBE_TIMEOUT_MS });
	if (result.exitCode !== 0) return null;
	const [soft, hard] = new TextDecoder().decode(result.stdout ?? new Uint8Array()).trim().split(/\s+/).map(Number);
	if (!Number.isInteger(soft) || soft <= 0) return null;
	return { soft, hard: Number.isInteger(hard) && hard > 0 ? hard : null };
}

/**
 * Keyed by the socket's full path, not its name: two instances with different
 * TMUX_TMPDIRs share a name but not a server, and must not boot out each other's job.
 */
export function launchdLabel(socketPath: string): string {
	const hash = createHash("sha256").update(socketPath).digest("hex").slice(0, 8);
	return `dev3.tmux.${basename(socketPath).replace(/[^A-Za-z0-9._-]/g, "_")}.${hash}`;
}

function xmlEscape(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// XML 1.0 cannot carry these at all; a variable holding one is dropped, not mangled.
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

export function buildLaunchdPlist(opts: {
	label: string;
	binary: string;
	socket: string;
	configFile: string;
	cwd: string;
	env: Record<string, string | undefined>;
	fileLimits?: { soft: number; hard: number | null } | null;
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
		...fileLimitEntries(opts.fileLimits),
		`\t<key>RunAtLoad</key><true/>`,
		// The default (Standard) lets macOS throttle CPU and I/O like a background daemon.
		`\t<key>ProcessType</key><string>Interactive</string>`,
		`</dict>`,
		`</plist>`,
		``,
	].join("\n");
}

// Panes inherit the server's limits, and tmux never raises them itself.
function fileLimitEntries(limits: { soft: number; hard: number | null } | null | undefined): string[] {
	if (!limits) return [];
	const entries = [`\t<key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>${limits.soft}</integer></dict>`];
	if (limits.hard !== null) {
		entries.push(`\t<key>HardResourceLimits</key><dict><key>NumberOfFiles</key><integer>${limits.hard}</integer></dict>`);
	}
	return entries;
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

function launchctl(args: string[], deps: LaunchdServerDeps, stdout: "pipe" | "ignore" = "ignore") {
	return deps.spawnSync(["launchctl", ...args], { stdout, stderr: "pipe", timeout: PROBE_TIMEOUT_MS });
}

/** The pid of the job's running server; null when it is not loaded or not running. */
function runningJobPid(target: string, deps: LaunchdServerDeps): number | null {
	const job = launchctl(["print", target], deps, "pipe");
	if (job.exitCode !== 0) return null;
	const pid = Number(/^\s*pid = (\d+)/m.exec(new TextDecoder().decode(job.stdout ?? new Uint8Array()))?.[1]);
	return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function waitForServer(binary: string, socket: string, deps: LaunchdServerDeps): boolean {
	for (const deadline = deps.now() + READY_TIMEOUT_MS; deps.now() < deadline; deps.sleep(READY_POLL_MS)) {
		if (probeServer(binary, socket, deps) === "alive") return true;
	}
	return false;
}

/** The bundle root and the binary's path inside it: `/A/dev-3.0.app` + `/Contents/Resources/app/tmux/tmux`. */
function splitBundlePath(binary: string): [string, string] {
	const end = binary.indexOf(".app/Contents/") + ".app".length;
	return [binary.slice(0, end), binary.slice(end)];
}

/**
 * The tmux inside a hardlink tree of the whole bundle under the data root, keyed by the tmux inode.
 * An update deletes the bundle, but the server's file keeps a link here, so the kernel keeps reporting
 * a path inside a signed dev3 bundle and tccd keeps the app's grants. Null when it cannot be built
 * (another volume, a read-only data root): the server then runs from the bundle, as before.
 */
function mirrorBundle(binary: string, deps: LaunchdServerDeps): string | null {
	// Keyed by inode, not dev:ino: links cannot cross volumes, so only a bundle on the data root's
	// volume is ever mirrored, and one elsewhere sharing a mirror's number is a theoretical collision.
	const key = deps.inode(binary);
	if (key === null) return null;
	const [bundle, inside] = splitBundlePath(binary);
	const dir = join(deps.mirrorRoot(), String(key));
	const mirrored = join(dir, basename(bundle)) + inside;
	const complete = join(dir, MIRROR_COMPLETE);
	if (deps.inode(mirrored) === key && deps.pathExists(complete)) return mirrored;
	try {
		// No marker: an interrupted build, which may already hold tmux but not Info.plist. Assumes one
		// writer; a concurrent build at worst makes the other start fall back to the bundle.
		deps.removeDir(dir);
		deps.linkTree(bundle, join(dir, basename(bundle)));
		deps.writeFile(complete, "");
		if (deps.inode(mirrored) === key) return mirrored;
	} catch (err) {
		log.warn("could not mirror the app bundle; the tmux server runs from the bundle itself", { error: String(err) });
	}
	deps.removeDir(dir);
	return null;
}

/** Deletes the mirrors no tmux runs from any more, so an old bundle costs disk only while its server lives. */
function pruneMirrors(deps: LaunchdServerDeps): void {
	const root = deps.mirrorRoot();
	const old = deps.listDir(root).filter((name) => {
		const modified = /^\d+$/.test(name) ? deps.mtimeMs(join(root, name)) : null;
		return modified !== null && deps.now() - modified >= MIRROR_PRUNE_MIN_AGE_MS;
	});
	if (old.length === 0) return;
	// A mirror is named by its tmux inode, so one scan of every tmux's executable covers them all.
	const running = runningTmuxInodes(deps);
	if (!running) return;
	for (const name of old) if (!running.has(Number(name))) deps.removeDir(join(root, name));
}

/** The inodes every running tmux maps as program text; null when lsof cannot tell, which keeps every mirror. */
function runningTmuxInodes(deps: LaunchdServerDeps): Set<number> | null {
	const result = deps.spawnSync(["/usr/sbin/lsof", "-c", "tmux", "-a", "-d", "txt", "-Fi"], {
		stdout: "pipe",
		stderr: "ignore",
		timeout: PROBE_TIMEOUT_MS,
	});
	if (result.exitCode !== 0 || result.exitedDueToTimeout) return null;
	const out = new TextDecoder().decode(result.stdout ?? new Uint8Array());
	return new Set([...out.matchAll(/^i(\d+)$/gm)].map((match) => Number(match[1])));
}

/**
 * Make sure a launchd-owned server listens on `socket` before a
 * server-starting tmux command runs. Never throws and never stops a live
 * server: on any doubt it returns and the caller's own command starts the
 * server exactly as before this module existed.
 */
export function ensureLaunchdServer(
	opts: { binary: string; socket: string; configFile: string; cwd: string; env: Record<string, string | undefined> },
	deps: LaunchdServerDeps = defaultDeps,
): "started" | "skipped" | "fallback" {
	const binary = deps.realpath(opts.binary);
	if (!binary || !usesLaunchdServer(deps.platform, binary)) return "skipped";
	if (probeServer(binary, opts.socket, deps) !== "absent") return "skipped";

	const label = launchdLabel(tmuxSocketPath(opts.socket, opts.env, deps.uid));
	const domain = `gui/${deps.uid}`;
	const target = `${domain}/${label}`;
	let dir: string | null = null;
	let serverBinary = binary;
	try {
		// A running job with no answering socket lost its socket file; SIGUSR1 makes tmux recreate it.
		const livePid = runningJobPid(target, deps);
		if (livePid !== null) {
			deps.signal(livePid, "SIGUSR1");
			if (waitForServer(binary, opts.socket, deps)) return "skipped";
			log.warn("launchd tmux server did not recreate its socket; tmux will start its own server", { label });
			return "fallback";
		}
		// A job left loaded by a server that already exited blocks a new bootstrap (EIO).
		launchctl(["bootout", target], deps);
		serverBinary = mirrorBundle(binary, deps) ?? binary;
		dir = deps.makePrivateDir();
		const plistPath = join(dir, `${label}.plist`);
		deps.writeFile(plistPath, buildLaunchdPlist({ ...opts, binary: serverBinary, label, fileLimits: deps.fileLimits() }));
		const boot = launchctl(["bootstrap", domain, plistPath], deps);
		if (boot.exitCode !== 0) {
			const stderr = boot.stderr ? new TextDecoder().decode(boot.stderr).trim() : "";
			log.warn("launchctl bootstrap failed; tmux will start its own server", {
				label, exitCode: boot.exitCode, timedOut: boot.exitedDueToTimeout === true, stderr,
			});
			// A bootstrap that timed out may still load the job later.
			if (boot.exitedDueToTimeout) launchctl(["bootout", target], deps);
			return "fallback";
		}
	} catch (err) {
		log.warn("launchd tmux start failed; tmux will start its own server", { label, error: String(err) });
		return "fallback";
	} finally {
		// launchd keeps its own copy; the file carries the app environment, so it must not linger.
		if (dir) deps.removeDir(dir);
	}

	if (waitForServer(binary, opts.socket, deps)) {
		log.info("tmux server started as a launchd job", { label, binary: serverBinary });
		if (serverBinary !== binary) deps.defer(() => {
			try {
				pruneMirrors(deps);
			} catch (err) {
				log.warn("could not prune old tmux bundle mirrors", { error: String(err) });
			}
		});
		return "started";
	}
	// A server that never came up must not be left to race the caller's own start.
	launchctl(["bootout", target], deps);
	log.warn("launchd tmux server did not come up; tmux will start its own server", { label });
	return "fallback";
}

/**
 * True when a bundled-tmux server is running on `socket` but launchd does not
 * own it — a server an older dev3 daemonized, still exposed to the TCC loss
 * until it restarts. Any doubt answers false: this only drives a hint.
 */
export function predatesLaunchdServer(
	opts: { binary: string; socket: string; env?: Record<string, string | undefined> },
	deps: LaunchdServerDeps = defaultDeps,
): boolean {
	const binary = deps.realpath(opts.binary);
	if (!binary || !usesLaunchdServer(deps.platform, binary)) return false;
	const serverPid = liveServerPid(binary, opts.socket, deps);
	if (serverPid === null) return false;

	const label = launchdLabel(tmuxSocketPath(opts.socket, opts.env ?? process.env, deps.uid));
	const job = launchctl(["print", `gui/${deps.uid}/${label}`], deps, "pipe");
	if (job.exitedDueToTimeout) return false;
	if (job.exitCode === LAUNCHCTL_NO_SUCH_SERVICE) return true;
	if (job.exitCode !== 0) return false;
	const jobPid = Number(/^\s*pid = (\d+)/m.exec(new TextDecoder().decode(job.stdout ?? new Uint8Array()))?.[1]);
	return jobPid !== serverPid;
}

function liveServerPid(binary: string, socket: string, deps: LaunchdServerDeps): number | null {
	const server = deps.spawnSync([binary, "-L", socket, "display-message", "-p", "#{pid}"], {
		stdout: "pipe",
		stderr: "ignore",
		timeout: PROBE_TIMEOUT_MS,
	});
	if (server.exitCode !== 0 || server.exitedDueToTimeout) return null;
	const pid = Number(new TextDecoder().decode(server.stdout ?? new Uint8Array()).trim());
	return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** The program text of `pid` as lsof sees it now: it follows a move, unlike argv or `ps -o comm=`. */
function processExecutable(pid: number, deps: LaunchdServerDeps) {
	const result = deps.spawnSync(["/usr/sbin/lsof", "-a", "-p", String(pid), "-d", "txt", "-Fikn"], {
		stdout: "pipe",
		stderr: "ignore",
		timeout: PROBE_TIMEOUT_MS,
	});
	if (result.exitCode !== 0 || result.exitedDueToTimeout) return null;
	return parseLsofExecutable(new TextDecoder().decode(result.stdout ?? new Uint8Array()));
}

/**
 * Whether the live server on `socket` is at risk of losing folder access. `deleted`: its file has no
 * links left (an update replaced or removed the bundle it ran from), which macOS 27 answers by denying
 * every pane at its next check. A server running from this bundle or from a mirror (`mirrorBundle`)
 * is fine. `elsewhere`: another dev3 bundle, lost once that copy is deleted. Any doubt answers null:
 * this only drives a hint.
 */
export function staleServerBinary(
	opts: { binary: string; socket: string },
	deps: LaunchdServerDeps = defaultDeps,
): "deleted" | "elsewhere" | null {
	const binary = deps.realpath(opts.binary);
	if (!binary || !usesLaunchdServer(deps.platform, binary)) return null;
	const serverPid = liveServerPid(binary, opts.socket, deps);
	if (serverPid === null) return null;
	const executable = processExecutable(serverPid, deps);
	if (!executable) return null;
	if (executableDeleted(executable, deps.inode)) return "deleted";
	// lsof names a hardlinked file by its last-used link, so a mirror is recognised by its inode-named dir.
	const mirrored = executable.inode !== null && deps.pathExists(join(deps.mirrorRoot(), String(executable.inode)));
	if (executable.path === binary || mirrored) return null;
	// A file that still has a link is not gone, even when lsof is left with a bare `/tmux` for it.
	if (executable.links === null && !deps.pathExists(executable.path)) return "deleted";
	return usesLaunchdServer(deps.platform, executable.path) && deps.pathExists(executable.path) ? "elsewhere" : null;
}
