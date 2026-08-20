import { useRef, useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { ALL_PRIORITIES, type Label } from "../../shared/types";
import { useT } from "../i18n";
import LabelChip from "./LabelChip";
import FilterFunnel from "./FilterFunnel";
import HelpSpot from "./HelpSpot";
import type { FilterFunnelGroup } from "../utils/taskFacets";
import { isFacetTokenActive, toggleFacetToken } from "../utils/taskSearch";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { useContainerWidth } from "../hooks/useContainerWidth";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import { PRIORITY_NAME_KEYS, PRIORITY_STYLES } from "./priorityStyles";

/** `gap-1.5` between the inline chips, in px — needed to predict the fit. */
const CHIP_GAP = 6;
/** Slack on the reserved "+N more" width so a digit change can't oscillate the fit. */
const MORE_SLACK = 8;

interface LabelFilterBarProps {
	/** Project labels in the order configured in Project Settings. */
	labels: Label[];
	searchQuery: string;
	onSearchChange: (query: string) => void;
	/** Grouped facet options for the shared filter funnel (built by the board). */
	filterGroups: FilterFunnelGroup[];
	disableGlobalFindShortcut?: boolean;
}

/**
 * The five priority quick-filter chips (P0…P4). Like the label chips, they are a
 * VIEW of the search string — a chip is active when its `priority:` token is
 * present, and clicking toggles that token (multi-select ⇒ OR).
 */
function PriorityFilterChips({
	query,
	onChange,
}: {
	query: string;
	onChange: (query: string) => void;
}) {
	const t = useT();
	return (
		<div className="flex items-center gap-1.5">
			{ALL_PRIORITIES.map((level) => {
				const isOn = isFacetTokenActive(query, "priority", level);
				const style = PRIORITY_STYLES[level];
				return (
					<button
						key={level}
						type="button"
						onClick={() => onChange(toggleFacetToken(query, "priority", level))}
						aria-pressed={isOn}
						aria-label={t("priority.filterAria", { level, name: t(PRIORITY_NAME_KEYS[level]) })}
						title={t(PRIORITY_NAME_KEYS[level])}
						className={`font-mono text-micro font-semibold px-1.5 py-0.5 rounded transition-colors ${
							isOn ? style.chipActive : style.chipIdle
						}`}
					>
						{level}
					</button>
				);
			})}
		</div>
	);
}

/** Rough "+N more" width used before the button has ever been laid out. */
const MORE_FALLBACK = 60;

/** How many chips of `widths` fit in `avail`, reserving room for "+N more". */
function fitCount(widths: number[], avail: number, moreWidth: number): number {
	const total = widths.reduce((sum, w, i) => sum + w + (i ? CHIP_GAP : 0), 0);
	if (total <= avail) return widths.length;

	const budget = avail - moreWidth - CHIP_GAP;
	let used = 0;
	let n = 0;
	for (const w of widths) {
		const next = used + w + (n ? CHIP_GAP : 0);
		if (next > budget) break;
		used = next;
		n++;
	}
	return n;
}

/**
 * How many label chips the row can show, or `null` while nothing is measurable
 * (first paint, no layout engine) — then every chip renders, which is also the
 * pass that measures them. Widths are cached per label id so a resize can
 * re-fit without rendering the trimmed-away chips again.
 */
function useFittedChipCount(labels: Label[], rowRef: RefObject<HTMLDivElement | null>): number | null {
	const rowWidth = useContainerWidth(rowRef);
	const chipWidths = useRef(new Map<string, number>());
	const moreWidth = useRef(0);
	const [fit, setFit] = useState<number | null>(null);

	useLayoutEffect(() => {
		const row = rowRef.current;
		if (!row) return;

		for (const el of row.querySelectorAll<HTMLElement>("[data-label-chip]")) {
			const id = el.dataset.labelChip;
			if (id && el.offsetWidth > 0) chipWidths.current.set(id, el.offsetWidth);
		}
		const moreEl = row.querySelector<HTMLElement>("[data-label-more]");
		if (moreWidth.current === 0 && moreEl && moreEl.offsetWidth > 0) {
			moreWidth.current = moreEl.offsetWidth + MORE_SLACK;
		}

		const widths = labels.map((label) => chipWidths.current.get(label.id) ?? 0);
		if (rowWidth <= 0 || widths.some((w) => w <= 0)) {
			setFit(null);
			return;
		}
		setFit(fitCount(widths, rowWidth, moreWidth.current || MORE_FALLBACK));
	}, [labels, rowWidth, fit, rowRef]);

	return fit;
}

function LabelFilterBar({
	labels,
	searchQuery,
	onSearchChange,
	filterGroups,
	disableGlobalFindShortcut = false,
}: LabelFilterBarProps) {
	const t = useT();
	const inputRef = useRef<HTMLInputElement>(null);
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	// Lifted so the "+N more" label chip can open the shared funnel.
	const [funnelOpen, setFunnelOpen] = useState(false);

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
	// Chips fill the row in the project settings order; whatever does not fit the
	// measured width lives in the funnel, reachable via the "+N more" chip.
	const chipRowRef = useRef<HTMLDivElement>(null);
	const fit = useFittedChipCount(labels, chipRowRef);
	const shownLabels = fit === null ? labels : labels.slice(0, fit);
	const hiddenLabelCount = labels.length - shownLabels.length;

	// Inline chips are a VIEW of the search string: active when the token is
	// present, click toggles it.
	const isLabelActive = (label: Label) => isFacetTokenActive(searchQuery, "label", label.name);
	const toggleLabel = (label: Label) => onSearchChange(toggleFacetToken(searchQuery, "label", label.name));

	// Narrow viewport: the inline chips eat vertical space. Keep search inline and
	// let the funnel own all filtering (it opens a bottom sheet on narrow).
	if (narrow) {
		return (
			<div className="flex items-center gap-2 px-3 py-2 border-b border-edge/50" data-help-id="board.filter-bar">
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
						aria-label={t("labels.searchAriaLabel")}
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
						className="w-full pl-7 pr-6 py-1.5 text-sm bg-base border border-edge rounded-lg text-fg placeholder:text-fg-muted focus:border-edge-active transition-colors"
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
				<FilterFunnel
					query={searchQuery}
					onChange={onSearchChange}
					groups={filterGroups}
					open={funnelOpen}
					onOpenChange={setFunnelOpen}
					helpTopicId="board.filter-bar"
				/>
			</div>
		);
	}

	return (
		<div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-6 pt-2 pb-1.5 border-b border-edge/50" data-help-id="board.filter-bar">
			{/* Search + funnel: the funnel sits snug against the search's right edge. */}
			<div className="flex items-center gap-1 flex-shrink-0">
				<div className="relative w-56">
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
						aria-label={t("labels.searchAriaLabel")}
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
						className="w-full pl-7 pr-6 py-1 text-xs bg-base border border-edge rounded-lg text-fg placeholder:text-fg-muted focus:border-edge-active transition-colors"
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
				<FilterFunnel
					query={searchQuery}
					onChange={onSearchChange}
					groups={filterGroups}
					open={funnelOpen}
					onOpenChange={setFunnelOpen}
				/>
			</div>

			{/* Priority quick-filter — the fast, high-value filter, right after search. */}
			<div className="flex items-center gap-1.5 flex-shrink-0">
				<span className="flex items-center gap-1 text-xs text-fg-3 font-medium">
					{t("priority.filterTitle")}:
					<HelpSpot topicId="board.priority-filter" />
				</span>
				<PriorityFilterChips query={searchQuery} onChange={onSearchChange} />
			</div>

			{/* Labels — the project-configured order fills the free width on one row,
			    the rest behind "+N more" which opens the funnel's full label list. */}
			{hasLabels && (
				<div className="flex items-center gap-1.5 flex-1 min-w-0">
					<span className="flex items-center gap-1 text-xs text-fg-3 font-medium flex-shrink-0">
						{t("labels.filterTitle")}:
						<HelpSpot topicId="board.filter-bar" />
					</span>
					<div ref={chipRowRef} className="flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden">
						{shownLabels.map((label) => (
							<span key={label.id} data-label-chip={label.id} className="flex-shrink-0">
								<LabelChip
									label={label}
									size="sm"
									active={isLabelActive(label)}
									onClick={() => toggleLabel(label)}
								/>
							</span>
						))}
						{hiddenLabelCount > 0 && (
							<button
								type="button"
								data-label-more
								onClick={() => setFunnelOpen(true)}
								className="text-dense font-medium text-fg-3 hover:text-fg px-1.5 py-0.5 rounded-full border border-edge hover:border-edge-active transition-colors flex-shrink-0"
							>
								{t("labels.moreLabels", { count: String(hiddenLabelCount) })}
							</button>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

export default LabelFilterBar;
