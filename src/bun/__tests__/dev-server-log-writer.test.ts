import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevServerLogWriter, readDevServerLogTail, resetDevServerLog } from "../dev-server-log";
import { DEV_SERVER_LOG_TRIM_NOTICE } from "../../shared/dev-server-log";

let root: string;
let logPath: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dev3-devlog-"));
	logPath = join(root, "logs", "dev-server.log");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("resetDevServerLog", () => {
	it("creates the directory and drops what the previous run left", () => {
		mkdirSync(join(root, "logs"), { recursive: true });
		writeFileSync(logPath, "output of a run that is over\n", "utf8");
		resetDevServerLog(logPath);
		expect(existsSync(logPath)).toBe(false);
		expect(existsSync(join(root, "logs"))).toBe(true);
	});

	it("does not throw when the directory cannot be made", () => {
		// Parent is a FILE, so the mkdir fails with ENOTDIR on every platform — no
		// dependence on a path like /proc that only exists on one of them.
		const blocker = join(root, "not-a-directory");
		writeFileSync(blocker, "", "utf8");
		expect(() => resetDevServerLog(join(blocker, "dev-server.log"))).not.toThrow();
	});
});

describe("DevServerLogWriter", () => {
	it("writes complete lines as plain text", () => {
		resetDevServerLog(logPath);
		const writer = new DevServerLogWriter(logPath);
		writer.write("\u001b[32mVITE ready\u001b[0m in 300 ms\n");
		writer.close();
		expect(readFileSync(logPath, "utf8")).toBe("VITE ready in 300 ms\n");
	});

	it("accepts raw PTY bytes, not only strings", () => {
		resetDevServerLog(logPath);
		const writer = new DevServerLogWriter(logPath);
		writer.write(new TextEncoder().encode("listening on 5173\n"));
		writer.close();
		expect(readFileSync(logPath, "utf8")).toBe("listening on 5173\n");
	});

	it("flushes the unterminated last line on close — usually the error that killed the server", () => {
		resetDevServerLog(logPath);
		const writer = new DevServerLogWriter(logPath);
		writer.write("Error: EADDRINUSE");
		expect(existsSync(logPath)).toBe(false);
		writer.close();
		expect(readFileSync(logPath, "utf8")).toBe("Error: EADDRINUSE\n");
	});

	it("ignores writes after close", () => {
		resetDevServerLog(logPath);
		const writer = new DevServerLogWriter(logPath);
		writer.close();
		writer.write("late\n");
		expect(existsSync(logPath)).toBe(false);
	});

	it("trims in place once past the cap, keeping the tail and never renaming a file", () => {
		resetDevServerLog(logPath);
		// The cap is injected: the real one is 32 MB, and a test that allocates that
		// much to prove one branch is a test that wedges a CI runner.
		const writer = new DevServerLogWriter(logPath, { maxBytes: 4096, keepBytes: 1024 });
		writer.write(`${"x".repeat(8192)}\nlast line\n`);
		writer.close();
		const content = readFileSync(logPath, "utf8");
		expect(content.startsWith(DEV_SERVER_LOG_TRIM_NOTICE)).toBe(true);
		expect(content.endsWith("last line\n")).toBe(true);
		expect(Buffer.byteLength(content, "utf8")).toBeLessThan(4096);
		// The rotation AGENTS.md forbids would have left a sibling behind.
		expect(existsSync(`${logPath}.1`)).toBe(false);
		expect(existsSync(`${logPath}.prev`)).toBe(false);
	});

	it("swallows a write to an unwritable path rather than taking the dev server down", () => {
		const blocker = join(root, "blocker-file");
		writeFileSync(blocker, "", "utf8");
		const writer = new DevServerLogWriter(join(blocker, "dev-server.log"));
		expect(() => {
			writer.write("anything\n");
			writer.close();
		}).not.toThrow();
	});
});

describe("readDevServerLogTail", () => {
	it("reports a missing file as not-yet-captured rather than as an error", () => {
		expect(readDevServerLogTail(logPath, 10)).toEqual({ exists: false, text: "", bytes: 0 });
	});

	it("returns the newest lines and the real size", () => {
		resetDevServerLog(logPath);
		const writer = new DevServerLogWriter(logPath);
		writer.write("one\ntwo\nthree\n");
		writer.close();
		const tail = readDevServerLogTail(logPath, 2);
		expect(tail.exists).toBe(true);
		expect(tail.text).toBe("two\nthree");
		expect(tail.bytes).toBe("one\ntwo\nthree\n".length);
	});
});
