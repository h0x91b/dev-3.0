// Stub Bun global for vitest (runs in Node.js, not Bun runtime)
// Must run before any src/bun/ module is imported.
(globalThis as any).Bun = {
	serve: () => ({ port: 9999 }),
	spawn: () => ({
		pid: 0,
		terminal: { close() {}, resize() {}, write() {} },
		kill() {},
		exited: Promise.resolve(0),
		stdout: new ReadableStream(),
		stderr: new ReadableStream(),
	}),
	spawnSync: () => ({ exitCode: 0, stdout: new Uint8Array(0) }),
	write: () => Promise.resolve(0),
	file: (path: string) => {
		const fs = require("node:fs");
		let stat: any = null;
		try { stat = fs.statSync(path); } catch { /* file doesn't exist */ }
		return {
			exists: () => Promise.resolve(stat !== null),
			json: () => {
				if (!stat) return Promise.resolve({});
				return Promise.resolve(JSON.parse(fs.readFileSync(path, "utf-8")));
			},
			get size() { return stat ? stat.size : 0; },
			text: () => Promise.resolve(stat ? fs.readFileSync(path, "utf-8") : ""),
			slice: (start: number, end: number) => ({
				arrayBuffer: () => {
					if (!stat) return Promise.resolve(new ArrayBuffer(0));
					const buf = Buffer.alloc(end - start);
					const fd = fs.openSync(path, "r");
					fs.readSync(fd, buf, 0, end - start, start);
					fs.closeSync(fd);
					return Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
				},
			}),
		};
	},
};

// Stub process.env if needed
if (typeof process === "undefined") {
	(globalThis as any).process = { env: { HOME: "/tmp" } };
}
