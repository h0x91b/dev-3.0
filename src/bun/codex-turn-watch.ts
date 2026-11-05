import { closeSync, openSync, readSync, statSync, unwatchFile, watchFile } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { createLogger } from "./logger";

const log = createLogger("codex-turn-watch");

/**
 * Codex fires no hook when an API error (403, usage limit, auth) ends a turn —
 * no `Stop`, nothing — so the board would keep saying "Agent is Working".
 * The rollout still records it as a `task_complete` carrying an `error`, so the
 * turn's rollout is tailed from the prompt until that record lands.
 */
export interface CodexTurnObservation {
	projectId: string;
	taskId: string;
	sessionId: string;
	transcriptPath: string;
}

export interface CodexTurnFailure extends CodexTurnObservation {
	message: string;
}

/** `undefined`: not a turn end. `null`: a clean end. A string: the turn died on that error. */
export function codexTurnEndError(line: string): string | null | undefined {
	try {
		const record = JSON.parse(line) as { type?: unknown; payload?: { type?: unknown; error?: { message?: unknown } | null } };
		if (record.type !== "event_msg") return undefined;
		if (record.payload?.type === "turn_aborted") return null;
		if (record.payload?.type !== "task_complete") return undefined;
		const error = record.payload.error;
		if (!error) return null;
		return typeof error.message === "string" && error.message.trim() ? error.message : "";
	} catch {
		return undefined;
	}
}

interface Observation {
	input: CodexTurnObservation;
	offset: number;
	partial: string;
	decoder: StringDecoder;
	changed: () => void;
	onFailure: (failure: CodexTurnFailure) => Promise<void>;
}

export class CodexTurnWatches {
	private observations = new Map<string, Observation>();

	observe(input: CodexTurnObservation, onFailure: Observation["onFailure"]): void {
		const key = this.key(input.taskId, input.sessionId);
		this.remove(key);
		// Codex creates a fresh session's rollout lazily, so a missing file is watched from its start.
		let offset = 0;
		try { offset = statSync(input.transcriptPath).size; } catch { /* not written yet */ }
		const changed = () => { void this.check(input.taskId, input.sessionId).catch(error => log.warn("Rollout check failed", { error: String(error) })); };
		this.observations.set(key, { input, offset, partial: "", decoder: new StringDecoder("utf8"), changed, onFailure });
		// ponytail: lost on app restart mid-turn; the next prompt re-arms it.
		try { watchFile(input.transcriptPath, { persistent: false, interval: 1000 }, changed); }
		catch { this.remove(key); }
	}

	async check(taskId: string, sessionId: string): Promise<void> {
		const key = this.key(taskId, sessionId);
		const observation = this.observations.get(key);
		if (!observation) return;
		const chunk = this.readAppended(observation);
		if (chunk === null) { this.remove(key); return; }
		const lines = (observation.partial + chunk).split("\n");
		observation.partial = lines.pop() ?? "";
		for (const line of lines) {
			const error = codexTurnEndError(line);
			if (error === undefined) continue;
			this.remove(key);
			if (error !== null) await observation.onFailure({ ...observation.input, message: error });
			return;
		}
	}

	endTurn(taskId: string, sessionId: string): void { this.remove(this.key(taskId, sessionId)); }

	forgetTask(taskId: string): void {
		for (const [key, observation] of this.observations) if (observation.input.taskId === taskId) this.remove(key);
	}

	close(): void { for (const key of this.observations.keys()) this.remove(key); }

	private readAppended(observation: Observation): string | null {
		let fd: number | null = null;
		let size: number;
		try { size = statSync(observation.input.transcriptPath).size; } catch { return ""; }
		try {
			if (size < observation.offset) return null;
			const length = size - observation.offset;
			if (length === 0) return "";
			const buffer = Buffer.alloc(length);
			fd = openSync(observation.input.transcriptPath, "r");
			const read = readSync(fd, buffer, 0, length, observation.offset);
			observation.offset += read;
			return observation.decoder.write(buffer.subarray(0, read));
		} catch {
			return null;
		} finally {
			if (fd !== null) closeSync(fd);
		}
	}

	private key(taskId: string, sessionId: string): string { return `${taskId}:${sessionId}`; }
	private remove(key: string): void {
		const observation = this.observations.get(key);
		if (observation) unwatchFile(observation.input.transcriptPath, observation.changed);
		this.observations.delete(key);
	}
}

export const codexTurnWatches = new CodexTurnWatches();
