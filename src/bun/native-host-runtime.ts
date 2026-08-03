/**
 * Which detached native terminal host THIS build launches (seq 1292).
 *
 * A packaged dev3 cannot re-enter `native-terminal-registry/cli.ts` — that file
 * does not exist on disk next to a bundled app — so a real product session needs
 * an executable runtime plus a host script that ship with the install. Resolution
 * order, first match wins:
 *
 *  1. `DEV3_NATIVE_HOST_ENTRYPOINT` — the documented DEVELOPMENT runtime path.
 *     Point it at a built host bundle (`dist/native/dev3-terminal-host.js`) and
 *     optionally override the runtime with `DEV3_NATIVE_HOST_RUNTIME`.
 *  2. The packaged host image shipped inside the install: discovered next to the
 *     app runtime, then copied ADDITIVELY into `~/.dev3.0/native-host-images/<tag>/`
 *     and launched from that immutable staged copy — never from the replaceable
 *     install directory, which an update swaps out from under a live host.
 *  3. Source checkout: the registry CLI, when this process can still see it.
 *
 * Nothing here ever falls back to tmux. When no runtime can be resolved the
 * failure is a {@link NativeHostRuntimeError} carrying the install step to run,
 * and the task launch fails with it.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnChild } from "node:child_process";
import { createLogger } from "./logger";
import { NATIVE_SESSION_PROTOCOL_VERSION } from "./native-terminal-registry/protocol";
import { hostImagesRootDir } from "./native-terminal-registry/paths";
import {
	discoverPackagedImage,
	stagePackagedImage,
	PACKAGED_HOST_IMAGE_PARENT,
} from "./native-terminal-registry/host-images/packaged-image";
import { hostImageRootForPackagedCli } from "./native-terminal-registry/host-images/package-layout";
import type { PackagedHostImageExpectations } from "./native-terminal-registry/host-images/packaged-image-manifest";
import type { HostLaunch, HostLauncher, HostSpawnOptions } from "./native-terminal-registry/registry";
import { encodeShellLaunchSpec, NATIVE_SESSION_LAUNCH_ENV } from "./native-terminal-registry/shell-launch";
import { nativeHostProcessName } from "./native-terminal-registry/process-naming";

const log = createLogger("native-host-runtime");

/** The packaged host bundle's verb for a real product session (see native-terminal-host/main.ts). */
export const PACKAGED_HOST_SESSION_VERB = "session-host";
/** The registry CLI's verb for the same thing in a source checkout. */
export const SOURCE_HOST_SESSION_VERB = "__host";

export const NATIVE_HOST_ENTRYPOINT_ENV = "DEV3_NATIVE_HOST_ENTRYPOINT";
export const NATIVE_HOST_RUNTIME_ENV = "DEV3_NATIVE_HOST_RUNTIME";

export type NativeHostRuntimeKind = "development-entrypoint" | "packaged-image" | "source-checkout";

export interface NativeHostRuntime {
	readonly kind: NativeHostRuntimeKind;
	/** Executable that runs the host script. */
	readonly runtimePath: string;
	/** Host script the runtime executes. */
	readonly entrypointPath: string;
	/** Verb the entrypoint needs before the session id. */
	readonly sessionVerb: string;
	/** Staged image tag, when the runtime came from a packaged image. */
	readonly imageTag?: string;
	/** Human-readable provenance for logs and diagnostics. */
	readonly origin: string;
}

/** No usable native host runtime — actionable, and never a reason to start tmux. */
export class NativeHostRuntimeError extends Error {
	readonly diagnostics: string[];

	constructor(message: string, diagnostics: string[]) {
		super([message, ...diagnostics].join("\n"));
		this.name = "NativeHostRuntimeError";
		this.diagnostics = diagnostics;
	}
}

function realExecDir(): string | null {
	try {
		return dirname(realpathSync(process.execPath));
	} catch {
		return null;
	}
}

