/**
 * The models an agent-dir harness (omp, pi) offers for one dev3 account: the
 * harness's own model listing in that account's agent dir, narrowed to the
 * providers the account signed in to. Both harnesses also count every provider
 * with an API key in the environment as available; those are not the account's,
 * so they stay out. The model the harness itself is set to start on leads the
 * list, so the launch picker's preselect matches what a bare launch would run.
 *
 * - omp: `omp models --json`, default from `omp config get modelRoles --json`.
 * - pi: `pi --list-models` (a text table — pi has no JSON form), default from
 *   `defaultProvider` + `defaultModel` in the agent dir's settings.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ENV_UNSET, type AgentDirAccountKind, type ProviderLogin } from "../shared/agent-accounts";
import { sortLiveModelsNewestFirst, type AgentLiveModels, type LiveModel } from "../shared/agent-live-models";
import { getActiveAgentDirSessionEnv, listAgentDirLogins } from "./agent-accounts";
import { createLogger } from "./logger";
import { spawn } from "./spawn";

const log = createLogger("agent-dir-live-models");
const CACHE_TTL_MS = 60_000;
const TIMEOUT_MS = 20_000;

interface OmpModelRow {
	provider?: unknown;
	kind?: unknown;
	id?: unknown;
	selector?: unknown;
	name?: unknown;
}

/** Chat models from `omp models --json`. Throws on a shape omp no longer prints,
 *  so a format change reads as "unknown", never as "none". */
export function parseOmpModels(json: unknown): LiveModel[] {
	const rows = (json as { models?: unknown })?.models;
	if (!Array.isArray(rows)) throw new Error("omp models --json: no models array");
	const models: LiveModel[] = [];
	for (const row of rows as OmpModelRow[]) {
		if (typeof row.provider !== "string" || typeof row.id !== "string" || typeof row.selector !== "string") continue;
		if (row.kind !== undefined && row.kind !== "chat") continue;
		models.push({
			selector: row.selector,
			provider: row.provider,
			id: row.id,
			name: typeof row.name === "string" && row.name.trim() ? row.name : row.id,
		});
	}
	return models;
}

/** Rows of `pi --list-models`: a `provider  model  context …` table, or pi's
 *  "No models available" notice. Anything else throws, for the same reason. */
export function parsePiModelList(text: string): LiveModel[] {
	const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
	if (lines.length === 0 || lines[0].startsWith("No models available")) return [];
	const [provider, model] = lines[0].split(/\s+/);
	if (provider !== "provider" || model !== "model") throw new Error("pi --list-models: unexpected header");
	return lines.slice(1).flatMap((line) => {
		const [rowProvider, id] = line.split(/\s+/);
		return rowProvider && id ? [{ selector: `${rowProvider}/${id}`, provider: rowProvider, id, name: id }] : [];
	});
}

/** The account's models: only its signed-in providers, the harness's own default
 *  first, then newest first. */
export function rankLiveModels(models: readonly LiveModel[], logins: readonly ProviderLogin[], defaultSelector: string | null = null): LiveModel[] {
	const providers = new Set(logins.map((login) => login.provider));
	const sorted = sortLiveModelsNewestFirst(models.filter((model) => providers.has(model.provider)));
	const preferred = sorted.findIndex((model) => model.selector === defaultSelector);
	return preferred > 0 ? [sorted[preferred], ...sorted.slice(0, preferred), ...sorted.slice(preferred + 1)] : sorted;
}

