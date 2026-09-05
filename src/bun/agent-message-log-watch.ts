import { existsSync, readdirSync, statSync, watch, watchFile, unwatchFile, type FSWatcher } from "node:fs";
import { basename, dirname, relative, sep } from "node:path";
import { getPushMessageLocal } from "./rpc-handlers/shared-pure";

interface LogWatch {
	projectId: string;
	directory: string;
	watchedPath: string;
	watcher?: FSWatcher;
	fileWatchers: Map<string, { watcher?: FSWatcher; changed: () => void }>;
	directoryChanged?: () => void;
	timer?: ReturnType<typeof setTimeout>;
	fingerprint: string;
}

const watches = new Map<string, LogWatch>();
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function fingerprint(directory: string): string {
	try {
		return readdirSync(directory).filter(name => DAY_FILE.test(name)).sort().map(name => {
			try {
				const stat = statSync(`${directory}/${name}`);
				return `${name}:${stat.size}:${stat.mtimeMs}`;
			} catch { return name; }
		}).join("|");
	} catch { return ""; }
}

function schedule(state: LogWatch): void {
	if (state.timer) clearTimeout(state.timer);
	state.timer = setTimeout(() => {
		state.timer = undefined;
		attach(state);
		const next = fingerprint(state.directory);
		if (next === state.fingerprint) return;
		state.fingerprint = next;
		try { getPushMessageLocal()?.("agentMessageLogChanged", { projectId: state.projectId }); }
		catch { /* A closed renderer must not break filesystem observation. */ }
	}, 100);
	state.timer.unref?.();
}

function attach(state: LogWatch): void {
	let target = state.directory;
	while (!existsSync(target) && dirname(target) !== target) target = dirname(target);
	if ((!state.watcher && !state.directoryChanged) || state.watchedPath !== target) {
		state.watcher?.close();
		if (state.directoryChanged) unwatchFile(state.watchedPath, state.directoryChanged);
		state.watcher = undefined;
		state.watchedPath = target;
		try {
			if (process.platform !== "darwin") state.watcher = watch(target, { persistent: false }, (_event, filename) => {
				const name = filename?.toString();
				const relevant = target === state.directory ? !name || DAY_FILE.test(name) || (_event === "rename" && name === basename(target)) : !name || name === relative(target, state.directory).split(sep)[0];
				if (relevant) schedule(state);
			});
			state.watcher?.on("error", () => { state.watcher?.close(); state.watcher = undefined; });
		} catch { /* The metadata watcher also discovers a recreated directory. */ }
		// macOS directory watchers may miss events and block close. Observe directory
		// metadata for discovery; message contents are never polled.
		state.directoryChanged = () => schedule(state);
		watchFile(target, { persistent: false, interval: 1000 }, state.directoryChanged);
	}
	let files: string[] = [];
	try { files = readdirSync(state.directory).filter(name => DAY_FILE.test(name)); } catch { /* No log yet. */ }
	for (const [file, observation] of state.fileWatchers) {
		if (files.includes(file)) continue;
		observation.watcher?.close();
		unwatchFile(`${state.directory}/${file}`, observation.changed);
		state.fileWatchers.delete(file);
	}
	for (const file of files) {
		if (state.fileWatchers.has(file)) continue;
		const changed = () => schedule(state);
		const observation: { watcher?: FSWatcher; changed: () => void } = { changed };
		try {
			if (process.platform !== "darwin") {
				observation.watcher = watch(`${state.directory}/${file}`, { persistent: false }, changed);
				observation.watcher.on("error", () => { observation.watcher?.close(); observation.watcher = undefined; });
			}
			// Bun on macOS can also miss native file events. Poll metadata only;
			// unchanged files cause no push and no message-history read.
			watchFile(`${state.directory}/${file}`, { persistent: false, interval: 1000 }, changed);
			state.fileWatchers.set(file, observation);
		} catch { /* A concurrent prune may remove this day. */ }
	}
}

/** Observe projects read by this app, including writes from older installed versions. */
export function watchAgentMessageLog(projectId: string, directory: string): void {
	let state = watches.get(directory);
	if (!state) {
		state = { projectId, directory, watchedPath: "", fileWatchers: new Map(), fingerprint: fingerprint(directory) };
		watches.set(directory, state);
	}
	attach(state);
	schedule(state);
}

/** The writer already pushed this append; suppress its duplicate filesystem notification. */
export function noteLocalMessageLogAppend(directory: string): void {
	const state = watches.get(directory);
	if (state) state.fingerprint = fingerprint(directory);
}

export function stopAgentMessageLogWatches(): void {
	for (const state of watches.values()) {
		state.watcher?.close();
		for (const [file, observation] of state.fileWatchers) {
			observation.watcher?.close();
			unwatchFile(`${state.directory}/${file}`, observation.changed);
		}
		if (state.directoryChanged) unwatchFile(state.watchedPath, state.directoryChanged);
		if (state.timer) clearTimeout(state.timer);
	}
	watches.clear();
}
