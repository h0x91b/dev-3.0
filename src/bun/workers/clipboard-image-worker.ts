import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { parentPort, workerData } from "node:worker_threads";
import type { ClipboardImageJob, ClipboardImageReply } from "../clipboard-image-reader";

// Electrobun's Linux clipboard calls wait on GTK until the clipboard owner answers,
// which a stalled owner stretches past two minutes; here that blocks only this thread.
// The library is already loaded by Electrobun, so dlopen shares its handle and state.
// Bundled to dist/workers by scripts/build-cli.ts.
function readClipboard({ libraryPath }: ClipboardImageJob): ClipboardImageReply {
	const lib = dlopen(libraryPath, {
		clipboardAvailableFormats: { args: [], returns: FFIType.cstring },
		clipboardReadImage: { args: [FFIType.ptr], returns: FFIType.ptr },
	});
	try {
		const raw = lib.symbols.clipboardAvailableFormats();
		const formats = raw ? String(raw).split(",").filter((f) => f.length > 0) : [];
		if (!formats.includes("image")) return { ok: true, formats, image: null };
		const size = new BigUint64Array(1);
		const data = lib.symbols.clipboardReadImage(ptr(size));
		const length = Number(size[0]);
		const image = data && length > 0 ? new Uint8Array(toArrayBuffer(data, 0, length)).slice() : null;
		return { ok: true, formats, image };
	} finally {
		lib.close();
	}
}

try {
	parentPort?.postMessage(readClipboard(workerData as ClipboardImageJob));
} catch (error) {
	parentPort?.postMessage({ ok: false, error: String(error) } satisfies ClipboardImageReply);
}
