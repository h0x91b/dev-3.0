import { spacesOfProject, type Space } from "../../shared/types";

/**
 * Search haystack for a project row: the display name first (so highlight
 * indices stay aligned with the rendered label), then its space names —
 * typing a space name surfaces every member project.
 */
export function projectSearchHaystack(name: string, spaces: readonly Space[], projectId: string): string {
	const spaceNames = spacesOfProject(spaces, projectId)
		.map((s) => s.name)
		.join(" ");
	return spaceNames ? `${name} ${spaceNames}` : name;
}
