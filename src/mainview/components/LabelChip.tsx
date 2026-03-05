import type { Label } from "../../shared/types";

interface LabelChipProps {
	label: Label;
	size?: "sm" | "xs";
	active?: boolean;
	onClick?: (e: React.MouseEvent) => void;
	onRemove?: (e: React.MouseEvent) => void;
}

function LabelChip({ label, size = "xs", active = false, onClick, onRemove }: LabelChipProps) {
	const isSmall = size === "xs";

	return (
		<span
			className={`group/chip inline-flex items-center rounded-full transition-all ${
				isSmall ? "text-[0.625rem]" : "text-xs"
			}`}
			style={
				active
					? { background: label.color, color: "#fff" }
					: {
						background: `${label.color}22`,
						color: label.color,
						border: `1px solid ${label.color}55`,
					}
			}
		>
			{/* Main chip area (clickable) */}
			<button
				type="button"
				onClick={onClick}
				className={`inline-flex items-center gap-1 rounded-full transition-all ${
					isSmall ? "pl-1.5 py-0.5" : "pl-2 py-0.5"
				} ${onRemove ? (isSmall ? "pr-0.5" : "pr-1") : (isSmall ? "pr-1.5" : "pr-2")} ${
					onClick ? "cursor-pointer" : "cursor-default"
				}`}
				title={label.name}
			>
				<span
					className="rounded-full flex-shrink-0"
					style={{
						width: isSmall ? 5 : 6,
						height: isSmall ? 5 : 6,
						background: active ? "rgba(255,255,255,0.8)" : label.color,
					}}
				/>
				<span className="font-medium leading-none truncate max-w-[5rem]">{label.name}</span>
			</button>

			{/* Remove button — only rendered when onRemove is provided */}
			{onRemove && (
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onRemove(e);
					}}
					className={`opacity-0 group-hover/chip:opacity-100 flex items-center justify-center rounded-full transition-all flex-shrink-0 ${
						isSmall ? "w-3.5 h-3.5 mr-0.5" : "w-4 h-4 mr-1"
					}`}
					style={{
						background: active ? "rgba(255,255,255,0.25)" : `${label.color}30`,
						color: active ? "#fff" : label.color,
					}}
					onMouseEnter={(e) => {
						(e.currentTarget as HTMLButtonElement).style.background = active
							? "rgba(255,255,255,0.45)"
							: `${label.color}60`;
					}}
					onMouseLeave={(e) => {
						(e.currentTarget as HTMLButtonElement).style.background = active
							? "rgba(255,255,255,0.25)"
							: `${label.color}30`;
					}}
					title={`Remove ${label.name}`}
				>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth={3}
						style={{ width: isSmall ? 7 : 8, height: isSmall ? 7 : 8 }}
					>
						<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			)}
		</span>
	);
}

export default LabelChip;
