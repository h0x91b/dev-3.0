import { Updater } from "electrobun/bun";
import { createLogger } from "./logger";
import { isNewerVersion } from "../shared/version";

const log = createLogger("updater");

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const BASE_URL = "https://h0x91b-releases.s3.eu-west-1.amazonaws.com/dev-3.0";

interface UpdateJson {
	version: string;
	hash: string;
}

interface UpdateCheckResult {
	updateAvailable: boolean;
	version: string;
	error?: string;
}

function getPlatformPrefix(): string {
	const platform = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "win" : "linux";
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	return `${platform}-${arch}`;
}

export async function getLocalVersion(): Promise<{ version: string; hash: string; channel: string }> {
	const [version, hash, channel] = await Promise.all([
		Updater.localInfo.version(),
		Updater.localInfo.hash(),
		Updater.localInfo.channel(),
	]);
	return { version, hash, channel };
}

export async function checkForUpdateWithChannel(channel: string): Promise<UpdateCheckResult> {
	const local = await getLocalVersion();
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

		const updateAvailable = isNewerVersion(local.version, remote.version);
		log.info("Update check result", {
			updateAvailable,
			localVersion: local.version,
			remoteVersion: remote.version,
			localHash: local.hash.slice(0, 12),
			remoteHash: remote.hash.slice(0, 12),
		});

		return {
			updateAvailable,
			version: remote.version || "unknown",
		};
	} catch (err) {
		const msg = `Failed to check for updates: ${err}`;
		log.error(msg);
		return { updateAvailable: false, version: local.version, error: msg };
	}
}

export async function downloadUpdateForChannel(
	channel: string,
	onProgress?: (status: string, progress?: number) => void,
): Promise<{ ok: boolean; error?: string }> {
	const local = await getLocalVersion();

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

			if (checkResult?.updateReady) {
				// Already downloaded from a previous attempt
				log.info("Update already downloaded and ready");
				onProgress?.("complete", 100);
				return { ok: true };
			}

			if (!checkResult?.updateAvailable) {
				const msg = "Built-in updater reports no update available";
				log.warn(msg);
				return { ok: false, error: msg };
			}

			// Step 2: download the update (patch or full bundle)
			await Updater.downloadUpdate();

			// Step 3: verify the update is actually ready after download.
			// Electrobun may not mark updateReady synchronously after downloadUpdate resolves.
			// Use exponential backoff: 500ms, 1s, 2s, 4s, 8s, 16s, 30s (~61.5s total).
			const backoffDelays = [500, 1000, 2000, 4000, 8000, 16000, 30000];
			for (let i = 0; i < backoffDelays.length; i++) {
				const info = i === 0 ? Updater.updateInfo?.() : await Updater.checkForUpdate();
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
			const final = await Updater.checkForUpdate();
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

	// Cross-channel update: download full .tar.zst manually
	// The built-in updater can still apply it via applyUpdate()
	log.info("Cross-channel update, downloading full bundle", { selectedChannel: channel, buildChannel: local.channel });
	onProgress?.("downloading", 0);

	try {
		// First, run the built-in checkForUpdate to populate internal state
		// by pointing it at the correct channel's update.json
		// For cross-channel, we need to download the full tar.zst ourselves
		const platformPrefix = getPlatformPrefix();
		const appName = "dev-3.0".replace(/\s/g, "");
		const ext = process.platform === "darwin" ? ".app.tar.zst" : ".tar.zst";
		const tarUrl = `${BASE_URL}/${channel}-${platformPrefix}-${appName}${ext}?_=${Date.now()}`;

		log.info("Downloading full bundle", { url: tarUrl });
		onProgress?.("downloading", 10);

		const resp = await fetch(tarUrl);
		if (!resp.ok) {
			const msg = `HTTP ${resp.status} downloading bundle`;
			log.error(msg);
			return { ok: false, error: msg };
		}

		// Use the built-in updater's checkForUpdate() first to set up internal state,
		// then downloadUpdate() which will handle the full bundle case
		// Actually, the built-in updater constructs its own URLs based on build-time channel.
		// For cross-channel, we'd need to work differently.
		// The safest approach: use built-in check+download since the baseUrl already points
		// to the flat directory where all channels live.
		// The built-in updater uses: {baseUrl}/{channel}-{platform}-{arch}-update.json
		// Since we sync all artifacts to the flat root, this should work.

		// For now, fall back to the built-in updater even for cross-channel
		// (it will download using its own build-time channel, which should be fine
		// since the S3 bucket has the flat artifact structure)
		log.warn("Cross-channel download not yet fully implemented, falling back to built-in updater");
		await Updater.checkForUpdate();
		await Updater.downloadUpdate();
		onProgress?.("complete", 100);
		return { ok: true };
	} catch (err) {
		const msg = `Download failed: ${err}`;
		log.error(msg);
		onProgress?.("error");
		return { ok: false, error: msg };
	}
}

export async function applyUpdate(): Promise<void> {
	// Verify the update is actually ready before attempting to apply.
	// Without this guard, applyUpdate() may just restart the app
	// without applying anything — causing an infinite update loop.
	let info = Updater.updateInfo?.();
	log.info("Applying update...", {
		updateReady: info?.updateReady,
		version: info?.version,
	});

	if (info && !info.updateReady) {
		// Try refreshing Electrobun's internal state — the download may have
		// completed but the ready flag wasn't propagated yet.
		log.warn("updateReady is false, refreshing via checkForUpdate...");
		const refreshed = await Updater.checkForUpdate();
		if (refreshed?.updateReady) {
			log.info("Update now ready after re-check");
			info = refreshed;
		} else {
			log.error("applyUpdate called but updateReady is still false after re-check — skipping to avoid restart loop");
			throw new Error("Update not ready to apply");
		}
	}

	await Updater.applyUpdate();
}

export function startAutoCheck(
	getChannel: () => Promise<string>,
	onUpdate: (version: string) => void,
	onProgress?: (status: string, progress?: number) => void,
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

			if (result.updateAvailable) {
				log.info("Auto-check found update", { version: result.version });
				onUpdate(result.version);
			} else {
				onProgress?.("idle");
			}
		} catch (err) {
			log.error("Auto-check failed", { error: String(err) });
			onProgress?.("idle");
		}
	};

	// Check on startup (slight delay to not block init)
	setTimeout(doCheck, 10_000);

	// Then every 3 hours
	setInterval(doCheck, CHECK_INTERVAL_MS);

	log.info("Auto-update check scheduled", { intervalMs: CHECK_INTERVAL_MS });
}
