import { readFileSync } from "node:fs";
import { resolveDev3Home } from "../shared/dev3-home";
import type { SpacesFile } from "../shared/types";
import { spacesOfProject } from "../shared/types";
import type { ProjectDirect } from "./context";

// Additive sibling file next to projects.json — absent until the user makes a
// space, and an unreadable file contributes nothing rather than throwing.
const DEV3_HOME = resolveDev3Home();
const SPACES_FILE = `${DEV3_HOME}/spaces.json`;

function readProjectsForSiblings(): ProjectDirect[] {
	const out: ProjectDirect[] = [];
	for (const file of [`${DEV3_HOME}/projects.json`, `${DEV3_HOME}/virtual-projects.json`]) {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf-8")) as ProjectDirect[];
			for (const p of parsed) if (!p.deleted) out.push(p);
		} catch { /* absent file contributes nothing */ }
	}
	return out;
}

export function readSpacesRaw(): SpacesFile {
	try {
		const parsed = JSON.parse(readFileSync(SPACES_FILE, "utf-8")) as SpacesFile;
		if (parsed.version === 1 && Array.isArray(parsed.spaces) && Array.isArray(parsed.order)) {
			return parsed;
		}
	} catch { /* missing or unreadable → empty */ }
	return { version: 1, spaces: [], order: [] };
}

/**
 * `dev3 current` fields for the project's space memberships: the space names,
 * then the read-only sibling repositories.
 *
 * A sibling carries its PROJECT ID, so an agent can address it with
 * `--project <id>` instead of asking the user to paste one. With more than one
 * space the siblings are GROUPED per space — a flat union cannot say which
 * repository belongs to which grouping, which is the whole point of a space.
 * One space keeps the flat single line (the common case stays as quiet as it was)
 * and zero spaces still print nothing at all.
 */
export function spaceFields(projectId: string): Array<[string, string]> {
	const memberships = spacesOfProject(readSpacesRaw().spaces, projectId);
	if (memberships.length === 0) return [];

	const byId = new Map(readProjectsForSiblings().map((p) => [p.id, p]));
	// Dangling ids (a project deleted, or one this machine never had) are skipped.
	const siblingsOf = (space: { projectIds: string[] }) =>
		space.projectIds
			.filter((id) => id !== projectId)
			.map((id) => byId.get(id))
			.filter((p): p is ProjectDirect => p !== undefined)
			.map((p) => `${p.path} (${p.name}, ${p.id})`);

	const fields: Array<[string, string]> = [["Spaces:", memberships.map((s) => s.name).join(", ")]];

	if (memberships.length === 1) {
		const siblings = siblingsOf(memberships[0]);
		if (siblings.length > 0) fields.push(["Siblings:", `${siblings.join(", ")} [read-only]`]);
		return fields;
	}

	const grouped = memberships
		.map((space) => [space.name, siblingsOf(space)] as const)
		.filter(([, siblings]) => siblings.length > 0);
	if (grouped.length === 0) return fields;

	fields.push(["Siblings:", "[read-only]"]);
	for (const [name, siblings] of grouped) fields.push([`  ${name}:`, siblings.join(", ")]);
	return fields;
}
