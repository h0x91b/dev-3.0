/**
 * Windows packaged-app launch proof.
 *
 * Runs as a standalone step AFTER `bun run package:win-archive` (the electrobun
 * postBuild/postPackage hooks already prove the native host lifecycle). It
 * extracts the FINAL update archive and asserts the three things a Windows
 * install needs — the desktop executable, the bundled `cli/dev3.exe`, and a
 * manifest-validated native terminal host image — then launches the extracted
 * desktop executable, waits for the deterministic readiness marker written by
 * `src/bun/app-ready-marker.ts`, shuts it down, and proves no owned process
 * survived.
 *
 * Everything it observes lands in `windows-app-launch-proof.json` beside the
 * artifacts. No-ops outside Windows.
 */

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { assertPackagedConptyRuntime } from "../src/shared/native-terminal-runtime";
import { NATIVE_SESSION_PROTOCOL_VERSION } from "../src/bun/native-terminal-registry/protocol";
import {
	discoverPackagedImage,
	PACKAGED_HOST_IMAGE_PARENT,
} from "../src/bun/native-terminal-registry/host-images/packaged-image";
import type { AppReadyMarker } from "../src/bun/app-ready-marker";
import { cliBinaryName } from "../electrobun.config";

const READY_TIMEOUT_MS = Number(process.env.DEV3_READY_TIMEOUT_MS ?? 180_000);
const GRACEFUL_SHUTDOWN_MS = 10_000;
const FORCED_SHUTDOWN_MS = 20_000;

export interface ProcessEntry {
	pid: number;
	parentPid: number;
	name: string;
}

/**
 * The Windows update archive electrobun emits is
 * `{channel}-win-{arch}-{app}.tar.zst`. Patch/setup artifacts share the folder,
 * so match the archive shape rather than trusting a single glob.
 */
export function selectWindowsArchive(fileNames: string[]): string {
	const candidates = fileNames.filter((name) => /^.+-win-[^-]+-.+\.tar\.zst$/.test(name)).sort();
	if (candidates.length === 0) {
		throw new Error(
			"No Windows update archive (*-win-*-*.tar.zst) found. Run `bun run package:win-archive` first.",
		);
	}
	if (candidates.length > 1) {
		throw new Error(`Expected exactly one Windows update archive; found ${candidates.length}: ${candidates.join(", ")}`);
	}
	return candidates[0];
}

/**
 * Electrobun's non-macOS bundle layout puts every executable in `bin/` and names
 * the desktop launcher `launcher.exe` (`createAppBundle` + the Windows rename in
 * `node_modules/electrobun/src/cli/index.ts`). Nothing lands at the bundle root,
 * which is why the old top-level scan found zero candidates.
 */
export const BUNDLE_EXEC_DIR = "bin";
export const DESKTOP_LAUNCHER_NAME = "launcher.exe";

export interface RejectedExecutable {
	relativePath: string;
	reason: string;
}

export interface DesktopExecutableSelection {
	/** Bundle-relative, POSIX-separated path of the launcher to start. */
	relativePath: string;
	rejected: RejectedExecutable[];
}

function toBundleRelative(path: string): string {
	return path.split(/[\\/]/).filter((segment) => segment.length > 0).join("/");
}

/**
 * Picks the desktop launcher out of every `.exe` in the package. Auxiliary
 * executables (`cli/dev3.exe`, the native terminal host image, setup/bootstrap
 * carriers) sit outside `bin/`; the electrobun runtime binaries (`bun.exe`,
 * `bspatch.exe`, `zig-zstd.exe`, CEF helpers) share `bin/` but are not the
 * launcher. Both classes are rejected with a reason so a layout change reads as
 * a diagnosis, not a mystery.
 */
