// ---- Spaces (many-to-many project grouping; stored in ~/.dev3.0/spaces.json) ----

/**
 * A Space is a named group of projects — a global tag, not a container. It
 * references projects by id and owns nothing; every project keeps its own
 * board. See decisions/2026/08/14/spaces-group-projects-without-replacing-boards.md.
 */
export interface Space {
	id: string;
	name: string;
	/** Reserved for nesting; always null in v1 so the format never changes later. */
	parentId: string | null;
	/** Membership AND this space's own project order. Dangling ids are normal. */
	projectIds: string[];
	createdAt: number;
	deleted?: boolean;
	/**
	 * Marks a space the user must not show on camera — the client's own name is
	 * the secret, whether or not any member project is marked. Inert unless
	 * streamer mode is on, exactly like `Project.sensitive`.
	 */
	sensitive?: boolean;
}

/** The full on-disk shape of spaces.json. A missing file means the empty shape. */
export interface SpacesFile {
	version: 1;
	spaces: Space[];
	order: string[];
}

export const EMPTY_SPACES_FILE: SpacesFile = Object.freeze({
	version: 1 as const,
	spaces: [],
	order: [],
});

/** Active spaces in display order: `order` first, unlisted actives appended. */
export function orderSpaces(spaces: Space[], order: string[]): Space[] {
	const active = spaces.filter((s) => !s.deleted);
	const byId = new Map(active.map((s) => [s.id, s]));
	const ordered: Space[] = [];
	for (const id of order) {
		const s = byId.get(id);
		if (s) {
			ordered.push(s);
			byId.delete(id);
		}
	}
	for (const s of active) if (byId.has(s.id)) ordered.push(s);
	return ordered;
}

/** Every non-deleted space the project belongs to, in input order. */
export function spacesOfProject(spaces: Space[], projectId: string): Space[] {
	return spaces.filter((s) => !s.deleted && s.projectIds.includes(projectId));
}

/**
 * Streamer masking is conservative: the space's own flag, or one sensitive
 * member, mutes the whole space.
 */
export function isSpaceSensitive(space: Space, sensitiveProjectIds: ReadonlySet<string>): boolean {
	return space.sensitive === true || space.projectIds.some((id) => sensitiveProjectIds.has(id));
}
