import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { ParsedArgs } from "../args";
import { exitError, exitUsage } from "../output";
import { rejectUnknownFlags } from "../flag-validation";
import { remoteStaticCodeError } from "../../shared/remote-static-code";
import { STATIC_CODE_PUBLIC_TUNNEL_WARNING, shouldWarnAboutPublicTunnel } from "../remote-static-code-notice";
import { listenHostError } from "../../shared/remote-listen-host";

/**
 * `dev3 remote install-service` / `uninstall-service` — manage a **systemd
 * --user** unit that runs the headless server, so it survives logout and starts
 * on boot. This is the persistent counterpart to `dev3 remote --detach` (which
 * only survives the current shell). Linux-only, and only meaningful from the
 * compiled `dev3` binary (a dev `bun run` checkout has no stable ExecStart).
 *
 * Mirrors the XDG-desktop-entry pattern in `gui.ts`: we write a file under the
 * user's config dir and never invoke sudo — `--user` units need no root.
 */

const SERVICE_NAME = "dev3-remote.service";

function userUnitDir(): string {
	const home = process.env.HOME || "";
	const xdg = process.env.XDG_CONFIG_HOME;
	const base = xdg && xdg.trim() ? xdg : `${home}/.config`;
	return `${base}/systemd/user`;
}

function unitPath(): string {
	return `${userUnitDir()}/${SERVICE_NAME}`;
}

/** True when the CLI runs via `bun run …` (dev) rather than as the compiled binary. */
function isRunningViaBun(): boolean {
	const exec = process.execPath;
	return exec.endsWith("/bun") || exec.endsWith("\\bun.exe");
}

/** Absolute path to the installed `dev3` binary (resolves brew bin → libexec symlinks). */
function resolveDev3Binary(): string {
	try {
		return realpathSync(process.execPath);
	} catch {
		return process.execPath;
	}
}

/** True if `systemctl` is on PATH. */
function hasSystemctl(): boolean {
	const r = spawnSync("which", ["systemctl"], { encoding: "utf-8" });
	return r.status === 0 && typeof r.stdout === "string" && r.stdout.trim().length > 0;
}

/** The validated `--host` value, or undefined when the flag is absent. Exits on a bad value. */
export function parseHostFlag(args: ParsedArgs): string | undefined {
	if (args.flags.host === undefined) return undefined;
	if (args.flags.host === "true") exitUsage(`--host requires a value: --host <addr>`);
	const host = args.flags.host.trim();
	const problem = listenHostError(host);
	if (problem) exitUsage(`--host ${problem}`);
	return host;
}

/**
 * Translate install-service flags into the `dev3 remote start …` arguments the
 * unit's ExecStart runs. Always includes --no-detach: `dev3 remote` backgrounds
 * by default now, but systemd (Type=simple) owns the process lifecycle and tracks
 * the foreground process — a detaching ExecStart would fork-and-exit and systemd
 * would treat the unit as failed.
 */
export function buildExecStartArgs(args: ParsedArgs): string[] {
	const out = ["remote", "start", "--no-detach"];

	if (args.flags.port !== undefined) {
		if (args.flags.port === "true") exitUsage(`--port requires a value: --port <1-65535>`);
		const n = Number.parseInt(args.flags.port, 10);
		if (!Number.isFinite(n) || n < 1 || n > 65535 || String(n) !== args.flags.port.trim()) {
			exitUsage(`--port must be an integer in 1-65535 (got "${args.flags.port}")`);
		}
		out.push("--port", String(n));
	}
	const host = parseHostFlag(args);
	if (host !== undefined) out.push("--host", host);
	if (args.flags["no-tunnel"] === "true") out.push("--no-tunnel");
	if (args.flags["expose-ports"] && args.flags["expose-ports"] !== "true") {
		out.push(`--expose-ports=${args.flags["expose-ports"]}`);
	}
	if (args.flags["static-code"] && args.flags["static-code"] !== "true") {
		const code = args.flags["static-code"];
		// Mirror buildServerEnv()'s min-length gate — otherwise the unit is written
		// and enabled, but every `dev3 remote start` it spawns exits non-zero, and
		// Restart=on-failure turns that into a silent restart loop (only visible in
		// journalctl). Validate at install time instead.
		const problem = remoteStaticCodeError(code);
		if (problem) {
			exitUsage(`--static-code ${problem}`);
		}
		// systemd splits ExecStart on whitespace (no shell), so a code with spaces
		// would be parsed as extra positional args and crash the server on every
		// start. Reject it here rather than emit a broken unit.
		if (/\s/.test(code)) {
			exitUsage(`--static-code must not contain whitespace (systemd splits ExecStart on spaces)`);
		}
		out.push(`--static-code=${code}`);
	} else if (args.flags["static-code"] === "true") {
		exitUsage(`--static-code requires a value: --static-code=<your-code>`);
	}
	// Same notice as the interactive `dev3 remote` path (collectRemoteEnv): the
	// combination is allowed — it is how you reach a headless box from a phone —
	// so say what it means at install time instead of refusing to write the unit.
	if (shouldWarnAboutPublicTunnel({
		flagCode: out.find((a) => a.startsWith("--static-code="))?.slice("--static-code=".length),
		tunnelDisabled: out.includes("--no-tunnel"),
	})) {
		process.stderr.write(`${STATIC_CODE_PUBLIC_TUNNEL_WARNING}\n`);
	}
	return out;
}