export function selectDesktopExecutable(bundleRelativePaths: string[]): DesktopExecutableSelection {
	const executables = bundleRelativePaths
		.map(toBundleRelative)
		.filter((path) => path.toLowerCase().endsWith(".exe"))
		.sort();
	const selected: string[] = [];
	const rejected: RejectedExecutable[] = [];
	for (const path of executables) {
		const segments = path.split("/");
		const directory = segments.slice(0, -1).join("/").toLowerCase();
		const name = segments[segments.length - 1].toLowerCase();
		if (directory !== BUNDLE_EXEC_DIR && directory !== "") {
			rejected.push({ relativePath: path, reason: `outside the bundle exec directory '${BUNDLE_EXEC_DIR}/'` });
		} else if (name !== DESKTOP_LAUNCHER_NAME) {
			rejected.push({ relativePath: path, reason: `not the electrobun desktop launcher '${DESKTOP_LAUNCHER_NAME}'` });
		} else {
			selected.push(path);
		}
	}
	if (selected.length !== 1) {
		const inventory = [
			...selected.map((relativePath) => `  ${relativePath} — desktop launcher candidate`),
			...rejected.map((entry) => `  ${entry.relativePath} — rejected: ${entry.reason}`),
		];
		throw new Error(
			`Expected exactly one desktop launcher ('${BUNDLE_EXEC_DIR}/${DESKTOP_LAUNCHER_NAME}'); found ${selected.length}` +
				`${selected.length > 1 ? `: ${selected.join(", ")}` : ""}.\nConsidered executables:\n` +
				`${inventory.join("\n") || "  none"}`,
		);
	}
	return { relativePath: selected[0], rejected };
}

export function isUsableReadyMarker(value: unknown, expectedVersion: string): value is AppReadyMarker {
	if (!value || typeof value !== "object") return false;
	const marker = value as Partial<AppReadyMarker>;
	return (
		marker.ready === true &&
		typeof marker.pid === "number" &&
		marker.pid > 0 &&
		marker.platform === "win32" &&
		marker.version === expectedVersion &&
		typeof marker.startedAt === "string" &&
		marker.startedAt.length > 0
	);
}

/** Depth-first descendants of `rootPid` in a process snapshot, excluding the root. */
export function descendantPids(snapshot: ProcessEntry[], rootPid: number): number[] {
	const childrenByParent = new Map<number, number[]>();
	for (const entry of snapshot) {
		const siblings = childrenByParent.get(entry.parentPid) ?? [];
		siblings.push(entry.pid);
		childrenByParent.set(entry.parentPid, siblings);
	}
	const found = new Set<number>();
	const queue = [rootPid];
	while (queue.length > 0) {
		const pid = queue.pop()!;
		for (const child of childrenByParent.get(pid) ?? []) {
			if (child === rootPid || found.has(child)) continue;
			found.add(child);
			queue.push(child);
		}
	}
	return [...found].sort((a, b) => a - b);
}

interface CommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

