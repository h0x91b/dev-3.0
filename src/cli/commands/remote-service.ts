import { existsSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { ParsedArgs } from "../args";
import { exitError, exitUsage } from "../output";
import { rejectUnknownFlags } from "../flag-validation";

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

/**
 * Translate install-service flags into the `dev3 remote start …` arguments the
 * unit's ExecStart runs. Note: NO --detach — systemd owns the process lifecycle,
 * so the server must run in the foreground.
 */
export function buildExecStartArgs(args: ParsedArgs): string[] {
	const out = ["remote", "start"];

	if (args.flags.port !== undefined) {
		if (args.flags.port === "true") exitUsage(`--port requires a value: --port <1-65535>`);
		const n = Number.parseInt(args.flags.port, 10);
		if (!Number.isFinite(n) || n < 1 || n > 65535 || String(n) !== args.flags.port.trim()) {
			exitUsage(`--port must be an integer in 1-65535 (got "${args.flags.port}")`);
		}
		out.push("--port", String(n));
	}
	if (args.flags["no-tunnel"] === "true") out.push("--no-tunnel");
	if (args.flags["expose-ports"] && args.flags["expose-ports"] !== "true") {
		out.push(`--expose-ports=${args.flags["expose-ports"]}`);
	}
	if (args.flags["static-code"] && args.flags["static-code"] !== "true") {
		out.push(`--static-code=${args.flags["static-code"]}`);
	}
	return out;
}

/** Render the systemd unit file body. Pure — exported for tests. */
export function renderUnitFile(binPath: string, execArgs: string[]): string {
	const execStart = [binPath, ...execArgs].join(" ");
	return [
		"[Unit]",
		"Description=dev-3.0 headless remote server (dev3 remote)",
		"After=network-online.target",
		"Wants=network-online.target",
		"",
		"[Service]",
		"Type=simple",
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
	rejectUnknownFlags(args, ["port", "no-tunnel", "expose-ports", "static-code", "no-start", "help", "h"]);

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

	const dir = userUnitDir();
	mkdirSync(dir, { recursive: true });
	const path = unitPath();
	writeFileSync(path, renderUnitFile(binPath, execArgs));
	process.stdout.write(`Wrote systemd unit: ${path}\n`);
	process.stdout.write(`  ExecStart=${[binPath, ...execArgs].join(" ")}\n`);
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
