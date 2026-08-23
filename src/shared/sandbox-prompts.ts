/**
 * The prompts the sandbox repo suggests for a first task.
 *
 * Shared because two places must agree on the exact text: the README seeded into
 * the repo (`bun/sandbox-project.ts`) and the guided tour, which prefills the
 * first one into the Create Task modal so a newcomer never has to invent a
 * prompt. If the two drifted, the tour would type something the README does not
 * mention.
 */

export const SANDBOX_TASK_PROMPTS = [
	"prices.js rounds money wrong — find the bug, fix it, and add a test.",
	"Add a --currency flag to prices.js and document it in this README.",
	"Translate this README into Spanish as README.es.md.",
] as const;

/** What the guided tour puts in the description field. */
export const SANDBOX_FIRST_PROMPT: string = SANDBOX_TASK_PROMPTS[0];
