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
 * `dev3 current` fields for the project's space memberships: the space names
 * plus read-only sibling paths (union across its spaces, deduplicated, the
 * project itself excluded, dangling ids skipped). Empty when the project is in
 * no space, so zero-spaces output stays byte-identical.
 */
export function spaceFields(projectId: string): Array<[string, string]> {
	const memberships = spacesOfProject(readSpacesRaw().spaces, projectId);
	if (memberships.length === 0) return [];

	const byId = new Map(readProjectsForSiblings().map((p) => [p.id, p]));
	const siblingIds = [...new Set(memberships.flatMap((s) => s.projectIds))].filter((id) => id !== projectId);
	const siblings = siblingIds
		.map((id) => byId.get(id))
		.filter((p): p is ProjectDirect => p !== undefined)
		.map((p) => `${p.path} (${p.name})`);

	const fields: Array<[string, string]> = [["Spaces:", memberships.map((s) => s.name).join(", ")]];
	if (siblings.length > 0) {
		fields.push(["Siblings:", `${siblings.join(", ")} [read-only]`]);
	}
	return fields;
}
