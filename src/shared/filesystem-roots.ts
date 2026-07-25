import { existsSync } from "node:fs";

/**
 * Drive roots the folder picker can jump to.
 *
 * Windows has no single filesystem root: `dirname("D:\\")` is `D:\\` itself, so a
 * picker that only walks parents can never leave the drive it started on, and a
 * repo on another drive cannot be added at all. Probing the 26 letters is cheap
 * and needs no shell. POSIX keeps its single `/`, which the renderer offers.
 */
export function listFilesystemRoots(
	platform: NodeJS.Platform = process.platform,
	exists: (path: string) => boolean = existsSync,
): string[] | undefined {
	if (platform !== "win32") return undefined;
	const roots: string[] = [];
	for (let code = "A".charCodeAt(0); code <= "Z".charCodeAt(0); code++) {
		const root = `${String.fromCharCode(code)}:\\`;
		if (exists(root)) roots.push(root);
	}
	return roots;
}
