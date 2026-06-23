import type { Project } from "../../shared/types";
import { useT } from "../i18n";
import { PaletteShell } from "./PaletteShell";

interface ProjectQuickSwitchModalProps {
	/**
	 * Non-deleted projects in display order — most-recently jumped-to first,
	 * then the rest in board order (see `orderByRecency`).
	 */
	projects: Project[];
	/**
	 * Project id → its 0-based BOARD index, for the ⌘N badge. Kept separate from
	 * display order so the badge keeps matching the Cmd+1..9 shortcut (which is
	 * board-order based) even after recency reorders the rows.
	 */
	shortcutIndexById?: Record<string, number>;
	onSelect: (projectId: string) => void;
	onClose: () => void;
}

/**
 * Cmd/Ctrl+K project quick-switch palette (navigation). Type to fuzzy-filter
 * projects by name; Enter jumps to the highlighted match (the top one by
 * default). With an empty query, rows are ordered most-recently-jumped first
 * (then board order). The ⌘N badge mirrors the Cmd+1..9 index shortcuts, which
 * stay board-order based regardless of the recency ordering.
 */
function ProjectQuickSwitchModal({ projects, shortcutIndexById, onSelect, onClose }: ProjectQuickSwitchModalProps) {
	const t = useT();
	return (
		<PaletteShell
			items={projects}
			getKey={(p) => p.id}
			getText={(p) => p.name}
			onSelect={(p) => onSelect(p.id)}
			onClose={onClose}
			placeholder={t("projectSwitch.placeholder")}
			ariaLabel={t("projectSwitch.title")}
			hint={t("projectSwitch.hint")}
			noResults={t("projectSwitch.noResults")}
			testId="project-quick-switch"
			renderItemRight={(p, _i, query) => {
				const idx = shortcutIndexById?.[p.id];
				return idx !== undefined && idx < 9 && query.length === 0 ? (
					<span className="text-fg-3 text-xs flex-shrink-0">⌘{idx + 1}</span>
				) : null;
			}}
		/>
	);
}

export default ProjectQuickSwitchModal;
