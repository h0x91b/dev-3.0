import { isBuiltinOpsProject, orderSpaces, type Project, type Space, type SpacesFile } from "../../shared/types";

export type MixedEntry =
	| { kind: "space"; space: Space; projects: Project[] }
	| { kind: "project"; project: Project };

/** Selection id of a mixed entry: the space id or the project id. */
export function mixedEntryId(entry: MixedEntry): string {
	return entry.kind === "space" ? entry.space.id : entry.project.id;
}

/**
 * The top-level list ⌘1–⌘9 walk in "Number keys follow spaces" mode: spaces and
 * standalone projects interleaved. Without a stored order a space takes the slot
 * of its first member in board order; a stored `mixedOrder` wins for the ids it
 * still names. A new space takes the slot its members held, anything else new goes last.
 */
export function resolveMixedOrder(projects: Project[], file: SpacesFile): MixedEntry[] {
	const eligible = projects.filter((p) => !p.deleted && !isBuiltinOpsProject(p));
	const byId = new Map(eligible.map((p) => [p.id, p]));

	const spaceEntries = new Map<string, Extract<MixedEntry, { kind: "space" }>>();
	const inSpace = new Set<string>();
	for (const space of orderSpaces(file.spaces, file.order)) {
		const members = space.projectIds.map((id) => byId.get(id)).filter((p): p is Project => p !== undefined);
		if (members.length === 0) continue;
		spaceEntries.set(space.id, { kind: "space", space, projects: members });
		for (const p of members) inSpace.add(p.id);
	}

	const derived: MixedEntry[] = [];
	const seenSpaces = new Set<string>();
	for (const p of eligible) {
		if (!inSpace.has(p.id)) {
			derived.push({ kind: "project", project: p });
			continue;
		}
		for (const entry of spaceEntries.values()) {
			if (seenSpaces.has(entry.space.id) || !entry.projects.includes(p)) continue;
			seenSpaces.add(entry.space.id);
			derived.push(entry);
		}
	}

	const stored = file.mixedOrder ?? [];
	if (stored.length === 0) return derived;

	const derivedById = new Map(derived.map((entry) => [mixedEntryId(entry), entry]));
	const ordered: MixedEntry[] = [];
	// Position of each placed entry in the stored list, to slot spaces in by.
	const rank = new Map<string, number>();
	stored.forEach((id, at) => {
		const entry = derivedById.get(id);
		if (!entry || rank.has(id)) return;
		rank.set(id, at);
		ordered.push(entry);
	});

	// A space the stored list never named takes the earliest slot any of its
	// members held there as a standalone project; a project freed by a deleted
	// space takes that space's slot. Anything else goes last.
	const deletedSpaceRank = new Map<string, number>();
	for (const space of file.spaces) {
		const at = stored.indexOf(space.id);
		if (space.deleted && at !== -1) deletedSpaceRank.set(space.id, at);
	}
	const heldBy = (entry: MixedEntry): number[] =>
		entry.kind === "space"
			? entry.projects.map((m) => stored.indexOf(m.id)).filter((at) => at !== -1)
			: file.spaces.filter((s) => deletedSpaceRank.has(s.id) && s.projectIds.includes(entry.project.id)).map((s) => deletedSpaceRank.get(s.id)!);
	const rest: MixedEntry[] = [];
	for (const entry of derived) {
		const id = mixedEntryId(entry);
		if (rank.has(id)) continue;
		const held = heldBy(entry);
		if (held.length === 0) {
			rest.push(entry);
			continue;
		}
		const at = Math.min(...held);
		const slot = ordered.findIndex((other) => rank.get(mixedEntryId(other))! > at);
		ordered.splice(slot === -1 ? ordered.length : slot, 0, entry);
		rank.set(id, at);
	}
	return [...ordered, ...rest];
}

/**
 * What ⌘1..9 (index 0..8) open. Off: ordinary projects in board order. On: the
 * first nine mixed entries. Every digit consumer reads this one list.
 */
export function digitTargets(projects: Project[], file: SpacesFile, followSpaces: boolean): MixedEntry[] {
	if (followSpaces) return resolveMixedOrder(projects, file).slice(0, 9);
	return projects
		.filter((p) => !p.deleted && !isBuiltinOpsProject(p))
		.slice(0, 9)
		.map((project) => ({ kind: "project", project }));
}

/** Digit badge ("1".."9") per target id, for surfaces that label rows with their shortcut. */
export function digitBadgeById(targets: MixedEntry[]): Record<string, string> {
	const badges: Record<string, string> = {};
	targets.forEach((target, i) => {
		badges[mixedEntryId(target)] = String(i + 1);
	});
	return badges;
}

/** `ids` with `sourceId` moved beside `targetId`; null when nothing would change. */
export function movedIds(ids: string[], sourceId: string, targetId: string, side: "before" | "after"): string[] | null {
	if (sourceId === targetId) return null;
	const next = ids.filter((id) => id !== sourceId);
	const at = next.indexOf(targetId);
	if (at === -1 || !ids.includes(sourceId)) return null;
	next.splice(side === "after" ? at + 1 : at, 0, sourceId);
	return next;
}

/** `ids` with `id` swapped one place; null at either end. */
export function steppedIds(ids: string[], id: string, delta: -1 | 1): string[] | null {
	const from = ids.indexOf(id);
	const to = from + delta;
	if (from === -1 || to < 0 || to >= ids.length) return null;
	const next = [...ids];
	[next[from], next[to]] = [next[to], next[from]];
	return next;
}
