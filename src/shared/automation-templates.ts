/**
 * Built-in automation templates offered in the create-automation form (UI) and
 * via `dev3 automations create --template <id>`. A template only pre-fills the
 * draft — the user can edit everything before saving.
 *
 * Prompts are written to be IDEMPOTENT: every fire derives its reporting window
 * from the current date at run time, so an at-least-once delivery (a missed run
 * caught up late, or a duplicate fire) produces a correct — not corrupted —
 * result.
 */

export interface AutomationTemplate {
	id: string;
	/** i18n key for the template picker label (renderer); CLI shows `name`. */
	nameKey: string;
	name: string;
	rrule: string;
	prompt: string;
}

const SHIPPED_REPORT_PROMPT = `Write my "What I shipped" orientation report. You are running as a scheduled automation; there is no human in the loop — gather everything yourself and produce the report in one pass.

Scope: the last 7 days (compute the window from today's date — run \`date\` to get it).

Gather, in this order:
1. \`dev3 projects list\` — all projects.
2. For each project: \`dev3 tasks list --project <id> --limit 50\` — collect tasks completed or actively worked in the window (use their updated/moved times).
3. For the most significant completed tasks, read their overviews and notes (\`dev3 task show --task <id> --notes\`) to understand WHAT actually shipped, not just titles.
4. In this repository (and any project checkout you can reach read-only), \`git log --since="7 days ago" --oneline --author="$(git config user.name)"\` for a commit-level picture. Use \`gh pr list --author @me --state merged --limit 30\` if gh is available.

Then write the report as markdown with exactly these sections:
## What I shipped (last week)
Grouped by project; one bullet per meaningful outcome (user-visible phrasing, not commit messages).
## In flight
Active/waiting tasks that carry over, with one-line state each.
## What's next
3-7 concrete candidates inferred from open todo tasks, notes, and unfinished threads.

Rules:
- Outcomes over activity: "shipped X so users can Y", never "worked on X".
- Be honest about small weeks — never pad.
- Keep the whole report under ~60 lines.

Deliver it:
1. Save the full report as a task note: \`dev3 note add @<file>\` (write it to a file first).
2. Set the task overview to a 1-2 sentence headline of the week.
3. Print the full report as your final message.
4. \`dev3 notify "Weekly shipped report is ready" --level success\`.`;

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
	{
		id: "shipped-report",
		nameKey: "automations.templateShippedReport",
		name: "What I shipped — weekly report",
		// Friday 17:00 local time — review the week while it is still warm.
		rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0",
		prompt: SHIPPED_REPORT_PROMPT,
	},
];

export function getAutomationTemplate(id: string): AutomationTemplate | undefined {
	return AUTOMATION_TEMPLATES.find((t) => t.id === id);
}
