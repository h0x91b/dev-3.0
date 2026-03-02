import type { Label } from "../../shared/types";

interface LabelBadgeProps {
	label: Label;
	onRemove?: () => void;
	onClick?: () => void;
	active?: boolean;
	size?: "sm" | "md";
}

function LabelBadge({ label, onRemove, onClick, active, size = "sm" }: LabelBadgeProps) {
	const isSm = size === "sm";
	const base = isSm ? "text-[10px] px-1.5 py-0.5" : "text-xs px-2 py-0.5";

	return (
		<span
			className={`inline-flex items-center gap-1 rounded-md font-medium select-none whitespace-nowrap transition-all ${base} ${onClick ? "cursor-pointer hover:brightness-110" : ""} ${active ? "ring-1 ring-white/40" : ""}`}
			style={{
				backgroundColor: `${label.color}25`,
				color: label.color,
			}}
			onClick={onClick}
			title={label.name}
		>
			{label.name}
			{onRemove && (
				<button
					className="ml-0.5 opacity-60 hover:opacity-100 transition-opacity leading-none"
					onClick={(e) => {
						e.stopPropagation();
						onRemove();
					}}
					title="Remove"
				>
					&times;
				</button>
			)}
		</span>
	);
}

export default LabelBadge;
