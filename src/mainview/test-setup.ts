import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import { _resetPendingToastsForTests } from "./toast";
import { storageIsWritable } from "./utils/storage";

// Toasts raised without a mounted host are queued for the next host (see toast.tsx),
// so drop the queue between tests instead of leaking them into the next render.
afterEach(() => {
	_resetPendingToastsForTests();
});

// NOTE on transport detection in tests: happy-dom has no `__electrobunWebviewId`,
// so `isRemote()` (utils/platform) reports browser-remote by default — the SAME
// signal `rpc.ts` uses to pick its transport. We deliberately do NOT fake the
// flag globally: setting it flips `rpc.ts` into the Electrobun bridge path, which
// throws at import in files that use the real rpc module. Tests that need the
// desktop keymap (e.g. ⌘Q, zoom) set the flag themselves AND mock rpc — see
// App.test.tsx / zoom.test.ts / KeyboardShortcutsModal.test.tsx.

// Node's experimental localStorage may shadow happy-dom with an unusable object.
// A write/read/delete probe distinguishes it; each setup file gets a fresh store.
function localStorageWorks(): boolean {
	try {
		return storageIsWritable(globalThis.localStorage, "__dev3_test_setup_probe__");
	} catch {
		return false;
	}
}

if (!localStorageWorks()) {
	const store = new Map<string, string>();
	const storage: Storage = {
		get length() {
			return store.size;
		},
		clear: () => store.clear(),
		getItem: (key) => store.get(String(key)) ?? null,
		key: (index) => Array.from(store.keys())[index] ?? null,
		removeItem: (key) => void store.delete(String(key)),
		setItem: (key, value) => void store.set(String(key), String(value)),
	};
	for (const target of [globalThis, globalThis.window].filter(Boolean)) {
		Object.defineProperty(target, "localStorage", { value: storage, configurable: true, writable: true });
	}
}

// happy-dom has no ResizeObserver; recharts' ResponsiveContainer needs one.
if (typeof globalThis.ResizeObserver === "undefined") {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
}

// Force prefers-reduced-motion: reduce = true (happy-dom's default matchMedia
// reports false) so animation hooks (useReducedMotion/useAnimatedNumber) render
// final values synchronously in tests; every other query reports false. Tests
// that need a specific media query still redefine window.matchMedia themselves.
if (typeof window !== "undefined") {
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		writable: true,
		value: (query: string) => ({
			matches: query.includes("prefers-reduced-motion"),
			media: query,
			onchange: null,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => false,
		}),
	});
}

vi.mock("@lobehub/icons/es/icons", () => {
	const makeIcon = (name: string) => {
		const Icon = (props: Record<string, unknown>) => createElement("svg", { "data-icon": name, ...props });
		const Compound = Icon as typeof Icon & { Color: typeof Icon; Avatar: typeof Icon };
		Compound.Color = (props: Record<string, unknown>) =>
			createElement("svg", { "data-icon": `${name}-color`, ...props });
		Compound.Avatar = (props: Record<string, unknown>) =>
			createElement("svg", { "data-icon": `${name}-avatar`, ...props });
		return Compound;
	};

	return {
		Claude: makeIcon("claude"),
		Codex: makeIcon("codex"),
		Cursor: makeIcon("cursor"),
		Gemini: makeIcon("gemini"),
		OpenCode: makeIcon("opencode"),
	};
});

// posthog.ts throws at import time when VITE_POSTHOG_KEY/HOST are unset, gated on
// import.meta.env.DEV — which vitest always reports true. Mock it so every test file
// that renders a component calling capture() doesn't crash on that module-level throw.
vi.mock("./posthog", () => ({ default: { capture: () => undefined } }));

// Suppress happy-dom AbortError noise during window teardown.
// When happy-dom tears down the test window it aborts all pending fetch requests,
// which surfaces as DOMException(AbortError) stack traces in the test output.
// These are harmless and purely cosmetic — vitest writes them directly to stderr.
const _origStderrWrite = process.stderr.write.bind(process.stderr);
let _suppressAbortErrors = false;
let _suppressTimer: ReturnType<typeof setTimeout> | null = null;

