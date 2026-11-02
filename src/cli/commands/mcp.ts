import type { ParsedArgs } from "../args";
import { expandShortProjectId, readProjectDirect, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { exitError, exitUsage, printTable } from "../output";
import { sendRequest } from "../socket-client";
import { isValidSenderId } from "../../shared/external-senders";
import { CLI_EXIT_CODE_EXTERNAL_SENDER_UNKNOWN } from "../../shared/cli-exit-codes";
import { externalSendersRegistryPath, loadExternalSenders } from "../../bun/external-senders";
import {
	MCP_DEFAULT_EXPIRY_DAYS,
	MCP_SCOPES,
	generateMcpToken,
	mcpConfigPath,
	readMcpConfig,
	tokenIsLive,
	updateMcpConfig,
	type McpScope,
	type McpTokenRecord,
} from "../../bun/mcp/token-store";

const USAGE =
	"Usage: dev3 mcp token issue --sender <id> --projects <id,…|*> [--scope read,stats,send,write,start,content] [--expires 90d|never] [--auto-approve] [--label \"…\"] [--json]\n" +
	"       dev3 mcp token list [--json] | dev3 mcp token revoke <id>\n" +
	"       dev3 mcp enable [--port N] | dev3 mcp disable | dev3 mcp status [--json]";

const DRIVING_SCOPES: McpScope[] = ["send", "start", "content", "write"];

function flag(args: ParsedArgs, name: string): string | undefined {
	const value = args.flags[name];
	if (value === undefined) return undefined;
	if (value === "true") exitUsage(`--${name} needs a value.\n${USAGE}`);
	return value.trim();
}

function refuseInsideTask(context: CliContext | null): void {
	// A speed bump, not the boundary: the store living outside every sandbox's write
	// roots is what actually keeps a task from enrolling a token.
	if (context?.taskId || process.env.DEV3_TASK_ID) {
		exitUsage("dev3 mcp changes who can reach this machine from the network. Run it from a plain terminal, not from inside a task.");
	}
}

function parseScopes(raw: string | undefined): McpScope[] {
	if (raw === undefined) return ["read"];
	const scopes = raw.split(",").map((s) => s.trim()).filter(Boolean);
	const bad = scopes.find((s) => !(MCP_SCOPES as readonly string[]).includes(s));
	if (bad || scopes.length === 0) exitUsage(`Invalid --scope "${bad ?? raw}". Valid: ${MCP_SCOPES.join(", ")} (comma-separated).`);
	return [...new Set(scopes)] as McpScope[];
}

function parseExpiry(raw: string | undefined, now: number): string | null {
	if (raw === "never") return null;
	const match = /^(\d+)d$/.exec(raw ?? `${MCP_DEFAULT_EXPIRY_DAYS}d`);
	if (!match || Number(match[1]) < 1) exitUsage(`Invalid --expires "${raw}". Use a number of days (90d) or never.`);
	return new Date(now + Number(match[1]) * 86_400_000).toISOString();
}

function parseProjects(raw: string | undefined, context: CliContext | null): string[] {
	if (!raw) exitUsage(`--projects is required: the project ids this token may touch, or * for every project.\n${USAGE}`);
	if (raw === "*") return ["*"];
	const ids = raw.split(",").map((s) => s.trim()).filter(Boolean).map((ref) => {
		const id = expandShortProjectId(ref, context);
		if (readProjectDirect(id)?.id !== id) exitError(`Project not found: ${ref}`, "Run `dev3 projects list` for the ids.");
		return id;
	});
	if (ids.length === 0) exitUsage("--projects needs at least one project id, or *.");
	return [...new Set(ids)];
}

async function issue(args: ParsedArgs, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["sender", "projects", "scope", "expires", "auto-approve", "label", "json"]);
	refuseInsideTask(context);
	const sender = flag(args, "sender");
	if (!sender || !isValidSenderId(sender)) {
		exitUsage(`--sender needs a sender id: lowercase a-z, 0-9 and . _ : - (1-64 chars), e.g. openclaw:home:main.\n${USAGE}`);
	}
	if (!loadExternalSenders().some((s) => s.id === sender)) {
		exitError(
			`Unknown external sender "${sender}".`,
			`Register it first in ${externalSendersRegistryPath()} as {"senders": {"${sender}": {"label": "…"}}}.`,
			CLI_EXIT_CODE_EXTERNAL_SENDER_UNKNOWN,
		);
	}
	const projects = parseProjects(flag(args, "projects"), context);
	const scopes = parseScopes(flag(args, "scope"));
	const now = Date.now();
	const expiresAt = parseExpiry(flag(args, "expires"), now);
	const autoApprove = args.flags["auto-approve"] === "true";
	if (autoApprove && !scopes.includes("start")) exitUsage("--auto-approve only applies with the start scope.");

	const { token, id, sha256 } = generateMcpToken();
	const record: McpTokenRecord = {
		id, sha256, sender, scopes, projects, autoApprove,
		label: flag(args, "label") || null,
		createdAt: new Date(now).toISOString(),
		expiresAt,
		revokedAt: null,
	};
	const config = await updateMcpConfig((c) => {
		c.tokens.push(record);
		return c;
	});

	if (args.flags.json === "true") {
		process.stdout.write(`${JSON.stringify({ token, id, sender, scopes, projects, expiresAt, autoApprove })}\n`);
	} else {
		process.stdout.write(
			`${token}\n\n` +
			`Token ${id} for ${sender}: scopes ${scopes.join(",")}, projects ${projects.join(",")}, ` +
			`${expiresAt ? `expires ${expiresAt}` : "never expires"}.\n` +
			"This is the only time it is shown. Paste it into the client's secret config, never into a chat.\n\n" +
			`Client: POST http://127.0.0.1:${config.listen.port}/mcp with header "Authorization: Bearer <token>"\n` +
			`  claude mcp add --transport http --scope project dev3 http://127.0.0.1:${config.listen.port}/mcp --header "Authorization: Bearer \${DEV3_MCP_TOKEN}"\n`,
		);
	}
	if (scopes.some((s) => DRIVING_SCOPES.includes(s))) {
		process.stderr.write(
			"warning: send/start/write/content let the holder drive agents that have a shell. Give them to a program such as a bridge plugin, not to a model-driven client.\n",
		);
	}
	if (autoApprove) process.stderr.write("warning: --auto-approve lets this token's launches start unattended after the configured delay.\n");
	if (!config.enabled) process.stderr.write("The listener is off: run `dev3 mcp enable` to start it.\n");
}

