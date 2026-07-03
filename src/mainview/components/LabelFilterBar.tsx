import { useRef, useEffect, useState } from "react";
import type { Label } from "../../shared/types";
import { useT } from "../i18n";
import LabelChip from "./LabelChip";
import BottomSheet from "./BottomSheet";
import HelpSpot from "./HelpSpot";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";

interface LabelFilterBarProps {
	labels: Label[];
	activeFilters: string[];
	onToggle: (labelId: string) => void;
	onClear: () => void;
	searchQuery: string;
	onSearchChange: (query: string) => void;
	disableGlobalFindShortcut?: boolean;
}

function LabelFilterBar({
	labels,
	activeFilters,
	onToggle,
	onClear,
	searchQuery,
	onSearchChange,
	disableGlobalFindShortcut = false,
}: LabelFilterBarProps) {
	const t = useT();
	const inputRef = useRef<HTMLInputElement>(null);
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [sheetOpen, setSheetOpen] = useState(false);

	// Ctrl/Cmd+F focuses the search input
	useEffect(() => {
		if (disableGlobalFindShortcut) {
			return;
		}

		function handleKeyDown(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key === "f") {
				e.preventDefault();
				inputRef.current?.focus();
			}
		}
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [disableGlobalFindShortcut]);

	const hasLabels = labels.length > 0;
	const hasActiveFilters = activeFilters.length > 0;

	// Narrow viewport: the inline chip grid eats 3-4 rows. Keep search inline and
	// move label filtering into a bottom sheet behind a funnel button, so the
	// feature stays touch-reachable while reclaiming the vertical space.
	if (narrow) {
		return (
			<>
				<div className="flex items-center gap-2 px-3 py-2 border-b border-edge/50">
					<div className="relative flex-1 min-w-0">
						<svg
							className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-3 pointer-events-none"
							fill="none"
							viewBox="0 0 24 24"
							strokeWidth={2}
							stroke="currentColor"
						>
							<path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
						</svg>
						<input
							ref={inputRef}
							type="text"
							data-search-input="true"
							value={searchQuery}
							onChange={(e) => onSearchChange(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.stopPropagation();
									onSearchChange("");
									inputRef.current?.blur();
								}
							}}
							placeholder={t("labels.searchPlaceholderTasks")}
							className="w-full pl-7 pr-6 py-1.5 text-sm bg-base border border-edge rounded-lg text-fg placeholder:text-fg-muted focus:outline-none focus:border-edge-active transition-colors"
						/>
						{searchQuery && (
							<button
								type="button"
								onClick={() => onSearchChange("")}
								className="absolute right-1.5 top-1/2 -translate-y-1/2 text-fg-3 hover:text-fg text-sm leading-none"
							>
								×
							</button>
						)}
					</div>
					{hasLabels && (
						<button
							type="button"
							onClick={() => setSheetOpen(true)}
							aria-label={t("labels.openFilters")}
							title={t("labels.openFilters")}
							className={`relative flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-lg border transition-colors ${
								hasActiveFilters
									? "border-accent/50 text-accent bg-accent/10"
									: "border-edge text-fg-3 hover:text-fg hover:bg-elevated"
							}`}
						>
							{/* Nerd Font: fa-filter (U+F0B0) */}
							<span className="font-mono text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
								{""}
							</span>
							{hasActiveFilters && (
								<span className="absolute -top-1 -right-1 min-w-[1rem] h-4 px-1 flex items-center justify-center rounded-full bg-accent text-white text-[0.625rem] font-bold leading-none">
									{activeFilters.length}
								</span>
							)}
						</button>
					)}
				</div>
				<BottomSheet
					open={sheetOpen}
					onClose={() => setSheetOpen(false)}
					title={t("labels.filterTitle")}
					testId="label-filter-sheet"
				>
					<div className="flex flex-wrap gap-2">
						{labels.map((label) => (
							<LabelChip
								key={label.id}
								label={label}
								size="sm"
								active={activeFilters.includes(label.id)}
								onClick={() => onToggle(label.id)}
							/>
						))}
					</div>
					{hasActiveFilters && (
						<button
							type="button"
							onClick={onClear}
							className="mt-4 w-full py-2 text-sm rounded-lg text-fg-2 hover:text-fg bg-elevated hover:bg-elevated-hover transition-colors"
						>
							× {t("labels.clearFilters")}
						</button>
					)}
				</BottomSheet>
			</>
		);
	}

	return (
		<div className="flex items-center gap-2 px-6 py-2 border-b border-edge/50 flex-wrap">
			{/* Search input */}
			<div className="relative flex-shrink-0">
				<svg
					className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-3 pointer-events-none"
					fill="none"
					viewBox="0 0 24 24"
					strokeWidth={2}
					stroke="currentColor"
				>
					<path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
				</svg>
				<input
					ref={inputRef}
					type="text"
					data-search-input="true"
					value={searchQuery}
					onChange={(e) => onSearchChange(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							e.preventDefault();
							e.stopPropagation();
							onSearchChange("");
							inputRef.current?.blur();
						}
					}}
					placeholder={t("labels.searchPlaceholderTasks")}
					className="w-44 pl-7 pr-2 py-1 text-xs bg-base border border-edge rounded-lg text-fg placeholder:text-fg-muted focus:outline-none focus:border-edge-active transition-colors"
				/>
				{searchQuery && (
					<button
						type="button"
						onClick={() => onSearchChange("")}
						className="absolute right-1.5 top-1/2 -translate-y-1/2 text-fg-3 hover:text-fg text-xs leading-none"
					>
						×
					</button>
				)}
			</div>

			{/* Label filters */}
			{hasLabels && (
				<>
					<span className="flex items-center gap-1 text-xs text-fg-3 font-medium flex-shrink-0">
						{t("labels.filterTitle")}:
						<HelpSpot topicId="board.filter-bar" />
					</span>
					<div className="flex items-center gap-1.5 flex-wrap">
						{labels.map((label) => (
							<LabelChip
								key={label.id}
								label={label}
								size="sm"
								active={activeFilters.includes(label.id)}
								onClick={() => onToggle(label.id)}
							/>
						))}
					</div>
				</>
			)}

			{hasActiveFilters && (
				<button
					type="button"
					onClick={onClear}
					className="ml-auto text-xs text-fg-3 hover:text-fg px-2 py-0.5 rounded-lg hover:bg-fg/8 transition-colors flex-shrink-0"
				>
					× {t("labels.clearFilters")}
				</button>
			)}
		</div>
	);
}

export default LabelFilterBar;
