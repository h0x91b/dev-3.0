import { accessSync, constants, existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { VENDORED_TMUX_PATHS } from "../../bun/rpc-handlers/shared-pure";
import { resolveSocketPath } from "../context";
import { BUILD_VERSION } from "../../shared/build-info.generated";
import { CLI_EXIT_CODE_DOCTOR_PROBLEMS, CLI_EXIT_CODE_SUCCESS } from "../../shared/cli-exit-codes";
import type { ParsedArgs } from "../args";
import { isExecutableFile } from "../../bun/executable";

// `dev3 doctor` — install health check. Deliberately works WITHOUT the app
// running (and without the socket): its whole purpose is diagnosing installs
// where the app crashed, the bundle was ripped away by a broken `brew upgrade`,
// or the tmux shim is poisoned. Read-only: it never fixes anything itself,
// it prints the exact command to run.

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
	/** Short check label, e.g. "tmux shim". */
	label: string;
	status: CheckStatus;
	/** One-line finding. */
	detail: string;
	/** Concrete remediation command(s)/steps, shown indented under the finding. */
	hints?: string[];
}

/** Everything the checks touch in the outside world, injectable for tests. */
export interface DoctorDeps {
	platform: NodeJS.Platform;
	home: string;
	cliVersion: string;
	/** Path of the running dev3 binary — bundled tmux lives next to it in CLI artifacts. */
	execPath: string;
	existsSync: (path: string) => boolean;
	isWritable: (path: string) => boolean;
	isSymlink: (path: string) => boolean;
	readlink: (path: string) => string;
	/** Throws on dangling targets and ELOOP cycles — same probe as pty-server's shim sanitizer. */
	realpath: (path: string) => string;
	isExecutableFile: (path: string) => boolean;
	readFile: (path: string) => string;
	/** Run a binary; null status/empty stdout on any spawn failure. */
	exec: (cmd: string, args: string[]) => { status: number | null; stdout: string };
	/** Live app socket path, or null when the app is not running. */
	socketPath: () => string | null;
}

export function realDoctorDeps(): DoctorDeps {
	return {
		platform: process.platform,
		home: process.env.HOME || "/tmp",
		cliVersion: BUILD_VERSION,
		execPath: process.execPath,
		existsSync,
		isWritable: (path) => {
			try {
				accessSync(path, constants.W_OK);
				return true;
			} catch {
				return false;
			}
		},
		isSymlink: (path) => {
			try {
				return lstatSync(path).isSymbolicLink();
			} catch {
				return false;
			}
		},
		readlink: (path) => readlinkSync(path),
		realpath: (path) => realpathSync(path),
		isExecutableFile,
		readFile: (path) => readFileSync(path, "utf-8"),
		exec: (cmd, args) => {
			try {
				const res = spawnSync(cmd, args, { encoding: "utf-8", timeout: 15_000 });
				return { status: res.status, stdout: res.stdout || "" };
			} catch {
				return { status: null, stdout: "" };
			}
		},
		socketPath: () => resolveSocketPath(),
	};
}

const APP_BUNDLE_CANDIDATES = ["/Applications/dev-3.0.app", "~/Applications/dev-3.0.app"];

/** Read the app version from the bundle's Info.plist (CFBundleVersion). */
function bundleVersion(deps: DoctorDeps, bundlePath: string): string | undefined {
	try {
		const plist = deps.readFile(`${bundlePath}/Contents/Info.plist`);
		return plist.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
	} catch {
		return undefined;
	}
}

function checkDataDir(deps: DoctorDeps): CheckResult {
	const dir = `${deps.home}/.dev3.0`;
	if (!deps.existsSync(dir)) {
		return {
			label: "data dir",
			status: "fail",
			detail: `${dir} does not exist`,
			hints: ["Start the desktop app once (or run `dev3 remote`) — it creates the data directory."],
		};
	}
	if (!deps.isWritable(dir)) {
		return {
			label: "data dir",
			status: "fail",
			detail: `${dir} is not writable`,
			hints: [`chown/chmod ${dir} so your user can write to it.`],
		};
	}
	return { label: "data dir", status: "ok", detail: `${dir} (writable)` };
}

