import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { useT } from "../i18n";
import Tooltip from "./Tooltip";

export interface ArtifactSearchBarHandle {
	/** Re-focus the query input and select its text (repeat ⌘F while open). */
	focusInput: () => void;
}

interface ArtifactSearchBarProps {
	query: string;
	onQueryChange: (query: string) => void;
	/** null = nothing searched yet (empty query) — the counter stays hidden. */
	matches: number | null;
	/** Zero-based position of the highlighted match; -1 when there is none. */
	activeIndex: number;
	onStep: (delta: 1 | -1) => void;
	onClose: () => void;
}

const ICON = "'JetBrainsMono Nerd Font Mono'";

/**
 * Floating ⌘F find bar over an artifact. Fully controlled: TaskArtifactViewer owns
 * the query and the match counter because the search itself runs inside the
 * opaque-origin iframe (postMessage round-trip), not here. Enter / Shift+Enter step
 * forward / back — document convention, unlike the terminal's history-first bar.
 */
const ArtifactSearchBar = forwardRef<ArtifactSearchBarHandle, ArtifactSearchBarProps>(
	function ArtifactSearchBar({ query, onQueryChange, matches, activeIndex, onStep, onClose }, ref) {
		const t = useT();
		const inputRef = useRef<HTMLInputElement>(null);

		useImperativeHandle(ref, () => ({
			focusInput: () => {
				inputRef.current?.focus();
				inputRef.current?.select();
			},
		}), []);

		useEffect(() => {
			inputRef.current?.focus();
		}, []);

		const noMatches = matches === 0;

		function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
			if (event.key === "Enter") {
				event.preventDefault();
				onStep(event.shiftKey ? -1 : 1);
			} else if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				onClose();
			} else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
				// The viewer's window-level handler treats arrows as artifact history
				// navigation; inside the query they must only move the caret.
				event.stopPropagation();
			}
		}

		return (
			<div
				data-testid="artifact-search-bar"
				className="absolute top-2 right-2 z-30 flex items-center gap-1 rounded-lg border border-edge bg-elevated/95 px-2 py-1 shadow-lg shadow-black/30 backdrop-blur-sm"
			>
			{/* Nerd Font draws this glyph high in its em box, so box-centering alone
			    leaves it ~3px above the query text's optical center - nudge it back down. */}
				<span aria-hidden="true" className="shrink-0 translate-y-[2px] text-sm leading-none text-fg-muted" style={{ fontFamily: ICON }}>{"\uf002"}</span>
				<input
					ref={inputRef}
					type="text"
					value={query}
					onChange={(event) => onQueryChange(event.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={t("artifactViewer.searchPlaceholder")}
					aria-label={t("artifactViewer.searchPlaceholder")}
					spellCheck={false}
					autoCorrect="off"
					autoCapitalize="off"
					className="w-40 bg-transparent text-sm text-fg placeholder:text-fg-muted focus:outline-none"
				/>
				{matches !== null && (
					<span
						data-testid="artifact-search-count"
						className={`shrink-0 text-xs tabular-nums ${noMatches ? "text-danger" : "text-fg-muted"}`}
						aria-live="polite"
					>
						{`${matches === 0 ? 0 : activeIndex + 1}/${matches}`}
					</span>
				)}
				<Tooltip content={t("artifactViewer.searchPrev")} placement="bottom">
					<button
						type="button"
						onClick={() => onStep(-1)}
						disabled={!matches}
						aria-label={t("artifactViewer.searchPrev")}
						className="rounded px-1 text-sm text-fg-3 transition-colors hover:text-fg disabled:opacity-40"
					>
						{"↑"}
					</button>
				</Tooltip>
				<Tooltip content={t("artifactViewer.searchNext")} placement="bottom">
					<button
						type="button"
						onClick={() => onStep(1)}
						disabled={!matches}
						aria-label={t("artifactViewer.searchNext")}
						className="rounded px-1 text-sm text-fg-3 transition-colors hover:text-fg disabled:opacity-40"
					>
						{"↓"}
					</button>
				</Tooltip>
				<Tooltip content={t("artifactViewer.searchClose")} placement="bottom">
					<button
						type="button"
						data-testid="artifact-search-close"
						onClick={onClose}
						aria-label={t("artifactViewer.searchClose")}
						className="rounded px-1 text-sm text-fg-3 transition-colors hover:text-fg"
					>
						{"✕"}
					</button>
				</Tooltip>
			</div>
		);
	},
);

export default ArtifactSearchBar;
