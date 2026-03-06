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
}

function LabelFilterBar({ labels, activeFilters, onToggle, onClear, searchQuery, onSearchChange }: LabelFilterBarProps) {
	const t = useT();
	const inputRef = useRef<HTMLInputElement>(null);

	// Ctrl/Cmd+F focuses the search input
	useEffect(() => {
		function handleKeyDown(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key === "f") {
				e.preventDefault();
				inputRef.current?.focus();
			}
		}
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, []);

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
					<span className="text-xs text-fg-3 font-medium flex-shrink-0">{t("labels.filterTitle")}:</span>
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
