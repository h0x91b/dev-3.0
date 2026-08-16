import { Fragment, useState, useRef, useEffect, useLayoutEffect, useCallback, useId, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { AgentCheckResult } from "../../shared/types";
import { useOverlayLayer } from "../utils/useOverlayLayer";
import { useReducedMotion } from "../utils/useReducedMotion";

export interface SelectOption {
	value: string;
	label: string;
	/** When true the option is shown but not selectable; clicking it runs
	 *  `onOptionDisabledClick` instead of selecting (used for gated presets). */
	disabled?: boolean;
	/** Set by `allowCustom` on rows the caller never declared: the typed value and
	 *  an off-list current value. Presentation only — it still commits as itself. */
	custom?: boolean;
	/** Heading this option sits under. A heading renders once, above the first
	 *  option that names it, and is not itself a row: keyboard navigation and the
	 *  listbox's option indices stay untouched. Options carrying the same section
	 *  must be adjacent — the caller owns the order. */
	section?: string;
}

/** Substring match that ignores case and separators, so "xhigh" finds "X-High". */
function looseIncludes(haystack: string, needle: string): boolean {
	const strip = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
	return haystack.toLowerCase().includes(needle.toLowerCase()) || strip(haystack).includes(strip(needle));
}

/** Lock badge on a gated option. Inline SVG, not a Nerd Font glyph: the icon
 *  face loads with `font-display: swap` and renders as tofu until it arrives. */
function LockIcon() {
	return (
		<svg
			aria-hidden
			className="w-3 h-3 flex-shrink-0"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.8}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<rect x="5" y="11" width="14" height="10" rx="2" />
			<path d="M8 11V7a4 4 0 0 1 8 0v4" />
		</svg>
	);
}

function CheckIcon() {
	return (
		<svg
			aria-hidden
			className="w-3.5 h-3.5 flex-shrink-0 text-accent"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.8}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M5 13l4 4L19 7" />
		</svg>
	);
}

interface ListboxProps {
	anchor: HTMLElement;
	panelRef: RefObject<HTMLDivElement | null>;
	triggerRef: RefObject<HTMLElement | null>;
	listboxId: string;
	optionIdFor: (index: number) => string;
	options: SelectOption[];
	value: string;
	activeIndex: number;
	grow?: boolean;
	renderOption?: (option: SelectOption) => ReactNode;
	onHover: (index: number) => void;
	onPick: (index: number) => void;
	onDismiss: () => void;
	/** Filter field rendered inside the panel; focus lives on it while open. */
	search?: {
		query: string;
		placeholder: string;
		/** The field's own name, for the filter input. Falls back to the
		 *  placeholder, which on an examples-style placeholder reads as a list
		 *  of values rather than a name. */
		label?: string;
		inputMode?: "text" | "decimal";
		emptyLabel: string;
		onQueryChange: (query: string) => void;
		onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
	};
}

/** The portalled `role="listbox"` panel. A separate component so the overlay
 *  layer registers on open and unregisters on close. */
