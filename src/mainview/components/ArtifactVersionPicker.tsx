import { useCallback, useEffect, useRef, useState } from "react";
import type { SharedArtifact } from "../../shared/types";
import { artifactVersions, droppedArtifactVersions, latestArtifactVersion } from "../../shared/artifact-versions";
import { useT } from "../i18n";

interface ArtifactVersionPickerProps {
	artifact: SharedArtifact;
	selected: number;
	onSelect: (version: number) => void;
}

function formatStamp(ms: number): string {
	try {
		return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
	} catch {
		return "";
	}
}

const POPOVER_WIDTH = 256;
const EDGE_GAP = 8;

/**
 * One chip that opens the artifact's publish history — never a second pair of
 * arrows, which would read as the artifact pager sitting next to it. Renders
 * nothing for a single-version artifact, so an artifact published once looks
 * exactly like it did before versioning existed.
 */
export default function ArtifactVersionPicker({ artifact, selected, onSelect }: ArtifactVersionPickerProps) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [spot, setSpot] = useState<{ left: number; top: number } | null>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const versions = artifactVersions(artifact);
	const latest = latestArtifactVersion(artifact);
	const dropped = droppedArtifactVersions(artifact);

	// Measured rather than a CSS anchor, because neither anchor works on its own:
	// right-aligned to the chip the popover spills out of a docked pane's left edge,
	// left-aligned it runs off the window. So: right-align, fall back to growing
	// rightwards from the chip, and clamp to the viewer header's own box.
	const place = useCallback(() => {
		const chip = buttonRef.current;
		if (!chip) return;
		const rect = chip.getBoundingClientRect();
		const box = chip.closest("header")?.getBoundingClientRect();
		const min = (box?.left ?? 0) + EDGE_GAP;
		const max = (box?.right ?? window.innerWidth) - EDGE_GAP - POPOVER_WIDTH;
		const wanted = rect.right - POPOVER_WIDTH;
		const left = wanted < min ? rect.left : wanted;
		setSpot({ left: Math.max(min, Math.min(max, left)), top: rect.bottom + 4 });
	}, []);

	useEffect(() => {
		if (!open) return;
		place();
		window.addEventListener("resize", place);
		return () => window.removeEventListener("resize", place);
	}, [open, place]);

	useEffect(() => {
		if (!open) return;
		// Capture phase, and Escape stops here: the viewer's own Escape chain would
		// otherwise close the whole viewer while a popover is still on screen.
		function onKey(event: KeyboardEvent) {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
		}
		window.addEventListener("keydown", onKey, { capture: true });
		return () => window.removeEventListener("keydown", onKey, { capture: true });
	}, [open]);

	if (versions.length < 2) return null;

	const label = t("artifactViewer.versionOf", { version: String(selected), count: String(latest) });

	return (
		<div className="flex-shrink-0">
			<button
				type="button"
				ref={buttonRef}
				data-testid="artifact-version-picker"
				className={`flex h-11 items-center gap-1 rounded-lg px-2 font-mono text-xs tabular-nums transition-colors sm:h-8 ${open ? "bg-accent/10 text-accent" : "text-fg-3 hover:bg-elevated-hover hover:text-fg"}`}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={label}
				title={label}
				onClick={() => setOpen((value) => !value)}
			>
				<span>v{selected}</span>
				{selected !== latest && <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />}
				<span aria-hidden="true" className="text-fg-muted">▾</span>
			</button>
			{open && (
				<>
				{/* An invisible scrim, not a window listener: most of the viewer is a
				    sandboxed iframe, and a click inside it never reaches this document —
				    so the popover used to stay open over the whole artifact. */}
				<div
					data-testid="artifact-version-scrim"
					className="fixed inset-0 z-10"
					onMouseDown={() => setOpen(false)}
					aria-hidden="true"
				/>
				<div
					role="listbox"
					data-testid="artifact-version-list"
					aria-label={t("artifactViewer.versions")}
					className="fixed z-20 flex w-64 flex-col overflow-hidden rounded-lg border border-edge bg-overlay shadow-lg"
					style={{ left: spot?.left ?? 0, top: spot?.top ?? 0, visibility: spot ? undefined : "hidden" }}
				>
					<div className="max-h-72 overflow-y-auto py-1">
					{[...versions].reverse().map((entry) => (
						<button
							key={entry.version}
							type="button"
							role="option"
							aria-selected={entry.version === selected}
							data-testid="artifact-version-option"
							className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-elevated-hover ${entry.version === selected ? "text-accent" : "text-fg-2"}`}
							onClick={() => { onSelect(entry.version); setOpen(false); }}
						>
							<span className="font-mono text-xs tabular-nums">v{entry.version}</span>
							<span className="min-w-0 flex-1 truncate text-micro text-fg-muted">{formatStamp(entry.createdAt)}</span>
							{entry.version === latest && (
								<span className="flex-shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-micro text-accent">{t("artifactViewer.versionLatest")}</span>
							)}
						</button>
					))}
					</div>
					{dropped > 0 && (
						// Outside the scroll area on purpose: what the cap dropped must be
						// readable without scrolling a 20-entry list to its end.
						<p data-testid="artifact-versions-dropped" className="border-t border-edge px-3 py-2 text-micro text-fg-muted">
							{t.plural("artifactViewer.versionsDropped", dropped)}
						</p>
					)}
				</div>
				</>
			)}
		</div>
	);
}
