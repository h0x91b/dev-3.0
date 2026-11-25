/**
 * vitest's vm pools keep ONE global context per worker for every file it runs
 * (`decisions/2026/11/25/renderer-tests-on-vm-threads.md`). A test that patches
 * `HTMLElement.prototype`, a global, `console`, `process.env` or storage would leak into
 * the next file. This snapshot, taken before the file's own code runs and restored after
 * its last hook, gives each file the pristine realm a fresh fork used to.
 */

type Descriptors = Map<PropertyKey, PropertyDescriptor>;

function ownDescriptors(target: object): Descriptors {
	return new Map(Reflect.ownKeys(target).map((key) => [key, Object.getOwnPropertyDescriptor(target, key)!]));
}

function sameDescriptor(a: PropertyDescriptor, b: PropertyDescriptor): boolean {
	return a.value === b.value && a.get === b.get && a.set === b.set
		&& a.writable === b.writable && a.enumerable === b.enumerable && a.configurable === b.configurable;
}

function restore(target: object, saved: Descriptors): void {
	for (const key of Reflect.ownKeys(target)) {
		if (saved.has(key)) continue;
		try { Reflect.deleteProperty(target, key); } catch { /* non-configurable: leave it */ }
	}
	for (const [key, descriptor] of saved) {
		const current = Object.getOwnPropertyDescriptor(target, key);
		if (current && sameDescriptor(current, descriptor)) continue;
		try { Object.defineProperty(target, key, descriptor); } catch { /* non-configurable: leave it */ }
	}
}

/** Every object a test can reasonably patch: DOM class prototypes and statics, plus the usual singletons. */
function patchableTargets(): object[] {
	const targets = new Set<object>();
	for (const key of Reflect.ownKeys(globalThis)) {
		if (typeof key !== "string" || !/^[A-Z]/.test(key)) continue;
		const value = Object.getOwnPropertyDescriptor(globalThis, key)?.value;
		if (typeof value !== "function") continue;
		targets.add(value);
		if (value.prototype && typeof value.prototype === "object") targets.add(value.prototype);
	}
	for (const extra of [console, process, process.stderr, process.stdout, globalThis.navigator, globalThis.document, globalThis.location]) {
		if (extra && typeof extra === "object") targets.add(extra);
	}
	return [...targets];
}

type TimerApi = { set: "setTimeout" | "setInterval" | "setImmediate"; clear: "clearTimeout" | "clearInterval" | "clearImmediate" };
const TIMER_APIS: TimerApi[] = [
	{ set: "setTimeout", clear: "clearTimeout" },
	{ set: "setInterval", clear: "clearInterval" },
	{ set: "setImmediate", clear: "clearImmediate" },
];

/**
 * A fork died with its file and took every pending timer along; a shared worker does not,
 * so a 10 s watchdog armed in one file fires inside a later one. Track what this file arms
 * and cancel whatever is still pending when it ends.
 */
function trackTimers(): () => void {
	const pending: Array<{ api: TimerApi; handle: unknown }> = [];
	const target = globalThis as unknown as Record<string, (...args: unknown[]) => unknown>;
	for (const api of TIMER_APIS) {
		const original = target[api.set];
		if (typeof original !== "function") continue;
		const tracked = function (this: unknown, ...args: unknown[]) {
			const handle = original.apply(this, args);
			pending.push({ api, handle });
			return handle;
		};
		Object.defineProperties(tracked, Object.getOwnPropertyDescriptors(original));
		target[api.set] = tracked;
	}
	return () => {
		for (const { api, handle } of pending) {
			try { target[api.clear]?.(handle); } catch { /* already gone */ }
		}
		pending.length = 0;
	};
}

export function guardSharedRealm(): () => void {
	const globalSnapshot = ownDescriptors(globalThis);
	const cancelTimers = trackTimers();
	const snapshots = patchableTargets().map((target) => [target, ownDescriptors(target)] as const);
	const env = { ...process.env };
	const cwd = process.cwd();
	return () => {
		cancelTimers();
		for (const [target, saved] of snapshots) restore(target, saved);
		restore(globalThis, globalSnapshot);
		for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
		Object.assign(process.env, env);
		if (process.cwd() !== cwd) process.chdir(cwd);
		for (const storage of [globalThis.localStorage, globalThis.sessionStorage]) {
			try { storage?.clear(); } catch { /* an unusable store has nothing to clear */ }
		}
	};
}