function SelectListbox({
	anchor,
	panelRef,
	triggerRef,
	listboxId,
	optionIdFor,
	options,
	value,
	activeIndex,
	grow,
	renderOption,
	onHover,
	onPick,
	onDismiss,
	search,
}: ListboxProps) {
	const reducedMotion = useReducedMotion();
	const [pos, setPos] = useState(() => {
		const rect = anchor.getBoundingClientRect();
		return { top: rect.bottom + 4, left: rect.left, width: rect.width };
	});
	const [measured, setMeasured] = useState(false);
	const [entered, setEntered] = useState(false);

	// Without a filter field focus stays on the trigger (roving
	// `aria-activedescendant`); with one it moves into the panel's input.
	useOverlayLayer(panelRef, { onDismiss, triggerRef, autoFocus: !!search });

	useLayoutEffect(() => {
		const panel = panelRef.current;
		if (!panel) return;
		const a = anchor.getBoundingClientRect();
		const rect = panel.getBoundingClientRect();
		const height = rect.height;
		// A grown panel is wider than the trigger, so the edge check has to use the
		// panel's own width — the trigger's would let it run off screen.
		const width = Math.max(a.width, rect.width);
		const pad = 8;
		let top = a.bottom + 4;
		if (top + height > window.innerHeight - pad) {
			const above = a.top - height - 4;
			top = above >= pad ? above : Math.max(pad, window.innerHeight - pad - height);
		}
		let left = a.left;
		if (left + width > window.innerWidth - pad) left = window.innerWidth - width - pad;
		if (left < pad) left = pad;
		setPos({ top, left, width: a.width });
		setMeasured(true);
	}, [anchor, options.length, panelRef]);

	// The pre-measure frame is hidden by opacity alone, so the panel stays
	// measurable; entering one frame later gives the transition a state to run from.
	useEffect(() => {
		if (!measured) return;
		if (reducedMotion) {
			setEntered(true);
			return;
		}
		const id = requestAnimationFrame(() => setEntered(true));
		return () => cancelAnimationFrame(id);
	}, [reducedMotion, measured]);

	// Focus never enters the panel (roving highlight), so `useOverlayLayer`'s own
	// focusout guard can't see the user tabbing away from the trigger.
	useEffect(() => {
		const trigger = triggerRef.current;
		if (!trigger || search) return;
		function onFocusOut(e: FocusEvent) {
			const next = e.relatedTarget as Node | null;
			if (!next || panelRef.current?.contains(next)) return;
			onDismiss();
		}
		trigger.addEventListener("focusout", onFocusOut);
		return () => trigger.removeEventListener("focusout", onFocusOut);
	}, [triggerRef, panelRef, onDismiss, search]);

	useEffect(() => {
		if (activeIndex < 0) return;
		const row = panelRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
		row?.scrollIntoView?.({ block: "nearest" });
	}, [activeIndex, panelRef]);

	const rows = (
		<>
			{options.map((opt, index) => {
				const isSelected = opt.value === value;
				const isActive = index === activeIndex;
				// Rendered above its first option rather than as a row of its own:
				// an unselectable row in a listbox breaks arrow-key counting and
				// reads as an option to a screen reader.
				const heading =
					opt.section && opt.section !== options[index - 1]?.section ? (
						<div
							key={`section-${opt.section}`}
							role="presentation"
							className="px-3 pt-2.5 pb-1 text-micro uppercase tracking-wide text-fg-muted"
						>
							{opt.section}
						</div>
					) : null;
				return (
					<Fragment key={opt.value}>
					{heading}
					<button
						type="button"
						role="option"
						id={optionIdFor(index)}
						data-index={index}
						tabIndex={-1}
						aria-selected={isSelected}
						aria-disabled={opt.disabled || undefined}
						onMouseDown={(e) => e.preventDefault()}
						onMouseEnter={() => onHover(index)}
						onClick={() => onPick(index)}
						className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${
							isActive ? "ring-1 ring-inset ring-accent" : ""
						} ${
							opt.disabled
								? "text-fg-muted hover:bg-elevated-hover"
								: isSelected
									? "bg-accent/15 text-fg font-medium"
									: "text-fg-2 hover:bg-elevated-hover hover:text-fg"
						}`}
					>
						{/* The lock is the option's state, not its content, so it survives a
						    caller's renderOption — a custom row must not silently drop it. */}
						<span className="flex-1 min-w-0 truncate">
							{renderOption && !opt.custom ? (
								opt.disabled ? (
									<span className="flex items-center gap-1.5 opacity-70">
										{renderOption(opt)}
										<LockIcon />
									</span>
								) : (
									renderOption(opt)
								)
							) : opt.disabled ? (
								<span className="flex items-center gap-1.5 opacity-70">
									{opt.label}
									<LockIcon />
								</span>
							) : (
								opt.label
							)}
						</span>
						{isSelected && <CheckIcon />}
					</button>
					</Fragment>
				);
			})}
			{options.length === 0 && search && (
				<div className="px-3 py-2 text-sm text-fg-muted">{search.emptyLabel}</div>
			)}
		</>
	);

	const panelClass = `bg-overlay border border-edge-active rounded-lg shadow-xl shadow-black/50 origin-top ${
		reducedMotion ? "" : "transition-[opacity,transform] duration-150"
	} ${entered ? "opacity-100 scale-100" : "opacity-0 scale-[0.98]"}`;
	// `grow`: the trigger's width is a floor, not the width. A dropdown narrower
	// than its own rows makes every row a two-line block or an ellipsis.
	const panelStyle = grow
		? { position: "fixed" as const, top: pos.top, left: pos.left, minWidth: pos.width, width: "max-content", maxWidth: "min(26rem, 92vw)", zIndex: 9999 }
		: { position: "fixed" as const, top: pos.top, left: pos.left, width: pos.width, zIndex: 9999 };

	if (!search) {
		return createPortal(
			<div ref={panelRef} id={listboxId} role="listbox" style={panelStyle} className={`${panelClass} overflow-y-auto max-h-72`}>
				{rows}
			</div>,
			document.body,
		);
	}

	return createPortal(
		<div ref={panelRef} style={panelStyle} className={panelClass}>
			<div className="p-1.5 border-b border-edge">
				<input
					data-overlay-autofocus
					type="text"
					role="combobox"
					aria-expanded
					aria-controls={listboxId}
					aria-autocomplete="list"
					aria-label={search.label ?? search.placeholder}
					aria-activedescendant={activeIndex >= 0 ? optionIdFor(activeIndex) : undefined}
					value={search.query}
					placeholder={search.placeholder}
					inputMode={search.inputMode}
					spellCheck={false}
					autoComplete="off"
					onChange={(e) => search.onQueryChange(e.target.value)}
					onKeyDown={search.onKeyDown}
					className="w-full bg-elevated text-fg text-sm rounded-md px-2.5 py-1.5 border border-edge focus:border-accent outline-none placeholder:text-fg-muted"
				/>
			</div>
			<div id={listboxId} role="listbox" className="overflow-y-auto max-h-64">
				{rows}
			</div>
		</div>,
		document.body,
	);
}

function Select({
	id,
	value,
	options,
	onChange,
	renderOption,
	growList,
	onOptionDisabledClick,
	searchable,
	allowCustom,
	placeholder,
	searchPlaceholder,
	searchLabel,
	ariaLabel,
	customOptionLabel,
	emptyLabel = "Nothing matches",
	inputMode,
}: {
	id?: string;
	value: string;
	options: SelectOption[];
	onChange: (value: string) => void;
	renderOption?: (option: SelectOption) => ReactNode;
	/** Let the open list be wider than the trigger, up to a cap. For a field whose
	 *  rows carry a caption the trigger has no room for. */
	growList?: boolean;
	/** Called when a `disabled` option is clicked (instead of `onChange`). */
	onOptionDisabledClick?: (value: string) => void;
	/** Show a filter field inside the panel. Implied by `allowCustom`. */
	searchable?: boolean;
	/** Let the typed text commit as the value, so a list the app shipped never
	 *  caps what the user can enter (model ids, modes, budgets). */
	allowCustom?: boolean;
	/** Trigger text when nothing is selected. */
	placeholder?: string;
	searchPlaceholder?: string;
	/** Accessible name for the filter field. Give it whenever the placeholder
	 *  is a list of example values rather than a name. */
	searchLabel?: string;
	/** Accessible name for the trigger, for a select with no visible <label>
	 *  (a table cell, where the column header names it only visually). */
	ariaLabel?: string;
	/** Label of the row that commits the typed text; defaults to the text itself. */
	customOptionLabel?: (query: string) => string;
	emptyLabel?: string;
	inputMode?: "text" | "decimal";
}) {
	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(-1);
	const [query, setQuery] = useState("");
	const buttonRef = useRef<HTMLButtonElement>(null);
	const dropdownRef = useRef<HTMLDivElement>(null);
	const reactId = useId();
	const listboxId = `${reactId}-listbox`;
	const optionIdFor = useCallback((index: number) => `${reactId}-option-${index}`, [reactId]);
	const closeList = useCallback(() => setOpen(false), []);
	const withSearch = !!(searchable || allowCustom);
	const declared = options.find((o) => o.value === value);
	/** An off-list current value is a row of its own, so it can read as selected. */
	const currentCustom: SelectOption | undefined = !declared && value && allowCustom
		? { value, label: value, custom: true }
		: undefined;
	const trimmed = query.trim();
	const filtered = withSearch && trimmed ? options.filter((o) => looseIncludes(`${o.label} ${o.value}`, trimmed)) : options;
	const typedIsNew = !!(allowCustom && trimmed) &&
		!options.some((o) => o.value === trimmed || o.label.toLowerCase() === trimmed.toLowerCase());
	const rowOptions: SelectOption[] = [
		...(currentCustom && !trimmed ? [currentCustom] : []),
		...filtered,
		...(typedIsNew ? [{ value: trimmed, label: customOptionLabel ? customOptionLabel(trimmed) : trimmed, custom: true }] : []),
	];
	const selectedIndex = rowOptions.findIndex((o) => o.value === value);
	const selected = declared ?? currentCustom;

	function openList(index = selectedIndex === -1 ? 0 : selectedIndex) {
		setQuery("");
		setActiveIndex(index);
		setOpen(true);
	}

	function commitOption(index: number) {
		const opt = rowOptions[index];
		if (!opt) return;
		setOpen(false);
		if (opt.disabled) {
			onOptionDisabledClick?.(opt.value);
			return;
		}
		onChange(opt.value);
	}

	function moveActive(step: number) {
		const last = rowOptions.length - 1;
		setActiveIndex((i) => Math.min(last, Math.max(0, (i === -1 ? 0 : i) + step)));
	}

	function handleSearchKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
		switch (e.key) {
			case "ArrowDown":
			case "ArrowUp":
				e.preventDefault();
				moveActive(e.key === "ArrowDown" ? 1 : -1);
				return;
			case "Home":
			case "End":
				if (rowOptions.length === 0) return;
				e.preventDefault();
				setActiveIndex(e.key === "Home" ? 0 : rowOptions.length - 1);
				return;
			case "Enter": {
				e.preventDefault();
				// Nothing was arrowed to: take what the user typed when it is a value
				// of its own, and only otherwise fall back to the first row. Loose
				// matching means "5.5" still lists the shipped "5", and committing
				// that instead of the typed amount silently changes the value.
				const typedRow = typedIsNew ? rowOptions.findIndex((o) => o.custom && o.value === trimmed) : -1;
				const fallback = typedRow >= 0 ? typedRow : 0;
				commitOption(activeIndex >= 0 ? activeIndex : fallback);
				buttonRef.current?.focus();
				return;
			}
			case "Tab":
				setOpen(false);
		}
	}

	function handleKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
		if (rowOptions.length === 0 && !withSearch) return;
		const last = rowOptions.length - 1;
		switch (e.key) {
			case "ArrowDown":
			case "ArrowUp": {
				e.preventDefault();
				if (!open) return openList();
				const step = e.key === "ArrowDown" ? 1 : -1;
				setActiveIndex((i) => Math.min(last, Math.max(0, (i === -1 ? 0 : i) + step)));
				return;
			}
			case "Home":
				if (!open) return;
				e.preventDefault();
				setActiveIndex(0);
				return;
			case "End":
				if (!open) return;
				e.preventDefault();
				setActiveIndex(last);
				return;
			case "Enter":
			case " ":
				e.preventDefault();
				if (!open) return openList();
				commitOption(activeIndex);
				return;
			default: {
				// With a filter field the panel's input owns typing.
				if (withSearch || e.key.length !== 1 || e.altKey || e.ctrlKey || e.metaKey) return;
				const match = rowOptions.findIndex((o) => o.label.toLowerCase().startsWith(e.key.toLowerCase()));
				if (match === -1) return;
				e.preventDefault();
				if (open) setActiveIndex(match);
				else openList(match);
			}
		}
	}

	useEffect(() => {
		function handleClick(e: MouseEvent) {
			const target = e.target as Node;
			if (
				buttonRef.current && !buttonRef.current.contains(target) &&
				(!dropdownRef.current || !dropdownRef.current.contains(target))
			) {
				setOpen(false);
			}
		}
		if (open) document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [open]);

	return (
		<div className="relative w-full">
			<button
				id={id}
				ref={buttonRef}
				type="button"
				// With a filter field the panel's input is the combobox; the trigger
				// is then only the thing that opens it.
				role={withSearch ? undefined : "combobox"}
				aria-label={ariaLabel}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={listboxId}
				aria-activedescendant={!withSearch && open && activeIndex >= 0 ? optionIdFor(activeIndex) : undefined}
				onClick={() => (open ? setOpen(false) : openList())}
				onKeyDown={handleKeyDown}
				className={`w-full flex items-center justify-between gap-2 bg-elevated text-fg text-sm rounded-lg px-3 py-1.5 border transition-colors outline-none text-left ${
					open ? "border-accent" : "border-edge hover:border-edge-active"
				}`}
			>
				<span className={`truncate ${selected ? "" : "text-fg-muted"}`}>
					{selected
						? (renderOption && !selected.custom ? renderOption(selected) : selected.label)
						: (placeholder ?? "")}
				</span>
				<svg
					className={`w-3.5 h-3.5 text-fg-3 flex-shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
					viewBox="0 0 12 12"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.8"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<polyline points="2,4 6,8 10,4" />
				</svg>
			</button>

			{open && buttonRef.current && (
				<SelectListbox
					anchor={buttonRef.current}
					panelRef={dropdownRef}
					triggerRef={buttonRef}
					listboxId={listboxId}
					optionIdFor={optionIdFor}
					options={rowOptions}
					value={value}
					activeIndex={activeIndex}
					grow={growList}
					renderOption={renderOption}
					onHover={setActiveIndex}
					onPick={commitOption}
					onDismiss={closeList}
					search={withSearch ? {
						query,
						placeholder: searchPlaceholder ?? "Filter…",
						label: searchLabel,
						inputMode,
						emptyLabel,
						// A creatable field highlights nothing while typing: pre-highlighting
						// the first match makes Enter take a shipped option over the value
						// the user is in the middle of writing.
						onQueryChange: (q) => { setQuery(q); setActiveIndex(allowCustom ? -1 : 0); },
						onKeyDown: handleSearchKeyDown,
					} : undefined}
				/>
			)}
		</div>
	);
}

export default Select;

/** Shared renderOption callback that shows a red "Not Installed" badge for unavailable agents. */
export function useAgentRenderOption(availability: AgentCheckResult[], notInstalledLabel: string): (opt: SelectOption) => ReactNode {
	return useCallback((opt: SelectOption) => {
		const avail = availability.find((a) => a.agentId === opt.value);
		const notInstalled = avail && !avail.installed;
		return (
			<span className="flex items-center gap-2">
				{opt.label}
				{notInstalled && (
					<span className="text-danger text-micro font-medium opacity-80">
						{notInstalledLabel}
					</span>
				)}
			</span>
		);
	}, [availability, notInstalledLabel]);
}