function run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 30_000): CommandResult {
	const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", timeout });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

function requireSuccess(result: CommandResult, description: string): string {
	if (result.status !== 0 || result.error) {
		throw new Error(
			`${description} failed (exit ${result.status ?? "none"}${result.error ? `, ${result.error.message}` : ""}).` +
				`\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
		);
	}
	return result.stdout.trim();
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function findFiles(root: string, name: string): string[] {
	const matches: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) matches.push(...findFiles(path, name));
		else if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) matches.push(path);
	}
	return matches;
}

/** Every `.exe` under `root`, as POSIX-separated bundle-relative paths. */
function listExecutables(root: string, prefix = ""): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
		const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) found.push(...listExecutables(root, relativePath));
		else if (entry.isFile() && entry.name.toLowerCase().endsWith(".exe")) found.push(relativePath);
	}
	return found.sort();
}

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

function tailOf(text: string, lines = 40): string {
	return text.split(/\r?\n/).slice(-lines).join("\n");
}

async function main(): Promise<void> {
	const repoRoot = resolve(import.meta.dir, "..");
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (!systemRoot) throw new Error("Windows app launch proof cannot resolve SystemRoot.");
	const system32 = join(systemRoot, "System32");
	const powershell = join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
	const taskkill = join(system32, "taskkill.exe");

	function processSnapshot(): ProcessEntry[] {
		const output = requireSuccess(
			run(
				powershell,
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress -Depth 3",
				],
				repoRoot,
				process.env,
				60_000,
			),
			"Process snapshot",
		);
		const parsed = JSON.parse(output) as unknown;
		const rows = Array.isArray(parsed) ? parsed : [parsed];
		return rows.map((row) => {
			const entry = row as { ProcessId?: number; ParentProcessId?: number; Name?: string };
			return { pid: Number(entry.ProcessId ?? 0), parentPid: Number(entry.ParentProcessId ?? 0), name: String(entry.Name ?? "") };
		});
	}

	function alivePids(pids: number[]): number[] {
		if (pids.length === 0) return [];
		const live = new Set(processSnapshot().map((entry) => entry.pid));
		return pids.filter((pid) => live.has(pid));
	}

	// ── Locate the archive ────────────────────────────────────────────────────
	const explicitTarget = process.argv[2] ?? process.env.DEV3_WINDOWS_APP_ARCHIVE;
	const artifactDir = resolve(process.env.ELECTROBUN_ARTIFACT_DIR ?? join(repoRoot, "artifacts"));
	let archivePath: string;
	if (explicitTarget) {
		archivePath = resolve(explicitTarget);
		if (!existsSync(archivePath)) throw new Error(`Windows archive not found at ${archivePath}.`);
	} else {
		if (!existsSync(artifactDir)) throw new Error(`Artifact directory ${artifactDir} does not exist.`);
		archivePath = join(artifactDir, selectWindowsArchive(readdirSync(artifactDir)));
	}
	const proofDir = existsSync(artifactDir) ? artifactDir : repoRoot;

	// ── Extract it ────────────────────────────────────────────────────────────
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	const zstdPath = resolve(repoRoot, `node_modules/electrobun/dist-win-${arch}/zig-zstd.exe`);
	const tarPath = join(system32, "tar.exe");
	if (!existsSync(zstdPath)) throw new Error(`Cannot find zig-zstd at ${zstdPath}.`);
	if (!existsSync(tarPath)) throw new Error(`Cannot find Windows tar at ${tarPath}.`);

	const workspace = mkdtempSync(join(tmpdir(), "dev3-app-launch-"));
	const unpackedDir = join(workspace, "unpacked");
	mkdirSync(unpackedDir, { recursive: true });
	let launcherPid: number | null = null;
	let ownedPids: number[] = [];
	let stdout = "";
	let stderr = "";
	try {
		requireSuccess(
			run(zstdPath, ["decompress", "-i", archivePath, "-o", "package.tar"], workspace, process.env, 180_000),
			"Windows archive decompression",
		);
		requireSuccess(run(tarPath, ["-xf", "package.tar", "-C", "unpacked"], workspace, process.env, 180_000), "Windows archive extraction");

		const topLevel = readdirSync(unpackedDir, { withFileTypes: true });
		const bundleDirs = topLevel.filter((entry) => entry.isDirectory());
		if (bundleDirs.length !== 1) {
			throw new Error(`Expected exactly one top-level bundle directory in the archive; found ${bundleDirs.length}.`);
		}
		const bundleRoot = join(unpackedDir, bundleDirs[0].name);

		// ── AC1: archive contents ──────────────────────────────────────────────
		// Written before selection so a layout change uploads its own evidence
		// instead of only a stack trace.
		const bundleExecutables = listExecutables(bundleRoot);
		writeFileSync(
			join(proofDir, "windows-app-layout.json"),
			`${JSON.stringify(
				{ archiveName: basename(archivePath), bundleRootName: bundleDirs[0].name, executables: bundleExecutables },
				null,
				2,
			)}\n`,
		);
		const desktopSelection = selectDesktopExecutable(bundleExecutables);
		const desktopExecutableRelativePath = desktopSelection.relativePath;
		const desktopExecutable = join(bundleRoot, desktopExecutableRelativePath);
		// The launcher must come from the artifact under test — never the source
		// checkout, an installed copy, or PATH.
		if (!resolve(desktopExecutable).startsWith(resolve(bundleRoot) + sep) || !statSync(desktopExecutable).isFile()) {
			throw new Error(
				`Selected desktop launcher ${desktopExecutableRelativePath} does not resolve to a file inside the extracted bundle.`,
			);
		}

		const expectedCliName = cliBinaryName("win32");
		const cliMatches = findFiles(bundleRoot, expectedCliName).filter((path) =>
			path.split(/[\\/]/).slice(-2, -1)[0]?.toLowerCase() === "cli",
		);
		if (cliMatches.length !== 1) {
			throw new Error(
				`Expected exactly one bundled cli/${expectedCliName} in the archive; found ${cliMatches.length}. ` +
					"The electrobun copy map must ship the Windows CLI binary.",
			);
		}
		const bundledCli = cliMatches[0];

		const runtimes = findFiles(bundleRoot, "bun.exe").filter(
			(path) => !path.split(/[\\/]/).includes(PACKAGED_HOST_IMAGE_PARENT),
		);
		if (runtimes.length !== 1) {
			throw new Error(`Expected exactly one packaged bun.exe outside ${PACKAGED_HOST_IMAGE_PARENT}/; found ${runtimes.length}.`);
		}
		const bunVersion = assertPackagedConptyRuntime(
			requireSuccess(run(runtimes[0], ["--version"], workspace, process.env), "Packaged app runtime version probe"),
		);
		const discovered = discoverPackagedImage(bundleRoot, {
			os: "win32",
			arch,
			bunVersion,
			protocolVersion: NATIVE_SESSION_PROTOCOL_VERSION,
			archiveParent: PACKAGED_HOST_IMAGE_PARENT,
		});
		if (discovered.status !== "ok") {
			throw new Error(`Archive does not ship a manifest-validated native terminal host: ${JSON.stringify(discovered)}`);
		}

		// ── AC2: launch, ready marker, clean shutdown ──────────────────────────
		const markerPath = join(workspace, "app-ready.json");
		// Electrobun itself launches the bundle from the exec directory, and so does
		// Explorer on a double-click.
		const child = spawn(desktopExecutable, [], {
			cwd: dirname(desktopExecutable),
			env: { ...process.env, DEV3_READY_MARKER_FILE: markerPath, ELECTROBUN_CONSOLE: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		launcherPid = child.pid ?? null;
		if (!launcherPid) throw new Error("Failed to obtain a pid for the launched desktop executable.");
		child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
		const desktopPid = launcherPid;
		const childState: { exitCode: number | null } = { exitCode: null };
		child.on("exit", (code) => { childState.exitCode = code; });

		const expectedVersion = String(JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version);
		const startedAt = Date.now();
		let marker: AppReadyMarker | null = null;
		while (Date.now() - startedAt < READY_TIMEOUT_MS) {
			if (existsSync(markerPath)) {
				try {
					const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as unknown;
					if (isUsableReadyMarker(parsed, expectedVersion)) {
						marker = parsed;
						break;
					}
				} catch {
					// Partially written or stale — the writer renames atomically, retry.
				}
			}
			if (childState.exitCode !== null) {
				throw new Error(
					`Desktop executable exited with code ${childState.exitCode} before reporting readiness.` +
						`\nstdout:\n${tailOf(stdout)}\nstderr:\n${tailOf(stderr)}`,
				);
			}
			await sleep(500);
		}
		const readyAfterMs = Date.now() - startedAt;
		if (!marker) {
			throw new Error(
				`Desktop executable did not write ${markerPath} within ${READY_TIMEOUT_MS}ms.` +
					`\nstdout:\n${tailOf(stdout)}\nstderr:\n${tailOf(stderr)}`,
			);
		}

		const snapshotBefore = processSnapshot();
		const descendantsBefore = descendantPids(snapshotBefore, desktopPid);
		// A marker written by anything outside the launched tree would let a hung
		// app pass as ready, so the reported main process must be the launcher
		// itself or one of its descendants.
		if (marker.pid !== desktopPid && !descendantsBefore.includes(marker.pid)) {
			throw new Error(
				`Ready marker reports pid ${marker.pid}, which is not the launched executable (${desktopPid}) ` +
					`nor one of its descendants (${descendantsBefore.join(", ") || "none"}).`,
			);
		}
		ownedPids = [...new Set([desktopPid, marker.pid, ...descendantsBefore])].sort((a, b) => a - b);
		const ownedProcessesBeforeShutdown = snapshotBefore
			.filter((entry) => ownedPids.includes(entry.pid))
			.map((entry) => ({ pid: entry.pid, parentPid: entry.parentPid, name: entry.name }));

		// A close request is tried first, but `exitOnLastWindowClosed: false` plus
		// the React quit-confirmation gate means it need not terminate the app —
		// so escalation to a forced tree kill is the expected path, not a failure.
		run(taskkill, ["/PID", String(desktopPid), "/T"], workspace, process.env);
		const gracefulDeadline = Date.now() + GRACEFUL_SHUTDOWN_MS;
		while (Date.now() < gracefulDeadline && alivePids(ownedPids).length > 0) await sleep(500);
		// The first snapshot cannot see a helper the app spawns while shutting down;
		// re-walk the tree so a late child is owned too, not silently left running.
		ownedPids = [...new Set([...ownedPids, ...descendantPids(processSnapshot(), desktopPid)])].sort((a, b) => a - b);
		let shutdownMethod: "close-request" | "forced-tree-kill" = "close-request";
		if (alivePids(ownedPids).length > 0) {
			shutdownMethod = "forced-tree-kill";
			for (const pid of [desktopPid, ...ownedPids]) {
				run(taskkill, ["/PID", String(pid), "/T", "/F"], workspace, process.env);
			}
			const forcedDeadline = Date.now() + FORCED_SHUTDOWN_MS;
			while (Date.now() < forcedDeadline && alivePids(ownedPids).length > 0) await sleep(500);
		}
		const shutdownAfterMs = Date.now() - startedAt - readyAfterMs;
		const survivors = alivePids(ownedPids);
		if (survivors.length > 0) {
			throw new Error(
				`Owned processes survived shutdown: ${survivors.join(", ")}.` +
					`\nstdout:\n${tailOf(stdout)}\nstderr:\n${tailOf(stderr)}`,
			);
		}
		launcherPid = null;

		const proof = {
			archiveName: basename(archivePath),
			archiveBytes: statSync(archivePath).size,
			archiveSha256: sha256(archivePath),
			bundleRoot: relative(unpackedDir, bundleRoot),
			desktopExecutableRelativePath,
			desktopExecutableBytes: statSync(desktopExecutable).size,
			desktopExecutableSha256: sha256(desktopExecutable),
			rejectedExecutables: desktopSelection.rejected,
			bundledCliArchivePath: relative(bundleRoot, bundledCli).split(/[\\/]/).join("/"),
			bundledCliBytes: statSync(bundledCli).size,
			bundledCliSha256: sha256(bundledCli),
			packagedAppBunVersion: bunVersion,
			hostImageTag: discovered.tag,
			hostImageArchiveRoot: discovered.manifest.archiveRoot,
			hostImageOs: discovered.manifest.artifact.os,
			hostImageArch: discovered.manifest.artifact.arch,
			hostImageProtocolVersion: discovered.manifest.artifact.protocolVersion,
			hostImageRuntimeFloor: discovered.manifest.runtimeFloor,
			hostImageFiles: discovered.manifest.artifact.files,
			hostImageManifestValidated: true,
			desktopExecutablePid: desktopPid,
			mainProcessPid: marker.pid,
			readyMarkerName: basename(markerPath),
			readyMarker: marker,
			readyAfterMs,
			readyTimeoutMs: READY_TIMEOUT_MS,
			ownedProcessesBeforeShutdown,
			shutdownMethod,
			shutdownAfterMs,
			survivingOwnedProcesses: [] as number[],
			stdoutTail: tailOf(stdout),
			stderrTail: tailOf(stderr),
		};
		writeFileSync(join(proofDir, "windows-app-launch-proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
		console.log(`[windows-app-launch] ${JSON.stringify(proof)}`);
		console.log(
			`[windows-app-launch] ${desktopExecutableRelativePath} (rejected ${desktopSelection.rejected.length} other executables) ` +
				`shipped with cli/${expectedCliName} and host image ${discovered.tag}, reached ready in ${readyAfterMs}ms, ` +
				`shut down via ${shutdownMethod} with no owned processes left`,
		);
	} finally {
		if (launcherPid !== null) {
			for (const pid of [launcherPid, ...ownedPids]) {
				run(taskkill, ["/PID", String(pid), "/T", "/F"], workspace, process.env);
			}
		}
		rmSync(workspace, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	if (process.platform !== "win32") {
		// CI sets DEV3_REQUIRE_WINDOWS_PROOF so a job that stops being a Windows
		// runner fails instead of reporting a green step that proved nothing.
		if (process.env.DEV3_REQUIRE_WINDOWS_PROOF === "1") {
			console.error(`[windows-app-launch] required proof cannot run on ${process.platform}`);
			process.exit(1);
		}
		console.log("[windows-app-launch] packaged app launch proof skipped outside Windows");
	} else {
		await main();
	}
}