function tokenRows(tokens: McpTokenRecord[]) {
	return tokens.map(({ sha256: _hash, ...rest }) => ({ ...rest, live: tokenIsLive(rest as McpTokenRecord) }));
}

function readOrExit() {
	const read = readMcpConfig();
	if (!read.ok) exitError(`Cannot read ${mcpConfigPath()}: ${read.error}`);
	return read.config;
}

function list(args: ParsedArgs): void {
	rejectUnknownFlags(args, ["json"]);
	const rows = tokenRows(readOrExit().tokens);
	if (args.flags.json === "true") {
		process.stdout.write(`${JSON.stringify({ schemaVersion: 1, tokens: rows }, null, 2)}\n`);
		return;
	}
	if (rows.length === 0) {
		process.stdout.write("No MCP tokens. Issue one with: dev3 mcp token issue --sender <id> --projects <ids>\n");
		return;
	}
	printTable(
		["ID", "SENDER", "SCOPES", "PROJECTS", "LABEL", "CREATED", "EXPIRES", "STATE"],
		rows.map((t) => [
			t.id, t.sender, t.scopes.join(","), t.projects.map((p) => (p === "*" ? "*" : p.slice(0, 8))).join(","), t.label ?? "-",
			t.createdAt.slice(0, 10), t.expiresAt?.slice(0, 10) ?? "never", t.revokedAt ? "revoked" : t.live ? "live" : "expired",
		]),
	);
}

