import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AgentCheckResult } from "../../shared/types";

export interface SelectOption {
	value: string;
	label: string;
	/** When true the option is shown but not selectable; clicking it runs
	 *  `onOptionDisabledClick` instead of selecting (used for gated presets). */
	disabled?: boolean;
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
	const [dropdownStyle, setDropdownStyle] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });
	const buttonRef = useRef<HTMLButtonElement>(null);
	const dropdownRef = useRef<HTMLDivElement>(null);
	const selected = options.find((o) => o.value === value);

	function handleOpen() {
		if (buttonRef.current) {
			const rect = buttonRef.current.getBoundingClientRect();
			setDropdownStyle({
				top: rect.bottom + 4,
				left: rect.left,
				width: rect.width,
			});
		}
		setOpen((v) => !v);
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
				onClick={handleOpen}
				onBlur={(e) => {
					// Close when focus leaves the trigger (e.g. Tab to another Select)
					// so two dropdowns can't be open at once — the document mousedown
					// handler only covers mouse, not keyboard navigation. Ignore focus
					// moving into our own portaled dropdown. Clicking an option does not
					// blur the trigger (options preventDefault on mousedown), so mouse
					// selection is unaffected.
					if (dropdownRef.current?.contains(e.relatedTarget as Node | null)) return;
					setOpen(false);
				}}
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

			{open && createPortal(
				<div
					ref={dropdownRef}
					style={{ position: "fixed", top: dropdownStyle.top, left: dropdownStyle.left, width: dropdownStyle.width, zIndex: 9999 }}
					className="bg-overlay border border-edge-active rounded-lg shadow-xl shadow-black/50 overflow-y-auto max-h-72"
				>
					{options.map((opt) => (
						<button
							key={opt.value}
							type="button"
							aria-disabled={opt.disabled || undefined}
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => {
								setOpen(false);
								if (opt.disabled) {
									onOptionDisabledClick?.(opt.value);
									return;
								}
								onChange(opt.value);
							}}
							className={`w-full text-left px-3 py-2 text-sm transition-colors ${
								opt.disabled
									? "text-fg-muted hover:bg-raised-hover"
									: opt.value === value
										? "bg-accent/15 text-fg font-medium"
										: "text-fg-2 hover:bg-raised-hover hover:text-fg"
							}`}
						>
							{renderOption ? (
								renderOption(opt)
							) : opt.disabled ? (
								<span className="flex items-center gap-1.5 opacity-70">
									{opt.label}
									<span
										aria-hidden
										className="text-[0.8em] leading-none"
										style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
									>
										{"\uf023"}
									</span>
								</span>
							) : (
								opt.label
							)}
						</button>
					))}
				</div>,
				document.body,
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
					<span className="text-danger text-[0.65rem] font-medium opacity-80">
						{notInstalledLabel}
					</span>
				)}
			</span>
		);
	}, [availability, notInstalledLabel]);
}
