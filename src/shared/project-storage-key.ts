/**
 * The directory name a project's dev3 state is stored under.
 *
 * `~/.dev3.0/data/<key>/` and `~/.dev3.0/worktrees/<key>/` are named by this
 * key, and the CLI recovers a task from `cwd` by re-deriving it. AGENTS.md
 * freezes the POSIX algorithm: `/a/b/c` → `a-b-c`, unchanged forever, because
 * every installed version of the app reads the same directory.
 *
 * A Windows path cannot go through that algorithm — `C:\src\repo` keeps its
 * colon and backslashes, none of which are legal in a directory name. The
 * Windows branch is therefore ADDITIVE: POSIX input produces the byte-identical
 * frozen result, and only win32 gets the sanitising pass. Windows has no
 * pre-existing `~/.dev3.0` to stay compatible with, so there is nothing to
 * migrate.
 *
 * This module has no imports on purpose — the bun main process, the CLI, and
 * the renderer-facing shared code all derive the key from here instead of
 * keeping their own copy of the formula.
 */

/** The frozen POSIX algorithm. Never change this — see AGENTS.md. */
export function posixProjectSlug(projectPath: string): string {
	// /Users/arsenyp/Desktop/my-repo → Users-arsenyp-Desktop-my-repo
	return projectPath.replace(/^\//, "").replaceAll("/", "-");
}

/**
 * Characters Win32 rejects inside a path component, plus the control range.
 * Space and `-` stay legal: `-` is the separator this key is built from.
 */
// eslint-disable-next-line no-control-regex
const WINDOWS_ILLEGAL = /[<>:"|?*\u0000-\u001f]/g;

/** Device names that cannot be used as a file or directory name on Windows. */
const WINDOWS_RESERVED = new Set([
	"CON", "PRN", "AUX", "NUL",
	"COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
	"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

function windowsProjectStorageKey(projectPath: string): string {
	const forward = projectPath.replaceAll("\\", "/");
	// A UNC path (`//server/share/repo`) loses its leading slashes the same way
	// a POSIX absolute path does.
	const rooted = forward.replace(/^\/+/, "");
	// `C:/src/repo` → `C/src/repo`. The drive colon is dropped rather than
	// escaped so the common case stays readable.
	const withoutDriveColon = rooted.replace(/^([A-Za-z]):/, "$1");
	// `C:\` must not become `C-`: a trailing separator is not a path component.
	const joined = withoutDriveColon.replace(/\/+$/, "").replaceAll("/", "-");
	// A trailing dot or space is silently stripped by Win32, which would make
	// the key we write differ from the key we later look up.
	const sanitised = joined.replace(WINDOWS_ILLEGAL, "_").replace(/[. ]+$/, "");
	if (sanitised === "") return "_";
	return WINDOWS_RESERVED.has(sanitised.toUpperCase()) ? `${sanitised}_` : sanitised;
}

export function projectStorageKey(
	projectPath: string,
	platform: NodeJS.Platform = process.platform,
): string {
	return platform === "win32" ? windowsProjectStorageKey(projectPath) : posixProjectSlug(projectPath);
}

/**
 * Rewrite `\` to `/` on Windows only.
 *
 * dev3 builds every `~/.dev3.0` path by string concatenation with forward
 * slashes, while `path.join`, `process.cwd()` and git hand back backslashes on
 * Windows — so one directory has two spellings in one process and a prefix
 * comparison between them fails. A backslash is a legal character in a POSIX
 * file name, so the rewrite must never run there.
 */
export function toPosixSeparators(
	value: string,
	platform: NodeJS.Platform = process.platform,
): string {
	return platform === "win32" ? value.replaceAll("\\", "/") : value;
}

/**
 * Last component of a filesystem path.
 *
 * Platform-gated: a backslash is a legal character in a POSIX file name, so only
 * Windows may treat it as a separator. Never call this from the renderer — in
 * remote mode the browser and the backend can be different operating systems, so
 * only the process that owns the filesystem can answer correctly.
 */
export function pathBasename(value: string, platform: NodeJS.Platform = process.platform): string {
	const separators = platform === "win32" ? /[\\/]/ : /\//;
	const trailing = platform === "win32" ? /[\\/]+$/ : /\/+$/;
	const trimmed = value.replace(trailing, "");
	const parts = trimmed.split(separators);
	return parts[parts.length - 1] || trimmed;
}
