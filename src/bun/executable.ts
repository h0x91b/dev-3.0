import { accessSync, constants, existsSync, statSync } from "node:fs";

/** True only when `path` names a regular file the current process can execute. */
export function isExecutableFile(path: string): boolean {
	try {
		if (!existsSync(path)) return false;
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
