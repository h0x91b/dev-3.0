/**
 * Launch-prompt template context + interpolation, shared by the agent adapters.
 *
 * Pure (no I/O). Moved from src/bun/agents.ts so adapters in src/shared can
 * build the task prompt without depending on src/bun. agents.ts re-exports both.
 */

export interface TemplateContext {
	taskTitle: string;
	taskDescription: string;
	projectName: string;
	projectPath: string;
	worktreePath: string;
}

export function interpolateTemplate(template: string, ctx: TemplateContext): string {
	const vars: Record<string, string> = {
		TASK_TITLE: ctx.taskTitle,
		TASK_DESCRIPTION: ctx.taskDescription,
		PROJECT_NAME: ctx.projectName,
		PROJECT_PATH: ctx.projectPath,
		WORKTREE_PATH: ctx.worktreePath,
	};
	return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

/** Build the base task prompt (description + interpolated appendPrompt) that a
 *  fresh (non-resume) launch injects. Returns "" when there is nothing to send
 *  (scratch/empty launches open an interactive window instead). Adapters that
 *  deliver the dev3 protocol via the prompt append their skill body separately. */
export function buildTaskPrompt(
	appendPrompt: string | undefined,
	ctx: TemplateContext,
): string {
	let prompt = ctx.taskDescription;
	if (appendPrompt) {
		const interpolated = interpolateTemplate(appendPrompt, ctx);
		if (interpolated.trim()) {
			prompt = prompt ? `${prompt}\n\n${interpolated}` : interpolated;
		}
	}
	return prompt;
}