async function revoke(args: ParsedArgs, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, []);
	refuseInsideTask(context);
	const id = args.positional[0]?.trim();
	if (!id || args.positional.length > 1) exitUsage(`Pass the token id to revoke (from \`dev3 mcp token list\`).\n${USAGE}`);
	const outcome = await updateMcpConfig((c) => {
		const token = c.tokens.find((t) => t.id === id);
		if (!token) return "missing" as const;
		if (token.revokedAt) return "already" as const;
		token.revokedAt = new Date().toISOString();
		return "revoked" as const;
	});
	if (outcome === "missing") exitError(`No MCP token ${id}.`, "Run `dev3 mcp token list` for the ids.");
	process.stdout.write(outcome === "already" ? `Token ${id} was already revoked.\n` : `Revoked token ${id}; its next request is refused.\n`);
}

async function setEnabled(args: ParsedArgs, context: CliContext | null, enabled: boolean): Promise<void> {
	rejectUnknownFlags(args, enabled ? ["port"] : []);
	refuseInsideTask(context);
	const rawPort = enabled ? flag(args, "port") : undefined;
	const port = rawPort === undefined ? undefined : Number(rawPort);
	if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) exitUsage(`Invalid --port "${rawPort}". Use 1..65535.`);
	const config = await updateMcpConfig((c) => {
		c.enabled = enabled;
		if (port !== undefined) c.listen.port = port;
		return c;
	});
	process.stdout.write(
		enabled
			? `MCP listener enabled on 127.0.0.1:${config.listen.port}/mcp. The running app picks it up within a few seconds.\n`
			: "MCP listener disabled. The running app closes it within a few seconds.\n",
	);
}

async function status(args: ParsedArgs, socketPath: string | null): Promise<void> {
	rejectUnknownFlags(args, ["json"]);
	const config = readOrExit();
	const resp = socketPath ? await sendRequest(socketPath, "mcp.status", {}).catch(() => null) : null;
	const app = resp?.ok ? resp.data as Record<string, unknown> : null;
	const live = config.tokens.filter((t) => tokenIsLive(t));
	const perSender: Record<string, number> = {};
	for (const t of live) perSender[t.sender] = (perSender[t.sender] ?? 0) + 1;
	const payload = {
		schemaVersion: 1,
		storePath: mcpConfigPath(),
		enabled: config.enabled,
		port: config.listen.port,
		app: app ?? null,
		liveTokensPerSender: perSender,
	};
	if (args.flags.json === "true") {
		process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		return;
	}
	const out = (line: string) => process.stdout.write(`${line}\n`);
	out(`Store:     ${payload.storePath}`);
	out(`Enabled:   ${config.enabled ? "yes" : "no"} (port ${config.listen.port})`);
	if (!app) out("App:       not reachable — start dev3 to serve MCP.");
	else {
		out(`Listening: ${app.listening ? `yes, 127.0.0.1:${app.port}` : "no"}${app.bindError ? ` — bind error: ${app.bindError}` : ""}${app.guest ? " (guest instance: never binds)" : ""}`);
		if (app.storeError) out(`Store error: ${app.storeError} — every token is refused until it is fixed.`);
	}
	out(`Tokens:    ${Object.entries(perSender).map(([s, n]) => `${s} ×${n}`).join(", ") || "none live"}`);
	const calls = (app?.recentCalls as Array<Record<string, unknown>> | undefined) ?? [];
	if (calls.length > 0) {
		out("");
		printTable(["AT", "TOKEN", "SENDER", "TOOL", "EXIT", "ERROR", "MS"], calls.map((c) => [
			String(c.at).slice(11, 19), String(c.tokenId), String(c.sender), String(c.tool), String(c.exitCode), String(c.errorCode ?? "-"), String(c.ms),
		]));
	}
}

/** `dev3 mcp …`: the network API's token store and on/off switch. Needs no running app, except `status`. */
export async function handleMcp(subcommand: string | undefined, args: ParsedArgs, context: CliContext | null, socketPath: string | null): Promise<void> {
	if (subcommand === "token") {
		const [verb, ...rest] = args.positional;
		const sub = { ...args, positional: rest };
		if (verb === "issue") return issue(sub, context);
		if (verb === "list") return list(sub);
		if (verb === "revoke") return revoke(sub, context);
		exitUsage(USAGE);
	}
	if (subcommand === "enable") return setEnabled(args, context, true);
	if (subcommand === "disable") return setEnabled(args, context, false);
	if (subcommand === "status") return status(args, socketPath);
	exitUsage(USAGE);
}
