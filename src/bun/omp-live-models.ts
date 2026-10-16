/**
 * The models omp offers for one dev3 account: `omp models --json` in that
 * account's agent dir, narrowed to the providers the account signed in to
 * (`omp usage accounts --json`). omp also counts every provider with an API key
 * in the environment as available; those are not the account's, so they stay out.
 */
import { ENV_UNSET, type OmpLogin } from "../shared/agent-accounts";
import { sortLiveModelsNewestFirst, type AgentLiveModels, type LiveModel } from "../shared/agent-live-models";
import { getActiveOmpSessionEnv, listOmpLogins } from "./agent-accounts";
import { createLogger } from "./logger";
import { spawn } from "./spawn";

const log = createLogger("omp-live-models");
const CACHE_TTL_MS = 60_000;
const TIMEOUT_MS = 20_000;

interface OmpModelRow {
	provider?: unknown;
	kind?: unknown;
	id?: unknown;
	selector?: unknown;
	name?: unknown;
}

/** Chat models of the signed-in providers, newest first. Throws on a shape omp
 *  no longer prints, so a format change reads as "unknown", never as "none". */
export function parseOmpModels(json: unknown, logins: readonly OmpLogin[]): LiveModel[] {
	const rows = (json as { models?: unknown })?.models;
	if (!Array.isArray(rows)) throw new Error("omp models --json: no models array");
	const providers = new Set(logins.map((login) => login.provider));
	const models: LiveModel[] = [];
	for (const row of rows as OmpModelRow[]) {
		if (typeof row.provider !== "string" || typeof row.id !== "string" || typeof row.selector !== "string") continue;
		if (row.kind !== undefined && row.kind !== "chat") continue;
		if (!providers.has(row.provider)) continue;
		models.push({
			selector: row.selector,
			provider: row.provider,
			id: row.id,
			name: typeof row.name === "string" && row.name.trim() ? row.name : row.id,
		});
	}
	return sortLiveModelsNewestFirst(models);
}

async function runOmpModels(agentDir: string | null): Promise<unknown> {
	const proc = spawn(["omp", "models", "--json"], {
		env: agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {},
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
	try {
		const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
		if (code !== 0) throw new Error(`omp models exited with code ${code}`);
		return JSON.parse(out);
	} finally {
		clearTimeout(timer);
	}
}

export interface OmpLiveModelDeps {
	resolveAgentDir: (accountId?: string | null) => Promise<string | null>;
	listLogins: (agentDir: string | null) => Promise<OmpLogin[]>;
	listModels: (agentDir: string | null) => Promise<unknown>;
	now: () => number;
}

/** The agent dir a launch on this account would use; null = omp's own default. */
async function resolveOmpAgentDir(accountId?: string | null): Promise<string | null> {
	const dir = (await getActiveOmpSessionEnv(accountId)).PI_CODING_AGENT_DIR;
	return dir && dir !== ENV_UNSET ? dir : null;
}

const defaultDeps: OmpLiveModelDeps = {
	resolveAgentDir: resolveOmpAgentDir,
	listLogins: listOmpLogins,
	listModels: runOmpModels,
	now: () => Date.now(),
};

const cache = new Map<string, { at: number; value: AgentLiveModels }>();

export function clearOmpLiveModelCache(): void {
	cache.clear();
}

/** Best-effort: anything that goes wrong answers `unknown`, which leaves the
 *  picker exactly as it was without live models. */
export async function getOmpLiveModels(
	accountId?: string | null,
	options: { refresh?: boolean } = {},
	deps: OmpLiveModelDeps = defaultDeps,
): Promise<AgentLiveModels> {
	let agentDir: string | null;
	try {
		agentDir = await deps.resolveAgentDir(accountId);
	} catch (err) {
		log.warn("Could not resolve the omp account for live models", { error: String(err) });
		return { status: "unknown" };
	}
	const key = agentDir ?? "";
	const hit = cache.get(key);
	if (!options.refresh && hit && deps.now() - hit.at < CACHE_TTL_MS) return hit.value;
	let value: AgentLiveModels;
	try {
		const logins = await deps.listLogins(agentDir);
		value = logins.length === 0
			? { status: "resolved", models: [] }
			: { status: "resolved", models: parseOmpModels(await deps.listModels(agentDir), logins) };
	} catch (err) {
		log.warn("omp live model listing failed", { error: String(err) });
		return { status: "unknown" };
	}
	cache.set(key, { at: deps.now(), value });
	return value;
}
