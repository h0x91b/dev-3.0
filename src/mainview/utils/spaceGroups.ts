import { isBuiltinOpsProject, orderSpaces, type Project, type Space, type SpacesFile } from "../../shared/types";
import { projectSearchHaystack } from "./projectSearchHaystack";

/**
 * Selection id for the computed `Home` group. `Home` is a UI grouping of the
 * projects that belong to no space — never stored, never renameable, and never
 * offered in a membership multi-select.
 */
export const HOME_GROUP_ID = "home";

export interface DashboardGroup {
	/** null = the computed `Home` group (projects in no space). */
	space: Space | null;
	projects: Project[];
}

/**
 * Group dashboard projects under their spaces. Returns null when no active
 * space exists so the caller renders its legacy flat path untouched — the
 * zero-spaces dashboard must stay byte-identical to today's.
 *
 * The builtin Operations board never joins a group: the caller keeps it in
 * its flat pinned position and passes only ordinary projects here.
 */
export function groupProjectsForDashboard(
	visibleProjects: Project[],
	file: SpacesFile,
): DashboardGroup[] | null {
	const spaces = orderSpaces(file.spaces, file.order);
	if (spaces.length === 0) return null;

	const eligible = visibleProjects.filter((p) => !isBuiltinOpsProject(p));
	const byId = new Map(eligible.map((p) => [p.id, p]));

	const grouped = new Set<string>();
	const groups: DashboardGroup[] = [];
	for (const space of spaces) {
		// Dangling ids (deleted projects, other machines) are skipped silently.
		const members = space.projectIds
			.map((id) => byId.get(id))
			.filter((p): p is Project => p !== undefined);
		if (members.length === 0) continue;
		for (const p of members) grouped.add(p.id);
		groups.push({ space, projects: members });
	}
	if (groups.length === 0) return null;

	const rest = eligible.filter((p) => !grouped.has(p.id));
	groups.push({ space: null, projects: rest });
	return groups;
}

/**
 * Group the header project switcher the same way the dashboard groups, with one
 * difference: every space the CURRENT project belongs to is hoisted to the top,
 * so its neighbours are the first rows under the cursor. Returns null when no
 * space holds a visible project — the caller keeps its flat list.
 *
 * The builtin Operations board is excluded here; the caller keeps it pinned.
 */
export function groupProjectsForSwitcher(
	visibleProjects: Project[],
	file: SpacesFile,
	currentProjectId: string | null,
): DashboardGroup[] | null {
	const groups = groupProjectsForDashboard(visibleProjects, file);
	if (groups === null) return null;
	if (!currentProjectId) return groups;

	const current: DashboardGroup[] = [];
	const rest: DashboardGroup[] = [];
	for (const group of groups) {
		// The Home group is never hoisted: "no space" is not the current space,
		// even when the current project happens to sit there.
		const isCurrentSpace = group.space !== null && group.space.projectIds.includes(currentProjectId);
		(isCurrentSpace ? current : rest).push(group);
	}
	return [...current, ...rest];
}

interface GroupFilter {
	/** null = all, `HOME_GROUP_ID` = the computed Home group, else a space id. */
	selectedSpaceId: string | null;
	/** Free-text query matched against project names AND their space names. */
	query: string;
	spaces: Space[];
}

/**
 * Apply the rail selection and the dashboard search to computed groups. Returns
 * null unchanged (zero spaces → the caller's legacy flat path), and drops groups
 * that end up empty so the screen never shows a header with nothing under it.
 */
export function filterDashboardGroups(
	groups: DashboardGroup[] | null,
	{ selectedSpaceId, query, spaces }: GroupFilter,
): DashboardGroup[] | null {
	if (groups === null) return null;
	const q = query.trim().toLowerCase();

	const selected = groups.filter((g) => {
		if (selectedSpaceId === null) return true;
		if (selectedSpaceId === HOME_GROUP_ID) return g.space === null;
		return g.space?.id === selectedSpaceId;
	});

	if (!q) return selected.filter((g) => g.projects.length > 0);

	// A space name match keeps that whole group; otherwise rows filter by name.
	const matched: DashboardGroup[] = [];
	for (const group of selected) {
		const spaceMatches = group.space ? group.space.name.toLowerCase().includes(q) : false;
		const projects = spaceMatches
			? group.projects
			: group.projects.filter((p) =>
					projectSearchHaystack(p.name, spaces, p.id).toLowerCase().includes(q),
				);
		if (projects.length > 0) matched.push({ space: group.space, projects });
	}
	return matched;
}
