import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockStatSync = vi.fn();

vi.mock("node:fs", () => ({
	existsSync: (...args: unknown[]) => mockExistsSync(...args),
	readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
	readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
	statSync: (...args: unknown[]) => mockStatSync(...args),
}));

const REAL_HOME = process.env.HOME || "/tmp";
const TEST_HOME = "/tmp/dev3-cli-endpoint-test";
const SOCKETS_DIR = `${TEST_HOME}/.dev3.0/sockets`;
const TOKEN = "c".repeat(64);

function endpointRecord(pid: number, overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		v: 1,
		pid,
		host: "127.0.0.1",
		port: 50000 + (pid % 10000),
		token: TOKEN,
		hostTaskId: null,
		startedAt: "2026-07-25T10:00:00.000Z",
		...overrides,
	});
}

/**
 * Windows publishes `<pid>.endpoint.json` records instead of `<pid>.sock`, so
 * discovery must select, deprioritize, and reject them by exactly the same rules.
 */
describe("endpoint record discovery", () => {
	let killSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		process.env.HOME = TEST_HOME;
		vi.resetModules();
		mockExistsSync.mockReset();
		mockReadFileSync.mockReset();
		mockReaddirSync.mockReset();
		mockStatSync.mockReset();
		killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

		mockExistsSync.mockImplementation((path: unknown) => path === SOCKETS_DIR);
		mockStatSync.mockReturnValue({ mtimeMs: 100 });
		mockReadFileSync.mockImplementation((path: unknown) => {
			const match = /(\d+)\.endpoint\.json$/.exec(String(path));
			if (match) return endpointRecord(Number(match[1]));
			throw new Error(`Unexpected readFileSync path: ${String(path)}`);
		});
	});

	afterEach(() => {
		process.env.HOME = REAL_HOME;
		killSpy.mockRestore();
	});

	function newer(file: string): void {
		mockStatSync.mockImplementation((path: unknown) => ({ mtimeMs: String(path).endsWith(file) ? 999 : 1 }));
	}

	it("returns a live record, keeps an EPERM-probed one as a fallback, and excludes one that already failed", async () => {
		const { discoverSocket, discoverSocketExcluding } = await import("../context");
		mockReaddirSync.mockReturnValue(["44818.endpoint.json"]);
		expect(discoverSocket()).toBe(`${SOCKETS_DIR}/44818.endpoint.json`);

		mockReaddirSync.mockReturnValue(["1100.endpoint.json", "1200.endpoint.json"]);
		expect(discoverSocketExcluding([`${SOCKETS_DIR}/1200.endpoint.json`])).toBe(`${SOCKETS_DIR}/1100.endpoint.json`);

		mockReaddirSync.mockReturnValue(["1000.endpoint.json"]);
		killSpy.mockImplementation(() => {
			throw Object.assign(new Error("EPERM"), { code: "EPERM" });
		});
		expect(discoverSocket()).toBe(`${SOCKETS_DIR}/1000.endpoint.json`);
	});

	it("ranks a Unix socket over a record, a primary over a newer guest, and the newest primary first", async () => {
		const { discoverSocket } = await import("../context");

		mockReaddirSync.mockReturnValue(["900.endpoint.json", "901.sock"]);
		newer(".endpoint.json");
		mockReadFileSync.mockImplementation((path: unknown) => {
			if (String(path).endsWith(".endpoint.json")) return endpointRecord(900);
			// No meta sidecar for the socket — treated as primary.
			throw new Error("ENOENT");
		});
		expect(discoverSocket(), "socket over record").toBe(`${SOCKETS_DIR}/901.sock`);

		mockReaddirSync.mockReturnValue(["100.endpoint.json", "200.endpoint.json"]);
		newer("100.endpoint.json");
		mockReadFileSync.mockImplementation((path: unknown) =>
			String(path).endsWith("100.endpoint.json") ? endpointRecord(100, { hostTaskId: "aabbccdd-1111-2222-3333-444444444444" }) : endpointRecord(200),
		);
		expect(discoverSocket(), "primary over newer guest").toBe(`${SOCKETS_DIR}/200.endpoint.json`);

		mockReaddirSync.mockReturnValue(["300.endpoint.json", "400.endpoint.json"]);
		newer("400.endpoint.json");
		mockReadFileSync.mockImplementation((path: unknown) => endpointRecord(Number(/(\d+)\.endpoint/.exec(String(path))?.[1])));
		expect(discoverSocket(), "newest primary").toBe(`${SOCKETS_DIR}/400.endpoint.json`);
	});

	it("skips a record whose process is gone, a corrupt record, and unrelated files", async () => {
		const { discoverSocket } = await import("../context");

		mockReaddirSync.mockReturnValue(["99999.endpoint.json", "500.endpoint.json"]);
		newer("99999.endpoint.json");
		killSpy.mockImplementation((pid: number) => {
			if (pid === 99999) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			return true;
		});
		expect(discoverSocket(), "dead process").toBe(`${SOCKETS_DIR}/500.endpoint.json`);

		mockReaddirSync.mockReturnValue(["600.endpoint.json", "700.endpoint.json"]);
		newer("600.endpoint.json");
		mockReadFileSync.mockImplementation((path: unknown) => (String(path).endsWith("600.endpoint.json") ? "{ truncated" : endpointRecord(700)));
		expect(discoverSocket(), "corrupt record").toBe(`${SOCKETS_DIR}/700.endpoint.json`);

		mockReaddirSync.mockReturnValue(["readme.txt", "not-a-pid.endpoint.json", "1300.meta.json"]);
		expect(discoverSocket(), "unrelated files").toBeNull();
	});

	it("skips a record that advertises a non-loopback host", async () => {
		mockReaddirSync.mockReturnValue(["800.endpoint.json"]);
		mockReadFileSync.mockImplementation(() => endpointRecord(800, { host: "0.0.0.0" }));

		const { discoverSocket } = await import("../context");

		expect(discoverSocket()).toBeNull();
	});
});

