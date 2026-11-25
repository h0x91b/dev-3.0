/**
 * The file a running tmux server executes, as the kernel reports it, and whether that file is gone.
 * Shared by the app's "Restart terminals" notice and `dev3 doctor`.
 * See decisions/2026/11/24/tmux-server-runs-from-a-hardlink-mirror.md.
 */

/** Under the data root: hardlink mirrors of the app bundle that the launchd tmux server runs from. */
export const TMUX_MIRROR_DIR = "tmux-host";

export type ServerExecutable = { path: string; inode: number | null; links: number | null };

/** The first txt record of `lsof -a -p <pid> -d txt -Fikn`: the program itself (dyld comes after it). */
export function parseLsofExecutable(stdout: string): ServerExecutable | null {
	let inode: number | null = null;
	let links: number | null = null;
	for (const line of stdout.split("\n")) {
		if (line.startsWith("f")) [inode, links] = [null, null];
		else if (line.startsWith("i")) inode = fieldNumber(line);
		else if (line.startsWith("k")) links = fieldNumber(line);
		else if (line.startsWith("n/")) return { path: line.slice(1), inode, links };
	}
	return null;
}

function fieldNumber(line: string): number | null {
	const value = Number(line.slice(1));
	return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * True when the server's file has no links left (`k0`): an update or uninstall deleted it. tccd then
 * cannot read the server's code, and on macOS 27 it does not fall back to whatever now sits at the
 * path. Without a link count, a different inode at the path means the same thing.
 */
export function executableDeleted(executable: ServerExecutable, inodeAt: (path: string) => number | null): boolean {
	if (executable.links !== null) return executable.links === 0;
	if (executable.inode === null) return false;
	const onDisk = inodeAt(executable.path);
	return onDisk !== null && onDisk !== executable.inode;
}
