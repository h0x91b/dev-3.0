/**
 * What a newly added project's Claude agents will use as their config folder, reported once
 * at add time. Absent when they use `~/.claude` because nothing pins another folder.
 * - `ready`: a pinned folder that already holds a Claude login.
 * - `no-login`: a pinned folder with no login yet; the first task asks the user to sign in.
 * - `refused`: the global per-project default was refused because git would not ignore the
 *   login file, so agents keep `~/.claude`.
 */
export interface ClaudeFolderNotice {
	state: "ready" | "no-login" | "refused";
	dir: string;
}

/** Active tasks whose Claude folder the "Each project uses its own Claude folder" switch would change. */
export interface ClaudeFolderSwitchImpact {
	taskCount: number;
	projectNames: string[];
}
