const HOME = process.env.HOME || "/tmp";

/** Root directory for all dev-3.0 data: projects, tasks, worktrees, logs */
export const DEV3_HOME = `${HOME}/.dev3.0`;

/**
 * Root for virtual ("Operations") boards. A virtual project's synthetic `path`
 * is `${OPS_DIR}/<readable-slug>`; its managed task working dirs nest under it
 * at `${OPS_DIR}/<readable-slug>/<taskId>/work`. This is an additive tree —
 * older app versions never read it, preserving the on-disk layout invariants.
 */
export const OPS_DIR = `${DEV3_HOME}/ops`;
