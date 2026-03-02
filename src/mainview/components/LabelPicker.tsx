import { useRef, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Label } from "../../shared/types";
import { useT } from "../i18n";

interface LabelPickerProps {
	labels: Label[];
	selectedIds: string[];
	onToggle: (labelId: string) => void;
	onClose: () => void;
	anchorRect: DOMRect;
}

function LabelPicker({ labels, selectedIds, onToggle, onClose, anchorRect }: LabelPickerProps) {
	const t = useT();
	const ref = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ top: 0, left: 0 });
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		function handleClick(e: MouseEvent) {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				onClose();
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [onClose]);

	useLayoutEffect(() => {
		if (!ref.current) return;
		const menu = ref.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;

		let top = anchorRect.bottom + 6;
		let left = anchorRect.left;

		if (top + menu.height > vh - pad) {
			top = anchorRect.top - menu.height - 6;
		}
		if (left + menu.width > vw - pad) {
			left = vw - menu.width - pad;
		}
		if (left < pad) left = pad;
		if (top < pad) top = pad;

		setPos({ top, left });
		setVisible(true);
	}, [anchorRect]);

	return createPortal(
		<div
			ref={ref}
			className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-1.5 min-w-[200px] max-w-[280px]"
			style={{ top: pos.top, left: pos.left, visibility: visible ? "visible" : "hidden" }}
			onClick={(e) => e.stopPropagation()}
		>
			<div className="px-3 py-2 text-xs text-fg-3 uppercase tracking-wider font-semibold">
				{t("labels.assign")}
			</div>
			{labels.length === 0 ? (
				<div className="px-3 py-2 text-sm text-fg-muted">{t("labels.noLabels")}</div>
			) : (
				labels.map((label) => {
					const selected = selectedIds.includes(label.id);
					return (
						<button
							key={label.id}
							onClick={() => onToggle(label.id)}
							className="w-full text-left px-3 py-2 text-sm text-fg-2 hover:bg-elevated-hover hover:text-fg flex items-center gap-2.5 transition-colors"
						>
							<div className="w-4 h-4 rounded border border-edge flex items-center justify-center flex-shrink-0"
								style={selected ? { backgroundColor: label.color, borderColor: label.color } : {}}
							>
								{selected && (
									<svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
										<path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
									</svg>
								)}
							</div>
							<div
								className="w-2.5 h-2.5 rounded-full flex-shrink-0"
								style={{ background: label.color }}
							/>
							<span className="truncate">{label.name}</span>
						</button>
					);
				})
			)}
		</div>,
		document.body,
	);
}

export default LabelPicker;