/**
 * Where a packaged image can sit, nearest first.
 *
 * The packaging hook assembles `<packageRoot>/native-host-image/<tag>/`, and
 * `<packageRoot>` is not always the runtime's own directory:
 *
 *  • The desktop app runs the packaged Bun from `<packageRoot>\bin\bun.exe`
 *    (Windows, Linux) or `<bundle>.app/Contents/MacOS/bun` (macOS), so the image
 *    is one level up. Looking only beside the executable missed the image the
 *    same build had just written (observed on a real Windows machine — the
 *    launch failed with "this dev3 package has no native-host-image/ directory").
 *  • `dev3 remote` / headless mode runs the BUNDLED CLI, several levels deeper at
 *    `<packageRoot>/Resources/app/cli/dev3`. Neither directory around it holds
 *    the image, so packaged remote mode could not launch a native task at all
 *    (seq 1352). That root comes from Electrobun's own named copy path rather
 *    than from walking up until something matches.
 */
export function packagedHostImageRoots(): string[] {
	const execDir = realExecDir();
	if (!execDir) return [];
	const parent = dirname(execDir);
	const roots = parent && parent !== execDir ? [execDir, parent] : [execDir];
	const bundledCliRoot = hostImageRootForPackagedCli(execDir);
	if (bundledCliRoot && !roots.includes(bundledCliRoot)) roots.push(bundledCliRoot);
	return roots;
}

function developmentRuntime(): NativeHostRuntime | null {
	const entrypointPath = process.env[NATIVE_HOST_ENTRYPOINT_ENV]?.trim();
	if (!entrypointPath) return null;
	if (!existsSync(entrypointPath)) {
		throw new NativeHostRuntimeError(`${NATIVE_HOST_ENTRYPOINT_ENV} points at a missing file.`, [
			`Set it to a built host bundle, e.g. ${join("dist", "native", "dev3-terminal-host.js")} after \`bun run build:native\`.`,
			`Current value: ${entrypointPath}`,
		]);
	}
	const runtimePath = process.env[NATIVE_HOST_RUNTIME_ENV]?.trim() || process.execPath;
	return {
		kind: "development-entrypoint",
		runtimePath,
		entrypointPath,
		sessionVerb: PACKAGED_HOST_SESSION_VERB,
		origin: `${NATIVE_HOST_ENTRYPOINT_ENV}=${entrypointPath}`,
	};
}

function packagedImageRuntime(diagnostics: string[]): NativeHostRuntime | null {
	const packageRoots = packagedHostImageRoots();
	if (packageRoots.length === 0) {
		diagnostics.push("Could not resolve this install's directory from process.execPath.");
		return null;
	}
	const expectations: PackagedHostImageExpectations = {
		// An image built for another OS/arch must be rejected, not adapted. An
		// unrecognised platform simply carries no expectation — the manifest's own
		// file hashes still have to validate.
		...(process.platform === "win32" || process.platform === "darwin" || process.platform === "linux"
			? { os: process.platform }
			: {}),
		arch: process.arch === "arm64" ? "arm64" : "x64",
		protocolVersion: NATIVE_SESSION_PROTOCOL_VERSION,
		archiveParent: PACKAGED_HOST_IMAGE_PARENT,
	};
	let discovered: ReturnType<typeof discoverPackagedImage> | null = null;
	for (const root of packageRoots) {
		const candidate = discoverPackagedImage(root, expectations);
		if (candidate.status === "ok") {
			discovered = candidate;
			break;
		}
		diagnostics.push(`Packaged host image unusable: ${candidate.reason}`);
	}
	if (!discovered) return null;
	const stagingRoot = hostImagesRootDir();
	const staged = stagePackagedImage({ sourceImageDir: discovered.imageDir, stagingRoot, expectations });
	if (staged.status === "failed") {
		diagnostics.push(`Staging the packaged host image into ${stagingRoot} failed: ${staged.reason}`);
		return null;
	}
	log.info("Native host image ready", { tag: staged.tag, status: staged.status, imageDir: staged.imageDir });
	return {
		kind: "packaged-image",
		runtimePath: staged.runtimeCarrierPath,
		entrypointPath: staged.entrypointPath,
		sessionVerb: PACKAGED_HOST_SESSION_VERB,
		imageTag: staged.tag,
		origin: `staged packaged host image ${staged.tag} (${staged.imageDir})`,
	};
}

