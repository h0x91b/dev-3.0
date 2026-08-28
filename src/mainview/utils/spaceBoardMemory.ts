// Which project the user last created a task in, per space board. Board-local UI
// state, exactly like the column-collapse memory: localStorage, never on disk in
// `~/.dev3.0`, and an unreadable value simply means "no memory".

const KEY_PREFIX = "dev3-space-last-project-";

export function lastProjectForSpace(spaceId: string): string | null {
	try {
		return localStorage.getItem(KEY_PREFIX + spaceId);
	} catch {
		return null;
	}
}

export function rememberProjectForSpace(spaceId: string, projectId: string): void {
	try {
		localStorage.setItem(KEY_PREFIX + spaceId, projectId);
	} catch {
		/* private mode / quota — the field just starts on the anchor next time */
	}
}
