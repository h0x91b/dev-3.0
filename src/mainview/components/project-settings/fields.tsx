import { type ReactNode } from "react";

/** Label + description + control, in the shape GlobalSettings uses. */
export function Field({ title, description, children }: { title: string; description: string; children: ReactNode }) {
	return (
		<div>
			<span className="block text-fg text-sm font-semibold mb-2">{title}</span>
			<p className="text-fg-3 text-sm mb-3">{description}</p>
			{children}
		</div>
	);
}

/** Quiet placeholder shown where a list has nothing in it yet. */
export function EmptyHint({ children }: { children: ReactNode }) {
	return (
		<p className="px-3 py-4 text-center text-fg-muted text-sm border border-dashed border-edge rounded-xl">
			{children}
		</p>
	);
}

/** "+ Add …" action that closes a settings list. */
export function AddRowButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="mt-3 px-2.5 py-1.5 -ml-2.5 rounded-lg text-sm text-accent font-medium outline-none hover:bg-accent/10 focus-visible:ring-2 focus-visible:ring-accent/50 transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96] disabled:opacity-50"
		>
			{children}
		</button>
	);
}

/** Amber caution note for a setting whose consequences are easy to miss. */
export function WarningNote({ children }: { children: ReactNode }) {
	return (
		<div className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5">
			<span className="mt-0.5 flex-shrink-0 text-warning-strong text-base">&#9888;</span>
			<p className="text-fg-2 text-xs leading-relaxed">{children}</p>
		</div>
	);
}

/**
 * The screen's only switch. Kept local (rather than reusing
 * global-settings/SettingsToggle) because these switches sit right-aligned
 * against a label+description block instead of carrying their own text.
 */
export function ToggleSwitch({
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