process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
	const str = typeof chunk === "string" ? chunk : chunk.toString();
	if (str.includes("AbortError") || str.includes("The operation was aborted")) {
		_suppressAbortErrors = true;
		if (_suppressTimer) clearTimeout(_suppressTimer);
		_suppressTimer = setTimeout(() => { _suppressAbortErrors = false; }, 50);
		return true;
	}
	if (_suppressAbortErrors && (str.trimStart().startsWith("at ") || str.trim() === "")) {
		return true;
	}
	_suppressAbortErrors = false;
	return _origStderrWrite(chunk, ...args as []);
}) as typeof process.stderr.write;

// Collapse React's act(...) warnings into one tallied line per test file.
//
// The warning itself is worth keeping — a stray update means a test asserted before
// its component settled, which is how flakes are born. What is not worth keeping is
// React re-printing the same seven-line boilerplate for every single occurrence: one
// renderer run emitted 680 of them, ~4.7k lines, which buried everything else in the
// output. The tally below names every offending component and how often it fired, so
// nothing is hidden — it is the same signal at 1% of the volume.
const _actTally = new Map<string, number>();
const _origConsoleError = console.error.bind(console);

/** Component name lands either inlined or as React's `%s` argument. */
export function _actOffenderForTests(args: unknown[]): string | null {
	const format = typeof args[0] === "string" ? args[0] : "";
	if (/^A suspended resource finished loading inside a test/.test(format)) {
		return "<suspended resource>";
	}
	// A stray update that landed after the test's act environment was torn down.
	if (/^The current testing environment is not configured to support act/.test(format)) {
		return "<after teardown>";
	}
	const inlined = /^An update to (\S+) inside a test was not wrapped in act/.exec(format);
	if (!inlined) return null;
	return inlined[1] === "%s" ? String(args[1] ?? "unknown") : inlined[1];
}

console.error = ((...args: unknown[]) => {
	const offender = _actOffenderForTests(args);
	if (offender === null) {
		_origConsoleError(...args);
		return;
	}
	_actTally.set(offender, (_actTally.get(offender) ?? 0) + 1);
}) as typeof console.error;

// Recharts measures its container and warns when it comes back 0×0. happy-dom has no
// layout engine, so every chart in every test is 0×0 and the warning can never mean
// anything here — unlike in a browser, where it is a real finding.
const _origConsoleWarn = console.warn.bind(console);

export function _isUnlayoutableChartWarning(args: unknown[]): boolean {
	const first = typeof args[0] === "string" ? args[0] : "";
	return /The width\(0\) and height\(0\) of chart should be greater than 0/.test(first);
}

console.warn = ((...args: unknown[]) => {
	if (_isUnlayoutableChartWarning(args)) return;
	_origConsoleWarn(...args);
}) as typeof console.warn;

// No unit test makes a real HTTP request. Two separate leaks were doing exactly that:
//
//  - analytics.ts asks telemetryEnabled(), which is "on" unless something opts out, and
//    nothing does under vitest — so every renderer run fired ~24 Google Analytics hits
//    and an ipify lookup from the dev machine and from every CI runner, and printed
//    happy-dom's CORS refusal for each.
//  - importing rpc.ts is enough to POST /rpc, which happy-dom resolves against its
//    default origin localhost:3000 where nothing listens — 15 raw ECONNREFUSED dumps
//    per run, from files that never meant to talk to a server.
//
// No suite in src/mainview starts a server of its own (no Bun.serve, no createServer),
// so blocking every http(s) call costs nothing and a test that needs one mocks it.
const _origFetch = globalThis.fetch;

export function _isBlockedTestUrl(input: unknown): boolean {
	const raw = typeof input === "string"
		? input
		: input instanceof URL
			? input.href
			: typeof (input as { url?: unknown })?.url === "string"
				? (input as { url: string }).url
				: "";
	// Relative URLs count: happy-dom resolves them against its own origin and dials it.
	return /^https?:/i.test(raw) || raw.startsWith("/");
}

if (typeof _origFetch === "function") {
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		if (_isBlockedTestUrl(input)) {
			return Promise.reject(new Error("network blocked in tests"));
		}
		return _origFetch(input, init);
	}) as typeof fetch;
}


afterAll(() => {
	if (_actTally.size === 0) return;
	const tally = [..._actTally].map(([name, count]) => `${name}×${count}`).join(", ");
	_actTally.clear();
	_origConsoleError(`act(): updates outside act(...) — ${tally}`);
});
