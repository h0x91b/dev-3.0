import type { Automation } from "../../shared/types";
import { AUTOMATION_TEMPLATES, getAutomationTemplate } from "../../shared/automation-templates";
import { sendRequest } from "../socket-client";
import { printTable, exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { readStdin } from "../stdin";

function requireProjectId(args: ParsedArgs, context: CliContext | null): string {
	const projectId = resolveProjectId(args.flags.project, context);
	if (!projectId) {
		exitUsage("--project <id> is required (or run from inside a worktree)");
	}
	return projectId;
}

function formatWhen(iso: string | null | undefined): string {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "—";
	return d.toISOString().slice(0, 16).replace("T", " ") + "Z";
}

function lastRunSummary(automation: Automation): string {
	const run = automation.runs[0];
	if (!run) return "never";
	const when = formatWhen(run.firedAt ?? run.scheduledFor);
	if (run.status === "created") return `ok ${when}`;
	if (run.status === "failed") return `FAILED ${when}`;
	return `missed ${when}`;
}

async function listAutomations(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["project"]);
	const projectId = requireProjectId(args, context);

	const resp = await sendRequest(socketPath, "automations.list", { projectId });
	if (!resp.ok) exitError(resp.error || "Failed to list automations");

	const automations = resp.data as Automation[];
	if (automations.length === 0) {
		process.stdout.write("No automations. Create one with: dev3 automations create --help\n");
		return;
	}

	printTable(
		["ID", "ON", "NAME", "SCHEDULE", "TZ", "NEXT RUN (UTC)", "LAST RUN"],
		automations.map((a) => [
			a.id.slice(0, 8),
			a.enabled ? "yes" : "no",
			a.name,
			a.rrule,
			a.timezone,
			formatWhen(a.nextRunAt),
			lastRunSummary(a),
		]),
	);
}

async function showAutomation(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["project", "id"]);
	const projectId = requireProjectId(args, context);
	const automationId = args.positional[0] || args.flags.id;
	if (!automationId) exitUsage("Usage: dev3 automations show <automation-id>");

	const resp = await sendRequest(socketPath, "automations.show", { projectId, automationId });
	if (!resp.ok) exitError(resp.error || "Failed to show automation");

	const a = resp.data as Automation;
	const lines = [
		`ID:        ${a.id}`,
		`Name:      ${a.name}`,
		`Enabled:   ${a.enabled ? "yes" : "no"}`,
		`Schedule:  ${a.rrule}`,
		`Timezone:  ${a.timezone}`,
		`Agent:     ${a.agentId ?? "(project default)"}`,
		`Catch-up:  ${a.catchUp}`,
		`Next run:  ${formatWhen(a.nextRunAt)} (UTC)`,
		`Created:   ${formatWhen(a.createdAt)}`,
		"",
		"Prompt:",
		...a.prompt.split("\n").map((l) => `  ${l}`),
	];
	if (a.runs.length > 0) {
		lines.push("", `Runs (${a.runs.length}, newest first):`);
		for (const run of a.runs) {
			const what = run.status === "created"
				? `created task ${run.taskId?.slice(0, 8) ?? "?"}`
				: run.status === "failed"
					? `FAILED: ${run.error ?? "unknown error"}`
					: "missed (app offline)";
			lines.push(`  [${run.status === "missed" ? formatWhen(run.scheduledFor) : formatWhen(run.firedAt)}] ${what}${run.manual ? " (manual)" : ""}`);
		}
	}
	process.stdout.write(lines.join("\n") + "\n");
}

async function createAutomation(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["project", "name", "prompt", "rrule", "timezone", "tz", "agent", "config", "catch-up", "disabled", "template"]);
	const projectId = requireProjectId(args, context);

	const template = args.flags.template ? getAutomationTemplate(args.flags.template) : undefined;
	if (args.flags.template && !template) {
		exitUsage(`Unknown template: ${args.flags.template}. Available: ${AUTOMATION_TEMPLATES.map((t) => t.id).join(", ")}`);
	}

	const name = (args.flags.name || args.positional[0] || template?.name || "").trim();
	const rrule = args.flags.rrule || template?.rrule || "";
	if (!name) exitUsage('Usage: dev3 automations create --name "..." --prompt "..." --rrule "FREQ=DAILY;BYHOUR=9" [--timezone <iana>] [--template shipped-report]');
	if (!rrule) exitUsage('--rrule is required (or use --template), e.g. "FREQ=WEEKLY;BYDAY=FR;BYHOUR=17"');
	const rawPrompt = args.flags.prompt;
	const prompt = rawPrompt === "-" ? await readStdin() : rawPrompt || template?.prompt || "";
	if (!prompt) exitUsage("--prompt is required (or use --template). @file syntax works: --prompt @prompt.md");

	const timezone = args.flags.timezone || args.flags.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
	const params: Record<string, unknown> = { projectId, name, prompt, rrule, timezone };
	if (args.flags.agent) params.agentId = args.flags.agent;
	if (args.flags.config) params.configId = args.flags.config;
	if (args.flags["catch-up"]) params.catchUp = args.flags["catch-up"];
	if (args.flags.disabled === "true") params.enabled = false;

	const resp = await sendRequest(socketPath, "automations.create", params);
	if (!resp.ok) exitError(resp.error || "Failed to create automation");

	const a = resp.data as Automation;
	process.stdout.write(`Created automation ${a.id.slice(0, 8)} "${a.name}" — next run ${formatWhen(a.nextRunAt)} (UTC)\n`);
}