function sourceCheckoutRuntime(diagnostics: string[]): NativeHostRuntime | null {
	let moduleDir: string;
	try {
		moduleDir = dirname(fileURLToPath(import.meta.url));
	} catch {
		diagnostics.push("This build is bundled, so the registry CLI source is not reachable.");
		return null;
	}
	const entrypointPath = resolve(moduleDir, "native-terminal-registry", "cli.ts");
	if (!existsSync(entrypointPath)) {
		diagnostics.push(`No registry CLI source at ${entrypointPath}.`);
		return null;
	}
	return {
		kind: "source-checkout",
		runtimePath: process.execPath,
		entrypointPath,
		sessionVerb: SOURCE_HOST_SESSION_VERB,
		origin: `source checkout ${entrypointPath}`,
	};
}

/**
 * Resolve the native host runtime for this build, or throw with the exact
 * install/dev step that is missing. Cheap enough to call per launch, and
 * deliberately not cached: an in-app update can stage a new image mid-session.
 */
export function resolveNativeHostRuntime(): NativeHostRuntime {
	const diagnostics: string[] = [];
	const explicit = developmentRuntime();
	if (explicit) return explicit;
	const packaged = packagedImageRuntime(diagnostics);
	if (packaged) return packaged;
	const source = sourceCheckoutRuntime(diagnostics);
	if (source) return source;
	throw new NativeHostRuntimeError(
		"This dev3 build cannot launch a native terminal host, and it will not silently start tmux instead.",
		[
			...diagnostics,
			`Development: run \`bun run build:native\` and set ${NATIVE_HOST_ENTRYPOINT_ENV} to the built dist/native/dev3-terminal-host.js.`,
			"Installed app: reinstall dev3 from a package that ships native-host-image/ (built with `bun run build:native`).",
			"Or set this task's terminal backend back to tmux: `dev3 task terminal-backend --to tmux`.",
		],
	);
}

/**
 * A registry {@link HostLauncher} that spawns the detached host from `runtime`.
 * Same env contract as the registry's own default launcher — the host reads its
 * session id, launch spec, and geometry from the environment.
 */
export function nativeHostLauncher(runtime: NativeHostRuntime): HostLauncher {
	return (sessionId: string, opts: HostSpawnOptions, logFd: number): HostLaunch => {
		const child = spawnChild(
			runtime.runtimePath,
			[runtime.entrypointPath, runtime.sessionVerb, sessionId],
			{
				// Human-readable identity in process viewers (seq 1383). The executable
				// still IS `runtime.runtimePath`, so the packaged carrier's image name —
				// and every contract keyed on it — is unchanged; only argv0 differs.
				argv0: nativeHostProcessName(sessionId, opts.launch.env),
				stdio: ["ignore", logFd, logFd],
				detached: true,
				env: {
					...process.env,
					DEV3_NATIVE_SESSION_ID: sessionId,
					[NATIVE_SESSION_LAUNCH_ENV]: encodeShellLaunchSpec(opts.launch),
					...(opts.cols ? { DEV3_NATIVE_SESSION_COLS: String(opts.cols) } : {}),
					...(opts.rows ? { DEV3_NATIVE_SESSION_ROWS: String(opts.rows) } : {}),
					...(opts.liveParser ? { DEV3_NATIVE_SESSION_LIVE_PARSER: "1" } : {}),
					...(opts.liveParser && opts.captureProjection
						? { DEV3_NATIVE_SESSION_CAPTURE_PROJECTION: "1" }
						: {}),
					...(opts.stateTap ? { DEV3_NATIVE_SESSION_STATE_TAP: "1" } : {}),
				},
			},
		);
		let exited = false;
		let earlyError: string | null = null;
		child.on("error", (err) => {
			exited = true;
			earlyError = err.message;
		});
		child.on("exit", () => {
			exited = true;
		});
		child.unref();
		log.info("Native host launched", {
			sessionId,
			kind: runtime.kind,
			runtimePath: runtime.runtimePath,
			childPid: child.pid ?? -1,
		});
		return {
			childPid: child.pid ?? -1,
			hasExited: () => exited,
			earlyError: () => earlyError,
		};
	};
}
