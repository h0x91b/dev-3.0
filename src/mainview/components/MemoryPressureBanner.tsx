import { useEffect, useState } from "react";
import type { SystemMemorySnapshot } from "../../shared/types";
import { api } from "../rpc";
import { useT } from "../i18n";
import { formatBytes } from "../utils/formatBytes";

/**
 * Launch-time memory notice for the create-task and launch-variants modals.
 *
 * A passive header widget will not stop anyone from starting a twentieth task, so
 * the same numbers appear at the moment the decision is actually made. It
 * INFORMS: it never blocks, never gates behind a confirmation, and never disables
 * the launch button. The user keeps authority over their own machine.
 *
 * It appears only when the machine is genuinely tight — otherwise it becomes
 * wallpaper the user stops reading.
 */

interface MemoryPressureBannerProps {
	/** How many tasks this launch will start. Drives the forecast. */
	launchCount: number;
}

export default function MemoryPressureBanner({ launchCount }: MemoryPressureBannerProps) {
	const t = useT();
	const [snapshot, setSnapshot] = useState<SystemMemorySnapshot | null>(null);

	useEffect(() => {
		let cancelled = false;
		api.request
			.getSystemMemory()
			.then((result) => {
				if (!cancelled) setSnapshot(result);
			})
			.catch(() => {
				// No data — the banner simply does not appear.
			});

		function onUpdate(e: Event) {
			setSnapshot((e as CustomEvent).detail as SystemMemorySnapshot);
		}
		window.addEventListener("rpc:systemMemoryUpdated", onUpdate);
		return () => {
			cancelled = true;
			window.removeEventListener("rpc:systemMemoryUpdated", onUpdate);
		};
	}, []);

	if (!snapshot) return null;

	// The forecast is built from what THIS user's tasks actually consume, not from
	// a generic number, so it is credible on their machine with their agents.
	const forecast = snapshot.medianTaskRss !== null ? snapshot.medianTaskRss * Math.max(1, launchCount) : null;
	const wontFit = forecast !== null && forecast > snapshot.headroom;

	const tight = snapshot.pressure !== "normal" || wontFit;
	if (!tight) return null;

	// The forecast overrunning what is left is the sharper signal, and should not
	// look identical to the merely-tight case.
	const severe = wontFit || snapshot.pressure === "critical";
	const surfaceClass = severe ? "border-danger/30 bg-danger/10" : "border-accent/30 bg-accent/10";
	const headlineClass = severe ? "text-danger" : "text-accent";

	return (
		<div
			role="status"
			aria-live="polite"
			data-testid="memory-pressure-banner"
			className={`flex flex-col gap-1 rounded-xl border px-3 py-2.5 ${surfaceClass}`}
		>
			<p className={`text-sm font-medium ${headlineClass}`}>
				{t("memory.bannerHeadline", { free: formatBytes(snapshot.headroom) })}
			</p>
			<p className="text-xs leading-relaxed text-fg-2">
				{snapshot.swapping && `${t("memory.bannerSwapping")} `}
				{forecast === null
					? t("memory.bannerNoForecast")
					: t("memory.bannerForecast", {
							median: formatBytes(snapshot.medianTaskRss!),
							count: String(Math.max(1, launchCount)),
							needed: formatBytes(forecast),
						})}
				{wontFit && ` ${t("memory.bannerWontFit")}`}
			</p>
		</div>
	);
}
