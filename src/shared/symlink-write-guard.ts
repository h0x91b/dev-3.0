import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/**
 * The first symlink met while walking from `root` down to `file` that leads
 * outside `root` (or nowhere), or null when the write stays inside `root`.
 *
 * dev3 writes agent config into a worktree (`.claude/settings.local.json`,
 * `.codex/hooks.json`). A repo can track any of those paths, or the directory
 * holding them, as a symlink into a shared config kit, and a write through it
 * silently edits a file outside the worktree. Callers skip the write instead.
 * `root` itself is not checked: `/tmp` on macOS is a symlink and that is fine.
 */
export function symlinkOnWritePath(root: string, file: string): string | null {
	const rel = relative(root, file);
	if (!isStrictlyInside(rel)) return null;
	let realRoot: string;
	try {
		realRoot = realpathSync(root);
	} catch {
		return null; // No root yet: nothing under it can be a link.
	}
	let current = root;
	for (const part of rel.split(sep)) {
		current = join(current, part);
		try {
			if (!lstatSync(current).isSymbolicLink()) continue;
		} catch {
			return null; // Missing from here down: the write creates real entries.
		}
		if (!resolvesInside(realRoot, current)) return current;
	}
	return null;
}

function resolvesInside(realRoot: string, link: string): boolean {
	try {
		return isStrictlyInside(relative(realRoot, realpathSync(link)));
	} catch {
		return false; // Dangling: writing would create a file wherever it points.
	}
}

function isStrictlyInside(rel: string): boolean {
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