async function runHarness(command: AgentDirAccountKind, args: string[], agentDir: string | null): Promise<string> {
	const proc = spawn([command, ...args], {
		env: agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {},
		// pi reads project-local config from its cwd; the account dir has none.
		cwd: command === "pi" ? (agentDir ?? undefined) : undefined,
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
	try {
		const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
		if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited with code ${code}`);
		return out;
	} finally {
		clearTimeout(timer);
	}
}

/** `modelRoles.default` from omp's settings as that agent dir sees them; null when unset or unreadable. */
async function readOmpDefaultModel(agentDir: string | null): Promise<string | null> {
	try {
		const answer = JSON.parse(await runHarness("omp", ["config", "get", "modelRoles", "--json"], agentDir)) as { value?: { default?: unknown } } | null;
		const selector = answer?.value?.default;
		return typeof selector === "string" && selector.includes("/") ? selector : null;
	} catch (err) {
		log.warn("Could not read omp's default model", { error: String(err) });
		return null;
	}
}

/** pi's startup model (`defaultProvider` + `defaultModel` in settings.json); null when either is unset. */
async function readPiDefaultModel(agentDir: string | null): Promise<string | null> {
	const file = join(agentDir ?? join(homedir(), ".pi", "agent"), "settings.json");
	try {
		if (!existsSync(file)) return null;
		const settings = JSON.parse(readFileSync(file, "utf-8")) as { defaultProvider?: unknown; defaultModel?: unknown };
		const { defaultProvider: provider, defaultModel: model } = settings;
		return typeof provider === "string" && provider && typeof model === "string" && model ? `${provider}/${model}` : null;
	} catch (err) {
		log.warn("Could not read pi's default model", { error: String(err) });
		return null;
	}
}

async function listHarnessModels(kind: AgentDirAccountKind, agentDir: string | null): Promise<LiveModel[]> {
	if (kind === "omp") return parseOmpModels(JSON.parse(await runHarness("omp", ["models", "--json"], agentDir)));
	// --offline: no catalog refresh on the way; --no-approve: no project-local config.
	return parsePiModelList(await runHarness("pi", ["--offline", "--no-approve", "--list-models"], agentDir));
}

export interface AgentDirLiveModelDeps {
	resolveAgentDir: (accountId?: string | null) => Promise<string | null>;
	listLogins: (agentDir: string | null) => Promise<ProviderLogin[]>;
	listModels: (agentDir: string | null) => Promise<LiveModel[]>;
	readDefaultModel: (agentDir: string | null) => Promise<string | null>;
	now: () => number;
}

function defaultDeps(kind: AgentDirAccountKind): AgentDirLiveModelDeps {
	return {
		// The agent dir a launch on this account would use; null = the harness's own default.
		resolveAgentDir: async (accountId) => {
			const dir = (await getActiveAgentDirSessionEnv(kind, accountId)).PI_CODING_AGENT_DIR;
			return dir && dir !== ENV_UNSET ? dir : null;
		},
		listLogins: (agentDir) => listAgentDirLogins(kind, agentDir),
		listModels: (agentDir) => listHarnessModels(kind, agentDir),
		readDefaultModel: kind === "omp" ? readOmpDefaultModel : readPiDefaultModel,
		now: () => Date.now(),
	};
}

const cache = new Map<string, { at: number; value: AgentLiveModels }>();

export function clearAgentDirLiveModelCache(): void {
	cache.clear();
}

/** Best-effort: anything that goes wrong answers `unknown`, which leaves the
 *  picker exactly as it was without live models. */
export async function getAgentDirLiveModels(
	kind: AgentDirAccountKind,
	accountId?: string | null,
	options: { refresh?: boolean } = {},
	deps: AgentDirLiveModelDeps = defaultDeps(kind),
): Promise<AgentLiveModels> {
	let agentDir: string | null;
	try {
		agentDir = await deps.resolveAgentDir(accountId);
	} catch (err) {
		log.warn("Could not resolve the account for live models", { kind, error: String(err) });
		return { status: "unknown" };
	}
	const key = `${kind}:${agentDir ?? ""}`;
	const hit = cache.get(key);
	if (!options.refresh && hit && deps.now() - hit.at < CACHE_TTL_MS) return hit.value;
	let value: AgentLiveModels;
	try {
		const logins = await deps.listLogins(agentDir);
		if (logins.length === 0) {
			value = { status: "resolved", models: [] };
		} else {
			const [models, defaultSelector] = await Promise.all([deps.listModels(agentDir), deps.readDefaultModel(agentDir)]);
			value = { status: "resolved", models: rankLiveModels(models, logins, defaultSelector) };
		}
	} catch (err) {
		log.warn("Live model listing failed", { kind, error: String(err) });
		return { status: "unknown" };
	}
	cache.set(key, { at: deps.now(), value });
	return value;
}
