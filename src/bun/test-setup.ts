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
	file: () => ({ exists: () => Promise.resolve(false), json: () => Promise.resolve({}) }),
};

// Stub process.env if needed
if (typeof process === "undefined") {
	(globalThis as any).process = { env: { HOME: "/tmp" } };
}
