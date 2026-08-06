import { useEffect, useState } from "react";
import type { SystemMemorySnapshot } from "../../shared/types";
import { api } from "../rpc";
import { useT } from "../i18n";

/**
 * Launch-time memory notice for the create-task and launch-variants modals.
 *
 * A passive header widget will not stop anyone from starting a twentieth task, so
 * a verdict appears at the moment the decision is actually made. It INFORMS: it
 * never blocks, never gates behind a confirmation, and never disables the launch
 * button. The user keeps authority over their own machine.
 *
 * One plain-language line, no byte counts: at launch time "139 MB per task" is
 * arithmetic the user has to do themselves, and it cost this notice as much
 * vertical space as the variant picker it sits above. The exact figures stay one
 * hover away in the header's memory readout.
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
	const surfaceClass = severe
		? "border-danger/30 bg-danger/10 text-danger"
		: "border-accent/30 bg-accent/10 text-accent";

	const count = Math.max(1, launchCount);
	const verdict =
		forecast === null
			? t("memory.bannerTight")
			: t.plural(severe ? "memory.bannerOutOfRoom" : "memory.bannerLoaded", count);

	return (
		<div
			role="status"
			aria-live="polite"
			data-testid="memory-pressure-banner"
			className={`flex items-start gap-2 rounded-lg border px-3 py-1.5 text-xs ${surfaceClass}`}
		>
			{/* mt-px keeps the glyph on the first line's optical centre when the
			    sentence wraps in a narrow dialog. */}
			<svg
				className="w-3.5 h-3.5 mt-px flex-shrink-0"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				aria-hidden="true"
			>
				<circle cx="8" cy="8" r="6.25" />
				<path d="M8 4.75v3.75M8 11.1h.01" />
			</svg>
			<span className="min-w-0">
				{verdict}
				{snapshot.swapping && ` ${t("memory.bannerSwapping")}`}
			</span>
		</div>
	);
}
