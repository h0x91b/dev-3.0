/**
 * How much command line an agent launch is allowed to spend — the ONE home for
 * the Windows ceiling and the budget dev3 keeps under it.
 *
 * Deliberately dependency-free. Both the pure prompt bodies
 * (`agent-skill-content.ts`, reachable from the CLI) and the impure launch path
 * (`src/bun/agent-system-prompt-file.ts`) have to read these, and neither may
 * drag the other's imports along.
 */

/**
 * A Windows command line stops at 32 767 characters.
 *
 * `CreateProcess` refuses past it with ERROR_FILENAME_EXCED_RANGE, which
 * PowerShell surfaces as `ApplicationFailedException` carrying no useful text —
 * so the failure names neither the length nor the argument that blew it. It is a
 * WHOLE-LINE budget: the binary, every flag, the user's task text and the dev3
 * protocol all share it.
 *
 * POSIX has no comparable ceiling (`ARG_MAX` is 1 MB on macOS, 2 MB on Linux),
 * which is exactly why a line that grew past this went unnoticed until an agent
 * was launched on Windows. Measured on a real Windows runner — see
 * decisions/2026/08/28/agent-command-lines-quote-in-the-launch-dialect.md.
 */
export const WINDOWS_COMMAND_LINE_LIMIT = 32767;

/**
 * Room every launch keeps for everything that is NOT the dev3 protocol: the
 * binary path, the flags, the quoting overhead, and above all the user's own
 * task description and append prompt — whose length dev3 does not control.
 *
 * 5 000 characters is roughly 800 words of task description, which covers the
 * briefs people actually write. It is a MAJORITY guarantee, not an absolute one:
 * a task whose description is a pasted 20 KB spec still cannot be launched on
 * Windows for any agent that carries the prompt on the command line, and no
 * reserve fixes that — only moving that agent's protocol off the command line
 * the way Claude's already is.
 */
export const AGENT_COMMAND_LINE_RESERVE = 5000;

/**
 * Hard cap on one composed protocol body.
 *
 * These bodies travel ON the command line for every agent except Claude (which
 * gets a file on Windows), so growing one past this cap does not fail loudly —
 * it makes Windows refuse to start the agent at all. Adding a section means
 * removing one; that is the intended cost.
 *
 * The guard is `src/bun/__tests__/agent-command-line-budget.test.ts`.
 */
export const AGENT_SKILL_BODY_LIMIT = WINDOWS_COMMAND_LINE_LIMIT - AGENT_COMMAND_LINE_RESERVE;
