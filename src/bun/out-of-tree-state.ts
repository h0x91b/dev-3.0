import { findBazelOutputBase, removeBazelOutputBase } from "./bazel-output-base";

/** Each finder locates one tool's state for a worktree and returns how to delete it. */
const FINDERS: Array<(worktreePath: string) => (() => Promise<void>) | null> = [
	(worktreePath) => {
		const base = findBazelOutputBase(worktreePath);
		return base && (() => removeBazelOutputBase(base));
	},
];

/**
 * Deletes state tools keep outside a worktree under a name derived from its path, which nothing reuses once
 * the worktree is gone. Finds it while the worktree still exists; deletes in the background, never throws.
 */
export function reclaimOutOfTreeState(worktreePath: string): void {
	for (const find of FINDERS) {
		const remove = find(worktreePath);
		if (remove) void remove();
	}
}
