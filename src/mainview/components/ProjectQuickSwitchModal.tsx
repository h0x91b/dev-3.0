import type { Project } from "../../shared/types";
import { isBuiltinOpsProject, projectDisplayName } from "../../shared/types";
import { useT } from "../i18n";
import { useProjectPrivacy } from "../sensitive-projects";
import { useSpaces } from "../useSpaces";
import { projectSearchHaystack } from "../utils/projectSearchHaystack";
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
	const privacy = useProjectPrivacy();
	const { spaces } = useSpaces();
	return (
		<PaletteShell
			items={projects}
			getKey={(p) => p.id}
			getText={(p) => projectDisplayName(p, t("ops.boardName"))}
			getSearchText={(p) =>
				isBuiltinOpsProject(p) ? projectDisplayName(p, t("ops.boardName")) : projectSearchHaystack(p.name, spaces, p.id)
			}
			getTextClassName={(p) => privacy.maskClass(p)}
			onSelect={(p) => onSelect(p.id)}
			onClose={onClose}
			placeholder={t("projectSwitch.placeholder")}
			ariaLabel={t("projectSwitch.title")}
			hint={t("projectSwitch.hint")}
			noResults={t("projectSwitch.noResults")}
			testId="project-quick-switch"
			renderItemRight={(p, _i, query) => {
				// A locked project stays listed so the palette does not lie about what
				// exists; selecting it is refused by the navigation guard.
				if (privacy.isLocked(p)) {
					return (
						<span aria-label={t("streamer.projectLocked")} className="text-fg-muted text-xs flex-shrink-0" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
							{"\u{F033E}"}
						</span>
					);
				}
				if (query.length === 0 && isBuiltinOpsProject(p)) {
					return <span className="text-fg-3 text-xs flex-shrink-0">⌘0</span>;
				}
				const idx = shortcutIndexById?.[p.id];
				return idx !== undefined && idx < 9 && query.length === 0 ? (
					<span className="text-fg-3 text-xs flex-shrink-0">⌘{idx + 1}</span>
				) : null;
			}}
		/>
	);
}

export default ProjectQuickSwitchModal;