function checkAppBundle(deps: DoctorDeps): { result: CheckResult; bundlePath?: string; appVersion?: string } {
	if (deps.platform !== "darwin") {
		return { result: { label: "desktop app", status: "ok", detail: "skipped (not macOS; Linux runs via `dev3 gui`/`dev3 remote`)" } };
	}
	const bundlePath = APP_BUNDLE_CANDIDATES.map((p) => p.replace(/^~/, deps.home)).find((p) => deps.existsSync(p));
	if (!bundlePath) {
		return {
			result: {
				label: "desktop app",
				status: "warn",
				detail: "dev-3.0.app not found in /Applications or ~/Applications",
				hints: [
					"A failed `brew upgrade` can remove the app mid-upgrade. Reinstall:",
					"  brew uninstall --cask dev3 2>/dev/null; rm -rf \"$(brew --prefix)/Caskroom/dev3\"",
					"  brew install --cask h0x91b/dev3/dev3",
					"(Fine to ignore if you only use `dev3 remote` on this machine.)",
				],
			},
		};
	}
	const appVersion = bundleVersion(deps, bundlePath);
	return {
		result: { label: "desktop app", status: "ok", detail: `${bundlePath} (${appVersion ?? "version unknown"})` },
		bundlePath,
		appVersion,
	};
}

function checkAppRunning(deps: DoctorDeps): CheckResult {
	const socket = deps.socketPath();
	if (socket) return { label: "app running", status: "ok", detail: `yes (socket ${socket})` };
	return { label: "app running", status: "ok", detail: "no live socket (app not running — informational)" };
}

function checkCliVersion(deps: DoctorDeps, appVersion?: string): CheckResult {
	if (!appVersion) return { label: "cli version", status: "ok", detail: `${deps.cliVersion} (app version unknown — skipped comparison)` };
	if (appVersion === deps.cliVersion) return { label: "cli version", status: "ok", detail: `${deps.cliVersion} (matches the app)` };
	return {
		label: "cli version",
		status: "warn",
		detail: `CLI is ${deps.cliVersion} but the app bundle is ${appVersion}`,
		hints: ["The app rewrites ~/.dev3.0/bin/dev3 on every startup — quit and relaunch dev-3.0 to sync."],
	};
}

function tmuxVersion(deps: DoctorDeps, binary: string): string | undefined {
	const result = deps.exec(binary, ["-V"]);
	const version = result.stdout.trim();
	return result.status === 0 && /^tmux \d/.test(version) ? version : undefined;
}

function tmuxSettingRepairHints(deps: DoctorDeps, settingsPath: string): string[] {
	return [
		"Quit dev-3.0 completely before changing this setting.",
		`cp ${settingsPath} ${settingsPath}.before-tmux-fix`,
		deps.platform === "darwin"
			? `plutil -remove customBinaryPaths.tmux ${settingsPath}`
			: `Remove customBinaryPaths.tmux from ${settingsPath}.`,
		`rm -f ${deps.home}/.dev3.0/bin/tmux`,
		"Relaunch dev-3.0 — it will resolve tmux again and recreate the shim.",
	];
}

function checkTmuxSetting(deps: DoctorDeps): CheckResult {
	const settingsPath = `${deps.home}/.dev3.0/settings.json`;
	if (!deps.existsSync(settingsPath)) {
		return { label: "tmux setting", status: "ok", detail: "no custom path saved (automatic resolution)" };
	}
	let customPath: unknown;
	try {
		const settings = JSON.parse(deps.readFile(settingsPath)) as { customBinaryPaths?: { tmux?: unknown } };
		customPath = settings.customBinaryPaths?.tmux;
	} catch {
		return {
			label: "tmux setting",
			status: "warn",
			detail: `${settingsPath} could not be parsed; custom tmux path was not checked`,
			hints: ["Open the file and repair its JSON, then run `dev3 doctor` again."],
		};
	}
	if (customPath === undefined) {
		return { label: "tmux setting", status: "ok", detail: "no custom path saved (automatic resolution)" };
	}
	if (typeof customPath !== "string" || !deps.isExecutableFile(customPath)) {
		return {
			label: "tmux setting",
			status: "fail",
			detail: `saved custom path is not an executable file: ${String(customPath)}`,
			hints: tmuxSettingRepairHints(deps, settingsPath),
		};
	}
	const version = tmuxVersion(deps, customPath);
	if (!version) {
		return {
			label: "tmux setting",
			status: "fail",
			detail: `saved custom path is executable but is not tmux: ${customPath}`,
			hints: tmuxSettingRepairHints(deps, settingsPath),
		};
	}
	return { label: "tmux setting", status: "ok", detail: `${customPath} (${version})` };
}