/**
 * Variables the installing shell may set that change how the server behaves.
 * systemd starts the unit with a bare environment, so anything not written into
 * the unit is lost. An allowlist, not `DEV3_*`: a task shell also carries
 * per-task vars (DEV3_TASK_ID, DEV3_REMOTE_PORT, ...) that must not leak in.
 */
export const SERVICE_ENV_KEYS = [
	"DEV3_TELEMETRY",
	"DO_NOT_TRACK",
	"DEV3_HOME",
	"DEV3_LOG_LEVEL",
	"DEV3_CLOUDFLARED_PROTOCOL",
	"DEV3_CLOUDFLARED_EDGE_BIND",
] as const;

export type ServiceEnv = Array<[string, string]>;

/**
 * The allowlisted variables that are set and non-empty, in allowlist order.
 * `DEV3_HOME` is made absolute: systemd runs the unit from `~`, not from this shell's cwd.
 */
export function collectServiceEnv(env: Readonly<Record<string, string | undefined>>): ServiceEnv {
	const out: ServiceEnv = [];
	for (const key of SERVICE_ENV_KEYS) {
		const value = env[key];
		if (value === undefined || value.trim() === "") continue;
		if (/[\x00-\x1f\x7f]/.test(value)) {
			exitUsage(`$${key} contains a control character and cannot be written into a systemd unit`);
		}
		out.push([key, key === "DEV3_HOME" ? resolve(value) : value]);
	}
	return out;
}

