/**
 * Observe a directory of `YYYY-MM-DD.jsonl` day-files and call back when its
 * contents actually change.
 *
 * Both append-only logs on disk — the per-project agent message log and the
 * global notification archive — are written by whichever dev3 instance the CLI
 * addressed, and read by all of them. The writer pushes to its own renderer;
 * every other instance only learns about the append from the filesystem. This is
 * that half, and it is deliberately one implementation rather than two: the
 * awkward parts (macOS missing native events, a directory that does not exist
 * yet, a day-file the retention prune deletes underneath the watcher) were paid
 * for once and must not be re-derived per log.
 *
 * A change is a CHANGE, not an event: the callback fires only when the
 * fingerprint (name, size, mtime of every day-file) differs from the last one it
 * reported, so a poll that finds nothing new costs nothing downstream.
 */

import { existsSync, readdirSync, statSync, unwatchFile, watch, watchFile, type FSWatcher } from "node:fs";
import { basename, dirname, relative, sep } from "node:path";

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

interface DayFileWatch {
	directory: string;
	/** Called after the fingerprint changed. Must never throw. */
	notify: () => void;
	watchedPath: string;
	watcher?: FSWatcher;
	fileWatchers: Map<string, { watcher?: FSWatcher; changed: () => void }>;
	directoryChanged?: () => void;
	timer?: ReturnType<typeof setTimeout>;
	fingerprint: string;
}

const watches = new Map<string, DayFileWatch>();

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

function schedule(state: DayFileWatch): void {
	if (state.timer) clearTimeout(state.timer);
	state.timer = setTimeout(() => {
		state.timer = undefined;
		attach(state);
		const next = fingerprint(state.directory);
		if (next === state.fingerprint) return;
		state.fingerprint = next;
		try { state.notify(); }
		catch { /* A closed renderer must not break filesystem observation. */ }
	}, 100);
	state.timer.unref?.();
}

function attach(state: DayFileWatch): void {
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
		// metadata for discovery; file contents are never polled.
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
			// unchanged files cause no push and no history read.
			watchFile(`${state.directory}/${file}`, { persistent: false, interval: 1000 }, changed);
			state.fileWatchers.set(file, observation);
		} catch { /* A concurrent prune may remove this day. */ }
	}
}

/**
 * Start (or refresh) observation of `directory`. Idempotent per directory: the
 * first caller's `notify` is the one kept, so a read handler may call this on
 * every request without stacking watchers or swapping the callback underneath.
 */
export function watchDayFiles(directory: string, notify: () => void): void {
	let state = watches.get(directory);
	if (!state) {
		state = { directory, notify, watchedPath: "", fileWatchers: new Map(), fingerprint: fingerprint(directory) };
		watches.set(directory, state);
	}
	attach(state);
	schedule(state);
}

/** The writer already pushed this append; suppress its duplicate filesystem notification. */
export function noteLocalDayFileAppend(directory: string): void {
	const state = watches.get(directory);
	if (state) state.fingerprint = fingerprint(directory);
}

export function stopDayFileWatches(): void {
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