function checkTmuxShim(deps: DoctorDeps): CheckResult {
	const shim = `${deps.home}/.dev3.0/bin/tmux`;
	if (!deps.existsSync(shim) && !deps.isSymlink(shim)) {
		return { label: "tmux shim", status: "ok", detail: "absent (the app creates it on startup)" };
	}
	if (!deps.isSymlink(shim)) {
		return {
			label: "tmux shim",
			status: "warn",
			detail: `${shim} is a regular file, not the app's symlink — used as your own tmux binary`,
			hints: [`If you did not put it there yourself: rm ${shim}  (the app recreates the symlink).`],
		};
	}
	try {
		const target = deps.realpath(shim); // throws on dangling targets and self-referential ELOOP cycles
		if (!deps.isExecutableFile(target)) {
			return {
				label: "tmux shim",
				status: "fail",
				detail: `broken symlink → ${deps.readlink(shim)} (target is not an executable file)`,
				hints: [`rm ${shim}`, "then relaunch dev-3.0 — it recreates a healthy shim."],
			};
		}
		if (!tmuxVersion(deps, target)) {
			return {
				label: "tmux shim",
				status: "fail",
				detail: `broken symlink → ${deps.readlink(shim)} (target is not tmux)`,
				hints: [`rm ${shim}`, "then relaunch dev-3.0 — it recreates a healthy shim."],
			};
		}
		return { label: "tmux shim", status: "ok", detail: `→ ${deps.readlink(shim)}` };
	} catch {
		let target = "(unreadable)";
		try {
			target = deps.readlink(shim);
		} catch {
			/* keep placeholder */
		}
		return {
			label: "tmux shim",
			status: "fail",
			detail: `broken symlink → ${target} (dangling or self-referential)`,
			hints: [`rm ${shim}`, "then relaunch dev-3.0 — it recreates a healthy shim."],
		};
	}
}

/**
 * Where release artifacts place the bundled self-contained tmux
 * (decisions/137): next to the dev3 binary in CLI tarball / brew libexec
 * installs, and under Resources/app/ inside the desktop app bundle.
 */
function bundledTmuxCandidates(deps: DoctorDeps): string[] {
	if (deps.platform !== "darwin") return [];
	const candidates: string[] = [];
	try {
		candidates.push(join(dirname(deps.realpath(deps.execPath)), "tmux", "tmux"));
	} catch {
		/* unreadable execPath — skip the CLI-sibling candidate */
	}
	for (const bundle of APP_BUNDLE_CANDIDATES) {
		candidates.push(`${bundle.replace(/^~/, deps.home)}/Contents/Resources/app/tmux/tmux`);
	}
	return candidates;
}

function checkTmuxBinary(deps: DoctorDeps): CheckResult {
	// Bundled self-contained tmux (preferred by the app — decisions/137).
	for (const bundled of bundledTmuxCandidates(deps)) {
		if (!deps.isExecutableFile(bundled)) continue;
		const version = tmuxVersion(deps, bundled);
		if (version) return { label: "tmux binary", status: "ok", detail: `bundled ${bundled} (${version})` };
	}
	for (const keg of VENDORED_TMUX_PATHS) {
		if (!deps.existsSync(keg) || !deps.isExecutableFile(keg)) continue;
		const version = tmuxVersion(deps, keg);
		if (version) return { label: "tmux binary", status: "ok", detail: `keg ${keg} (${version})` };
	}
	// No bundled tmux and no keg — the app falls back to PATH tmux (fine for
	// a single instance, unless it's the known-bad 3.7 line).
	const pathTmux = deps.exec("tmux", ["-V"]);
	const version = pathTmux.stdout.trim();
	if (pathTmux.status !== 0 || !/^tmux \d/.test(version)) {
		return {
			label: "tmux binary",
			status: "fail",
			detail: "no bundled tmux, no usable tmux@3.6 keg and no tmux in PATH — terminals cannot start",
			hints: [
				"Reinstall the dev-3.0 app (release bundles ship their own tmux since v1.36).",
				"Or install the pinned keg: brew install h0x91b/dev3/tmux@3.6",
			],
		};
	}
	if (/tmux 3\.7/.test(version)) {
		return {
			label: "tmux binary",
			status: "warn",
			detail: `bundled/keg tmux absent; PATH has ${version} — known CPU-storm regression with multiple dev-3.0 instances`,
			hints: ["brew install h0x91b/dev3/tmux@3.6   # the app prefers bundled/keg tmux automatically"],
		};
	}
	return { label: "tmux binary", status: "ok", detail: `bundled/keg tmux absent; PATH has ${version} (fine — bundled tmux is only preferred, not required)` };
}

