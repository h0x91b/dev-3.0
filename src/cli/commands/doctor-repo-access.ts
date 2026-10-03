import { dirname, join } from "node:path";
import type { CheckResult } from "./doctor";

// Git answers "not a git repository" alike for a deleted repo, a POSIX
// permission problem and an EPERM denial. This check probes the worktree's real
// git directory from the caller's own process — run in a task terminal, the
// same context as the shell — and reports the errno. EPERM alone cannot say
// which policy denied it (macOS privacy, a sandbox, MDM), so it lists causes.

export interface RepoAccessDeps {
	platform: NodeJS.Platform;
	home: string;
	cwd: string;
	pid: number;
	/** Error code (`ENOENT`, `EPERM`, `EACCES`, …) from listing `path`, or null when readable. */
	probeDir: (path: string) => string | null;
	/** `.git` contents when it is a file, "dir" when a directory, null when absent; throws errno errors. */
	readDotGit: (path: string) => string | "dir" | null;
	/** `ps`-style lookup: parent pid and executable path, or null when the process is gone. */
	processInfo: (pid: number) => { ppid: number; path: string } | null;
}

export type RepoAccessCause = "ok" | "missing" | "denied" | "filesystem" | "unknown";

const LABEL = "repository access";
const DOCS_URL = "https://github.com/h0x91b/dev-3.0/blob/main/docs/troubleshooting.md#task-terminals-lose-access-to-desktop-or-documents-on-macos";

/** Folders macOS guards per program (Apple Platform Security: "Controlling app access to files in macOS"). */
export function macPrivacyFolder(path: string, home: string): string | null {
	for (const name of ["Desktop", "Documents", "Downloads"]) {
		const root = join(home, name);
		if (path === root || path.startsWith(`${root}/`)) return `~/${name}`;
	}
	const icloud = join(home, "Library", "Mobile Documents");
	if (path === icloud || path.startsWith(`${icloud}/`)) return "iCloud Drive";
	if (path.startsWith("/Volumes/")) return "an external or network volume";
	return null;
}

export function classifyAccessError(code: string | null): RepoAccessCause {
	if (code === null) return "ok";
	if (code === "ENOENT" || code === "ENOTDIR") return "missing";
	if (code === "EACCES") return "filesystem";
	if (code === "EPERM") return "denied";
	return "unknown";
}

/** The process that hosts this terminal: the tmux server, the native terminal host, or the app itself. */
export function findTerminalHost(deps: Pick<RepoAccessDeps, "pid" | "processInfo">): { kind: "tmux" | "native" | "app"; path: string } | null {
	let pid = deps.pid;
	for (let hops = 0; hops < 64 && pid > 1; hops++) {
		const info = deps.processInfo(pid);
		if (!info) return null;
		if (/(^|\/)tmux$/.test(info.path)) return { kind: "tmux", path: info.path };
		if (/dev3-terminal-host/.test(info.path)) return { kind: "native", path: info.path };
		if (/\.app\/Contents\/MacOS\//.test(info.path) && /dev-3\.0/.test(info.path)) return { kind: "app", path: info.path };
		pid = info.ppid;
	}
	return null;
}

function codeOf(err: unknown): string {
	return (err as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
}

/** Locate the git directory for `cwd`; an unreadable step is returned as the failing path. */
function locateGitDir(deps: RepoAccessDeps): { gitDir: string } | { blocked: string; code: string } | null {
	let dir = deps.cwd;
	for (;;) {
		const dotGit = join(dir, ".git");
		let content: string | "dir" | null;
		try {
			content = deps.readDotGit(dotGit);
		} catch (err) {
			return { blocked: dotGit, code: codeOf(err) };
		}
		if (content === "dir") return { gitDir: dotGit };
		if (content !== null) {
			const target = content.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
			if (!target) return null;
			return { gitDir: target.startsWith("/") ? target : join(dir, target) };
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Null when the current directory is not inside a git checkout — the check does not apply. */
export function checkRepositoryAccess(deps: RepoAccessDeps): CheckResult | null {
	const located = locateGitDir(deps);
	if (!located) return null;
	const path = "gitDir" in located ? located.gitDir : located.blocked;
	const code = "gitDir" in located ? deps.probeDir(located.gitDir) : located.code;
	const cause = classifyAccessError(code);
	if (cause === "ok") return { label: LABEL, status: "ok", detail: `git directory readable (${path})` };

	if (cause === "missing") {
		return {
			label: LABEL,
			status: "fail",
			detail: `this worktree points at ${path}, which does not exist — the project repository was moved or deleted`,
			hints: ["Git reports this as `not a git repository`.", "Move the project back, or re-add it in dev-3.0 from its new location."],
		};
	}
	if (cause === "filesystem") {
		return {
			label: LABEL,
			status: "fail",
			detail: `file permissions deny reading ${path} (EACCES)`,
			hints: [`Inspect ownership and ACLs: ls -lde "${path}"`],
		};
	}
	if (cause === "denied") {
		const host = findTerminalHost(deps);
		const folder = deps.platform === "darwin" ? macPrivacyFolder(path, deps.home) : null;
		const who = host ? `${host.kind === "tmux" ? "tmux server" : host.kind === "native" ? "native terminal host" : "dev-3.0"} ${host.path}` : "unknown";
		const hints = ["Possible causes — EPERM alone does not say which:"];
		if (folder) {
			hints.push(
				`macOS privacy protection for ${folder}: ${host ? `adding ${host.path}` : "adding the terminal's host program"} in System Settings → Privacy & Security → Full Disk Access restored access in one observed case.`,
			);
		}
		hints.push("an agent sandbox — re-run `dev3 doctor` from a plain task terminal to compare;", "another security or MDM policy on this Mac.");
		if (folder) hints.push(`Details: ${DOCS_URL}`);
		return {
			label: LABEL,
			status: "fail",
			detail: `access denied reading ${path} (EPERM); terminal host: ${who}`,
			hints,
		};
	}
	return { label: LABEL, status: "warn", detail: `could not read ${path} (${code})` };
}
