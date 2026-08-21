import { resolveDev3Home } from "../shared/dev3-home";

/** Re-exported so app modules have one import for both forms of the root. */
export { resolveDev3Home };

/**
 * Root directory for all dev-3.0 data: projects, tasks, worktrees, logs.
 *
 * Resolved once at module load, because the launcher sets `$DEV3_HOME` before the
 * app boots and a root that could drift mid-run would split one instance's state
 * across two directories. Callers that must re-read the environment per call (the
 * native-terminal path helpers, whose tests repoint it between cases) call
 * `resolveDev3Home` directly instead.
 */
export const DEV3_HOME = resolveDev3Home();

/**
 * Root for virtual ("Operations") boards. A virtual project's synthetic `path`
 * is `${OPS_DIR}/<readable-slug>`; its managed task working dirs nest under it
 * at `${OPS_DIR}/<readable-slug>/<taskId>/work`. This is an additive tree —
 * older app versions never read it, preserving the on-disk layout invariants.
 */
export const OPS_DIR = `${DEV3_HOME}/ops`;
