import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { helpTopic, type HelpTopic } from "../help";
import { useT } from "../i18n";
import HelpCard from "./HelpCard";

/**
 * Help mode — the screen-wide "Explain this screen" overlay (bible §5.4).
 *
 * Every element tagged `data-help-id="<topic id>"` (a registered `help.ts`
 * topic) gets an (i) badge + outline; clicking a badge opens the topic's
 * HelpCard pinned to that zone. This is how dense, headerless zones (inspector
 * quickbars, task cards, header utilities) get explanations with zero
 * permanent chrome. Esc closes the open card first, then exits the mode.
 *
 * Positioning mirrors `HintOverlay`: static scan on mount, imperative
 * scroll/resize repositioning straight to the DOM.
 */

interface HelpZone {
	topic: HelpTopic;
	element: HTMLElement;
}

function isVisible(el: HTMLElement): boolean {
	const r = el.getBoundingClientRect();
	if (r.width === 0 || r.height === 0) return false;
	if (r.bottom <= 0 || r.right <= 0 || r.top >= window.innerHeight || r.left >= window.innerWidth) {
		return false;
	}
	const x = Math.max(0, Math.min(window.innerWidth - 1, r.left + Math.min(8, r.width / 2)));
	const y = Math.max(0, Math.min(window.innerHeight - 1, r.top + Math.min(8, r.height / 2)));
	const topEl = typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null;
	if (!topEl) return true; // no layout engine (jsdom) — trust the viewport check
	return el.contains(topEl) || topEl.contains(el);
}

/** One zone per topic id — first visible match in DOM order wins (rows repeat the id). */
function scanZones(): HelpZone[] {
	const all = Array.from(document.querySelectorAll<HTMLElement>("[data-help-id]"));
	const byId = new Map<string, HelpZone>();
	for (const el of all) {
		const id = el.getAttribute("data-help-id");
		if (!id || byId.has(id)) continue;
		const topic = helpTopic(id);
		if (!topic) continue;
		if (!isVisible(el)) continue;
		byId.set(id, { topic, element: el });
	}
	return Array.from(byId.values());
}

/**
 * Resolve a zone's element afresh instead of trusting the node captured at scan
 * time.
 *
 * A conditional readout (the memory pill, the remote connection readout) can
 * unmount and remount while help mode is open — it renders only while it has bad
 * news. React then puts a NEW node in the DOM and the captured one is detached,
 * whose `getBoundingClientRect()` is all zeros, so the outline, the badge and the
 * card all collapse into the top-left corner of the screen instead of sitting
 * beside the thing they explain.
 */
export function liveHelpZoneElement(zone: HelpZone): HTMLElement | null {
	const fresh = document.querySelector<HTMLElement>(`[data-help-id="${CSS.escape(zone.topic.id)}"]`);
	if (fresh) return fresh;
	// Gone from the screen entirely (the readout went quiet): nothing to point at.
	return zone.element.isConnected ? zone.element : null;
}

interface HelpOverlayProps {
	onExit: () => void;
	/** Passed when a guided tour applies to this screen. Help mode is where a
	 *  walkthrough is asked for a second time — the mode already means "teach me",
	 *  and it needs no button of its own on the board. */
	onRunTour?: () => void;
}

