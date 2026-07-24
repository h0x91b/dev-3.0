import "@testing-library/jest-dom/vitest";
import { createElement } from "react";

// NOTE on transport detection in tests: happy-dom has no `__electrobunWebviewId`,
// so `isRemote()` (utils/platform) reports browser-remote by default — the SAME
// signal `rpc.ts` uses to pick its transport. We deliberately do NOT fake the
// flag globally: setting it flips `rpc.ts` into the Electrobun bridge path, which
// throws at import in files that use the real rpc module. Tests that need the
// desktop keymap (e.g. ⌘Q, zoom) set the flag themselves AND mock rpc — see
// App.test.tsx / zoom.test.ts / KeyboardShortcutsModal.test.tsx.

// Node 26 exposes an experimental global `localStorage` that is undefined unless
// --localstorage-file is passed, and it shadows happy-dom's on both globalThis
// and window (sessionStorage is unaffected). Substitute an in-memory Storage —
// setupFiles run per test file, so each file gets a fresh, isolated store, which
// is the isolation happy-dom's own storage provided.
if (typeof globalThis.localStorage === "undefined") {
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
