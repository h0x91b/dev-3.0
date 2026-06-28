import { useRef, useEffect } from "react";
import type { Label } from "../../shared/types";
import { useT } from "../i18n";
import LabelChip from "./LabelChip";

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
						<span
							className="cursor-help text-fg-muted hover:text-fg transition-colors leading-none"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							title={t("labels.manageHint")}
							aria-label={t("labels.manageHint")}
						>
							{"\u{F02FC}"}
						</span>
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
