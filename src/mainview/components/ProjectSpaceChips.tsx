import { isSpaceSensitive, spacesOfProject, type Space } from "../../shared/types";
import { MASK_CLASS } from "../sensitive-projects";

interface ProjectSpaceChipsProps {
	spaces: Space[];
	projectId: string;
	/** Space whose group is rendering this row — omitted from the chips so the
	 *  row does not repeat the header it already sits under. */
	omitSpaceId?: string;
	/** Projects the user marked hide-on-camera — a space of theirs is masked too. */
	sensitiveProjectIds?: ReadonlySet<string>;
}

/** The row's space memberships. Projects in no space (Home) render nothing. */
function ProjectSpaceChips({ spaces, projectId, omitSpaceId, sensitiveProjectIds }: ProjectSpaceChipsProps) {
	const memberships = spacesOfProject(spaces, projectId).filter((s) => s.id !== omitSpaceId);
	if (memberships.length === 0) return null;
	return (
		<span className="hidden md:flex items-center gap-1 flex-shrink-0" data-testid={`row-space-chips-${projectId}`}>
			{memberships.map((space) => (
				<span
					key={space.id}
					className={`inline-flex items-center px-1.5 py-0.5 rounded bg-raised border border-edge text-fg-3 text-nano ${
						isSpaceSensitive(space, sensitiveProjectIds ?? new Set()) ? MASK_CLASS : ""
					}`}
				>
					{space.name}
				</span>
			))}
		</span>
	);
}

export default ProjectSpaceChips;
