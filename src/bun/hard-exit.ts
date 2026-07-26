/**
 * Leave the desktop process with a real exit code — for real.
 *
 * Two layers of the runtime fight this:
 *
 * 1. Electrobun REPLACES `process.exit`. The first call routes into its own
 *    `quit()`, which emits `before-quit` (our gate can cancel it) and always ends
 *    in `forceExit(0)` — so a desktop-side `process.exit(8)` exits 0.
 * 2. `process.reallyExit` is not patched and works in a plain Bun process
 *    (`bun -e "process.reallyExit(8)"` exits 8), but it does NOT end an electrobun
 *    app: measured on Windows, the app logged its cleanup and then stayed alive
 *    for minutes with the native runtime still holding the process (decision 177).
 *
 * So the primary exit is the OS primitive — `ExitProcess` / `_exit` — which
 * terminates every thread of the process with the code we ask for, native runtime
 * included. `bun:ffi` is imported dynamically: this module is also loaded by tests
 * running under Node, and the import only happens on the failure path.
 *
 * All of these skip exit handlers and buffered stream flushes, so callers must
 * have written their diagnostic synchronously (`writeSync`) beforehand.
 */

export interface ExitCapableProcess {
	exit: (code?: number) => never;
	reallyExit?: (code: number) => void;
	platform: NodeJS.Platform;
}

export interface HardExitDeps {
	proc?: ExitCapableProcess;
	/** Injected in tests; the default goes through `bun:ffi`. */
	osExit?: (code: number, platform: NodeJS.Platform) => void | Promise<void>;
}

async function ffiOsExit(code: number, platform: NodeJS.Platform): Promise<void> {
	const { dlopen, FFIType } = await import("bun:ffi");
	if (platform === "win32") {
		// TerminateProcess, not ExitProcess: `ExitProcess(8)` runs loader/CRT
		// teardown while electrobun's native threads are live, and Bun fail-fasts
		// on the way out — the process died with 0xC0000409 instead of 8 (measured).
		// TerminateProcess kills every thread immediately with the code we pass,
		// which is safe here because our own cleanup already ran.
		const lib = dlopen("kernel32.dll", {
			GetCurrentProcess: { args: [], returns: FFIType.ptr },
			TerminateProcess: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		});
		lib.symbols.TerminateProcess(lib.symbols.GetCurrentProcess(), code);
		return;
	}
	const library = platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
	const lib = dlopen(library, {
		_exit: { args: [FFIType.u32], returns: FFIType.void },
	});
	lib.symbols._exit(code);
}

/**
 * Never returns in practice. Ordered attempts: OS primitive → `reallyExit` →
 * electrobun's `process.exit`, so a platform where the FFI lookup fails still
 * gets the best available exit instead of a process that refuses to die.
 */
export async function hardExit(code: number, deps: HardExitDeps = {}): Promise<void> {
	const proc = deps.proc ?? (process as unknown as ExitCapableProcess);
	const osExit = deps.osExit ?? ffiOsExit;
	try {
		await osExit(code, proc.platform);
	} catch {
		// dlopen or the symbol lookup failed — fall through to the JS exits.
	}
	try {
		proc.reallyExit?.(code);
	} catch {
		// ignore — the last resort below is electrobun's own exit
	}
	proc.exit(code);
}