async function updateAutomation(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["project", "id", "name", "prompt", "rrule", "timezone", "tz", "agent", "config", "catch-up", "enable", "disable"]);
	const projectId = requireProjectId(args, context);
	const automationId = args.positional[0] || args.flags.id;
	if (!automationId) exitUsage("Usage: dev3 automations update <automation-id> [--name ...] [--prompt ...] [--rrule ...] [--enable|--disable]");

	const params: Record<string, unknown> = { projectId, automationId };
	if (args.flags.name !== undefined) params.name = args.flags.name;
	if (args.flags.prompt !== undefined) {
		params.prompt = args.flags.prompt === "-" ? await readStdin() : args.flags.prompt;
	}
	if (args.flags.rrule !== undefined) params.rrule = args.flags.rrule;
	const tz = args.flags.timezone ?? args.flags.tz;
	if (tz !== undefined) params.timezone = tz;
	if (args.flags.agent !== undefined) params.agentId = args.flags.agent;
	if (args.flags.config !== undefined) params.configId = args.flags.config;
	if (args.flags["catch-up"] !== undefined) params.catchUp = args.flags["catch-up"];
	if (args.flags.enable === "true") params.enabled = true;
	if (args.flags.disable === "true") params.enabled = false;
	if (Object.keys(params).length === 2) exitUsage("Nothing to update — pass at least one field flag.");

	const resp = await sendRequest(socketPath, "automations.update", params);
	if (!resp.ok) exitError(resp.error || "Failed to update automation");

	const a = resp.data as Automation;
	process.stdout.write(`Updated automation ${a.id.slice(0, 8)} — ${a.enabled ? `next run ${formatWhen(a.nextRunAt)} (UTC)` : "disabled"}\n`);
}

async function deleteAutomation(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["project", "id"]);
	const projectId = requireProjectId(args, context);
	const automationId = args.positional[0] || args.flags.id;
	if (!automationId) exitUsage("Usage: dev3 automations delete <automation-id>");

	const resp = await sendRequest(socketPath, "automations.delete", { projectId, automationId });
	if (!resp.ok) exitError(resp.error || "Failed to delete automation");

	process.stdout.write(`Deleted automation ${automationId.slice(0, 8)}\n`);
}

async function runAutomation(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["project", "id"]);
	const projectId = requireProjectId(args, context);
	const automationId = args.positional[0] || args.flags.id;
	if (!automationId) exitUsage("Usage: dev3 automations run <automation-id>");

	const resp = await sendRequest(socketPath, "automations.run", { projectId, automationId });
	if (!resp.ok) exitError(resp.error || "Failed to run automation");

	const { taskId } = resp.data as { taskId: string };
	process.stdout.write(`Automation fired — created task ${taskId.slice(0, 8)}\n`);
}

function listTemplates(): void {
	printTable(
		["TEMPLATE", "NAME", "SCHEDULE"],
		AUTOMATION_TEMPLATES.map((t) => [t.id, t.name, t.rrule]),
	);
}

export async function handleAutomations(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	switch (subcommand) {
		case "list":
			return listAutomations(args, socketPath, context);
		case "show":
			return showAutomation(args, socketPath, context);
		case "create":
			return createAutomation(args, socketPath, context);
		case "update":
			return updateAutomation(args, socketPath, context);
		case "delete":
			return deleteAutomation(args, socketPath, context);
		case "run":
			return runAutomation(args, socketPath, context);
		case "templates":
			return listTemplates();
		default:
			exitUsage(
				`Unknown subcommand: automations ${subcommand || "(none)"}` +
				"\nAvailable: automations list, show, create, update, delete, run, templates",
			);
	}
}
