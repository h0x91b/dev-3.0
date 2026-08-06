import { Updater } from "./electrobun-platform";
import { createLogger } from "./logger";
import { isNewerVersion } from "../shared/version";
import { markQuitConfirmed } from "./quit-manager";
import { BUILD_ORDER } from "../shared/build-info.generated";
import { decideUpdate, type UpdateChannel, type UpdateManifest } from "../shared/update-channel";
import type { UpdateChangelog } from "../shared/types";

const log = createLogger("updater");

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
/** How often a already-downloaded update re-nags the user (issue #1072). */
export const READY_REMINDER_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const BASE_URL = "https://h0x91b-releases.s3.eu-west-1.amazonaws.com/dev-3.0";

// Electrobun's Updater keeps its state (updateReady flag, downloaded tar
// bookkeeping) in module-level memory, and its checkForUpdate() OVERWRITES
// that state with the parsed remote update.json — which has no `updateReady`
// field. Any check that runs after a download therefore wipes the ready flag
// (issue #813: dead "Restart to Update" button). Serialize every download /
// apply through a single-flight queue so a periodic auto-check can never
// interleave with (and wipe state under) a user-initiated apply.
let updaterQueue: Promise<unknown> = Promise.resolve();

function withUpdaterLock<T>(fn: () => Promise<T>): Promise<T> {
	const run = updaterQueue.then(fn, fn);
	updaterQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/**
 * The version already downloaded and waiting for a restart. Electrobun's own
 * `updateReady` flag cannot be trusted for this (any later checkForUpdate wipes
 * it — decision 106), so we remember it ourselves: it gates re-downloads and
 * paces the "still waiting for restart" reminder.
 */
let readyUpdate: { version: string; remindedAt: number } | null = null;

export function markUpdateReady(version: string, now: number = Date.now()): void {
	readyUpdate = { version, remindedAt: now };
}

export function clearReadyUpdate(): void {
	readyUpdate = null;
}

export function getReadyUpdateVersion(): string | null {
	return readyUpdate?.version ?? null;
}

/** True when `version` is already downloaded — a re-download would be wasted work. */
export function isUpdateAlreadyReady(version: string): boolean {
	return !!readyUpdate && !isNewerVersion(readyUpdate.version, version);
}

/**
 * Nag gate for an update that sits downloaded while the user keeps working.
 * Returns true at most once per READY_REMINDER_INTERVAL_MS so people don't
 * linger on an old version, without a toast on every 30-minute check.
 */
export function shouldRemindAboutReadyUpdate(now: number = Date.now()): boolean {
	if (!readyUpdate) return false;
	if (now - readyUpdate.remindedAt < READY_REMINDER_INTERVAL_MS) return false;
	readyUpdate.remindedAt = now;
	return true;
}

type UpdateJson = UpdateManifest & { changelog?: UpdateChangelog | null };

interface UpdateCheckResult {
	updateAvailable: boolean;
	version: string;
	changelog?: UpdateChangelog;
	error?: string;
	/** True when running a from-source "dev" build, where updates are disabled. */
	devBuild?: boolean;
	/**
	 * Set when the offer CROSSES channels. The UI must then name the direction
	 * ("Switch to stable (1.42.0)") instead of calling it an update, because the target
	 * channel's build is simply a different build and may well be an older one.
	 */
	switchTo?: UpdateChannel;
	/**
	 * Only meaningful with {@link switchTo}: the offered build is OLDER than the running
	 * one. Going unstable → stable normally is, and the user has to be told, because an
	 * older build then reads state a newer build already wrote.
	 */
	installsOlderBuild?: boolean;
}

function getPlatformPrefix(): string {
	const platform = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "win" : "linux";
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	return `${platform}-${arch}`;
}

export async function getLocalVersion(): Promise<{ version: string; hash: string; channel: string; buildOrder: number }> {
	const [version, hash, channel] = await Promise.all([
		Updater.localInfo.version(),
		Updater.localInfo.hash(),
		Updater.localInfo.channel(),
	]);
	// buildOrder cannot come from version.json — Electrobun writes that file and we do
	// not control its fields. It is baked in by scripts/generate-build-info.ts from the
	// same `git rev-list --count HEAD` the published manifest uses, in the same job.
	return { version, hash, channel, buildOrder: BUILD_ORDER };
}

export async function checkForUpdateWithChannel(channel: UpdateChannel): Promise<UpdateCheckResult> {
	const local = await getLocalVersion();

	// Dev/source builds have updates disabled in Electrobun's updater; a download
	// there dereferences its uninitialized state and throws (see
	// doDownloadUpdateForChannel). Report the dev build instead of checking.
	if (local.channel === "dev") {
		log.info("Skipping update check on dev channel");
		return { updateAvailable: false, version: local.version, devBuild: true };
	}

	const platformPrefix = getPlatformPrefix();

	// Construct URL for the selected channel's update.json
	const updateUrl = `${BASE_URL}/${channel}-${platformPrefix}-update.json?_=${Date.now()}`;

	log.info("Checking for update", { channel, url: updateUrl, localHash: local.hash.slice(0, 12) });

	try {
		const resp = await fetch(updateUrl);

		if (!resp.ok) {
			const msg = `HTTP ${resp.status} fetching update.json`;
			log.warn(msg, { url: updateUrl });
			return { updateAvailable: false, version: local.version, error: msg };
		}

		const remote: UpdateJson = await resp.json();

		if (!remote.version) {
			return { updateAvailable: false, version: local.version, error: "Invalid update.json: missing version" };
		}

		const decision = decideUpdate(local, channel, remote, isNewerVersion);
		log.info("Update check result", {
			decision: decision.kind,
			selectedChannel: channel,
			buildChannel: local.channel,
			localVersion: local.version,
			remoteVersion: remote.version,
			localBuildOrder: local.buildOrder,
			remoteBuildOrder: remote.buildOrder,
			localHash: local.hash.slice(0, 12),
			remoteHash: remote.hash.slice(0, 12),
		});

		if (decision.kind === "error") {
			return { updateAvailable: false, version: local.version, error: decision.reason };
		}
		const changelog = remote.changelog ? { changelog: remote.changelog } : {};
		if (decision.kind === "switch") {
			return {
				updateAvailable: true,
				version: decision.version || "unknown",
				switchTo: decision.to,
				installsOlderBuild: decision.installsOlderBuild,
				...changelog,
			};
		}
		return {
			updateAvailable: decision.kind === "update",
			version: remote.version || "unknown",
			...changelog,
		};
	} catch (err) {
		const msg = `Failed to check for updates: ${err}`;
		log.error(msg);
		return { updateAvailable: false, version: local.version, error: msg };
	}
}

export function downloadUpdateForChannel(
	channel: UpdateChannel,
	onProgress?: (status: string, progress?: number) => void,
): Promise<{ ok: boolean; error?: string }> {
	return withUpdaterLock(async () => {
		const result = await doDownloadUpdateForChannel(channel, onProgress);
		// Remember (or forget) the waiting-for-restart version here, so every
		// caller — auto-check, menu, Settings RPC — feeds the same guard.
		if (result.ok) {
			const version = Updater.updateInfo?.()?.version;
			if (version) markUpdateReady(version);
		} else {
			clearReadyUpdate();
		}
		return result;
	});
}

async function doDownloadUpdateForChannel(
	channel: UpdateChannel,
	onProgress?: (status: string, progress?: number) => void,
): Promise<{ ok: boolean; error?: string }> {
	const local = await getLocalVersion();

	// Crash-proof floor for dev/source builds. Electrobun's checkForUpdate()
	// early-returns on the "dev" channel without initializing its module-level
	// updateInfo, so the subsequent downloadUpdate() writes `updateInfo.error`
	// on undefined and throws a TypeError. Never reach that call on dev.
	if (local.channel === "dev") {
		const msg = "Updates are disabled on dev builds (running from source)";
		log.info(msg);
		return { ok: false, error: msg };
	}

	// If selected channel matches the build-time channel, use built-in updater
	if (channel === local.channel) {
		log.info("Channel matches build-time, using built-in updater flow");
		onProgress?.("downloading", 0);

		try {
			// Step 1: checkForUpdate() populates Electrobun's internal state
			// (remote version, hash, download URLs). Without this,
			// downloadUpdate() has no target and silently does nothing.
			const checkResult = await Updater.checkForUpdate();
			log.info("Built-in checkForUpdate result", {
				updateAvailable: checkResult?.updateAvailable,
				updateReady: checkResult?.updateReady,
				version: checkResult?.version,
				hash: checkResult?.hash?.slice(0, 12),
			});

			if (!checkResult?.updateAvailable) {
				const msg = "Built-in updater reports no update available";
				log.warn(msg);
				return { ok: false, error: msg };
			}

			// Step 2: download the update (patch or full bundle). If the tar is
			// already on disk from a previous attempt, this just re-marks the
			// update as ready without downloading anything.
			await Updater.downloadUpdate();

			// Step 3: verify the update is actually ready after download.
			// Electrobun may not mark updateReady synchronously after downloadUpdate resolves.
			// Poll via updateInfo() ONLY — calling checkForUpdate() here would itself
			// wipe the updateReady flag we are waiting for (it overwrites Electrobun's
			// state with the remote update.json, which has no such field).
			// Use exponential backoff: 500ms, 1s, 2s, 4s, 8s, 16s, 30s (~61.5s total).
			const backoffDelays = [500, 1000, 2000, 4000, 8000, 16000, 30000];
			for (let i = 0; i < backoffDelays.length; i++) {
				const info = Updater.updateInfo?.();
				if (info?.updateReady) {
					log.info("Update ready", { attempt: i + 1 });
					onProgress?.("complete", 100);
					return { ok: true };
				}
				log.warn("updateReady is false, retrying...", {
					attempt: i + 1,
					delayMs: backoffDelays[i],
				});
				await new Promise((r) => setTimeout(r, backoffDelays[i]));
			}

			// Final check after last delay
			const final = Updater.updateInfo?.();
			if (final?.updateReady) {
				log.info("Update ready after final re-check");
				onProgress?.("complete", 100);
				return { ok: true };
			}

			const msg = "Download completed but update not marked as ready after retries";
			log.error(msg, { updateReady: final?.updateReady, totalRetries: backoffDelays.length });
			onProgress?.("error");
			return { ok: false, error: msg };
		} catch (err) {
			const msg = `Download failed: ${err}`;
			log.error(msg);
			onProgress?.("error");
			return { ok: false, error: msg };
		}
	}

	// ── Crossing channels ────────────────────────────────────────────────────────
	// The channel is BAKED INTO THE BUNDLE at build time (Resources/version.json), and
	// Electrobun has no runtime channel switch — there is a literal
	// `// todo: allow switching channels` in its Updater. Every URL it builds comes from
	// the cached `localInfo` object, so pointing it at the other channel means mutating
	// that cache: `channel` (it prefixes every artifact name) and `name` (non-stable
	// channels suffix the app file name, e.g. `dev-3.0-unstable`, and the tarball URL is
	// built from it).
	//
	// THAT IS SAFE ON macOS AND NOT ELSEWHERE, and the asymmetry is not ours to wish away:
	// `Updater.appDataFolder()` is `{appData}/{identifier}/{channel}`. On macOS that folder
	// is only download scratch — the bundle swap targets `process.execPath`, i.e. the .app
	// that is actually running, so a mutated channel cannot misdirect it. On Linux and
	// Windows the running app IS `{appDataFolder}/app`, so a mutated channel would install
	// the new bundle into a directory the launcher does not run from: the user restarts,
	// sees no change, and nothing reports a failure. A silent no-op is worse than a refusal.
	if (process.platform !== "darwin") {
		const msg =
			"Switching channels in place is not supported on this platform yet — the update would install into a directory the launcher does not run from. Install the other channel's build once from the releases page; the channel setting is already saved.";
		log.warn("Cross-channel switch refused on non-macOS platform", {
			platform: process.platform,
			selectedChannel: channel,
			buildChannel: local.channel,
		});
		return { ok: false, error: msg };
	}

	log.info("Cross-channel switch, retargeting the updater", { selectedChannel: channel, buildChannel: local.channel });
	onProgress?.("downloading", 0);

	// Mutating the object Electrobun hands back mutates its module-level cache, which is
	// what retargets checkForUpdate/downloadUpdate/applyUpdate as one coherent set. It is
	// restored on failure so a refused switch cannot leave the updater aimed at a channel
	// the bundle is not on; on success it stays retargeted only until the restart, after
	// which the newly installed bundle's own version.json says the target channel.
	const info = (await Updater.getLocalInfo()) as { channel: string; name: string };
	const previous = { channel: info.channel, name: info.name };
	info.channel = channel;
	info.name = channel === "stable" ? "dev-3.0" : `dev-3.0-${channel}`;

	try {
		const checkResult = await Updater.checkForUpdate();
		if (!checkResult?.updateAvailable) {
			// Electrobun compares HASHES, so it says "available" for an older build too —
			// which is exactly what a switch back to stable needs. Not-available here means
			// the two channels are genuinely on the same bundle.
			info.channel = previous.channel;
			info.name = previous.name;
			const msg = "Both channels are on the same build — nothing to install";
			log.info(msg);
			return { ok: false, error: msg };
		}
		await Updater.downloadUpdate();
		if (!Updater.updateInfo?.()?.updateReady) {
			info.channel = previous.channel;
			info.name = previous.name;
			const msg = "Cross-channel bundle downloaded but the updater did not mark it ready";
			log.error(msg);
			onProgress?.("error");
			return { ok: false, error: msg };
		}
		onProgress?.("complete", 100);
		return { ok: true };
	} catch (err) {
		info.channel = previous.channel;
		info.name = previous.name;
		const msg = `Channel switch failed: ${err}`;
		log.error(msg);
		onProgress?.("error");
		return { ok: false, error: msg };
	}
}

export function applyUpdate(): Promise<void> {
	return withUpdaterLock(doApplyUpdate);
}

async function doApplyUpdate(): Promise<void> {
	const info = Updater.updateInfo?.();
	log.info("Applying update...", {
		updateReady: info?.updateReady,
		version: info?.version,
	});

	// Always re-run downloadUpdate() before applying — it is the ONLY call that
	// can (re)set Electrobun's in-memory updateReady flag, and it is cheap when
	// the downloaded tar is already on disk (one update.json fetch + a stat).
	// This heals two dead-button states in one move:
	//   1. updateReady wiped by any checkForUpdate() that ran after the
	//      download (periodic auto-check, menu check) — the tar is still on
	//      disk, so this just re-marks it ready.
	//   2. A newer release shipped after the download: updateReady points at a
	//      stale tar and Electrobun's applyUpdate() would silently no-op on the
	//      missing latest tar, leaving the UI stuck on "Restarting...". Here
	//      the fresh tar gets downloaded instead.
	if (!info?.updateReady) {
		log.warn("updateReady is false, repairing via downloadUpdate...");
	}
	await Updater.downloadUpdate();

	const repaired = Updater.updateInfo?.();
	if (!repaired?.updateReady) {
		log.error("applyUpdate: update still not ready after repair download — aborting to avoid a no-op restart", {
			error: repaired?.error,
		});
		throw new Error("Update not ready to apply");
	}

	// The updater restarts the app via Utils.quit(). Mark the quit as confirmed
	// so the `before-quit` gate lets it through instead of popping the quit
	// confirmation dialog (this is a relaunch, not a user-initiated quit).
	markQuitConfirmed();
	await Updater.applyUpdate();
}

export function startAutoCheck(
	getChannel: () => Promise<UpdateChannel>,
	onUpdate: (version: string, changelog?: UpdateChangelog) => void,
	onProgress?: (status: string, progress?: number) => void,
	onRemind?: (version: string, changelog?: UpdateChangelog) => void,
): void {
	const doCheck = async () => {
		try {
			const local = await getLocalVersion();
			// Skip auto-check in dev channel
			if (local.channel === "dev") {
				log.info("Skipping auto-check in dev channel");
				return;
			}

			onProgress?.("checking");
			const channel = await getChannel();
			const result = await checkForUpdateWithChannel(channel);

			if (!result.updateAvailable) {
				onProgress?.("idle");
				return;
			}

			// Already downloaded and waiting for a restart: never re-download it
			// (issue #1072), but keep reminding the user on a slower cadence so
			// nobody sits on an old version for days.
			if (isUpdateAlreadyReady(result.version)) {
				onProgress?.("idle");
				if (shouldRemindAboutReadyUpdate()) {
					log.info("Reminding about downloaded update", { version: getReadyUpdateVersion() });
					onRemind?.(result.version, result.changelog);
				} else {
					log.info("Update already downloaded, skipping re-download", { version: result.version });
				}
				return;
			}

			log.info("Auto-check found update", { version: result.version });
			onUpdate(result.version, result.changelog);
		} catch (err) {
			log.error("Auto-check failed", { error: String(err) });
			onProgress?.("idle");
		}
	};

	// Check on startup (slight delay to not block init)
	setTimeout(doCheck, 10_000);

	// Then every CHECK_INTERVAL_MS
	setInterval(doCheck, CHECK_INTERVAL_MS);

	log.info("Auto-update check scheduled", { intervalMs: CHECK_INTERVAL_MS });
}
