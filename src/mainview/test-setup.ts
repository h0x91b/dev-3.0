import "@testing-library/jest-dom/vitest";

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
