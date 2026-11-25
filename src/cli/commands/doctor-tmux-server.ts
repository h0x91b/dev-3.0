import { join } from "node:path";
import { executableDeleted, parseLsofExecutable } from "../../shared/tmux-server-executable";
import type { CheckResult } from "./doctor";
import { classifyAccessError, findTerminalHost, macPrivacyFolder, type RepoAccessDeps } from "./doctor-repo-access";

// Names the dev3 tmux server hosting this pane, whether the file it runs survived updates, and
// probes a protected project folder from this terminal's own process (it shares the server's access).
// See decisions/2026/11/24/tmux-server-runs-from-a-hardlink-mirror.md.

export interface TmuxServerDeps extends Pick<RepoAccessDeps, "platform" | "home" | "pid" | "processInfo" | "probeDir"> {
	/** `lsof -a -p <pid> -d txt -Fikn` output; null when it fails. */
	lsofExecutable: (pid: number) => string | null;
	/** The inode now at `path`; null when it cannot be read. */
	inode: (path: string) => number | null;
	/** Paths of the projects on the boards; empty when unreadable. */
	projectPaths: () => string[];
	/** Root of the bundle mirrors the launchd server runs from; each is named by its tmux inode. */
	mirrorRoot: string;
}

const LABEL = "tmux server";
const RESTART_HINTS = [
	"An update or uninstall deleted the tmux this server runs, so macOS can cut every pane's folder access at its next check.",
	"Relaunch dev-3.0 and choose \"Restart terminals\" in its notice once no agent is mid-turn; agents come back with `dev3 agent resume`.",
];

/** Null unless this runs in a pane of dev3's bundled tmux on macOS: no other server is dev3's to restart. */
export function checkTmuxServer(deps: TmuxServerDeps): CheckResult | null {
	if (deps.platform !== "darwin") return null;
	const host = findTerminalHost(deps);
	if (host?.kind !== "tmux" || !host.path.includes(".app/Contents/")) return null;
	const lsof = deps.lsofExecutable(host.pid);
	const executable = lsof === null ? null : parseLsofExecutable(lsof);
	const deleted = executable !== null && executableDeleted(executable, deps.inode);
	const runs = !executable
		? "its executable could not be read"
		: deleted
			? `runs ${executable.path} (inode ${executable.inode ?? "?"}), which is no longer on disk`
			: executable.inode !== null && deps.inode(join(deps.mirrorRoot, String(executable.inode))) !== null
				? `runs its update-proof copy in ${join(deps.mirrorRoot, String(executable.inode))}`
				: `runs ${executable.path}`;
	const probe = probeProtectedProject(deps);
	const detail = `pid ${host.pid} ${runs}; ${probe.text}`;
	if (probe.denied) return { label: LABEL, status: "fail", detail, ...(deleted ? { hints: RESTART_HINTS } : {}) };
	if (deleted) return { label: LABEL, status: "warn", detail, hints: RESTART_HINTS };
	return { label: LABEL, status: "ok", detail };
}

/** Lists the first present project inside a macOS privacy folder from this process. */
function probeProtectedProject(deps: TmuxServerDeps): { text: string; denied: boolean } {
	for (const project of deps.projectPaths()) {
		const folder = macPrivacyFolder(project, deps.home);
		if (!folder) continue;
		const code = deps.probeDir(project);
		const cause = classifyAccessError(code);
		if (cause === "missing") continue;
		if (cause === "ok") return { text: `${folder} readable (${project})`, denied: false };
		if (cause === "denied") return { text: `${folder} denied (EPERM reading ${project})`, denied: true };
		return { text: `${folder} probe inconclusive (${code} reading ${project})`, denied: false };
	}
	return { text: "no project in a protected folder to probe", denied: false };
}
