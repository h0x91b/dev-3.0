/**
 * Agent-facing `dev3 config` end to end: the real CLI command, the real socket
 * handlers and the real config files on disk. Only the socket transport (the
 * CLI's request goes straight to the handler) and the app's project store are
 * stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Project } from "../../shared/types";
import { CLI_EXIT_CODE_CONFIG_INVALID } from "../../shared/cli-exit-codes";

const ROOT = join(tmpdir(), `dev3-config-e2e-${process.pid}`);
const MAIN = join(ROOT, "project");
const WORKTREE = join(ROOT, "worktree");

const PROJECT: Project = {
	id: "p-1", name: "sample", path: MAIN, setupScript: "", devScript: "", cleanupScript: "",
	defaultBaseBranch: "main", createdAt: "2026-01-01",
};

vi.mock("../paths", () => ({ DEV3_HOME: join(tmpdir(), `dev3-config-e2e-home-${process.pid}`) }));
vi.mock("../git", () => ({
	detectDefaultCompareRef: vi.fn(async () => "origin/main"),
	resolveConfiguredCompareRef: vi.fn(async (_p: string, _b: string, c: string) => c),
	projectSlug: (p: string) => p.replace(/^\//, "").replaceAll("/", "-"),
}));
vi.mock("../settings", () => ({ loadSettings: vi.fn(async () => ({})) }));
vi.mock("../data", () => ({
	getProject: vi.fn(async () => PROJECT),
	loadTasks: vi.fn(async () => [{ id: "t-1", foreignCode: false }]),
}));
vi.mock("../spaces-data", () => ({ loadSpacesFile: vi.fn() }));
vi.mock("../rpc-handlers", () => ({ getPushMessage: () => null, getPushMessageLocal: () => null }));
vi.mock("../rpc-handlers/tmux-pty", () => ({}));
vi.mock("../agent-prompt-native", () => ({ NATIVE_PROMPT_DELIVERY_METHOD: "x.prompt", deliverNativePromptAsOwner: vi.fn() }));
vi.mock("../pane-input-native", () => ({ NATIVE_PANE_INPUT_METHOD: "x.pane", runNativePaneInputAsOwner: vi.fn() }));
vi.mock("../launch-handoff", () => ({ LAUNCH_ACTIVATE_METHOD: "x.launch", handleLaunchActivate: vi.fn() }));

const { systemHandlers } = await import("../cli-socket/system-commands");

vi.mock("../../cli/socket-client", () => ({
	sendRequest: vi.fn(async (_socket: string, method: string, params: Record<string, unknown>) => {
		try {
			// Through JSON, like the real socket.
			const data = await systemHandlers[method](JSON.parse(JSON.stringify(params)));
			return { id: "1", ok: true, data: JSON.parse(JSON.stringify(data)) };
		} catch (err) {
			return { id: "1", ok: false, error: (err as Error).message };
		}
	}),
}));

vi.mock("../../cli/context", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../cli/context")>()),
	readProjectDirect: vi.fn(() => PROJECT),
}));

const { handleConfig } = await import("../../cli/commands/config");

const CONTEXT = { projectId: "p-1", taskId: "t-1", socketPath: "/sock", worktreePath: WORKTREE };

let out = "";
let err = "";

async function dev3config(...words: string[]): Promise<{ code: number; out: string; err: string }> {
	out = "";
	err = "";
	const [sub, ...rest] = words;
	try {
		await handleConfig(sub, { flags: {}, positional: [] }, "/sock", CONTEXT, rest);
		return { code: 0, out, err };
	} catch (e) {
		const m = /^exit:(\d+)$/.exec((e as Error).message);
		if (!m) throw e;
		return { code: Number(m[1]), out, err };
	}
}

beforeEach(() => {
	mkdirSync(join(MAIN, ".dev3"), { recursive: true });
	mkdirSync(WORKTREE, { recursive: true });
	vi.spyOn(process.stdout, "write").mockImplementation((c) => { out += String(c); return true; });
	vi.spyOn(process.stderr, "write").mockImplementation((c) => { err += String(c); return true; });
	vi.spyOn(process, "exit").mockImplementation(((code: number) => { throw new Error(`exit:${code}`); }) as never);
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(ROOT, { recursive: true, force: true });
});

describe("dev3 config, agent-facing flow", () => {
	it("discovers, writes, reads back and validates a setting without touching JSON by hand", async () => {
		// 1. What can I configure? The schema alone answers it.
		const schema = await dev3config("schema");
		expect(schema.out).toContain("portCount  integer 0-20");
		expect((await dev3config("schema", "portCount")).out).toContain("dev3 config set portCount '2'");

		// 2. The committed main config has the author's own formatting.
		const committed = '{\n\t"setupScript": "npm ci",\n\t"clonePaths": ["node_modules"]\n}\n';
		writeFileSync(join(MAIN, ".dev3", "config.json"), committed);

		// 3. Set a value in the worktree's committed file, and a personal one at the root.
		expect((await dev3config("set", "portCount", "2")).code).toBe(0);
		expect(out).toContain(`in ${join(WORKTREE, ".dev3", "config.json")}`);
		expect((await dev3config("set", "--local", "--main", "env.NODE_ENV", "development")).code).toBe(0);
		expect(readFileSync(join(MAIN, ".gitignore"), "utf-8")).toContain(".dev3/config.local.json");

		// 4. show reports each effective value with its layer.
		const shown = JSON.parse((await dev3config("show", "--json")).out);
		expect(shown.settings.portCount).toBe(2);
		expect(shown.sources.portCount).toBe("repo");
		expect(shown.sources.setupScript).toBe("main-repo");
		expect(shown.envSources.NODE_ENV).toBe("main-local");
		expect((await dev3config("get", "setupScript")).out).toBe("npm ci\n");

		// 5. The untouched committed file kept its tabs and inline array.
		await dev3config("set", "--main", "defaultBaseBranch", "develop");
		expect(readFileSync(join(MAIN, ".dev3", "config.json"), "utf-8")).toBe(
			'{\n\t"setupScript": "npm ci",\n\t"clonePaths": ["node_modules"],\n\t"defaultBaseBranch": "develop"\n}\n',
		);

		// 6. A shadowed write says so.
		const shadowed = await dev3config("set", "--main", "portCount", "4");
		expect(shadowed.out).toContain("the repo layer also sets portCount and wins");

		// 7. Validation passes on what was written.
		expect((await dev3config("validate")).code).toBe(0);

		// 8. unset brings the lower layer back.
		await dev3config("unset", "portCount");
		expect(JSON.parse((await dev3config("show", "--json")).out).settings.portCount).toBe(4);
	});

	it("refuses an invalid value before anything is written", async () => {
		const result = await dev3config("set", "portCount", "99");
		expect(result.code).toBe(CLI_EXIT_CODE_CONFIG_INVALID);
		expect(result.err).toContain("must be at most 20");
		expect(existsSync(join(WORKTREE, ".dev3", "config.json"))).toBe(false);
	});

	it("refuses to overwrite a file that is not valid JSON", async () => {
		writeFileSync(join(MAIN, ".dev3", "config.json"), "{ broken");
		const result = await dev3config("set", "--main", "portCount", "1");
		expect(result.code).not.toBe(0);
		expect(result.err).toContain("is not valid JSON");
		expect(readFileSync(join(MAIN, ".dev3", "config.json"), "utf-8")).toBe("{ broken");
		expect((await dev3config("validate")).code).toBe(CLI_EXIT_CODE_CONFIG_INVALID);
	});

	it("warns on unknown keys without failing validation", async () => {
		writeFileSync(join(MAIN, ".dev3", "config.json"), JSON.stringify({ setupScritp: "x" }));
		const result = await dev3config("validate");
		expect(result.code).toBe(0);
		expect(result.out).toContain('did you mean "setupScript"');
	});
});