function checkHomebrew(deps: DoctorDeps, appVersion?: string, bundleExists?: boolean): CheckResult[] {
	const prefix = deps.exec("brew", ["--prefix"]).stdout.trim();
	if (!prefix) {
		return [{ label: "homebrew", status: "ok", detail: "brew not found — skipping Homebrew checks" }];
	}
	const results: CheckResult[] = [];

	const caskList = deps.exec("brew", ["list", "--cask", "--versions", "dev3"]);
	const caskVersion = caskList.status === 0 ? caskList.stdout.trim().split(/\s+/)[1] : undefined;
	const caskroomExists = deps.existsSync(`${prefix}/Caskroom/dev3`);

	if (caskVersion) {
		if (appVersion && caskVersion !== appVersion) {
			results.push({
				label: "homebrew cask",
				status: "ok",
				detail: `installed (records ${caskVersion}, app is ${appVersion} — normal after in-app updates)`,
			});
		} else {
			results.push({ label: "homebrew cask", status: "ok", detail: `installed (${caskVersion})` });
		}
	} else if (caskroomExists) {
		results.push({
			label: "homebrew cask",
			status: "fail",
			detail: "leftover Caskroom directory but the cask is not installed — a `brew upgrade` died mid-flight",
			hints: [`rm -rf "${prefix}/Caskroom/dev3"`, "brew install --cask h0x91b/dev3/dev3   # add --adopt if the app is already in /Applications"],
		});
	} else if (deps.platform === "darwin" && bundleExists) {
		results.push({
			label: "homebrew cask",
			status: "ok",
			detail: "not installed (app not managed by brew — use `brew install --cask h0x91b/dev3/dev3 --adopt` to change that)",
		});
	} else {
		results.push({ label: "homebrew cask", status: "ok", detail: "not installed" });
	}

	const formulaList = deps.exec("brew", ["list", "--formula", "--versions", "dev3"]);
	if (formulaList.status === 0 && formulaList.stdout.trim()) {
		if (deps.platform === "darwin" && bundleExists) {
			results.push({
				label: "homebrew formula",
				status: "warn",
				detail: "the headless CLI formula `dev3` is installed alongside the desktop app — usually an accidental `brew install` without `--cask`",
				hints: ["brew uninstall --formula dev3   # the app ships its own CLI in ~/.dev3.0/bin"],
			});
		} else {
			results.push({ label: "homebrew formula", status: "ok", detail: "headless CLI formula installed" });
		}
	}

	return results;
}

/** Run every check. Pure with respect to `deps` — no printing, no exiting. */
export function collectChecks(deps: DoctorDeps): CheckResult[] {
	const results: CheckResult[] = [];
	results.push(checkDataDir(deps));
	const app = checkAppBundle(deps);
	results.push(app.result);
	results.push(checkAppRunning(deps));
	results.push(checkCliVersion(deps, app.appVersion));
	results.push(checkTmuxSetting(deps));
	results.push(checkTmuxShim(deps));
	results.push(checkTmuxBinary(deps));
	results.push(...checkHomebrew(deps, app.appVersion, Boolean(app.bundlePath)));
	return results;
}

const STATUS_MARK: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

export function renderChecks(results: CheckResult[]): string {
	const labelWidth = Math.max(...results.map((r) => r.label.length));
	const lines: string[] = [];
	for (const r of results) {
		lines.push(`${STATUS_MARK[r.status]} ${r.label.padEnd(labelWidth)}  ${r.detail}`);
		for (const hint of r.hints ?? []) {
			lines.push(`    ↳ ${hint}`);
		}
	}
	const problems = results.filter((r) => r.status === "fail").length;
	const warnings = results.filter((r) => r.status === "warn").length;
	lines.push("");
	lines.push(
		problems === 0 && warnings === 0
			? "Everything looks healthy."
			: `${problems} problem${problems === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}.`,
	);
	return lines.join("\n") + "\n";
}

export async function handleDoctor(args: ParsedArgs, deps: DoctorDeps = realDoctorDeps()): Promise<void> {
	const results = collectChecks(deps);
	if (args.flags?.json) {
		process.stdout.write(JSON.stringify({ checks: results }, null, 2) + "\n");
	} else {
		process.stdout.write(renderChecks(results));
	}
	const hasProblems = results.some((r) => r.status === "fail");
	process.exit(hasProblems ? CLI_EXIT_CODE_DOCTOR_PROBLEMS : CLI_EXIT_CODE_SUCCESS);
}