/** The allowlisted `Environment=` values a previously written unit carried. Inverse of renderEnvironmentLine. */
export function parseUnitServiceEnv(unit: string): ServiceEnv {
	const found = new Map<string, string>();
	for (const line of unit.split("\n")) {
		const m = /^Environment="(.*)"$/.exec(line.trim());
		if (!m) continue;
		const pair = m[1].replace(/\\(["\\])|%%/g, (_whole, ch: string | undefined) => ch ?? "%");
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		found.set(pair.slice(0, eq), pair.slice(eq + 1));
	}
	return SERVICE_ENV_KEYS.flatMap((key): ServiceEnv => (found.has(key) ? [[key, found.get(key)!]] : []));
}

/**
 * Shell values win; a key the shell does not set keeps the value the previous unit carried.
 * Without this, re-running install-service from a fresh shell (say, to change the port)
 * would silently drop `DEV3_TELEMETRY=off` and turn telemetry back on.
 */
export function mergeServiceEnv(fromShell: ServiceEnv, fromPreviousUnit: ServiceEnv): { env: ServiceEnv; kept: ServiceEnv } {
	const shell = new Map(fromShell);
	const previous = new Map(fromPreviousUnit);
	const env: ServiceEnv = [];
	const kept: ServiceEnv = [];
	for (const key of SERVICE_ENV_KEYS) {
		const value = shell.get(key) ?? previous.get(key);
		if (value === undefined) continue;
		env.push([key, value]);
		if (!shell.has(key)) kept.push([key, value]);
	}
	return { env, kept };
}

function readExistingUnit(path: string): string {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

/** One `Environment=` line, quoted so spaces, quotes, backslashes and `%` survive systemd parsing. */
function renderEnvironmentLine(key: string, value: string): string {
	const escaped = `${key}=${value}`.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("%", "%%");
	return `Environment="${escaped}"`;
}

/** Render the systemd unit file body. Pure — exported for tests. */
export function renderUnitFile(binPath: string, execArgs: string[], env: ServiceEnv = []): string {
	const execStart = [binPath, ...execArgs].join(" ");
	return [
		"[Unit]",
		"Description=dev-3.0 headless remote server (dev3 remote)",
		"After=network-online.target",
		"Wants=network-online.target",
		"",
		"[Service]",
		"Type=simple",
		...env.map(([key, value]) => renderEnvironmentLine(key, value)),
		`ExecStart=${execStart}`,
		// Clean `dev3 remote stop` / `systemctl stop` exits 0 → no restart; only a
		// crash restarts. Keeps `dev3 remote stop` authoritative even under systemd.
		"Restart=on-failure",
		"RestartSec=5",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}

export async function installRemoteService(args: ParsedArgs): Promise<void> {
	rejectUnknownFlags(args, ["port", "host", "no-tunnel", "expose-ports", "static-code", "no-start", "help", "h"]);

	if (process.platform !== "linux") {
		exitError(
			`install-service is Linux-only (systemd --user).`,
			`On macOS, run \`dev3 remote --detach\` to background the server, or wrap it in launchd yourself.`,
		);
	}
	if (isRunningViaBun()) {
		exitError(
			`install-service needs the compiled dev3 binary.`,
			`You're running via \`bun run …\`, which has no stable ExecStart path. Install dev3 (Homebrew or the CLI tarball) and rerun from that binary.`,
		);
	}
	if (!process.env.HOME) {
		exitError(`Cannot resolve $HOME — needed to place the systemd --user unit.`);
	}

	const binPath = resolveDev3Binary();
	const execArgs = buildExecStartArgs(args);
	const noPort = !execArgs.includes("--port");
	const fromShell = collectServiceEnv(process.env);

	const dir = userUnitDir();
	mkdirSync(dir, { recursive: true });
	const path = unitPath();
	const { env: serviceEnv, kept } = mergeServiceEnv(fromShell, parseUnitServiceEnv(readExistingUnit(path)));
	writeFileSync(path, renderUnitFile(binPath, execArgs, serviceEnv));
	process.stdout.write(`Wrote systemd unit: ${path}\n`);
	process.stdout.write(`  ExecStart=${[binPath, ...execArgs].join(" ")}\n`);
	if (fromShell.length > 0) {
		process.stdout.write(`  Carried from this shell into the unit:\n`);
		for (const [key, value] of fromShell) process.stdout.write(`    ${key}=${value}\n`);
	}
	if (kept.length > 0) {
		process.stdout.write(`  Kept from the previous unit (not set in this shell):\n`);
		for (const [key, value] of kept) process.stdout.write(`    ${key}=${value}\n`);
	}
	if (serviceEnv.length === 0) {
		process.stdout.write(`  No environment carried (none of ${SERVICE_ENV_KEYS.join(", ")} is set).\n`);
	}
	process.stdout.write(
		`  To change a value, set it and re-run \`dev3 remote install-service\`;\n` +
		`  to drop one, run \`dev3 remote uninstall-service\` first.\n`,
	);
	if (noPort) {
		process.stdout.write(
			`  ⚠ No --port given — the server picks a random port each start, which makes\n` +
			`    SSH-forwarding and reverse proxies awkward. Re-run with --port <n> for a stable port.\n`,
		);
	}

	if (!hasSystemctl()) {
		process.stdout.write(
			`\nsystemctl not found — the unit was written but not enabled.\n` +
			`Once systemd is available, run:\n` +
			`  systemctl --user daemon-reload\n` +
			`  systemctl --user enable --now ${SERVICE_NAME}\n`,
		);
		return;
	}

	run(["systemctl", "--user", "daemon-reload"]);
	const noStart = args.flags["no-start"] === "true";
	const enableArgs = noStart
		? ["systemctl", "--user", "enable", SERVICE_NAME]
		: ["systemctl", "--user", "enable", "--now", SERVICE_NAME];
	const enabled = run(enableArgs);

	if (enabled) {
		process.stdout.write(
			`\n✓ Service ${noStart ? "enabled" : "enabled and started"}.\n` +
			`  Status:  systemctl --user status ${SERVICE_NAME}\n` +
			`  Logs:    journalctl --user -u ${SERVICE_NAME} -f\n` +
			`  Link:    dev3 remote url\n` +
			`\n  To keep it running after you log out (headless box):\n` +
			`    sudo loginctl enable-linger ${process.env.USER || "$USER"}\n`,
		);
	} else {
		process.stdout.write(
			`\nThe unit is written at ${path}, but \`systemctl --user\` failed.\n` +
			`If this box has no user D-Bus session (common over plain SSH), enable lingering first:\n` +
			`  sudo loginctl enable-linger ${process.env.USER || "$USER"}\n` +
			`then re-run \`dev3 remote install-service\`.\n`,
		);
	}
}

export async function uninstallRemoteService(args: ParsedArgs): Promise<void> {
	rejectUnknownFlags(args, ["help", "h"]);

	if (process.platform !== "linux") {
		exitError(`uninstall-service is Linux-only (systemd --user).`);
	}

	const path = unitPath();
	if (hasSystemctl()) {
		run(["systemctl", "--user", "disable", "--now", SERVICE_NAME]);
	}
	if (existsSync(path)) {
		try {
			unlinkSync(path);
			process.stdout.write(`Removed systemd unit: ${path}\n`);
		} catch (err) {
			exitError(`Failed to remove ${path}: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else {
		process.stdout.write(`No systemd unit found at ${path} — nothing to remove.\n`);
	}
	if (hasSystemctl()) run(["systemctl", "--user", "daemon-reload"]);
	process.stdout.write(`Done. The dev3 remote service is stopped and disabled.\n`);
}

/** Run a command, streaming its output; return true on exit code 0. */
function run(cmd: string[]): boolean {
	const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
	return r.status === 0;
}
