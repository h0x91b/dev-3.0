import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";

export interface SelectOption {
	value: string;
	label: string;
}

function Select({
	id,
	value,
	options,
	onChange,
}: {
	id?: string;
	value: string;
	options: SelectOption[];
	onChange: (value: string) => void;
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
				className={`w-full flex items-center justify-between gap-2 bg-elevated text-fg text-sm rounded-lg px-3 py-1.5 border transition-colors outline-none text-left ${
					open ? "border-accent" : "border-edge hover:border-edge-active"
				}`}
			>
				<span className="truncate">{selected?.label ?? ""}</span>
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
					className="bg-overlay border border-edge-active rounded-lg shadow-xl shadow-black/50 overflow-hidden"
				>
					{options.map((opt) => (
						<button
							key={opt.value}
							type="button"
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => {
								onChange(opt.value);
								setOpen(false);
							}}
							className={`w-full text-left px-3 py-2 text-sm transition-colors ${
								opt.value === value
									? "bg-accent/15 text-fg font-medium"
									: "text-fg-2 hover:bg-raised-hover hover:text-fg"
							}`}
						>
							{opt.label}
						</button>
					))}
				</div>,
				document.body,
			)}
		</div>
	);
}

export default Select;
