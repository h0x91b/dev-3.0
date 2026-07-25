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

	it("returns a live endpoint record when no sockets exist", async () => {
		mockReaddirSync.mockReturnValue(["44818.endpoint.json"]);

		const { discoverSocket } = await import("../context");

		expect(discoverSocket()).toBe(`${SOCKETS_DIR}/44818.endpoint.json`);
	});

	it("deprioritizes a guest instance record", async () => {
		mockReaddirSync.mockReturnValue(["100.endpoint.json", "200.endpoint.json"]);
		mockReadFileSync.mockImplementation((path: unknown) => {
			if (String(path).endsWith("100.endpoint.json")) {
				return endpointRecord(100, { hostTaskId: "aabbccdd-1111-2222-3333-444444444444" });
			}
			return endpointRecord(200);
		});
		// The guest is newer, so only the guest rule can put the primary first.
		mockStatSync.mockImplementation((path: unknown) => ({
			mtimeMs: String(path).endsWith("100.endpoint.json") ? 999 : 1,
		}));

		const { discoverSocket } = await import("../context");

		expect(discoverSocket()).toBe(`${SOCKETS_DIR}/200.endpoint.json`);
	});

	it("prefers the newest record among primaries", async () => {
		mockReaddirSync.mockReturnValue(["300.endpoint.json", "400.endpoint.json"]);
		mockStatSync.mockImplementation((path: unknown) => ({
			mtimeMs: String(path).endsWith("400.endpoint.json") ? 500 : 100,
		}));

		const { discoverSocket } = await import("../context");

		expect(discoverSocket()).toBe(`${SOCKETS_DIR}/400.endpoint.json`);
	});

	it("skips a record whose process is gone", async () => {
		mockReaddirSync.mockReturnValue(["99999.endpoint.json", "500.endpoint.json"]);
		mockStatSync.mockImplementation((path: unknown) => ({
			mtimeMs: String(path).endsWith("99999.endpoint.json") ? 999 : 1,
		}));
		killSpy.mockImplementation((pid: number) => {
			if (pid === 99999) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			return true;
		});

		const { discoverSocket } = await import("../context");

		expect(discoverSocket()).toBe(`${SOCKETS_DIR}/500.endpoint.json`);
	});

	it("skips a corrupt record so it cannot block a healthy instance", async () => {
		mockReaddirSync.mockReturnValue(["600.endpoint.json", "700.endpoint.json"]);
		mockStatSync.mockImplementation((path: unknown) => ({
			mtimeMs: String(path).endsWith("600.endpoint.json") ? 999 : 1,
		}));
		mockReadFileSync.mockImplementation((path: unknown) => {
			if (String(path).endsWith("600.endpoint.json")) return "{ truncated";
			return endpointRecord(700);
		});

		const { discoverSocket } = await import("../context");

		expect(discoverSocket()).toBe(`${SOCKETS_DIR}/700.endpoint.json`);
	});

	it("skips a record that advertises a non-loopback host", async () => {
		mockReaddirSync.mockReturnValue(["800.endpoint.json"]);
		mockReadFileSync.mockImplementation(() => endpointRecord(800, { host: "0.0.0.0" }));

		const { discoverSocket } = await import("../context");

		expect(discoverSocket()).toBeNull();
	});

	it("prefers a Unix socket over an endpoint record when both are present", async () => {
		mockReaddirSync.mockReturnValue(["900.endpoint.json", "901.sock"]);
		mockStatSync.mockImplementation((path: unknown) => ({
			mtimeMs: String(path).endsWith(".endpoint.json") ? 999 : 1,
		}));
		mockReadFileSync.mockImplementation((path: unknown) => {
			if (String(path).endsWith(".endpoint.json")) return endpointRecord(900);
			// No meta sidecar for the socket — treated as primary.
			throw new Error("ENOENT");
		});

		const { discoverSocket } = await import("../context");

		expect(discoverSocket()).toBe(`${SOCKETS_DIR}/901.sock`);
	});

	it("keeps an EPERM-probed record as a fallback candidate", async () => {
		mockReaddirSync.mockReturnValue(["1000.endpoint.json"]);
		killSpy.mockImplementation(() => {
			throw Object.assign(new Error("EPERM"), { code: "EPERM" });
		});

		const { discoverSocket } = await import("../context");

		expect(discoverSocket()).toBe(`${SOCKETS_DIR}/1000.endpoint.json`);
	});

	it("excludes an endpoint that already failed this invocation", async () => {
		mockReaddirSync.mockReturnValue(["1100.endpoint.json", "1200.endpoint.json"]);

		const { discoverSocketExcluding } = await import("../context");

		expect(discoverSocketExcluding([`${SOCKETS_DIR}/1200.endpoint.json`])).toBe(`${SOCKETS_DIR}/1100.endpoint.json`);
	});

	it("ignores unrelated files in the sockets dir", async () => {
		mockReaddirSync.mockReturnValue(["readme.txt", "not-a-pid.endpoint.json", "1300.meta.json"]);

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

	it("flags an unreadable record instead of pretending it is fine", async () => {
		mockReaddirSync.mockReturnValue(["1500.endpoint.json"]);
		mockReadFileSync.mockImplementation(() => "garbage");

		const { socketDiagnostics } = await import("../context");

		expect(socketDiagnostics("/tmp/somewhere")).toContain("UNREADABLE RECORD");
	});

	it("marks a guest record as deprioritized", async () => {
		mockReaddirSync.mockReturnValue(["1600.endpoint.json"]);
		mockReadFileSync.mockImplementation(() => endpointRecord(1600, { hostTaskId: "task-9" }));

		const { socketDiagnostics } = await import("../context");

		expect(socketDiagnostics("/tmp/somewhere")).toContain("[guest instance — deprioritized]");
	});
});
