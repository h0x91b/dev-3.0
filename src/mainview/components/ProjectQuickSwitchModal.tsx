import type { Project } from "../../shared/types";
import { useT } from "../i18n";
import { PaletteShell } from "./PaletteShell";

interface ProjectQuickSwitchModalProps {
	/** Non-deleted projects, in board order. */
	projects: Project[];
	onSelect: (projectId: string) => void;
	onClose: () => void;
}

/**
 * Cmd/Ctrl+K project quick-switch palette (navigation). Type to fuzzy-filter
 * projects by name; Enter jumps to the highlighted match (the top one by
 * default). The Cmd+1..9 badge mirrors the index shortcuts when the query is
 * empty (results are in board order, so position N === Cmd+N).
 */
function ProjectQuickSwitchModal({ projects, onSelect, onClose }: ProjectQuickSwitchModalProps) {
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
			renderItemRight={(_p, i, query) =>
				i < 9 && query.length === 0 ? <span className="text-fg-3 text-xs flex-shrink-0">⌘{i + 1}</span> : null
			}
		/>
	);
}

export default ProjectQuickSwitchModal;
