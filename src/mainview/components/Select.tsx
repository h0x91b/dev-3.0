import { useState, useRef, useEffect, useLayoutEffect, useCallback, useId, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
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
	renderOption?: (option: SelectOption) => ReactNode;
	onHover: (index: number) => void;
	onPick: (index: number) => void;
	onDismiss: () => void;
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
	renderOption,
	onHover,
	onPick,
	onDismiss,
}: ListboxProps) {
	const reducedMotion = useReducedMotion();
	const [pos, setPos] = useState(() => {
		const rect = anchor.getBoundingClientRect();
		return { top: rect.bottom + 4, left: rect.left, width: rect.width };
	});
	const [measured, setMeasured] = useState(false);
	const [entered, setEntered] = useState(false);

	// Focus stays on the trigger (roving `aria-activedescendant`), so no autoFocus.
	useOverlayLayer(panelRef, { onDismiss, triggerRef });

	useLayoutEffect(() => {
		const panel = panelRef.current;
		if (!panel) return;
		const a = anchor.getBoundingClientRect();
		const height = panel.getBoundingClientRect().height;
		const pad = 8;
		let top = a.bottom + 4;
		if (top + height > window.innerHeight - pad) {
			const above = a.top - height - 4;
			top = above >= pad ? above : Math.max(pad, window.innerHeight - pad - height);
		}
		let left = a.left;
		if (left + a.width > window.innerWidth - pad) left = window.innerWidth - a.width - pad;
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
		if (!trigger) return;
		function onFocusOut(e: FocusEvent) {
			const next = e.relatedTarget as Node | null;
			if (!next || panelRef.current?.contains(next)) return;
			onDismiss();
		}
		trigger.addEventListener("focusout", onFocusOut);
		return () => trigger.removeEventListener("focusout", onFocusOut);
	}, [triggerRef, panelRef, onDismiss]);

	useEffect(() => {
		if (activeIndex < 0) return;
		const row = panelRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
		row?.scrollIntoView?.({ block: "nearest" });
	}, [activeIndex, panelRef]);

	return createPortal(
		<div
			ref={panelRef}
			id={listboxId}
			role="listbox"
			style={{
				position: "fixed",
				top: pos.top,
				left: pos.left,
				width: pos.width,
				zIndex: 9999,
			}}
			className={`bg-overlay border border-edge-active rounded-lg shadow-xl shadow-black/50 overflow-y-auto max-h-72 origin-top ${
				reducedMotion ? "" : "transition-[opacity,transform] duration-150"
			} ${entered ? "opacity-100 scale-100" : "opacity-0 scale-[0.98]"}`}
		>
			{options.map((opt, index) => {
				const isSelected = opt.value === value;
				const isActive = index === activeIndex;
				return (
					<button
						key={opt.value}
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
						<span className="flex-1 min-w-0 truncate">
							{renderOption ? (
								renderOption(opt)
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
				);
			})}
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
	onOptionDisabledClick,
}: {
	id?: string;
	value: string;
	options: SelectOption[];
	onChange: (value: string) => void;
	renderOption?: (option: SelectOption) => ReactNode;
	/** Called when a `disabled` option is clicked (instead of `onChange`). */
	onOptionDisabledClick?: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(-1);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const dropdownRef = useRef<HTMLDivElement>(null);
	const reactId = useId();
	const listboxId = `${reactId}-listbox`;
	const optionIdFor = useCallback((index: number) => `${reactId}-option-${index}`, [reactId]);
	const closeList = useCallback(() => setOpen(false), []);
	const selectedIndex = options.findIndex((o) => o.value === value);
	const selected = selectedIndex === -1 ? undefined : options[selectedIndex];

	function openList(index = selectedIndex === -1 ? 0 : selectedIndex) {
		setActiveIndex(index);
		setOpen(true);
	}

	function commitOption(index: number) {
		const opt = options[index];
		if (!opt) return;
		setOpen(false);
		if (opt.disabled) {
			onOptionDisabledClick?.(opt.value);
			return;
		}
		onChange(opt.value);
	}

	function handleKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
		if (options.length === 0) return;
		const last = options.length - 1;
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
				if (e.key.length !== 1 || e.altKey || e.ctrlKey || e.metaKey) return;
				const match = options.findIndex((o) => o.label.toLowerCase().startsWith(e.key.toLowerCase()));
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
				role="combobox"
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={listboxId}
				aria-activedescendant={open && activeIndex >= 0 ? optionIdFor(activeIndex) : undefined}
				onClick={() => (open ? setOpen(false) : openList())}
				onKeyDown={handleKeyDown}
				className={`w-full flex items-center justify-between gap-2 bg-elevated text-fg text-sm rounded-lg px-3 py-1.5 border transition-colors outline-none text-left ${
					open ? "border-accent" : "border-edge hover:border-edge-active"
				}`}
			>
				<span className="truncate">{selected ? (renderOption ? renderOption(selected) : selected.label) : ""}</span>
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
					options={options}
					value={value}
					activeIndex={activeIndex}
					renderOption={renderOption}
					onHover={setActiveIndex}
					onPick={commitOption}
					onDismiss={closeList}
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