export default function HelpOverlay({ onExit, onRunTour }: HelpOverlayProps) {
	const t = useT();
	const [activeId, setActiveId] = useState<string | null>(null);
	const outlineRefs = useRef(new Map<string, HTMLDivElement>());
	const badgeRefs = useRef(new Map<string, HTMLButtonElement>());
	const onExitRef = useRef(onExit);
	onExitRef.current = onExit;

	const [zones] = useState<HelpZone[]>(() =>
		scanZones().sort((a, b) => {
			const ra = a.element.getBoundingClientRect();
			const rb = b.element.getBoundingClientRect();
			return ra.top - rb.top || ra.left - rb.left;
		}),
	);
	const zonesRef = useRef(zones);
	zonesRef.current = zones;

	const activeZone = activeId ? zones.find((z) => z.topic.id === activeId) : undefined;
	// Resolved at render, not at scan: the node the card anchors to may have been
	// replaced since the mode was entered.
	const activeAnchor = activeZone ? liveHelpZoneElement(activeZone) : null;

	// Nothing to explain on this screen — leave immediately instead of trapping.
	useEffect(() => {
		if (zones.length === 0) onExitRef.current();
	}, [zones.length]);

	// Focus the first badge so Tab/Enter work without reaching for the mouse.
	useEffect(() => {
		const first = zonesRef.current[0];
		if (first) badgeRefs.current.get(first.topic.id)?.focus();
	}, []);

	const reposition = useCallback(() => {
		for (const zone of zonesRef.current) {
			const el = liveHelpZoneElement(zone);
			if (!el) continue;
			const r = el.getBoundingClientRect();
			const outline = outlineRefs.current.get(zone.topic.id);
			if (outline) {
				outline.style.top = `${r.top - 3}px`;
				outline.style.left = `${r.left - 3}px`;
				outline.style.width = `${r.width + 6}px`;
				outline.style.height = `${r.height + 6}px`;
			}
			const badge = badgeRefs.current.get(zone.topic.id);
			if (badge) {
				badge.style.top = `${r.top - 8}px`;
				badge.style.left = `${Math.max(4, r.left - 8)}px`;
			}
		}
	}, []);

	useEffect(() => {
		window.addEventListener("scroll", reposition, { capture: true, passive: true });
		window.addEventListener("resize", reposition);
		return () => {
			window.removeEventListener("scroll", reposition, { capture: true });
			window.removeEventListener("resize", reposition);
		};
	}, [reposition]);

	// Esc: close the open card first, then exit the mode. The pinned HelpCard
	// registers its own capture-phase Esc handler (useEscapeKey) which stops
	// propagation, so this handler only fires when no card is open.
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopImmediatePropagation();
			onExitRef.current();
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	if (zones.length === 0) return null;

	return createPortal(
		<div className="fixed inset-0 z-[80]" data-testid="help-overlay">
			{/* Dim + click-shield: clicking empty space exits the mode. */}
			<div
				className="absolute inset-0 bg-black/35"
				data-testid="help-overlay-backdrop"
				onClick={() => (activeId ? setActiveId(null) : onExitRef.current())}
			/>
			{zones.map((zone) => {
				const { topic } = zone;
				const element = liveHelpZoneElement(zone);
				// The readout this zone points at has left the screen — no outline and
				// no badge, rather than a marker pinned to nothing.
				if (!element) return null;
				const r = element.getBoundingClientRect();
				const active = topic.id === activeId;
				return (
					<div key={topic.id}>
						<div
							ref={(el) => {
								if (el) outlineRefs.current.set(topic.id, el);
								else outlineRefs.current.delete(topic.id);
							}}
							className={`absolute rounded-lg pointer-events-none border-2 ${
								active ? "border-accent bg-accent/10" : "border-accent/50"
							}`}
							style={{ top: r.top - 3, left: r.left - 3, width: r.width + 6, height: r.height + 6 }}
						/>
						<button
							ref={(el) => {
								if (el) badgeRefs.current.set(topic.id, el);
								else badgeRefs.current.delete(topic.id);
							}}
							type="button"
							data-testid="help-badge"
							data-help-badge={topic.id}
							aria-label={t(topic.titleKey)}
							onClick={() => setActiveId(active ? null : topic.id)}
							className={`absolute w-5 h-5 flex items-center justify-center rounded-full border shadow-lg shadow-black/40 text-xs leading-none transition-colors ${
								active
									? "bg-accent-fill text-white border-accent"
									: "bg-overlay text-accent border-accent/60 hover:bg-accent-fill hover:text-white"
							}`}
							style={{
								top: r.top - 8,
								left: Math.max(4, r.left - 8),
								fontFamily: "'JetBrainsMono Nerd Font Mono'",
							}}
						>
							{"\uf05a"}
						</button>
					</div>
				);
			})}

			{activeZone && activeAnchor ? (
				<HelpCard
					topic={activeZone.topic}
					anchorEl={activeAnchor}
					pinned
					closeOnOutsideClick={false}
					onClose={() => setActiveId(null)}
				/>
			) : null}

			<div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full border border-edge-active bg-overlay px-4 py-2 text-sm text-fg-2 shadow-2xl shadow-black/50 max-w-[calc(100vw-2rem)]">
				<span className="min-w-0 truncate">{t("help.ui.modeBanner")}</span>
				<span className="text-fg-muted">·</span>
				<span className="flex items-center gap-1.5 flex-shrink-0">
					<kbd className="inline-flex items-center rounded border border-accent/60 bg-accent/15 px-1.5 py-0.5 font-mono text-micro font-semibold leading-none text-accent shadow-sm">
						Esc
					</kbd>
					<span className="font-medium text-fg">{t("help.ui.exitHint")}</span>
				</span>
				{onRunTour && (
					<>
						<span className="text-fg-muted">·</span>
						<button
							type="button"
							onClick={onRunTour}
							data-testid="help-run-tour"
							className="flex-shrink-0 font-medium text-accent hover:text-accent-emphasis transition-[color,transform] duration-150 ease-out motion-safe:active:scale-[0.96]"
						>
							{t("help.ui.runTour")}
						</button>
					</>
				)}
			</div>
		</div>,
		document.body,
	);
}
