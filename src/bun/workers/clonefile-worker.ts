import { dlopen, FFIType } from "bun:ffi";
import { parentPort, workerData } from "node:worker_threads";
import type { ClonefileJob, ClonefileReply } from "../cow-clone";

// clonefile(2) on a directory clones the whole tree in one syscall that can run
// for seconds; here it blocks only this thread, never the host's event loop.
// Bundled to dist/workers by scripts/build-cli.ts.
function cloneTree({ src, dst }: ClonefileJob): ClonefileReply {
	const lib = dlopen("libSystem.B.dylib", {
		clonefile: { args: [FFIType.cstring, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
	});
	try {
		const result = lib.symbols.clonefile(Buffer.from(`${src}\0`, "utf-8"), Buffer.from(`${dst}\0`, "utf-8"), 0);
		return result === 0 ? { ok: true } : { ok: false, error: `clonefile returned ${result}` };
	} finally {
		lib.close();
	}
}

try {
	parentPort?.postMessage(cloneTree(workerData as ClonefileJob));
} catch (error) {
	parentPort?.postMessage({ ok: false, error: String(error) } satisfies ClonefileReply);
}
