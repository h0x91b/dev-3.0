import { useEffect, useId, useRef, useState } from "react";
import { useT, type TranslationKey } from "../i18n";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { isFacetTokenActive, toggleFacetToken, countActiveFacetTokens } from "../utils/taskSearch";
import type { FilterFunnelGroup, FilterGroupId, FilterFunnelOption } from "../utils/taskFacets";
import BottomSheet from "./BottomSheet";
import HelpSpot from "./HelpSpot";

/** Section titles for each funnel group. */
const GROUP_TITLE_KEY: Record<FilterGroupId, TranslationKey> = {
	priority: "filter.group.priority",
	status: "filter.group.status",
	labels: "filter.group.labels",
	agents: "filter.group.agents",
	flags: "filter.group.flags",
};

interface FilterFunnelProps {
	/** The single source-of-truth search string. */
	query: string;
	/** Emits the edited query string when a value is checked/unchecked. */
	onChange: (next: string) => void;
	/** Grouped, present-values-only options (built by the host surface). */
	groups: FilterFunnelGroup[];
	/** Compact (board bar) vs tiny (sidebar) button sizing. */
	size?: "sm" | "xs";
	/** Controlled open state (optional). When omitted, the funnel owns it. */
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	/** When set, a help (i) sits next to the funnel (used where no section (i) exists). */
	helpTopicId?: string;
}

/**
 * Shared VSCode-Extensions-style filter funnel. A ghost icon button with an
 * accent count badge opens a dropdown (bottom sheet on narrow viewports) of
 * checkable filter values grouped by facet. Checking a value inserts its token
 * into the search string; unchecking removes it — the string stays the single
 * source of truth. Reused by the Kanban filter bar and the Active Tasks sidebar.
 */
export default function FilterFunnel({ query, onChange, groups, size = "sm", open: controlledOpen, onOpenChange, helpTopicId }: FilterFunnelProps) {
	const t = useT();
	const [internalOpen, setInternalOpen] = useState(false);
	const open = controlledOpen ?? internalOpen;
	const setOpen = (next: boolean) => (onOpenChange ? onOpenChange(next) : setInternalOpen(next));
	const narrow = useNarrowViewport(768);
	const containerRef = useRef<HTMLDivElement>(null);
	const panelId = useId();

	const activeCount = countActiveFacetTokens(query);

	// Close the (wide) dropdown on outside click / Escape.
	useEffect(() => {
		if (!open || narrow) return;
		function onPointerDown(e: MouseEvent) {
			if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
		}
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(false);
			}
		}
		window.addEventListener("mousedown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("mousedown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [open, narrow]);

	if (groups.length === 0) return null;

	const btnSize = size === "xs" ? "w-6 h-6" : "w-7 h-7";

	function handleToggle(opt: FilterFunnelOption) {
		onChange(toggleFacetToken(query, opt.facet, opt.value));
	}

	const groupList = (
		<div className="py-1" data-testid="filter-funnel-groups">
			{groups.map((group) => (
				<div key={group.id} className="py-1">
					<div className="px-3 pb-1 text-[0.625rem] font-semibold uppercase tracking-wider text-fg-3">
						{t(GROUP_TITLE_KEY[group.id])}
					</div>
					{group.options.map((opt) => {
						const checked = isFacetTokenActive(query, opt.facet, opt.value);
						return (
							<button
								key={`${opt.facet}:${opt.value}`}
								type="button"
								role="checkbox"
								aria-checked={checked}
								onClick={() => handleToggle(opt)}
								className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm text-fg-2 hover:bg-elevated-hover hover:text-fg transition-colors"
							>
								<span
									aria-hidden
									className={`flex-shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors ${
										checked ? "bg-accent border-accent text-white" : "border-edge-active"
									}`}
								>
									{checked && (
										<svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
											<path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
										</svg>
									)}
								</span>
								{opt.color && (
									<span
										aria-hidden
										className="flex-shrink-0 w-2 h-2 rounded-full"
										style={{ background: opt.color }}
									/>
								)}
								<span className="truncate">{opt.label}</span>
							</button>
						);
					})}
				</div>
			))}
		</div>
	);

	return (
		<div ref={containerRef} className="relative flex-shrink-0">
			<div className="flex items-center gap-0.5">
				<button
					type="button"
					aria-label={t("filter.funnelLabel")}
					title={t("filter.funnelLabel")}
					aria-expanded={open}
					aria-controls={open && !narrow ? panelId : undefined}
					onClick={() => setOpen(!open)}
					data-testid="filter-funnel-button"
					className={`relative flex items-center justify-center rounded-lg border transition-colors ${btnSize} ${
						activeCount > 0 || open
							? "border-accent/50 text-accent bg-accent/10"
							: "border-edge text-fg-3 hover:text-fg hover:bg-elevated"
					}`}
				>
					{/* Nerd Font: nf-fa-filter (U+F0B0) */}
					<span className="font-mono text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
						{""}
					</span>
					{activeCount > 0 && (
						<span
							className="absolute -top-1 -right-1 min-w-[1rem] h-4 px-1 flex items-center justify-center rounded-full bg-accent text-white text-[0.625rem] font-bold leading-none"
							data-testid="filter-funnel-badge"
						>
							{activeCount}
						</span>
					)}
				</button>
				{helpTopicId && <HelpSpot topicId={helpTopicId} />}
			</div>

			{open && !narrow && (
				<div
					id={panelId}
					className="absolute right-0 mt-1 z-50 min-w-[13rem] max-w-[18rem] max-h-[70vh] overflow-y-auto rounded-lg border border-edge bg-elevated shadow-lg"
					data-testid="filter-funnel-dropdown"
				>
					{groupList}
				</div>
			)}

			{narrow && (
				<BottomSheet
					open={open}
					onClose={() => setOpen(false)}
					title={t("filter.title")}
					testId="filter-funnel-sheet"
				>
					{groupList}
				</BottomSheet>
			)}
		</div>
	);
}
