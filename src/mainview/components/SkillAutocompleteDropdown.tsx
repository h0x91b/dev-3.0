import type { AgentSkillInfo } from "../../shared/types";

interface SkillAutocompleteDropdownProps {
	items: AgentSkillInfo[];
	activeIndex: number;
	onHover: (index: number) => void;
	onSelect: (skill: AgentSkillInfo) => void;
}

/** Suggestion list for the "/" skill autocomplete, anchored under a textarea. */
function SkillAutocompleteDropdown({ items, activeIndex, onHover, onSelect }: SkillAutocompleteDropdownProps) {
	return (
		<div
			role="listbox"
			aria-label="Skill suggestions"
			data-skill-autocomplete="true"
			className="absolute top-full left-0 right-0 mt-1 z-20 max-h-56 overflow-y-auto bg-overlay border border-edge rounded-xl shadow-2xl py-1"
		>
			{items.map((skill, index) => (
				<button
					key={`${skill.source}:${skill.name}`}
					type="button"
					role="option"
					aria-selected={index === activeIndex}
					onMouseEnter={() => onHover(index)}
					onMouseDown={(e) => {
						// preventDefault keeps focus in the textarea while selecting.
						e.preventDefault();
						onSelect(skill);
					}}
					className={`w-full flex items-baseline gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
						index === activeIndex ? "bg-accent/15 text-fg" : "text-fg-2 hover:bg-elevated-hover"
					}`}
				>
					<span className="font-medium text-fg shrink-0">/{skill.name}</span>
					{skill.description && (
						<span className="text-fg-muted text-xs truncate">{skill.description}</span>
					)}
				</button>
			))}
		</div>
	);
}

export default SkillAutocompleteDropdown;
