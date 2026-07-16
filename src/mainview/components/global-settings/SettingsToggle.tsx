export default function SettingsToggle({
	checked,
	disabled = false,
	ariaLabel,
	onLabel,
	offLabel,
	onToggle,
}: {
	checked: boolean;
	disabled?: boolean;
	ariaLabel?: string;
	onLabel: string;
	offLabel: string;
	onToggle: () => void;
}) {
	return (
		<label className="inline-flex items-center gap-3 cursor-pointer select-none">
			<div
				role="switch"
				aria-checked={checked}
				aria-label={ariaLabel}
				tabIndex={disabled ? -1 : 0}
				className={`relative w-11 h-6 rounded-full transition-colors ${
					disabled
						? "bg-raised border border-edge opacity-50 cursor-not-allowed"
						: checked
							? "bg-accent"
							: "bg-raised border border-edge"
				}`}
				onClick={() => {
					if (!disabled) onToggle();
				}}
				onKeyDown={(event) => {
					if (!disabled && (event.key === "Enter" || event.key === " ")) {
						event.preventDefault();
						onToggle();
					}
				}}
			>
				<div
					className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
						checked ? "translate-x-5" : ""
					}`}
				/>
			</div>
			<span className="text-fg text-sm">{checked ? onLabel : offLabel}</span>
		</label>
	);
}
