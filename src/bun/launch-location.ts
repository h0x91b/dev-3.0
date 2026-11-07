/**
 * Launch-time guard against running dev3 from somewhere it can never update itself:
 * a mounted DMG, a hidden App Translocation copy, or any other read-only location.
 * The update-time half of the story is `macBundleReplaceBlocker()` in updater.ts;
 * see decisions/2026/11/04/block-launch-from-read-only-location.md.
 */

import { accessSync, constants as fsConstants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { LaunchLocationIssue } from "../shared/types";
import { isNewerVersion } from "../shared/version";
import { createLogger } from "./logger";
import { spawn, spawnSync } from "./spawn";
import { macBundleReplaceBlocker } from "./updater";

const log = createLogger("launch-location");

export interface LaunchLocationEnv {
	platform: string;
	channel: string;
	bundlePath: string;
	home: string;
	/** Why the bundle cannot be replaced in place, or null — `macBundleReplaceBlocker`. */
	replaceBlocker: (bundlePath: string) => string | null;
	/** Mount points of attached disk images (`hdiutil info`). */
	diskImageMounts: () => string[];
	isWritable: (dir: string) => boolean;
}

export function runningBundlePath(execPath: string = process.execPath): string {
	return resolve(dirname(execPath), "..", "..");
}

function isInsideApplications(bundlePath: string, home: string): boolean {
	return [join("/", "Applications"), join(home, "Applications")].some((dir) => bundlePath.startsWith(`${dir}/`));
}

/** The disk-image mount the bundle came from, if any: the one it sits on, or one holding a same-named app. */
export function findSourceVolume(bundlePath: string, mounts: string[]): string | null {
	const direct = mounts.find((m) => bundlePath.startsWith(`${m}/`));
	if (direct) return direct;
	if (!bundlePath.includes("/AppTranslocation/")) return null;
	return mounts.find((m) => existsSync(join(m, basename(bundlePath)))) ?? null;
}

/** `DEV3_APPLICATIONS_DIR` points the move somewhere else, so QA never touches the real /Applications. */
export function applicationsDestination(
	bundlePath: string,
	env: Pick<LaunchLocationEnv, "home" | "isWritable">,
	override: string | undefined = process.env.DEV3_APPLICATIONS_DIR,
): string {
	const name = basename(bundlePath);
	if (override) return join(override, name);
	const system = join("/", "Applications");
	return join(env.isWritable(system) ? system : join(env.home, "Applications"), name);
}

/**
 * Null when the running bundle is fine. A bundle that cannot be replaced but already lives
 * in /Applications or ~/Applications (an MDM-owned install, say) is NOT blocked: moving it
 * "to Applications" means nothing there, and the updater already explains the failure.
 */
export function detectLaunchLocationIssue(env: LaunchLocationEnv): LaunchLocationIssue {
	if (env.platform !== "darwin" || env.channel === "dev") return null;
	const bundlePath = env.bundlePath;
	if (!bundlePath.endsWith(".app")) return null;
	const translocated = bundlePath.includes("/AppTranslocation/");
	if (!translocated && isInsideApplications(bundlePath, env.home)) return null;
	const reason = env.replaceBlocker(bundlePath);
	if (!reason) return null;
	const volumePath = findSourceVolume(bundlePath, env.diskImageMounts());
	const kind = translocated ? "translocated" : volumePath ? "disk-image" : "read-only";
	return { kind, bundlePath, volumePath, destination: applicationsDestination(bundlePath, env), reason };
}

export function parseHdiutilMountPoints(plist: string): string[] {
	const unescape = (s: string) =>
		s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
	return [...plist.matchAll(/<key>mount-point<\/key>\s*<string>([^<]*)<\/string>/g)].map((m) => unescape(m[1]));
}

function readDiskImageMounts(): string[] {
	try {
		const result = spawnSync(["hdiutil", "info", "-plist"], { timeout: 5000 });
		if (result.exitCode !== 0) return [];
		return parseHdiutilMountPoints(result.stdout?.toString() ?? "");
	} catch {
		return [];
	}
}

function isWritable(dir: string): boolean {
	try {
		accessSync(dir, fsConstants.W_OK);
		return true;
	} catch {
		return false;
	}
}

let cached: { issue: LaunchLocationIssue } | null = null;

export async function getLaunchLocationIssue(channel: () => Promise<string>): Promise<LaunchLocationIssue> {
	if (cached) return cached.issue;
	if (process.platform !== "darwin") return null;
	const issue = detectLaunchLocationIssue({
		platform: process.platform,
		channel: await channel(),
		bundlePath: runningBundlePath(),
		home: homedir(),
		replaceBlocker: macBundleReplaceBlocker,
		diskImageMounts: readDiskImageMounts,
		isWritable,
	});
	if (issue) log.warn("dev3 is running from a location it cannot update", issue);
	cached = { issue };
	return issue;
}

export function resetLaunchLocationCacheForTests(): void {
	cached = null;
}

export function readBundleVersion(bundlePath: string): string | null {
	try {
		const plist = readFileSync(join(bundlePath, "Contents", "Info.plist"), "utf-8");
		return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? null;
	} catch {
		return null;
	}
}

type Run = (cmd: string[]) => Promise<{ exitCode: number; stderr: string }>;

async function runCommand(cmd: string[]): Promise<{ exitCode: number; stderr: string }> {
	const proc = spawn(cmd, { stdout: "ignore", stderr: "pipe" });
	const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	return { exitCode, stderr: stderr.trim() };
}

export interface InstallDeps {
	run: Run;
	exists: (path: string) => boolean;
	readVersion: (bundlePath: string) => string | null;
	pid: number;
}

const defaultInstallDeps: InstallDeps = { run: runCommand, exists: existsSync, readVersion: readBundleVersion, pid: process.pid };

/**
 * Copy the running bundle to `destination`, replacing an older copy, and return the bundle
 * that should be launched. A NEWER copy already there wins untouched: launching an older
 * build over it would downgrade the shared ~/.dev3.0 state.
 */
export async function installBundleCopy(
	source: string,
	destination: string,
	deps: InstallDeps = defaultInstallDeps,
): Promise<{ launch: string; replaced: boolean }> {
	const ours = deps.readVersion(source);
	if (deps.exists(destination)) {
		const theirs = deps.readVersion(destination);
		if (ours && theirs && isNewerVersion(ours, theirs)) return { launch: destination, replaced: false };
	}
	const check = async (cmd: string[], what: string) => {
		const r = await deps.run(cmd);
		if (r.exitCode !== 0) throw new Error(`${what} failed: ${r.stderr || `exit ${r.exitCode}`}`);
	};
	await check(["mkdir", "-p", dirname(destination)], "Creating the Applications folder");
	const staging = `${destination}.dev3-move-${deps.pid}`;
	await deps.run(["rm", "-rf", staging]);
	try {
		// ditto keeps the signature, symlinks and extended attributes intact.
		await check(["ditto", source, staging], "Copying dev3");
		// A copy still carrying quarantine would be translocated again on its first launch.
		await deps.run(["xattr", "-dr", "com.apple.quarantine", staging]);
		const old = `${destination}.dev3-old-${deps.pid}`;
		const hadOld = deps.exists(destination);
		if (hadOld) await check(["mv", destination, old], "Moving the old copy aside");
		const placed = await deps.run(["mv", staging, destination]);
		if (placed.exitCode !== 0) {
			if (hadOld) await deps.run(["mv", old, destination]);
			throw new Error(`Placing the new copy failed: ${placed.stderr || `exit ${placed.exitCode}`}`);
		}
		if (hadOld) await deps.run(["rm", "-rf", old]);
	} finally {
		await deps.run(["rm", "-rf", staging]);
	}
	return { launch: destination, replaced: true };
}

/**
 * A detached helper waits for this process to exit, opens the new copy, then ejects the
 * installer volume. It has to wait: a launch while we still run would just hand off to us.
 * Args: <pid> <volume or ""> <command…>.
 */
export const RELAUNCH_SCRIPT = [
	'pid=$1; vol=$2; shift 2',
	'i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 300 ]; do sleep 0.2; i=$((i+1)); done',
	'"$@"',
	'if [ -n "$vol" ]; then sleep 2; hdiutil detach "$vol" -quiet >/dev/null 2>&1 || true; fi',
].join("\n");

// LaunchServices starts the new copy with launchd's environment, so an instance scoped to
// its own home or tmux socket dir would wake up on the real board. Carry those over.
const RELAUNCH_FORWARDED_ENV = ["DEV3_HOME", "TMUX_TMPDIR"] as const;

export function relaunchCommand(launch: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const forwarded = RELAUNCH_FORWARDED_ENV.flatMap((key) => (env[key] ? ["--env", `${key}=${env[key]}`] : []));
	return ["open", ...forwarded, launch];
}

export function scheduleRelaunch(launch: string, volumePath: string | null, pid: number = process.pid): void {
	const proc = spawn(["/bin/sh", "-c", RELAUNCH_SCRIPT, "dev3-relaunch", String(pid), volumePath ?? "", ...relaunchCommand(launch)], {
		stdio: ["ignore", "ignore", "ignore"],
		detached: true,
	});
	proc.unref();
}
