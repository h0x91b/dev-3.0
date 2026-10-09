/**
 * A switch that sits right-aligned against a label+description block. Unlike
 * global-settings/SettingsToggle, it carries no text of its own.
 */
export default function ToggleSwitch({
	checked,
	ariaLabel,
	onToggle,
	size = "md",
}: {
	checked: boolean;
	ariaLabel: string;
	onToggle: () => void;
	size?: "sm" | "md";
}) {
	const track = size === "sm" ? "w-8 h-5" : "w-10 h-6";
	const knob = size === "sm" ? "w-4 h-4" : "w-5 h-5";
	const shift = size === "sm" ? "translate-x-3" : "translate-x-4";
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={ariaLabel}
			onClick={onToggle}
			className={`relative flex-shrink-0 rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-base ${track} ${
				checked ? "bg-accent" : "bg-edge-active"
			}`}
		>
			<span
				className={`absolute top-0.5 left-0.5 rounded-full bg-white shadow transition-transform duration-150 ease-out ${knob} ${
					checked ? shift : "translate-x-0"
				}`}
			/>
		</button>
	);
}
