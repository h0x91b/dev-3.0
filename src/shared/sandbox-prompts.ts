/**
 * The prompts the sandbox repo suggests for a first task.
 *
 * Shared because two places must agree on the exact text: the README seeded into
 * the repo (`bun/sandbox-project.ts`) and the guided tour, which prefills the
 * first one into the Create Task modal so a newcomer never has to invent a
 * prompt. If the two drifted, the tour would type something the README does not
 * mention.
 */

/**
 * The first one is deliberately the smallest visible change in the repo: one
 * colour, on one button, on a page the dev server already serves. A newcomer has
 * to be able to SEE the agent's work without reading a diff — and the artifact
 * carries the before/after, so the screenshots are part of the prompt rather
 * than a step of the tour.
 */
export const SANDBOX_TASK_PROMPTS = [
	"Change the Ship it button in index.html from green to blue. Take screenshots of the page before and after, show them in a dev3 artifact, then commit.",
	"Give index.html a dark/light toggle, then show it off in a dev3 artifact.",
	"Make the card in index.html look right on a phone-sized screen.",
] as const;

/** What the guided tour puts in the description field. */
export const SANDBOX_FIRST_PROMPT: string = SANDBOX_TASK_PROMPTS[0];