describe("socketDiagnostics with endpoint records", () => {
	let killSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		process.env.HOME = TEST_HOME;
		vi.resetModules();
		mockExistsSync.mockReset();
		mockReadFileSync.mockReset();
		mockReaddirSync.mockReset();
		mockStatSync.mockReset();
		killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		mockExistsSync.mockImplementation((path: unknown) => path === SOCKETS_DIR);
		mockStatSync.mockReturnValue({ mtimeMs: 100 });
	});

	afterEach(() => {
		process.env.HOME = REAL_HOME;
		killSpy.mockRestore();
	});

	it("reports the loopback target and never leaks the token", async () => {
		mockReaddirSync.mockReturnValue(["1400.endpoint.json"]);
		mockReadFileSync.mockImplementation(() => endpointRecord(1400));

		const { socketDiagnostics } = await import("../context");
		const output = socketDiagnostics("/tmp/somewhere");

		expect(output).toContain("endpoint 1400.endpoint.json");
		expect(output).toContain("loopback 127.0.0.1:51400");
		expect(output).toContain("process alive");
		expect(output).not.toContain(TOKEN);
	});

	it("flags an unreadable record, and marks a guest record as deprioritized naming its host task", async () => {
		const { socketDiagnostics } = await import("../context");
		mockReaddirSync.mockReturnValue(["1500.endpoint.json"]);
		mockReadFileSync.mockImplementation(() => "garbage");
		expect(socketDiagnostics("/tmp/somewhere")).toContain("UNREADABLE RECORD");

		mockReaddirSync.mockReturnValue(["1600.endpoint.json"]);
		mockReadFileSync.mockImplementation(() => endpointRecord(1600, { hostTaskId: "task-9" }));
		const out = socketDiagnostics("/tmp/somewhere");
		expect(out).toContain("guest instance — deprioritized");
		// A pid changes on every dev-server restart; the task id is what a human can aim at.
		expect(out).toContain("hosted by task task-9");
		expect(out).toContain("--instance task:task-9");
	});
});
