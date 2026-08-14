import { join } from "path";
import { mkdirSync, statSync } from "fs";
import { Updater, Utils } from "../electrobun-platform";
import { createLogger } from "../logger";
import { buildWindowsSwapScript } from "./script";
import { scheduleSwapScript } from "./handover";

const log = createLogger("windows-update");

/**
 * Where the pieces of a Windows update live, all under Electrobun's
 * `{appDataFolder}` = `%LOCALAPPDATA%\{identifier}\{channel}` (NOT `~/.dev3.0`,
 * so the on-disk invariants in AGENTS.md do not govern this tree).
 */
export interface WindowsUpdatePaths {
	extractionFolder: string;
	extractionDir: string;
	tarPath: string;
	newAppDir: string;
	targetAppDir: string;
	launcherPath: string;
	scriptPath: string;
	logPath: string;
}

export function resolveWindowsUpdatePaths(appDataFolder: string, hash: string, appName: string): WindowsUpdatePaths {
	const extractionFolder = join(appDataFolder, "self-extraction");
	const extractionDir = join(extractionFolder, `temp-${hash}`);
	const targetAppDir = join(appDataFolder, "app");
	return {
		extractionFolder,
		extractionDir,
		tarPath: join(extractionFolder, `${hash}.tar`),
		newAppDir: join(extractionDir, appName),
		targetAppDir,
		launcherPath: join(targetAppDir, "bin", "launcher.exe"),
		scriptPath: join(appDataFolder, "dev3-update.cmd"),
		logPath: join(appDataFolder, "dev3-update.log"),
	};
}

/**
 * Windows replacement for `Updater.applyUpdate()`. Same extraction and swap, but
 * the handover script waits on our PID instead of matching process image names —
 * see {@link buildWindowsSwapScript} for why that matters.
 */
export async function applyWindowsUpdate(): Promise<void> {
	const info = Updater.updateInfo?.();
	const hash = info?.hash;
	if (!hash) throw new Error("Windows update: no downloaded update to apply");

	const appDataFolder = await Updater.appDataFolder();
	const local = (await Updater.getLocalInfo()) as { name: string };
	const paths = resolveWindowsUpdatePaths(appDataFolder, hash, local.name);

	if (!statSync(paths.tarPath, { throwIfNoEntry: false })) {
		throw new Error(`Windows update: downloaded archive is missing at ${paths.tarPath}`);
	}

	mkdirSync(paths.extractionDir, { recursive: true });
	const bytes = await Bun.file(paths.tarPath).arrayBuffer();
	await new Bun.Archive(bytes).extract(paths.extractionDir);

	if (!statSync(paths.newAppDir, { throwIfNoEntry: false })) {
		throw new Error(`Windows update: extracted app not found at ${paths.newAppDir}`);
	}

	const script = buildWindowsSwapScript({
		pid: process.pid,
		version: info?.version ?? hash.slice(0, 8),
		targetAppDir: paths.targetAppDir,
		newAppDir: paths.newAppDir,
		extractionDir: paths.extractionDir,
		launcherPath: paths.launcherPath,
		logPath: paths.logPath,
	});
	await Bun.write(paths.scriptPath, script);

	// Task Scheduler, not a detached child: the script has to outlive our own
	// process tree, and this is the handover Electrobun already proved runs.
	const taskName = `Dev3Update_${Date.now()}`;
	const scheduled = scheduleSwapScript(paths.scriptPath, taskName);
	if (!scheduled.ok) throw new Error(`Windows update: ${scheduled.error}`);

	log.info("Windows update handed over to the swap script", { taskName, version: info?.version });
	Utils.quit();
}
