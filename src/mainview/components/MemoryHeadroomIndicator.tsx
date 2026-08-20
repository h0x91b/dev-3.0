import { useCallback, useEffect, useState } from "react";
import type { SystemMemorySnapshot } from "../../shared/types";
import type { Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { formatBytes, formatBytesCompact } from "../utils/formatBytes";
import { useHeaderFlyout } from "../hooks/useHeaderFlyout";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import BottomSheet from "./BottomSheet";
import HeaderFlyoutPanel from "./HeaderFlyoutPanel";
import MemoryBreakdownPanel, { PRESSURE_BAR_CLASS, PRESSURE_TEXT_CLASS } from "./MemoryBreakdownPanel";

/**
 * Ambient memory-headroom readout for the global header.
 *
 * Shows what is LEFT, not what is used: "12 GB" answers "can I start another
 * task?" directly, where "52 / 64" makes the reader do the subtraction. The
 * wording is load-bearing — a bare quantity labelled only "memory" reproduces the
 * exact ambiguity this widget exists to dissolve, so the accessible name and
 * tooltip both say *free*.
 *
 * There is deliberately no icon. A drawn memory module was tried first and failed
 * at 18 px: board, chips, contact teeth and notch all collapse into one grey
 * smudge that reads as a cassette. The number carries the meaning and a bar the
 * full width of the pill carries the level, which is the one thing that cannot
 * lose detail at this size.
 *
 * Colour comes from the operating system's own pressure verdict, never from a
 * percentage threshold of our own, so it stays meaningful on an 8 GB laptop and
 * on a 512 GB workstation alike. Length comes from the number. Those two are kept
 * separate on purpose: the bar can say "nearly full" while the colour still says
 * "the OS is fine with it", which on a 128 GB machine is the truth.
 *
 * On narrow it folds into the header kebab sheet alongside prevent-sleep and the
 * rate limits (PRODUCT_UX_BIBLE §12.6), and its breakdown opens as a BottomSheet:
 * there is no hover on touch and a floating popover would overflow a phone.
 *
 * The open/pin/position behaviour is `useHeaderFlyout`, shared with the remote
 * connection-quality readout.
 */

const POPOVER_WIDTH = 26 * 16;

interface MemoryHeadroomIndicatorProps {
	navigate: (route: Route) => void;
	/**
	 * `bar` is the header pill — it renders ONLY while the OS reports pressure, so a
	 * machine that is fine carries no readout at all. `menu` is the labelled row in
	 * the header's overflow menu, where the number is always available on demand.
	 */
	variant?: "bar" | "menu";
}

export default function MemoryHeadroomIndicator({ navigate, variant = "bar" }: MemoryHeadroomIndicatorProps) {
	const t = useT();
	const isNarrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [snapshot, setSnapshot] = useState<SystemMemorySnapshot | null>(null);
	const flyout = useHeaderFlyout({ variant, isNarrow, repositionKey: snapshot });

	useEffect(() => {
		let cancelled = false;
		api.request
			.getSystemMemory()
			.then((result) => {
				if (!cancelled) setSnapshot(result);
			})
			.catch(() => {
				// No snapshot yet (first poll pending) — the widget stays hidden.
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

	const selectTask = useCallback(
		(taskId: string, projectId: string) => {
			flyout.close();
			navigate({ screen: "project", projectId, activeTaskId: taskId });
		},
		[flyout, navigate],
	);

	// Render nothing until the first snapshot lands: a placeholder pill would
	// cause exactly the header layout shift the UX manifest warns about.
	if (!snapshot) return null;

	// A machine with headroom is not news. The header bar earns the readout only once
	// the OS itself says the memory is tight (yellow); until then it lives in the
	// menu. Narrow is exempt: there the same `bar` markup IS the sheet row (the phone
	// header never carries it), and a sheet the user opened should not be empty.
	if (variant === "bar" && !isNarrow && snapshot.pressure === "normal") return null;

	const usedRatio = snapshot.total > 0 ? snapshot.used / snapshot.total : 0;
	const pressureClass = PRESSURE_TEXT_CLASS[snapshot.pressure];
	const accessibleName = t("memory.ariaLabel", { free: formatBytes(snapshot.headroom) });

	const breakdown = (
		<MemoryBreakdownPanel snapshot={snapshot} onSelectTask={selectTask} onCloseOverlay={flyout.close} />
	);

	const level = (
		<span aria-hidden="true" className="h-0.5 w-full overflow-hidden rounded-full bg-edge">
			<span
				className={`hdr-mem-bar block h-full rounded-full ${PRESSURE_BAR_CLASS[snapshot.pressure]}`}
				style={{ width: `${Math.round(Math.min(1, Math.max(0, usedRatio)) * 100)}%` }}
			/>
		</span>
	);

	// Menu row: hover opens the flyout after a dwell, a click pins it. Click-only
	// made the row read as a label — nobody found the breakdown behind it.
	if (variant === "menu") {
		return (
			<>
				<button
					ref={flyout.anchorRef}
					type="button"
					role="menuitem"
					aria-label={accessibleName}
					data-testid="memory-headroom-indicator"
					className="header-anim w-full px-3 py-2 flex items-center gap-2.5 text-fg-2 hover:bg-elevated hover:text-fg transition-colors"
					{...flyout.triggerProps}
				>
					<span className="flex w-[1.125rem] flex-col justify-center gap-[0.1875rem]">{level}</span>
					<span className="text-sm flex-1 text-left">{t("memory.label")}</span>
					<span className={`text-micro font-medium tabular-nums ${pressureClass}`}>
						{formatBytesCompact(snapshot.headroom)}
					</span>
				</button>
				{flyout.open && !isNarrow && (
					<HeaderFlyoutPanel
						flyout={flyout}
						width={POPOVER_WIDTH}
						ariaLabel={t("memory.label")}
						testId="memory-breakdown-popover"
					>
						{breakdown}
					</HeaderFlyoutPanel>
				)}
			</>
		);
	}

	return (
		<>
			<button
				ref={flyout.anchorRef}
				type="button"
				aria-label={accessibleName}
				data-help-id="header.memory"
				data-testid="memory-headroom-indicator"
				className={`header-anim flex shrink-0 flex-col justify-center gap-[0.1875rem] rounded-lg transition-colors hover:bg-elevated ${
					isNarrow ? "h-11 px-2" : "px-1.5 py-1"
				} ${pressureClass}`}
				{...flyout.triggerProps}
			>
				<span className="text-micro font-medium leading-none tabular-nums">
					{formatBytesCompact(snapshot.headroom)}
				</span>
				{/* The level lives in a bar under the number, not in a glyph: at header
				    size a drawn memory module loses the detail that made it readable,
				    while a bar the full width of the pill cannot lose anything. */}
				{level}
			</button>

			{isNarrow ? (
				<BottomSheet
					open={flyout.open}
					onClose={flyout.close}
					title={t("memory.label")}
					testId="memory-breakdown-sheet"
				>
					{breakdown}
				</BottomSheet>
			) : (
				flyout.open && (
					<HeaderFlyoutPanel
						flyout={flyout}
						width={POPOVER_WIDTH}
						ariaLabel={t("memory.label")}
						testId="memory-breakdown-popover"
					>
						{breakdown}
					</HeaderFlyoutPanel>
				)
			)}
		</>
	);
}
