import { useRef, useState } from "react";
import { DEFAULT_PRIORITY, type TaskPriority } from "../../shared/types";
import { useT } from "../i18n";
import { PRIORITY_NAME_KEYS, PRIORITY_STYLES } from "./priorityStyles";
import PriorityPicker from "./PriorityPicker";

interface PriorityBadgeProps {
	priority: TaskPriority | undefined;
	/** Called with the chosen level. Omit for a static, non-interactive badge. */
	onChange?: (priority: TaskPriority) => void;
	/** `xs` = task card, `sm` = modals, `touch` = narrow bars next to the status control. */
	size?: "xs" | "sm" | "touch";
	className?: string;
}

/**
 * Compact monospace `P{n}` importance badge. When `onChange` is given it is a
 * focusable button that opens the {@link PriorityPicker}; otherwise it renders a
 * static chip. Colors come from semantic tokens ({@link PRIORITY_STYLES}) — never
 * hardcoded — so both themes work. Always visible (no hover-only affordance).
 */
function PriorityBadge({ priority, onChange, size = "xs", className = "" }: PriorityBadgeProps) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const btnRef = useRef<HTMLButtonElement>(null);
	const level = priority ?? DEFAULT_PRIORITY;
	const style = PRIORITY_STYLES[level];
	// `touch` mirrors the narrow status control so the two sit as one band on a
	// phone instead of a tall pill next to a tiny chip. The +2px is the status
	// control's own wrapper border, which sits outside its min-h-[2.75rem] button.
	const sizeCls =
		size === "touch"
			? "text-sm px-2.5 min-h-[calc(2.75rem+2px)] rounded-lg"
			: size === "sm"
				? "text-xs px-1.5 py-0.5 rounded-md"
				: "text-dense px-1 py-0.5 rounded";
	const baseCls = `${size === "touch" ? "" : "touch-inline "}inline-flex items-center justify-center font-mono font-semibold leading-none`;
	const aria = t("priority.badgeAria", { level, name: t(PRIORITY_NAME_KEYS[level]) });

	if (!onChange) {
		return (
			<span className={`${baseCls} ${sizeCls} ${style.badge} ${className}`}>
				{level}
			</span>
		);
	}

	return (
		<>
			<button
				ref={btnRef}
				type="button"
				aria-label={aria}
				aria-haspopup="menu"
				aria-expanded={open}
				title={aria}
				onClick={(e) => {
					e.stopPropagation();
					setOpen((v) => !v);
				}}
				className={`${baseCls} transition-colors hover:brightness-110 focus-visible:ring-1 focus-visible:ring-accent/60 ${sizeCls} ${style.badge} ${className}`}
			>
				{level}
			</button>
			{open && btnRef.current && (
				<PriorityPicker
					selected={priority}
					anchorEl={btnRef.current}
					onClose={() => setOpen(false)}
					onSelect={(p) => {
						setOpen(false);
						if (p !== level) onChange(p);
					}}
				/>
			)}
		</>
	);
}

export default PriorityBadge;
