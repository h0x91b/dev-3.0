import { useRef, type KeyboardEvent } from "react";
import type { TaskVisibility } from "../../shared/board-filter-state";
import { useT } from "../i18n";

const VISIBILITIES: readonly TaskVisibility[] = ["active", "all"];

// Wide: 26px tall like the search input; narrow: 34px like its py-1.5 text-sm search input.
const WIDE_SIZE = "px-2 py-0.5 text-xs leading-4";
const NARROW_SIZE = "px-2.5 py-1 text-sm leading-5";
const SEGMENT =
	"rounded-md font-medium whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent active:scale-[0.96] transition-[color,background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none motion-reduce:active:scale-100";

interface BoardVisibilitySwitchProps {
	visibility: TaskVisibility;
	onChange: (visibility: TaskVisibility) => void;
	narrow?: boolean;
}

/** One-click Active | All switch for the board; Active hides completed and cancelled tasks. */
function BoardVisibilitySwitch({ visibility, onChange, narrow = false }: BoardVisibilitySwitchProps) {
	const t = useT();
	const refs = useRef<Record<TaskVisibility, HTMLButtonElement | null>>({ active: null, all: null });

	const select = (next: TaskVisibility) => {
		if (next !== visibility) onChange(next);
		refs.current[next]?.focus();
	};

	const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
		const index = VISIBILITIES.indexOf(visibility);
		const count = VISIBILITIES.length;
		let next: TaskVisibility | undefined;
		if (e.key === "ArrowRight" || e.key === "ArrowDown") next = VISIBILITIES[(index + 1) % count];
		else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = VISIBILITIES[(index - 1 + count) % count];
		else if (e.key === "Home") next = VISIBILITIES[0];
		else if (e.key === "End") next = VISIBILITIES[count - 1];
		if (!next) return;
		e.preventDefault();
		select(next);
	};

	return (
		<div
			role="radiogroup"
			aria-label={t("board.visibility.label")}
			data-testid="board-visibility-switch"
			className="inline-flex items-center flex-shrink-0 p-0.5 gap-0.5 rounded-lg bg-base border border-edge"
		>
			{VISIBILITIES.map((value) => {
				const selected = value === visibility;
				return (
					<button
						key={value}
						ref={(el) => { refs.current[value] = el; }}
						type="button"
						role="radio"
						aria-checked={selected}
						tabIndex={selected ? 0 : -1}
						title={value === "active" ? t("board.visibility.activeHint") : undefined}
						aria-description={value === "active" ? t("board.visibility.activeHint") : undefined}
						onClick={() => select(value)}
						onKeyDown={onKeyDown}
						className={`${narrow ? NARROW_SIZE : WIDE_SIZE} ${SEGMENT} ${selected ? "bg-elevated text-fg" : "text-fg-3 hover:text-fg-2 hover:bg-raised-hover"}`}
					>
						{t(value === "active" ? "board.visibility.active" : "board.visibility.all")}
					</button>
				);
			})}
		</div>
	);
}

export default BoardVisibilitySwitch;
