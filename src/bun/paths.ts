import { resolveDev3Home } from "../shared/dev3-home";

// Deliberately NOT re-exported. 45 suites mock this module with a factory that
// lists its exports by name, so a module importing the resolver through here
// would get `undefined` whenever one of those suites reaches it. Import it from
// `shared/dev3-home` directly.

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

/**
 * Home of the throwaway sandbox repo (`${SANDBOX_DIR}/<name>`) dev3 creates for a
 * first-run user who has nothing to point it at yet. Additive, like `OPS_DIR`, and
 * a sibling of it — so it can never collide with an `ops/<slug>` path.
 */
export const SANDBOX_DIR = `${DEV3_HOME}/sandbox`;
