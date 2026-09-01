import { spacesOfProject, type Space } from "../../shared/types";

/**
 * Project ids visible in the sidebar's `space` scope: the union of members
 * across every space the project belongs to (itself included). Null when the
 * project is in no space — the scope button renders disabled.
 */
export function spaceSiblingProjectIds(spaces: Space[], projectId: string): Set<string> | null {
	const memberships = spacesOfProject(spaces, projectId);
	if (memberships.length === 0) return null;
	return new Set(memberships.flatMap((s) => s.projectIds));
}

/**
 * Project ids the sidebar's `space` scope holds, honouring the space the user
 * actually came through (`routeSpaceId`). A project in two spaces would
 * otherwise pool both, which is not the board the user is looking at.
 *
 * A space id that no longer resolves — deleted, or the project has left it —
 * falls back to the union rather than narrowing the pool to nothing.
 */
export function spaceScopeProjectIds(
	spaces: Space[],
	projectId: string,
	spaceId: string | null,
): Set<string> | null {
	if (spaceId) {
		const space = spaces.find((s) => s.id === spaceId && !s.deleted);
		if (space?.projectIds.includes(projectId)) return new Set(space.projectIds);
	}
	return spaceSiblingProjectIds(spaces, projectId);
}
