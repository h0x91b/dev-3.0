import { existsSync, readFileSync, readdirSync, realpathSync, statSync, unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import { parseClaudeSessionState, claudeSessionBecameIdle, type ClaudeSessionState } from "../shared/claude-session-state";
import { createLogger } from "./logger";

const log = createLogger("claude-session-watch");

export interface ClaudeSessionObservation {
	projectId: string;
	taskId: string;
	paneId: string;
	sessionId: string;
	directory: string;
	cwd: string;
}

export interface ClaudeIdleEvent extends ClaudeSessionObservation {
	generation: number;
	statusUpdatedAt: number;
}

interface Observation {
	input: ClaudeSessionObservation;
	path: string;
	previous: ClaudeSessionState;
	generation: number;
	changed: () => void;
	onIdle: (event: ClaudeIdleEvent) => Promise<void>;
	reported: boolean;
}

function readState(path: string): ClaudeSessionState | null {
	try {
		if (statSync(path).size > 64 * 1024) return null;
		return parseClaudeSessionState(JSON.parse(readFileSync(path, "utf8")));
	} catch { return null; }
}

function samePath(a: string, b: string): boolean {
	try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Observe native state changes, never elapsed silence or terminal keystrokes. */
export class ClaudeSessionWatches {
	private observations = new Map<string, Observation>();
	private generation = 0;

	constructor(private isAlive: (pid: number) => boolean = processAlive) {}

	observe(input: ClaudeSessionObservation, onIdle: Observation["onIdle"]): void {
		const key = this.key(input.taskId, input.paneId);
		this.remove(key);
		let files: string[];
		try { files = readdirSync(input.directory).filter(name => /^\d+\.json$/.test(name)); } catch { return; }
		const matches = files.flatMap(name => {
			const path = join(input.directory, name);
			const state = readState(path);
			return state && state.sessionId === input.sessionId && samePath(state.cwd, input.cwd) && this.isAlive(state.pid)
				? [{ path, state }] : [];
		});
		if (matches.length !== 1) return;
		const { path, state } = matches[0]!;
		const changed = () => { void this.check(input.taskId, input.paneId).catch(error => log.warn("Session observation failed", { error: String(error) })); };
		this.observations.set(key, { input, path, previous: state, generation: ++this.generation, changed, onIdle, reported: false });
		// Metadata polling also works on Bun/macOS where fs.watch can miss events.
		// The interval samples a declared state; it is never an inactivity timeout.
		try { watchFile(path, { persistent: false, interval: 250 }, changed); }
		catch { this.remove(key); }
	}

	async check(taskId: string, paneId: string): Promise<void> {
		const key = this.key(taskId, paneId);
		const observation = this.observations.get(key);
		if (!observation || observation.reported) return;
		const next = readState(observation.path);
		if (!next) {
			if (!existsSync(observation.path)) this.remove(key);
			return;
		}
		if (!this.isAlive(next.pid)) { this.remove(key); return; }
		const previous = observation.previous;
		if (next.pid !== previous.pid || next.sessionId !== previous.sessionId || next.startedAt !== previous.startedAt || next.cwd !== previous.cwd) {
			this.remove(key);
			return;
		}
		if (next.statusUpdatedAt < previous.statusUpdatedAt) return;
		const idle = claudeSessionBecameIdle(observation.previous, next);
		observation.previous = next;
		if (!idle) return;
		observation.reported = true;
		unwatchFile(observation.path, observation.changed);
		await observation.onIdle({ ...observation.input, generation: observation.generation, statusUpdatedAt: next.statusUpdatedAt });
	}

	isCurrentIdle(event: ClaudeIdleEvent): boolean {
		const observation = this.observations.get(this.key(event.taskId, event.paneId));
		if (!observation || observation.generation !== event.generation) return false;
		const state = this.currentIdle(observation);
		return state?.statusUpdatedAt === event.statusUpdatedAt;
	}

	allIdle(taskId: string, panes: ReadonlyArray<{ paneId?: string | null; sessionId?: string | null }>): boolean {
		return panes.length > 0 && panes.every(pane => {
			if (!pane.paneId || !pane.sessionId) return false;
			const observation = this.observations.get(this.key(taskId, pane.paneId));
			return observation?.input.sessionId === pane.sessionId && this.currentIdle(observation) !== null;
		});
	}

	forgetTask(taskId: string): void {
		for (const [key, observation] of this.observations) if (observation.input.taskId === taskId) this.remove(key);
	}

	endTurn(taskId: string, paneId: string, sessionId: string): void {
		const observation = this.observations.get(this.key(taskId, paneId));
		if (!observation || observation.input.sessionId !== sessionId) return;
		observation.reported = true;
		observation.generation = ++this.generation;
		unwatchFile(observation.path, observation.changed);
	}

	close(): void { for (const key of this.observations.keys()) this.remove(key); }

	private currentIdle(observation: Observation): ClaudeSessionState | null {
		const state = readState(observation.path);
		const previous = observation.previous;
		return state && state.status === "idle" && state.sessionId === observation.input.sessionId
			&& state.pid === previous.pid && state.startedAt === previous.startedAt
			&& state.statusUpdatedAt >= previous.statusUpdatedAt
			&& samePath(state.cwd, observation.input.cwd) && this.isAlive(state.pid) ? state : null;
	}

	private key(taskId: string, paneId: string): string { return `${taskId}:${paneId}`; }
	private remove(key: string): void {
		const observation = this.observations.get(key);
		if (observation) unwatchFile(observation.path, observation.changed);
		this.observations.delete(key);
	}
}

export const claudeSessionWatches = new ClaudeSessionWatches();
